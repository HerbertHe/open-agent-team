import type { ExecutionDatabase } from "./execution-database";
import type { BudgetMode } from "./plan-scheduler";
import type { WorkPackage } from "./program-types";
import { PlanActivationService } from "./plan-activation-service";
import { isDeepStrictEqual } from "node:util";

export interface ReplanDecision {
  shouldReplan: boolean;
  consecutiveFailures: number;
  inheritedCompleted: string[];
  retained: WorkPackage[];
  cancelled: string[];
}

export class Replanner {
  constructor(private readonly handle: ExecutionDatabase, private readonly threshold = 2) {}

  recordFailure(input: { programId: string; failureClass: string; at: string }): number {
    return this.handle.connection.transaction(() => {
      this.handle.connection.prepare("DELETE FROM replan_failures WHERE program_id=? AND failure_class<>?").run(input.programId, input.failureClass);
      this.handle.connection.prepare(`INSERT INTO replan_failures(program_id,failure_class,consecutive_count,last_failure_at)
        VALUES(?,?,1,?) ON CONFLICT(program_id,failure_class) DO UPDATE SET consecutive_count=consecutive_count+1,last_failure_at=excluded.last_failure_at`)
        .run(input.programId, input.failureClass, new Date(input.at).toISOString());
      return Number(this.handle.connection.prepare("SELECT consecutive_count FROM replan_failures WHERE program_id=? AND failure_class=?").pluck().get(input.programId, input.failureClass));
    }).immediate();
  }

  resetFailure(input: { programId: string; failureClass: string }): void {
    this.handle.connection.prepare("DELETE FROM replan_failures WHERE program_id=? AND failure_class=?").run(input.programId, input.failureClass);
  }

  switchPlan(input: { programId: string; planVersionId: string; expectedProgramRevision: number; expectedPlanRevision: number; selectedTier: "minimum" | "standard" | "stretch"; approvedAt: string }): void {
    const program = this.handle.connection.prepare("SELECT status FROM programs WHERE id=?").get(input.programId) as { status: string } | undefined;
    if (program?.status !== "replanning") throw new Error("PROGRAM_NOT_REPLANNING");
    const inheritedWithoutEvidence = this.handle.connection.prepare(`SELECT wp.id FROM work_packages wp
      WHERE wp.plan_version_id=? AND wp.status='completed' AND NOT EXISTS (
        SELECT 1 FROM work_package_attempts a WHERE a.work_package_id=wp.id AND a.status='completed'
        AND EXISTS (SELECT 1 FROM acceptance_criteria ac WHERE ac.work_package_id=wp.id)
        AND NOT EXISTS (SELECT 1 FROM acceptance_criteria ac WHERE ac.work_package_id=wp.id AND NOT EXISTS (
          SELECT 1 FROM verification_evidence ve WHERE ve.attempt_id=a.id AND ve.work_package_id=wp.id AND ve.criterion_id=ac.id
          AND ve.criterion_type=ac.type AND ve.passed=1 AND (ve.artifact_digest IS NOT NULL OR ve.git_sha IS NOT NULL)
        ))
      ) LIMIT 1`).pluck().get(input.planVersionId) as string | undefined;
    if (inheritedWithoutEvidence) throw new Error(`INHERITED_COMPLETION_UNVERIFIED:${inheritedWithoutEvidence}`);
    new PlanActivationService(this.handle).activate(input);
    this.handle.connection.prepare("DELETE FROM replan_failures WHERE program_id=?").run(input.programId);
  }

  plan(input: { previous: readonly WorkPackage[]; proposed: readonly WorkPackage[]; mode: BudgetMode; failureCount: number }): ReplanDecision {
    const previousByKey = new Map(input.previous.map((item) => [item.stableKey, item]));
    const inheritedCompleted: string[] = [];
    const cancelled: string[] = [];
    const retained: WorkPackage[] = [];
    for (const candidate of input.proposed) {
      const prior = previousByKey.get(candidate.stableKey);
      if (prior?.status === "completed" && isDeepStrictEqual(prior.acceptanceCriteria, candidate.acceptanceCriteria)) {
        inheritedCompleted.push(candidate.id);
        retained.push({ ...candidate, status: "completed" });
        continue;
      }
      const disabled = input.mode === "closeout" || (input.mode !== "explore" && candidate.scopeTier === "stretch") ||
        (input.mode === "commit" && (!candidate.mandatory || candidate.scopeTier !== "minimum"));
      if (disabled) cancelled.push(candidate.id);
      else retained.push(candidate);
    }
    return { shouldReplan: input.failureCount >= this.threshold, consecutiveFailures: input.failureCount, inheritedCompleted, retained, cancelled };
  }
}
