import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { BudgetLedger, BudgetAccountRepository } from "../budget/budget-ledger";
import { isZeroBudgetVector, sumBudgetVectors } from "../budget/budget-types";
import { QueuedTaskStatusEnum, type QueuedTask, type ToolCreateTaskBody } from "../types";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import { PlanVersionRepository, ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { LeaseService } from "./lease-service";
import { PlanScheduler } from "./plan-scheduler";
import { decideProgramBudgetMode } from "./budget-health";
import type { WorkPackage } from "./program-types";

export interface ProgramTaskDispatcher {
  createTask(body: ToolCreateTaskBody): Promise<QueuedTask>;
  getTask(id: string): QueuedTask | undefined;
  findTaskByConflictKey(conflictKey: string): QueuedTask | undefined;
  resolveAgent(workPackage: WorkPackage): string | undefined;
}

export interface ProgramExecutionTickResult {
  programId: string;
  mode: string;
  dispatched: Array<{ workPackageId: string; attemptId: string; taskId: string; agentId: string; reservationId?: string }>;
  reconciled: Array<{ workPackageId: string; taskId: string; status: string }>;
  blocked: Array<{ workPackageId: string; reasons: string[] }>;
}

/** Bridges durable Program state to the existing Agent task scheduler. */
export class ProgramExecutionCoordinator {
  private readonly programs: ProgramRepository;
  private readonly plans: PlanVersionRepository;
  private readonly work: WorkPackageRepository;
  private readonly leases: LeaseService;
  private readonly ledger: BudgetLedger;
  private readonly accounts: BudgetAccountRepository;
  private readonly audit: ExecutionAuditRepository;
  private readonly scheduler = new PlanScheduler();
  private readonly ticking = new Set<string>();

  constructor(private readonly handle: ExecutionDatabase, private readonly tasks: ProgramTaskDispatcher, private readonly maxConcurrency = 4) {
    this.programs = new ProgramRepository(handle);
    this.plans = new PlanVersionRepository(handle);
    this.work = new WorkPackageRepository(handle);
    this.leases = new LeaseService(handle);
    this.ledger = BudgetLedger.from(handle);
    this.accounts = BudgetAccountRepository.from(handle);
    this.audit = new ExecutionAuditRepository(handle);
  }

  async tick(programId: string, now = new Date().toISOString()): Promise<ProgramExecutionTickResult> {
    if (this.ticking.has(programId)) throw new Error(`Program ${programId} is already being scheduled`);
    this.ticking.add(programId);
    try {
      this.recoverDispatchIntents(programId, now);
      const reconciled = this.reconcile(programId, now);
      let program = this.programs.get(programId);
      if (!program) throw new Error(`Program ${programId} was not found`);
      if (program.status === "admitted") program = this.programs.transitionStatus(program.id, program.revision, "running", now);
      if (program.status === "waiting") program = this.programs.transitionStatus(program.id, program.revision, "running", now);
      const plan = program.activePlanVersionId ? this.plans.get(program.activePlanVersionId) : undefined;
      const packages = plan ? this.work.listByPlan(plan.id) : [];
      const projectedMandatoryRemaining = sumBudgetVectors(packages
        .filter((item) => item.mandatory && ["planned", "blocked", "runnable", "failed", "replanning_required"].includes(item.status))
        .map((item) => item.hardEnvelope));
      const health = decideProgramBudgetMode(this.handle, { programId, projectedMandatoryRemaining });
      const selection = this.scheduler.select({
        packages,
        programRunning: program.status === "running",
        planActive: plan?.status === "active",
        selectedTier: plan?.scopeTier ?? "minimum",
        mode: health.mode,
        now,
        maxConcurrency: this.maxConcurrency,
        executionAvailable: health.executionAvailable,
        agentAvailable: (item) => this.tasks.resolveAgent(item) !== undefined,
      });
      const dispatched: ProgramExecutionTickResult["dispatched"] = [];
      for (const item of selection.selected) {
        const agentId = this.tasks.resolveAgent(item);
        if (!agentId) continue;
        dispatched.push(await this.dispatch(item, agentId, now));
      }
      return {
        programId,
        mode: health.mode,
        dispatched,
        reconciled,
        blocked: selection.candidates.filter((item) => item.blockedBy.length > 0)
          .map((item) => ({ workPackageId: item.workPackage.id, reasons: item.blockedBy })),
      };
    } finally {
      this.ticking.delete(programId);
    }
  }

  private async dispatch(item: WorkPackage, agentId: string, now: string): Promise<ProgramExecutionTickResult["dispatched"][number]> {
    const dispatchId = randomUUID();
    const accountKind = item.scopeTier === "minimum" ? "minimum" : "upgrade_pool";
    const account = this.accounts.listByProgram(item.programId).find((candidate) => candidate.kind === accountKind);
    if (!account) throw new Error(`No ${accountKind} execution account exists for ${item.programId}`);
    const reservationId = `reservation:${dispatchId}`;
    const attemptId = `attempt:${dispatchId}`;
    const conflictKey = `program:${item.programId}:work:${item.id}`;
    this.audit.append({
      id: `audit-start:${dispatchId}`, programId: item.programId, actorType: "service", actorId: "program-execution-coordinator",
      eventType: "program.work_dispatch_started", requestId: dispatchId,
      metadata: { dispatchId, workPackageId: item.id, agentId, reservationId, attemptId, conflictKey, hasReservation: !isZeroBudgetVector(item.hardEnvelope) }, createdAt: now,
    });
    let reservation = isZeroBudgetVector(item.hardEnvelope) ? undefined : this.ledger.reserve({
      id: reservationId, programId: item.programId, accountId: account.id,
      operationKey: `dispatch:${dispatchId}`, amount: item.hardEnvelope, consumerClass: "execution", createdAt: now,
    });
    if (reservation) reservation = this.ledger.activate(reservation.id, reservation.revision, `task-dispatch:${dispatchId}`, now);
    const attempt = this.leases.acquire({
      workPackageId: item.id, ownerId: agentId, now,
      expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString(),
      attemptId,
    });
    this.leases.transition({ attemptId: attempt.id, ownerId: agentId, fencingToken: attempt.fencingToken, now, status: "running" });
    let createdTask: QueuedTask | undefined;
    try {
      const task = await this.tasks.createTask({
        targetAgentId: agentId,
        createdBy: "admin",
        prompt: item.prompt,
        conflictKey,
        executionContext: {
          programId: item.programId, workPackageId: item.id, attemptId: attempt.id,
          executionEpoch: attempt.executionEpoch, fencingToken: attempt.fencingToken,
          operationId: `dispatch:${dispatchId}`, ...(reservation ? { reservationId: reservation.id } : {}),
        },
      });
      createdTask = task;
      this.audit.append({
        id: `audit:${dispatchId}`, programId: item.programId, attemptId: attempt.id, requestId: dispatchId,
        actorType: "service", actorId: "program-execution-coordinator", eventType: "program.work_dispatched",
        metadata: { dispatchId, workPackageId: item.id, taskId: task.id, agentId, ...(reservation ? { reservationId: reservation.id } : {}) }, createdAt: now,
      });
      return { workPackageId: item.id, attemptId: attempt.id, taskId: task.id, agentId, ...(reservation ? { reservationId: reservation.id } : {}) };
    } catch (error) {
      // createTask is durable before it returns. If only the final correlation
      // audit failed, leave the intent open so startup recovery can relink the
      // task by conflict key; compensating here would strand a live task.
      if (createdTask) throw error;
      this.compensateFailedDispatch(item.id, attempt.id, agentId, attempt.fencingToken, reservation?.id, now, error);
      this.audit.append({ id: `audit-failed:${dispatchId}`, programId: item.programId, attemptId: attempt.id, requestId: dispatchId,
        actorType: "service", actorId: "program-execution-coordinator", eventType: "program.work_dispatch_failed",
        reason: error instanceof Error ? error.message : String(error), metadata: { dispatchId, workPackageId: item.id }, createdAt: now });
      throw error;
    }
  }

  private recoverDispatchIntents(programId: string, now: string): void {
    const rows = this.handle.connection.prepare(`SELECT request_id, metadata_json FROM audit_events s
      WHERE s.program_id=? AND s.event_type='program.work_dispatch_started'
      AND NOT EXISTS (SELECT 1 FROM audit_events t WHERE t.request_id=s.request_id
        AND t.event_type IN ('program.work_dispatched','program.work_dispatch_failed'))
      ORDER BY s.created_at, s.id`).all(programId) as Array<{ request_id: string; metadata_json: string }>;
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const dispatchId = row.request_id;
      const workPackageId = String(metadata.workPackageId ?? "");
      const agentId = String(metadata.agentId ?? "");
      const attemptId = String(metadata.attemptId ?? "");
      const reservationId = metadata.hasReservation === true ? String(metadata.reservationId ?? "") : undefined;
      const conflictKey = String(metadata.conflictKey ?? "");
      const task = conflictKey ? this.tasks.findTaskByConflictKey(conflictKey) : undefined;
      if (task) {
        this.audit.append({ id: `audit:${dispatchId}`, programId, attemptId, requestId: dispatchId, actorType: "service",
          actorId: "program-execution-coordinator", eventType: "program.work_dispatched",
          metadata: { dispatchId, workPackageId, taskId: task.id, agentId, ...(reservationId ? { reservationId } : {}), recovered: true }, createdAt: now });
        continue;
      }
      const attempt = this.handle.connection.prepare("SELECT fencing_token FROM work_package_attempts WHERE id=?").get(attemptId) as { fencing_token: number } | undefined;
      if (attempt) this.compensateFailedDispatch(workPackageId, attemptId, agentId, attempt.fencing_token, reservationId, now, "Recovered incomplete dispatch");
      else {
        const reservation = reservationId ? this.ledger.getReservation(reservationId) : undefined;
        if (reservation && ["created", "active", "uncertain", "expired"].includes(reservation.state)) this.ledger.release(reservation.id, reservation.revision, now);
      }
      this.audit.append({ id: `audit-failed:${dispatchId}`, programId, ...(attempt ? { attemptId } : {}), requestId: dispatchId,
        actorType: "service", actorId: "program-execution-coordinator", eventType: "program.work_dispatch_failed",
        reason: "Recovered incomplete dispatch", metadata: { dispatchId, workPackageId, recovered: true }, createdAt: now });
    }
  }

  private compensateFailedDispatch(workPackageId: string, attemptId: string, agentId: string, fencingToken: number, reservationId: string | undefined, now: string, error: unknown): void {
    const reservation = reservationId ? this.ledger.getReservation(reservationId) : undefined;
    if (reservation && ["created", "active", "uncertain", "expired"].includes(reservation.state)) this.ledger.release(reservation.id, reservation.revision, now);
    try { this.leases.transition({ attemptId, ownerId: agentId, fencingToken, now, status: "failed" }); } catch { /* best-effort compensation below */ }
    this.handle.connection.prepare("DELETE FROM attempt_leases WHERE attempt_id=?").run(attemptId);
    const item = this.work.get(workPackageId);
    if (item?.status === "running") this.work.transitionStatus(item.id, item.revision, "failed", now);
    this.handle.connection.prepare("UPDATE work_package_attempts SET failure_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify({ reason: error instanceof Error ? error.message : String(error), phase: "dispatch" }), now, attemptId);
  }

  private reconcile(programId: string, now: string): ProgramExecutionTickResult["reconciled"] {
    const output: ProgramExecutionTickResult["reconciled"] = [];
    const events = this.handle.connection.prepare(`SELECT attempt_id, metadata_json FROM audit_events
      WHERE program_id=? AND event_type='program.work_dispatched' ORDER BY created_at, id`).all(programId) as Array<{ attempt_id: string | null; metadata_json: string }>;
    for (const event of events) {
      const metadata = JSON.parse(event.metadata_json) as Record<string, unknown>;
      const taskId = typeof metadata.taskId === "string" ? metadata.taskId : undefined;
      const workPackageId = typeof metadata.workPackageId === "string" ? metadata.workPackageId : undefined;
      const agentId = typeof metadata.agentId === "string" ? metadata.agentId : undefined;
      const reservationId = typeof metadata.reservationId === "string" ? metadata.reservationId : undefined;
      if (!taskId || !workPackageId || !agentId || !event.attempt_id) continue;
      const task = this.tasks.getTask(taskId);
      const attempt = this.handle.connection.prepare(`SELECT a.status, a.fencing_token, l.expires_at FROM work_package_attempts a
        LEFT JOIN attempt_leases l ON l.attempt_id=a.id WHERE a.id=?`).get(event.attempt_id) as { status: string; fencing_token: number; expires_at: string | null } | undefined;
      const item = this.work.get(workPackageId);
      if (!task || !attempt || !item) continue;
      if (["leased", "running"].includes(attempt.status) && (task.status === QueuedTaskStatusEnum.Paused || !attempt.expires_at || attempt.expires_at <= now)) {
        this.handle.connection.transaction(() => {
          this.handle.connection.prepare("UPDATE work_package_attempts SET status='uncertain', updated_at=? WHERE id=? AND status IN ('leased','running')").run(now, event.attempt_id);
          this.handle.connection.prepare("DELETE FROM attempt_leases WHERE attempt_id=?").run(event.attempt_id);
          const current = this.work.get(workPackageId);
          if (current?.status === "running") this.work.transitionStatus(current.id, current.revision, "replanning_required", now);
        }).immediate();
        const uncertainReservation = reservationId ? this.ledger.getReservation(reservationId) : undefined;
        if (uncertainReservation && ["created", "active"].includes(uncertainReservation.state)) this.ledger.markUncertain(uncertainReservation.id, uncertainReservation.revision, now);
        output.push({ workPackageId, taskId, status: "uncertain" });
        continue;
      }
      if ([QueuedTaskStatusEnum.Queued, QueuedTaskStatusEnum.Running, QueuedTaskStatusEnum.Waiting].includes(task.status as QueuedTaskStatusEnum)
        && attempt.status === "running" && attempt.expires_at && attempt.expires_at > now) {
        this.leases.renew({ attemptId: event.attempt_id, ownerId: agentId, fencingToken: attempt.fencing_token, now, expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString() });
      } else if ([QueuedTaskStatusEnum.Completed, QueuedTaskStatusEnum.ReviewPending].includes(task.status as QueuedTaskStatusEnum) && attempt.status === "running") {
        this.leases.transition({ attemptId: event.attempt_id, ownerId: agentId, fencingToken: attempt.fencing_token, now, status: "verifying" });
        if (item.status === "running") this.work.transitionStatus(item.id, item.revision, "verifying", now);
        output.push({ workPackageId, taskId, status: "verifying" });
      } else if ([QueuedTaskStatusEnum.Failed, QueuedTaskStatusEnum.Cancelled].includes(task.status as QueuedTaskStatusEnum) && ["leased", "running"].includes(attempt.status)) {
        const attemptStatus = task.status === QueuedTaskStatusEnum.Cancelled ? "aborted" : "failed";
        this.leases.transition({ attemptId: event.attempt_id, ownerId: agentId, fencingToken: attempt.fencing_token, now, status: attemptStatus });
        if (item.status === "running") this.work.transitionStatus(item.id, item.revision, task.status === QueuedTaskStatusEnum.Cancelled ? "cancelled" : "failed", now);
        this.handle.connection.prepare("DELETE FROM attempt_leases WHERE attempt_id=?").run(event.attempt_id);
        const reservation = reservationId ? this.ledger.getReservation(reservationId) : undefined;
        if (reservation && ["created", "active", "uncertain", "expired"].includes(reservation.state)) this.ledger.release(reservation.id, reservation.revision, now);
        output.push({ workPackageId, taskId, status: attemptStatus });
      }
    }
    return output;
  }
}

export function registerExperimentalProgramExecutionRoutes(app: Express, coordinator: ProgramExecutionCoordinator, enabled: boolean): boolean {
  if (!enabled) return false;
  app.post("/api/experimental/programs/:id/tick", async (request: Request, response: Response) => {
    try { response.json(await coordinator.tick(String(request.params.id))); }
    catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  return true;
}
