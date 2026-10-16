import { createHash } from "node:crypto";
import { BudgetAccountRepository } from "../budget/budget-ledger";
import { addBudgetVectors, budgetVectorFits, subtractBudgetVectors, sumBudgetVectors } from "../budget/budget-types";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import { ExecutionBarrier } from "./execution-barrier";
import { PlanVersionRepository, ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { decideProgramBudgetMode } from "./budget-health";
import { PlanValidator } from "./plan-validator";
import { Replanner } from "./replanner";
import { PlanVersionSchema, WorkPackageSchema, type WorkPackage } from "./program-types";
import type { AcceptanceCriterionType } from "./acceptance-criteria";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const OPEN = ["planned", "blocked", "runnable", "failed", "replanning_required"];
const LIVE = ["leased", "running", "checkpointed", "verifying"];

/** Conservative replanning of approved definitions, with bounded retries. It
 * never asks a model to rewrite scope, acceptance or spending authority. */
export class ProgramLifecycleRuntime {
  private readonly work: WorkPackageRepository;
  private readonly programs: ProgramRepository;
  private readonly plans: PlanVersionRepository;
  private readonly audit: ExecutionAuditRepository;
  private readonly replanner: Replanner;

  constructor(private readonly handle: ExecutionDatabase,
    private readonly closeout: (programId: string, now: string, reason: string, assertCurrent?: () => void) => Promise<void>,
    private readonly options: { maxReplans?: number; validatorVersion?: (type: AcceptanceCriterionType) => string | undefined } = {}) {
    this.work = new WorkPackageRepository(handle); this.programs = new ProgramRepository(handle);
    this.plans = new PlanVersionRepository(handle); this.audit = new ExecutionAuditRepository(handle); this.replanner = new Replanner(handle);
  }

  async advance(programId: string, now: string, assertCurrent?: () => void): Promise<void> {
    assertCurrent?.();
    const program = this.programs.get(programId);
    if (!program) throw new Error("PROGRAM_NOT_FOUND");
    if (program.status === "closing_out") { await this.closeout(programId, now, "resume_closeout", assertCurrent); return; }
    if (program.status !== "running" || !program.activePlanVersionId || new ExecutionBarrier(this.handle).isFrozen(programId)) return;
    const plan = this.plans.get(program.activePlanVersionId)!;
    const packages = this.work.listByPlan(plan.id);
    if (!packages.length) return;
    this.observe(programId, plan.id, now, assertCurrent);
    const pending = packages.filter((item) => OPEN.includes(item.status));
    const failed = packages.filter((item) => ["failed", "replanning_required"].includes(item.status));
    const highImpactReplay = failed.some((item) => this.handle.connection.prepare(`SELECT 1 FROM effects e
      JOIN work_package_attempts a ON a.id=e.attempt_id JOIN work_packages w ON w.id=a.work_package_id
      WHERE w.program_id=? AND w.stable_key=? AND e.impact='high' AND e.state<>'cancelled' LIMIT 1`).get(programId, item.stableKey));
    const health = decideProgramBudgetMode(this.handle, { programId,
      projectedMandatoryRemaining: sumBudgetVectors(pending.filter((item) => item.mandatory).map((item) => item.hardEnvelope)) });
    const uncertain = this.handle.connection.prepare(`SELECT 1 FROM budget_reservations WHERE program_id=? AND state IN ('uncertain','expired')
      UNION ALL SELECT 1 FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id
      WHERE w.plan_version_id=? AND a.status IN ('uncertain','expired') LIMIT 1`).get(programId, plan.id);
    const expired = pending.some((item) => item.mandatory && item.deadlineAt && item.deadlineAt <= now);
    const allDone = packages.every((item) => ["completed", "cancelled"].includes(item.status));
    const optionalExhausted = !pending.some((item) => item.mandatory) && !packages.some((item) => LIVE.includes(item.status))
      && (pending.some((item) => item.deadlineAt && item.deadlineAt <= now) || !this.fitsPartitions(programId, pending));
    const failedLimit = failed.some((item) => Number(this.handle.connection.prepare(`SELECT COUNT(*) FROM work_package_attempts a
      JOIN work_packages w ON w.id=a.work_package_id WHERE w.program_id=? AND w.stable_key=? AND a.status='failed'`)
      .pluck().get(programId, item.stableKey)) >= 6);
    if (allDone || optionalExhausted || failedLimit || highImpactReplay || health.mode === "closeout" || expired || uncertain || !this.fitsPartitions(programId, pending.filter((item) => item.mandatory))) {
      await this.closeout(programId, now, allDone ? "work_finished" : highImpactReplay ? "high_impact_effect_before_failure" : failedLimit ? "retry_limit_reached" : uncertain ? "uncertain_execution" : expired ? "mandatory_deadline" : "execution_budget_exhausted", assertCurrent);
      return;
    }
    const count = Number(this.handle.connection.prepare("SELECT COALESCE(MAX(consecutive_count),0) FROM replan_failures WHERE program_id=?").pluck().get(programId));
    if (!failed.length) return;
    if (count < 2) {
      for (const item of failed) {
        if (!this.fitsPartitions(programId, [item])) continue;
        if (item.status === "replanning_required") continue; // uncertain work never retries automatically
        this.handle.connection.transaction(() => {
          assertCurrent?.();
          const current = this.work.get(item.id)!;
          if (current.status !== "failed") return;
          this.work.transitionStatus(current.id, current.revision, "runnable", now);
          this.record(programId, `retry:${item.id}:${current.revision}`, "program.work_retry_scheduled", { workPackageId: item.id }, now);
        }).immediate();
      }
      return;
    }
    // Switching plans while an old attempt is live would give two definitions
    // authority over the same workspace. Let existing work drain first.
    if (packages.some((item) => LIVE.includes(item.status))) return;
    const replans = Number(this.handle.connection.prepare("SELECT COUNT(*) FROM audit_events WHERE program_id=? AND event_type='program.plan_replanned'").pluck().get(programId));
    if (replans >= (this.options.maxReplans ?? 2)) { await this.closeout(programId, now, "replan_limit_reached", assertCurrent); return; }
    const completed = packages.filter((item) => item.status === "completed");
    if (completed.some((item) => !this.verifiedAttempt(item))) { await this.closeout(programId, now, "inherited_evidence_unavailable", assertCurrent); return; }
    if (!this.fitsPartitions(programId, pending.filter((item) => item.status !== "cancelled"))) {
      await this.closeout(programId, now, "replan_budget_unavailable", assertCurrent); return;
    }
    this.handle.connection.transaction(() => {
      assertCurrent?.();
      const current = this.programs.get(programId)!;
      new ExecutionBarrier(this.handle).assertAllowed(programId, program.executionEpoch);
      if (current.revision !== program.revision || current.activePlanVersionId !== plan.id || current.status !== "running") throw new Error("REPLAN_STALE_EXECUTION");
      const version = Number(this.handle.connection.prepare("SELECT MAX(version)+1 FROM plan_versions WHERE program_id=?").pluck().get(programId));
      const planId = `plan:${hash(`${programId}:${plan.id}:${version}`)}`;
      const ids = new Map(packages.map((item) => [item.id, `work:${hash(`${planId}:${item.stableKey}`)}`]));
      const proposed = packages.map((item) => WorkPackageSchema.parse({ ...item, id: ids.get(item.id), planVersionId: planId,
        dependsOn: item.dependsOn.map((id) => ids.get(id)!), status: item.status === "cancelled" ? "cancelled" : "planned",
        revision: 0, createdAt: now, updatedAt: now }));
      // Definitions and selected scope are unchanged: inheritance is the only
      // authority-free transformation; new scope must use the approval API.
      const decision = this.replanner.plan({ previous: packages, proposed, mode: "explore", failureCount: count });
      const next = PlanVersionSchema.parse({ id: planId, programId, version, parentVersionId: plan.id, reason: "failure", scopeTier: plan.scopeTier,
        status: "draft", workPackageIds: proposed.map((item) => item.id), createdBy: "program-replanner", revision: 0, createdAt: now });
      const valid = new PlanValidator().validate({ plan: next, workPackages: decision.retained });
      if (!valid.valid) throw new Error(`REPLAN_INVALID:${valid.issues.map((item) => item.code).join(",")}`);
      this.plans.create(next); this.work.createBatch(decision.retained);
      for (const item of completed) this.inheritEvidence(item, ids.get(item.id)!, now);
      const validated = this.plans.transitionStatus(next.id, next.revision, "validated");
      const replanning = this.programs.transitionStatus(programId, current.revision, "replanning", now);
      this.replanner.switchPlan({ programId, planVersionId: next.id, expectedProgramRevision: replanning.revision,
        expectedPlanRevision: validated.revision, selectedTier: plan.scopeTier, approvedAt: now });
      this.record(programId, `replanned:${next.id}`, "program.plan_replanned", { previousPlanId: plan.id, planVersionId: next.id,
        consecutiveFailures: count, inheritedCompleted: decision.inheritedCompleted, selectedTier: plan.scopeTier }, now);
    }).immediate();
  }

  private fitsPartitions(programId: string, packages: WorkPackage[]): boolean {
    const accounts = BudgetAccountRepository.from(this.handle).listByProgram(programId);
    return (["minimum", "upgrade_pool"] as const).every((kind) => {
      const items = packages.filter((item) => (item.scopeTier === "minimum") === (kind === "minimum"));
      if (!items.length) return true;
      const account = accounts.find((item) => item.kind === kind);
      if (!account) return false;
      return budgetVectorFits(sumBudgetVectors(items.map((item) => item.hardEnvelope)), subtractBudgetVectors(account.limit, addBudgetVectors(account.spent, account.reserved)));
    });
  }

  private observe(programId: string, planId: string, now: string, assertCurrent?: () => void): void {
    const attempts = this.handle.connection.prepare(`SELECT a.id,a.status,a.failure_json FROM work_package_attempts a
      JOIN work_packages w ON w.id=a.work_package_id WHERE w.plan_version_id=?
      AND a.status IN ('completed','failed','uncertain','expired') AND a.id NOT LIKE 'inherit:%' ORDER BY a.updated_at,a.id`)
      .all(planId) as Array<{ id: string; status: string; failure_json: string | null }>;
    this.handle.connection.transaction(() => {
      assertCurrent?.();
      for (const attempt of attempts) {
        const id = `observed:${hash(attempt.id)}`;
        if (this.audit.get(id)) continue;
        const failureClass = attempt.status === "failed" ? (attempt.failure_json && JSON.parse(attempt.failure_json).phase === "verification" ? "verification" : "execution") : attempt.status;
        if (attempt.status === "completed") this.handle.connection.prepare("DELETE FROM replan_failures WHERE program_id=?").run(programId);
        else this.replanner.recordFailure({ programId, failureClass, at: now });
        this.record(programId, id, "program.attempt_observed", { attemptId: attempt.id, status: attempt.status, failureClass }, now);
      }
    }).immediate();
  }

  private verifiedAttempt(item: WorkPackage): string | undefined {
    if (!item.acceptanceCriteria.length) return undefined;
    const attemptId = this.handle.connection.prepare("SELECT id FROM work_package_attempts WHERE work_package_id=? AND status='completed' ORDER BY attempt_number DESC LIMIT 1").pluck().get(item.id) as string | undefined;
    if (!attemptId) return undefined;
    return item.acceptanceCriteria.every((criterion) => {
      const evidence = this.handle.connection.prepare("SELECT criterion_type,passed,validator_version,artifact_digest,git_sha FROM verification_evidence WHERE work_package_id=? AND attempt_id=? AND criterion_id=?")
        .get(item.id, attemptId, criterion.id) as { criterion_type: string; passed: number; validator_version: string; artifact_digest: string | null; git_sha: string | null } | undefined;
      return evidence?.passed === 1 && evidence.criterion_type === criterion.type && Boolean(evidence.artifact_digest || evidence.git_sha)
        && (!this.options.validatorVersion || this.options.validatorVersion(criterion.type) === evidence.validator_version);
    }) ? attemptId : undefined;
  }

  private inheritEvidence(prior: WorkPackage, workId: string, now: string): void {
    const priorAttempt = this.verifiedAttempt(prior)!;
    const attemptId = `inherit:${hash(workId)}`;
    const program = this.programs.get(prior.programId)!;
    this.handle.connection.prepare(`INSERT INTO work_package_attempts(id,work_package_id,attempt_number,status,execution_epoch,fencing_token,created_at,updated_at)
      VALUES(?,?,1,'completed',?,1,?,?)`).run(attemptId, workId, program.executionEpoch, now, now);
    this.handle.connection.prepare(`INSERT INTO verification_evidence(id,program_id,work_package_id,attempt_id,criterion_id,criterion_type,passed,validator_version,artifact_digest,git_sha,evidence_path,details_json,created_at)
      SELECT 'inherit:' || id || ':' || ?, program_id, ?, ?, criterion_id,criterion_type,passed,validator_version,artifact_digest,git_sha,evidence_path,details_json,?
      FROM verification_evidence WHERE attempt_id=? AND work_package_id=?`).run(hash(workId).slice(0, 16), workId, attemptId, now, priorAttempt, prior.id);
    this.record(prior.programId, `inherited:${hash(workId)}`, "program.work_inherited", { workPackageId: workId, priorWorkPackageId: prior.id, priorAttemptId: priorAttempt, attemptId }, now);
  }

  private record(programId: string, id: string, eventType: string, metadata: Record<string, unknown>, now: string): void {
    this.audit.append({ id, programId, actorType: "service", actorId: "program-lifecycle", eventType, metadata, createdAt: now });
  }
}
