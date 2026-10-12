import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import { AdmissionDecisionSchema, type AdmissionDecision } from "./admission-controller";
import { WorkPackageCostEstimateSchema, type WorkPackageCostEstimate } from "./cost-estimator";
import { PlanVersionIdSchema, ScopeTierSchema, WorkPackageIdSchema, type ScopeTier } from "./program-types";

export class PlanningArtifactConflictError extends Error {
  readonly code = "PLANNING_ARTIFACT_CONFLICT";
}

export class PlanningArtifactRepository {
  private readonly database: Database.Database;
  constructor(handle: ExecutionDatabase) { this.database = handle.connection; }

  saveEstimate(estimateInput: WorkPackageCostEstimate, createdAt: string): WorkPackageCostEstimate {
    const estimate = WorkPackageCostEstimateSchema.parse(estimateInput);
    WorkPackageIdSchema.parse(estimate.workPackageId);
    const result = this.database.prepare(`INSERT INTO work_package_estimates(work_package_id, estimate_json, estimator_version, created_at)
      VALUES(?, ?, ?, ?) ON CONFLICT(work_package_id) DO NOTHING`)
      .run(estimate.workPackageId, JSON.stringify(estimate), estimate.estimatorVersion, new Date(createdAt).toISOString());
    if (result.changes === 0 && !isDeepStrictEqual(this.getEstimate(estimate.workPackageId), estimate)) {
      throw new PlanningArtifactConflictError(`Estimate for ${estimate.workPackageId} is immutable`);
    }
    return estimate;
  }

  getEstimate(workPackageId: string): WorkPackageCostEstimate | undefined {
    const json = this.database.prepare("SELECT estimate_json FROM work_package_estimates WHERE work_package_id = ?").pluck().get(WorkPackageIdSchema.parse(workPackageId)) as string | undefined;
    return json ? WorkPackageCostEstimateSchema.parse(JSON.parse(json) as unknown) : undefined;
  }

  saveAdmissionDecision(input: { planVersionId: string; scopeTier: ScopeTier; decision: AdmissionDecision; createdAt: string }): AdmissionDecision {
    const planVersionId = PlanVersionIdSchema.parse(input.planVersionId); const scopeTier = ScopeTierSchema.parse(input.scopeTier);
    const decision = AdmissionDecisionSchema.parse(input.decision);
    const id = `admission:${createHash("sha256").update(`${planVersionId}:${scopeTier}`).digest("hex")}`;
    const result = this.database.prepare(`INSERT INTO admission_decisions(id, plan_version_id, scope_tier, seed, decision_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(plan_version_id, scope_tier) DO NOTHING`)
      .run(id, planVersionId, scopeTier, decision.seed, JSON.stringify(decision), new Date(input.createdAt).toISOString());
    if (result.changes === 0 && !isDeepStrictEqual(this.getAdmissionDecision(planVersionId, scopeTier), decision)) {
      throw new PlanningArtifactConflictError(`Admission decision for ${planVersionId}/${scopeTier} is immutable`);
    }
    return decision;
  }

  getAdmissionDecision(planVersionId: string, scopeTier: ScopeTier): AdmissionDecision | undefined {
    const json = this.database.prepare("SELECT decision_json FROM admission_decisions WHERE plan_version_id = ? AND scope_tier = ?")
      .pluck().get(PlanVersionIdSchema.parse(planVersionId), ScopeTierSchema.parse(scopeTier)) as string | undefined;
    return json ? AdmissionDecisionSchema.parse(JSON.parse(json) as unknown) : undefined;
  }
}
