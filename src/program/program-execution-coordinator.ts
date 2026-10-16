import type { FaultPoint } from "./fault-injection-harness";
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { BudgetLedger, BudgetAccountRepository, BudgetLedgerError } from "../budget/budget-ledger";
import { isZeroBudgetVector, sumBudgetVectors } from "../budget/budget-types";
import { QueuedTaskStatusEnum, type QueuedTask, type ToolCreateTaskBody } from "../types";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import { PlanVersionRepository, ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { LeaseService } from "./lease-service";
import { ExecutionBarrier } from "./execution-barrier";
import { PlanScheduler, type BudgetMode } from "./plan-scheduler";
import { decideProgramBudgetMode } from "./budget-health";
import { SchedulerOwnership, SchedulerOwnershipError, type SchedulerClaim } from "./scheduler-ownership";
import type { WorkPackage } from "./program-types";

export interface ProgramTaskDispatcher {
  createTask(body: ToolCreateTaskBody): Promise<QueuedTask>;
  getTask(id: string): QueuedTask | undefined;
  findTaskByConflictKey(conflictKey: string, attemptId?: string): QueuedTask | undefined;
  resolveAgent(workPackage: WorkPackage, mode?: BudgetMode): string | undefined;
  modelRefForAgent?(agentId: string): string;
}

export interface ProgramExecutionTickResult {
  programId: string;
  mode: string;
  dispatched: Array<{ workPackageId: string; attemptId: string; taskId: string; agentId: string; reservationId?: string }>;
  reconciled: Array<{ workPackageId: string; taskId: string; status: string }>;
  blocked: Array<{ workPackageId: string; reasons: string[] }>;
}

const defaultOwners = new WeakMap<ExecutionDatabase, string>();

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
  private readonly ownership: SchedulerOwnership;
  readonly instanceId: string;
  private readonly clock: () => string;
  private readonly owned = new Map<string, number>();
  private readonly drains = new Set<Promise<void>>();
  private renewal?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly handle: ExecutionDatabase, private readonly tasks: ProgramTaskDispatcher, private readonly maxConcurrency = 4,
    private readonly runtime: { reconcileAttempt?: (attemptId: string) => Promise<void>; verifyProgram?: (programId: string, assertCurrent?: () => void) => Promise<void>;
      maintainProgram?: (programId: string, now: string, assertCurrent?: () => void) => Promise<void>;
      instanceId?: string; clock?: () => string; faultInjector?: (point: FaultPoint) => void } = {}) {
    let owner = runtime.instanceId ?? defaultOwners.get(handle);
    if (!owner) { owner = `scheduler:${randomUUID()}`; defaultOwners.set(handle, owner); }
    this.instanceId = owner; this.ownership = new SchedulerOwnership(handle, owner);
    this.clock = runtime.clock ?? (() => new Date().toISOString());
    this.programs = new ProgramRepository(handle);
    this.plans = new PlanVersionRepository(handle);
    this.work = new WorkPackageRepository(handle);
    this.leases = new LeaseService(handle);
    this.ledger = BudgetLedger.from(handle);
    this.accounts = BudgetAccountRepository.from(handle);
    this.audit = new ExecutionAuditRepository(handle);
  }

  start(): void {
    if (this.renewal || this.stopped) return;
    this.renewal = setInterval(() => {
      for (const [id, fence] of this.owned) {
        try { if (!this.ownership.renew(id, fence, this.clock())) this.owned.delete(id); }
        catch { this.owned.delete(id); }
      }
    }, 20_000);
    this.renewal.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.renewal) clearInterval(this.renewal);
    await Promise.all([...this.drains]);
    this.ownership.relinquish(this.clock());
    this.owned.clear();
  }

  async tick(programId: string, now = new Date().toISOString()): Promise<ProgramExecutionTickResult> {
    if (this.stopped) return { programId, mode: "stopped", dispatched: [], reconciled: [], blocked: [] };
    if (this.ticking.has(programId)) throw new Error(`Program ${programId} is already being scheduled`);
    this.ticking.add(programId);
    let complete!: () => void;
    const done = new Promise<void>((resolve) => { complete = resolve; }); this.drains.add(done);
    let claim: SchedulerClaim | undefined;
    let renewal: NodeJS.Timeout | undefined;
    try {
      const initial = this.programs.get(programId);
      if (!initial) throw new Error(`Program ${programId} was not found`);
      if (["completed", "incomplete", "cancelled"].includes(initial.status)) return {
        programId, mode: initial.status, dispatched: [], reconciled: [], blocked: [],
      };
      if (!["admitted", "running", "waiting", "closing_out"].includes(initial.status)) throw new Error(`Program ${programId} is not schedulable`);
      claim = this.ownership.claim(programId, this.clock());
      if (!claim) return { programId, mode: "standby", dispatched: [], reconciled: [], blocked: [] };
      const tickClaim = claim;
      this.owned.set(programId, claim.fencingToken);
      const assertOwner = () => this.ownership.assertCurrent(tickClaim, this.clock());
      renewal = setInterval(() => {
        try { this.ownership.renew(programId, tickClaim.fencingToken, this.clock(), tickClaim.tickId); } catch { /* assertions fence subsequent writes */ }
      }, 20_000);
      renewal.unref();
      if (initial.status === "closing_out" && this.runtime.maintainProgram) {
        await this.runtime.maintainProgram(programId, now, assertOwner);
        return { programId, mode: "closeout", dispatched: [], reconciled: [], blocked: [] };
      }
      const epoch = initial.executionEpoch;
      const assertRunnable = () => {
        assertOwner();
        const current = this.programs.get(programId);
        if (!current || !["admitted", "running", "waiting"].includes(current.status)) throw new Error(`Program ${programId} is not schedulable`);
        new ExecutionBarrier(this.handle).assertAllowed(programId, epoch);
      };
      assertRunnable();
      this.recoverForeignAttempts(programId, tickClaim, now);
      this.recoverDispatchIntents(programId, now, tickClaim, assertOwner);
      const reconciled = await this.reconcile(programId, now, assertRunnable);
      assertRunnable();
      let program = this.programs.get(programId);
      if (!program) throw new Error(`Program ${programId} was not found`);
      if (program.status === "admitted") program = this.programs.transitionStatus(program.id, program.revision, "running", now);
      if (program.status === "waiting") program = this.programs.transitionStatus(program.id, program.revision, "running", now);
      await this.runtime.verifyProgram?.(programId, assertOwner);
      assertOwner();
      await this.runtime.maintainProgram?.(programId, now, assertOwner);
      assertOwner();
      program = this.programs.get(programId)!;
      const plan = program.activePlanVersionId ? this.plans.get(program.activePlanVersionId) : undefined;
      const packages = plan ? this.work.listByPlan(plan.id) : [];
      const projectedMandatoryRemaining = sumBudgetVectors(packages
        .filter((item) => item.mandatory && ["planned", "blocked", "runnable", "failed", "replanning_required"].includes(item.status))
        .map((item) => item.hardEnvelope));
      const health = decideProgramBudgetMode(this.handle, { programId, projectedMandatoryRemaining });
      const resolveAgent = (item: WorkPackage) => {
        if (item.conflictKeys.some((key) => !this.ownership.resourceAvailable(program.projectId, `conflict:${key}`))) return undefined;
        const id = this.tasks.resolveAgent(item, health.mode);
        return id && this.ownership.resourceAvailable(program.projectId, `agent:${id}`) ? id : undefined;
      };
      const selection = this.scheduler.select({
        packages,
        programRunning: program.status === "running",
        planActive: plan?.status === "active",
        selectedTier: plan?.scopeTier ?? "minimum",
        mode: health.mode,
        now,
        maxConcurrency: this.maxConcurrency,
        executionAvailable: health.executionAvailable,
        agentAvailable: (item) => resolveAgent(item) !== undefined,
      });
      const dispatched: ProgramExecutionTickResult["dispatched"] = [];
      for (const item of selection.selected) {
        assertRunnable();
        const agentId = resolveAgent(item);
        if (!agentId) continue;
        try { dispatched.push(await this.dispatch(item, agentId, now, tickClaim, assertRunnable)); }
        catch (error) { if (!(error instanceof SchedulerOwnershipError) || error.code !== "RESOURCE_BUSY") throw error; }
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
      if (renewal) clearInterval(renewal);
      try { if (claim) this.ownership.finish(claim); }
      finally { this.ticking.delete(programId); this.drains.delete(done); complete(); }
    }
  }

  private async dispatch(item: WorkPackage, agentId: string, now: string, claim: SchedulerClaim, assertCurrent: () => void): Promise<ProgramExecutionTickResult["dispatched"][number]> {
    const dispatchId = randomUUID();
    const accountKind = item.scopeTier === "minimum" ? "minimum" : "upgrade_pool";
    const account = this.accounts.listByProgram(item.programId).find((candidate) => candidate.kind === accountKind);
    if (!account) throw new Error(`No ${accountKind} execution account exists for ${item.programId}`);
    const reservationId = `reservation:${dispatchId}`;
    const attemptId = `attempt:${dispatchId}`;
    const conflictKey = `program:${item.programId}:work:${item.id}`;
    const { reservation, attempt } = this.handle.connection.transaction(() => {
      assertCurrent();
      const current = this.work.get(item.id);
      if (current?.revision !== item.revision || current.status !== "runnable") throw new SchedulerOwnershipError("RESOURCE_BUSY", "Work selection changed");
      this.audit.append({
        id: `audit-start:${dispatchId}`, programId: item.programId, actorType: "service", actorId: "program-execution-coordinator",
        eventType: "program.work_dispatch_started", requestId: dispatchId,
        metadata: { dispatchId, workPackageId: item.id, agentId, reservationId, attemptId, conflictKey, hasReservation: !isZeroBudgetVector(item.hardEnvelope),
          ...(this.tasks.modelRefForAgent ? { modelRef: this.tasks.modelRefForAgent(agentId) } : {}), schedulerOwnerId: claim.ownerId, schedulerFence: claim.fencingToken }, createdAt: now,
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
      this.ownership.bindAttempt(attempt.id, claim);
      this.leases.transition({ attemptId: attempt.id, ownerId: agentId, fencingToken: attempt.fencingToken, now, status: "running" });
      const program = this.programs.get(item.programId)!;
      this.ownership.claimResources(program.projectId, [`agent:${agentId}`, ...item.conflictKeys.map((key) => `conflict:${key}`)], attempt.id);
      return { reservation, attempt };
    }).immediate();
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
      this.runtime.faultInjector?.("dispatch_after_provider_accept");
      assertCurrent();
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
      assertCurrent();
      this.compensateFailedDispatch(item.id, attempt.id, agentId, attempt.fencingToken, reservation?.id, now, error);
      this.audit.append({ id: `audit-failed:${dispatchId}`, programId: item.programId, attemptId: attempt.id, requestId: dispatchId,
        actorType: "service", actorId: "program-execution-coordinator", eventType: "program.work_dispatch_failed",
        reason: error instanceof Error ? error.message : String(error), metadata: { dispatchId, workPackageId: item.id }, createdAt: now });
      throw error;
    }
  }

  private recoverForeignAttempts(programId: string, claim: SchedulerClaim, now: string): void {
    this.handle.connection.transaction(() => {
      this.ownership.assertCurrent(claim, this.clock());
      const rows = this.handle.connection.prepare(`SELECT a.id,a.work_package_id FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id
        LEFT JOIN attempt_execution_owners o ON o.attempt_id=a.id WHERE w.program_id=? AND a.status IN ('leased','running','checkpointed','verifying')
        AND (o.owner_id IS NULL OR o.owner_id<>? OR o.scheduler_fencing_token<>?)`).all(programId, claim.ownerId, claim.fencingToken) as Array<{ id: string; work_package_id: string }>;
      for (const row of rows) {
        this.handle.connection.prepare("UPDATE work_package_attempts SET status='uncertain',updated_at=? WHERE id=?").run(now, row.id);
        this.handle.connection.prepare("DELETE FROM attempt_leases WHERE attempt_id=?").run(row.id);
        const item = this.work.get(row.work_package_id);
        if (item && ["running", "verifying", "checkpointed"].includes(item.status)) this.work.transitionStatus(item.id, item.revision, "replanning_required", now);
        else if (item?.status === "leased") {
          const runnable = this.work.transitionStatus(item.id, item.revision, "runnable", now);
          this.work.transitionStatus(runnable.id, runnable.revision, "replanning_required", now);
        }
        this.audit.append({ id: `ownership-lost:${row.id}`, programId, attemptId: row.id, actorType: "service", actorId: this.instanceId,
          eventType: "program.foreign_attempt_uncertain", metadata: { workPackageId: row.work_package_id, schedulerFence: claim.fencingToken }, createdAt: now });
      }
      if (rows.length) {
        const reservations = this.handle.connection.prepare("SELECT id,revision FROM budget_reservations WHERE program_id=? AND state IN ('created','active')").all(programId) as Array<{ id: string; revision: number }>;
        for (const reservation of reservations) this.ledger.markUncertain(reservation.id, reservation.revision, now);
      }
    }).immediate();
  }

  private recoverDispatchIntents(programId: string, now: string, claim: SchedulerClaim, assertCurrent: () => void): void {
    const rows = this.handle.connection.prepare(`SELECT request_id, metadata_json FROM audit_events s
      WHERE s.program_id=? AND s.event_type='program.work_dispatch_started'
      AND NOT EXISTS (SELECT 1 FROM audit_events t WHERE t.request_id=s.request_id
        AND t.event_type IN ('program.work_dispatched','program.work_dispatch_failed','program.work_dispatch_uncertain'))
      ORDER BY s.created_at, s.id`).all(programId) as Array<{ request_id: string; metadata_json: string }>;
    for (const row of rows) {
      assertCurrent();
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const dispatchId = row.request_id;
      const workPackageId = String(metadata.workPackageId ?? "");
      const agentId = String(metadata.agentId ?? "");
      const attemptId = String(metadata.attemptId ?? "");
      const reservationId = metadata.hasReservation === true ? String(metadata.reservationId ?? "") : undefined;
      const conflictKey = String(metadata.conflictKey ?? "");
      const binding = this.handle.connection.prepare("SELECT owner_id,scheduler_fencing_token FROM attempt_execution_owners WHERE attempt_id=?").get(attemptId) as { owner_id: string; scheduler_fencing_token: number } | undefined;
      const hasAttempt = this.handle.connection.prepare("SELECT 1 FROM work_package_attempts WHERE id=?").get(attemptId);
      if ((metadata.schedulerOwnerId && (metadata.schedulerOwnerId !== claim.ownerId || metadata.schedulerFence !== claim.fencingToken))
        || (hasAttempt && (!binding || binding.owner_id !== claim.ownerId || binding.scheduler_fencing_token !== claim.fencingToken))) {
        this.audit.append({ id: `audit-uncertain:${dispatchId}`, programId, requestId: dispatchId, actorType: "service",
          actorId: this.instanceId, eventType: "program.work_dispatch_uncertain", metadata: { dispatchId, workPackageId, attemptId, recovered: true }, createdAt: now });
        continue;
      }
      const candidate = conflictKey ? this.tasks.findTaskByConflictKey(conflictKey, attemptId) : undefined;
      const task = candidate?.executionContext?.attemptId === attemptId && candidate.executionContext.programId === programId
        && candidate.executionContext.workPackageId === workPackageId ? candidate : undefined;
      if (task) {
        this.audit.append({ id: `audit:${dispatchId}`, programId, attemptId, requestId: dispatchId, actorType: "service",
          actorId: "program-execution-coordinator", eventType: "program.work_dispatched",
          metadata: { dispatchId, workPackageId, taskId: task.id, agentId, ...(reservationId ? { reservationId } : {}), recovered: true }, createdAt: now });
        continue;
      }
      const attempt = this.handle.connection.prepare("SELECT fencing_token FROM work_package_attempts WHERE id=?").get(attemptId) as { fencing_token: number } | undefined;
      if (attempt) {
        this.handle.connection.transaction(() => {
          assertCurrent();
          this.handle.connection.prepare("UPDATE work_package_attempts SET status='uncertain',updated_at=? WHERE id=? AND status IN ('leased','running','verifying','checkpointed')").run(now, attemptId);
          this.handle.connection.prepare("DELETE FROM attempt_leases WHERE attempt_id=?").run(attemptId);
          const current = this.work.get(workPackageId);
          if (current && ["running", "verifying", "checkpointed"].includes(current.status)) this.work.transitionStatus(current.id, current.revision, "replanning_required", now);
          const reservation = reservationId ? this.ledger.getReservation(reservationId) : undefined;
          if (reservation && ["created", "active"].includes(reservation.state)) this.ledger.markUncertain(reservation.id, reservation.revision, now);
          this.audit.append({ id: `audit-uncertain:${dispatchId}`, programId, attemptId, requestId: dispatchId, actorType: "service", actorId: this.instanceId,
            eventType: "program.work_dispatch_uncertain", metadata: { dispatchId, workPackageId, recovered: true }, createdAt: now });
        }).immediate();
        continue;
      }
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

  private async reconcile(programId: string, now: string, assertCurrent: () => void): Promise<ProgramExecutionTickResult["reconciled"]> {
    const output: ProgramExecutionTickResult["reconciled"] = [];
    const events = this.handle.connection.prepare(`SELECT attempt_id, metadata_json FROM audit_events
      WHERE program_id=? AND event_type='program.work_dispatched' ORDER BY created_at, id`).all(programId) as Array<{ attempt_id: string | null; metadata_json: string }>;
    for (const event of events) {
      assertCurrent();
      const metadata = JSON.parse(event.metadata_json) as Record<string, unknown>;
      const taskId = typeof metadata.taskId === "string" ? metadata.taskId : undefined;
      const workPackageId = typeof metadata.workPackageId === "string" ? metadata.workPackageId : undefined;
      const agentId = typeof metadata.agentId === "string" ? metadata.agentId : undefined;
      const reservationId = typeof metadata.reservationId === "string" ? metadata.reservationId : undefined;
      if (!taskId || !workPackageId || !agentId || !event.attempt_id) continue;
      const candidate = this.tasks.getTask(taskId);
      const task = candidate?.executionContext?.attemptId === event.attempt_id && candidate.executionContext.programId === programId
        && candidate.executionContext.workPackageId === workPackageId ? candidate : undefined;
      const attempt = this.handle.connection.prepare(`SELECT a.status, a.fencing_token, l.expires_at FROM work_package_attempts a
        LEFT JOIN attempt_leases l ON l.attempt_id=a.id WHERE a.id=?`).get(event.attempt_id) as { status: string; fencing_token: number; expires_at: string | null } | undefined;
      const item = this.work.get(workPackageId);
      if (!attempt || !item) continue;
      if (!task) {
        if (["leased", "running", "checkpointed", "verifying"].includes(attempt.status)) {
          this.handle.connection.transaction(() => {
            assertCurrent();
            this.handle.connection.prepare("UPDATE work_package_attempts SET status='uncertain',updated_at=? WHERE id=?").run(now, event.attempt_id);
            this.handle.connection.prepare("DELETE FROM attempt_leases WHERE attempt_id=?").run(event.attempt_id);
            if (["running", "checkpointed", "verifying"].includes(item.status)) this.work.transitionStatus(item.id, item.revision, "replanning_required", now);
            const reservation = reservationId ? this.ledger.getReservation(reservationId) : undefined;
            if (reservation && ["created", "active"].includes(reservation.state)) this.ledger.markUncertain(reservation.id, reservation.revision, now);
            this.audit.append({ id: `missing-task:${event.attempt_id}`, programId, attemptId: event.attempt_id ?? undefined, actorType: "service", actorId: this.instanceId,
              eventType: "program.task_state_unavailable", metadata: { workPackageId, taskId }, createdAt: now });
          }).immediate();
          output.push({ workPackageId, taskId, status: "uncertain" });
        }
        continue;
      }
      if (["leased", "running"].includes(attempt.status) && (task.status === QueuedTaskStatusEnum.Paused || !attempt.expires_at || attempt.expires_at <= now)) {
        await this.runtime.reconcileAttempt?.(event.attempt_id);
        assertCurrent();
        this.handle.connection.transaction(() => {
          assertCurrent();
          this.handle.connection.prepare("UPDATE work_package_attempts SET status='uncertain', updated_at=? WHERE id=? AND status IN ('leased','running')").run(now, event.attempt_id);
          this.handle.connection.prepare("DELETE FROM attempt_leases WHERE attempt_id=?").run(event.attempt_id);
          const current = this.work.get(workPackageId);
          if (current?.status === "running") this.work.transitionStatus(current.id, current.revision, "replanning_required", now);
          const uncertainReservation = reservationId ? this.ledger.getReservation(reservationId) : undefined;
          if (uncertainReservation && ["created", "active"].includes(uncertainReservation.state)) this.ledger.markUncertain(uncertainReservation.id, uncertainReservation.revision, now);
        }).immediate();
        output.push({ workPackageId, taskId, status: "uncertain" });
        continue;
      }
      if ([QueuedTaskStatusEnum.Queued, QueuedTaskStatusEnum.Running, QueuedTaskStatusEnum.Waiting, QueuedTaskStatusEnum.ReviewPending].includes(task.status as QueuedTaskStatusEnum)
        && attempt.status === "running" && attempt.expires_at && attempt.expires_at > now) {
        this.leases.renew({ attemptId: event.attempt_id, ownerId: agentId, fencingToken: attempt.fencing_token, now, expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString() });
      } else if (task.status === QueuedTaskStatusEnum.Completed && attempt.status === "running") {
        this.handle.connection.transaction(() => {
          assertCurrent();
          this.leases.transition({ attemptId: event.attempt_id!, ownerId: agentId, fencingToken: attempt.fencing_token, now, status: "verifying" });
          if (item.status === "running") this.work.transitionStatus(item.id, item.revision, "verifying", now);
        }).immediate();
        output.push({ workPackageId, taskId, status: "verifying" });
      } else if ([QueuedTaskStatusEnum.Failed, QueuedTaskStatusEnum.Cancelled].includes(task.status as QueuedTaskStatusEnum) && ["leased", "running"].includes(attempt.status)) {
        await this.runtime.reconcileAttempt?.(event.attempt_id);
        assertCurrent();
        const attemptStatus = task.status === QueuedTaskStatusEnum.Cancelled ? "aborted" : "failed";
        this.handle.connection.transaction(() => {
          assertCurrent();
          this.leases.transition({ attemptId: event.attempt_id!, ownerId: agentId, fencingToken: attempt.fencing_token, now, status: attemptStatus });
          this.handle.connection.prepare("UPDATE work_package_attempts SET failure_json=? WHERE id=?")
            .run(JSON.stringify({ phase: "execution", reason: task.status }), event.attempt_id);
          if (item.status === "running") this.work.transitionStatus(item.id, item.revision, task.status === QueuedTaskStatusEnum.Cancelled ? "cancelled" : "failed", now);
          this.handle.connection.prepare("DELETE FROM attempt_leases WHERE attempt_id=?").run(event.attempt_id);
          const reservation = reservationId ? this.ledger.getReservation(reservationId) : undefined;
          if (reservation && ["created", "active", "uncertain", "expired"].includes(reservation.state)) {
            try { this.ledger.release(reservation.id, reservation.revision, now); }
            catch (error) {
              if (!(error instanceof BudgetLedgerError) || error.code !== "ACTIVE_CHILD_RESERVATIONS") throw error;
              if (["created", "active"].includes(reservation.state)) this.ledger.markUncertain(reservation.id, reservation.revision, now);
            }
          }
        }).immediate();
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
