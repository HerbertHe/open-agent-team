import { assertAttemptSchedulerOwnership } from "./scheduler-ownership";
import { randomUUID } from "node:crypto";
import { QueuedTaskStatusEnum, type QueuedTask } from "../types";
import { simpleGit } from "simple-git";
import type { ExecutionDatabase } from "./execution-database";
import { BudgetLedger, BudgetLedgerError } from "../budget/budget-ledger";
import { ExecutionBarrier } from "./execution-barrier";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import { ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { LeaseService } from "./lease-service";
import { VerificationService } from "./verification-service";
import { createDefaultAcceptanceValidators } from "./default-acceptance-validators";
import type { AcceptanceValidatorRegistry } from "./acceptance-criteria";
import { CloseoutService } from "./closeout-service";
import type { WorkPackage, WorkPackageStatus } from "./program-types";

export class ProgramVerificationRuntime {
  private readonly inFlight = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly work: WorkPackageRepository;
  private readonly ledger: BudgetLedger;
  private readonly audit: ExecutionAuditRepository;
  constructor(private readonly handle: ExecutionDatabase, private readonly getTask: (id: string) => QueuedTask | undefined,
    private readonly workspaceForTask: (task: QueuedTask) => string | undefined,
    private readonly reconcileAttempt: (attemptId: string) => Promise<void>,
    private readonly validators: AcceptanceValidatorRegistry = createDefaultAcceptanceValidators(),
    private readonly clock = () => new Date().toISOString(), private readonly options: { autoCloseout?: boolean } = {}) {
    this.work = new WorkPackageRepository(handle); this.ledger = BudgetLedger.from(handle); this.audit = new ExecutionAuditRepository(handle);
  }

  private transition(item: WorkPackage, status: WorkPackageStatus, now: string): void {
    this.work.transitionStatus(item.id, item.revision, status, now, { outboxEvents: [{ id: `evt:${randomUUID()}`,
      dedupeKey: `verification:${item.id}:${item.revision}:${status}`, aggregateType: "work_package", aggregateId: item.id,
      eventType: "work_package.projected", payload: { workPackageId: item.id, programId: item.programId, title: item.title, status, updatedAt: now },
      availableAt: now, createdAt: now }] });
  }

  advance(programId: string, assertScheduler?: () => void): Promise<void> {
    const current = this.inFlight.get(programId);
    if (current) return current.done;
    const controller = new AbortController();
    const done = this.run(programId, controller.signal, assertScheduler).finally(() => { this.inFlight.delete(programId); });
    this.inFlight.set(programId, { controller, done });
    return done;
  }

  async cancel(programId: string): Promise<void> {
    const current = this.inFlight.get(programId);
    current?.controller.abort();
    await current?.done;
  }

  async cancelAll(): Promise<void> { await Promise.all([...this.inFlight.keys()].map((id) => this.cancel(id))); }

  private async run(programId: string, signal: AbortSignal, assertScheduler?: () => void): Promise<void> {
    const programs = new ProgramRepository(this.handle);
    const program = programs.get(programId);
    if (program?.status !== "running" || !program.activePlanVersionId || new ExecutionBarrier(this.handle).isFrozen(programId)) return;
    const events = this.handle.connection.prepare(`SELECT attempt_id,metadata_json FROM audit_events WHERE program_id=? AND event_type='program.work_dispatched' ORDER BY created_at,id`)
      .all(programId) as Array<{ attempt_id: string; metadata_json: string }>;
    for (const event of events) {
      const metadata = JSON.parse(event.metadata_json) as { taskId: string; workPackageId: string; agentId: string; reservationId?: string };
      const item = this.work.get(metadata.workPackageId);
      if (item?.status !== "verifying" || item.planVersionId !== program.activePlanVersionId) continue;
      const task = this.getTask(metadata.taskId);
      if (task?.status !== QueuedTaskStatusEnum.Completed) continue;
      if (task.executionContext?.programId !== programId || task.executionContext.workPackageId !== item.id
        || task.executionContext.attemptId !== event.attempt_id) continue;
      const workspacePath = task && this.workspaceForTask(task);
      const attempt = this.handle.connection.prepare("SELECT execution_epoch,fencing_token,status FROM work_package_attempts WHERE id=?").get(event.attempt_id) as
        { execution_epoch: number; fencing_token: number; status: string } | undefined;
      if (!attempt || attempt.status !== "verifying" || attempt.execution_epoch !== program.executionEpoch) continue;
      const assertCurrent = () => {
        assertScheduler?.();
        assertAttemptSchedulerOwnership(this.handle.connection, event.attempt_id, programId, this.clock());
        if (signal.aborted) throw new Error("VERIFICATION_ABORTED");
        new ExecutionBarrier(this.handle).assertAllowed(programId, attempt.execution_epoch);
        const current = programs.get(programId);
        const valid = this.handle.connection.prepare(`SELECT 1 FROM work_package_attempts a JOIN attempt_leases l ON l.attempt_id=a.id
          WHERE a.id=? AND a.status='verifying' AND a.execution_epoch=? AND a.fencing_token=? AND l.fencing_token=? AND l.owner_id=? AND l.expires_at>?`)
          .get(event.attempt_id, attempt.execution_epoch, attempt.fencing_token, attempt.fencing_token, metadata.agentId, this.clock());
        if (!valid || current?.status !== "running" || current.executionEpoch !== attempt.execution_epoch || current.activePlanVersionId !== item.planVersionId
          || this.work.get(item.id)?.status !== "verifying") throw new Error("VERIFICATION_STALE_EXECUTION");
      };
      try {
        assertCurrent();
        new LeaseService(this.handle).renew({ attemptId: event.attempt_id, ownerId: metadata.agentId, fencingToken: attempt.fencing_token,
          now: this.clock(), expiresAt: new Date(Date.parse(this.clock()) + 15 * 60_000).toISOString() });
        if (!workspacePath) throw new Error("VERIFICATION_WORKSPACE_UNAVAILABLE");
        if (!item.acceptanceCriteria.length) throw new Error("VERIFICATION_CRITERIA_MISSING");
        if (item.acceptanceCriteria.some((criterion) => !this.validators.versionFor(criterion.type))) throw new Error("VERIFICATION_VALIDATOR_UNAVAILABLE");
        await this.reconcileAttempt(event.attempt_id);
        const gitSha = await simpleGit(workspacePath).revparse(["HEAD"]).then((sha) => sha.trim()).catch(() => undefined);
        if (task.git?.headSha && task.git.headSha !== gitSha) throw new Error("VERIFICATION_WORKSPACE_HEAD_CHANGED");
        const result = await new VerificationService(this.handle, this.validators).verify({ programId, workPackageId: item.id, attemptId: event.attempt_id,
          criteria: item.acceptanceCriteria, workspacePath, createdAt: this.clock(), assertCurrent, signal, gitSha });
        if (gitSha && await simpleGit(workspacePath).revparse(["HEAD"]).then((sha) => sha.trim()).catch(() => undefined) !== gitSha) throw new Error("VERIFICATION_WORKSPACE_HEAD_CHANGED");
        this.handle.connection.transaction(() => {
          assertCurrent();
          const now = this.clock();
          const status = result.passed ? "completed" : "failed";
          new LeaseService(this.handle).transition({ attemptId: event.attempt_id, ownerId: metadata.agentId, fencingToken: attempt.fencing_token, now, status });
          if (!result.passed) this.handle.connection.prepare("UPDATE work_package_attempts SET failure_json=? WHERE id=?")
            .run(JSON.stringify({ phase: "verification" }), event.attempt_id);
          const current = this.work.get(item.id)!;
          this.transition(current, status, now);
          this.handle.connection.prepare("DELETE FROM attempt_leases WHERE attempt_id=?").run(event.attempt_id);
          const reservation = metadata.reservationId ? this.ledger.getReservation(metadata.reservationId) : undefined;
          if (reservation && ["created", "active"].includes(reservation.state)) {
            try { this.ledger.release(reservation.id, reservation.revision, now); }
            catch (error) {
              if (!(error instanceof BudgetLedgerError) || error.code !== "ACTIVE_CHILD_RESERVATIONS") throw error;
              this.ledger.markUncertain(reservation.id, reservation.revision, now);
            }
          }
          this.audit.append({ id: `verification:${randomUUID()}`, programId, attemptId: event.attempt_id, actorType: "service", actorId: "program-verifier",
            eventType: "program.work_verified", metadata: { workPackageId: item.id, passed: result.passed }, createdAt: now });
        }).immediate();
      } catch (error) {
        if (error instanceof Error && error.message === "VERIFICATION_CONTAINER_NOT_QUIESCENT") throw error;
        // Unsupported/unavailable evidence and interrupted verification never imply success.
        const auditId = `verification-blocked:${event.attempt_id}`;
        if (!this.audit.get(auditId)) this.audit.append({ id: auditId, programId, attemptId: event.attempt_id, actorType: "service",
          actorId: "program-verifier", eventType: "program.verification_blocked", reason: error instanceof Error ? error.message : String(error), createdAt: this.clock() });
      }
    }
    this.handle.connection.transaction(() => {
      assertScheduler?.();
      const current = programs.get(programId);
      if (signal.aborted || new ExecutionBarrier(this.handle).isFrozen(programId)) return;
      if (current?.status !== "running" || current.executionEpoch !== program.executionEpoch || current.activePlanVersionId !== program.activePlanVersionId) return;
      new ExecutionBarrier(this.handle).assertAllowed(programId, program.executionEpoch);
      let packages = this.work.listByPlan(program.activePlanVersionId!);
      const completed = new Set(packages.filter((item) => item.status === "completed").map((item) => item.id));
      for (const item of packages) if (["planned", "blocked"].includes(item.status) && item.dependsOn.length > 0 && item.dependsOn.every((id) => completed.has(id))) {
        this.transition(item, "runnable", this.clock());
      }
      packages = this.work.listByPlan(program.activePlanVersionId!);
      const unresolvedEffects = this.handle.connection.prepare("SELECT 1 FROM effects WHERE program_id=? AND state IN ('prepared','dispatched','uncertain') LIMIT 1").get(programId);
      if (unresolvedEffects) return;
      if (this.options.autoCloseout !== false && packages.length && packages.every((item) => ["completed", "cancelled"].includes(item.status)) && packages.some((item) => item.mandatory && item.status === "completed")) {
        new CloseoutService(this.handle).close(programId, this.clock());
      }
    }).immediate();
  }
}
