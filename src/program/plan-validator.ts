import { acceptanceCriteriaAreSufficient } from "./acceptance-criteria";
import { PlanVersionSchema, WorkPackageSchema, type PlanVersion, type ScopeTier, type WorkPackage } from "./program-types";
import { budgetVectorFits, isZeroBudgetVector, sumBudgetVectors, type BudgetVector } from "../budget/budget-types";

export type PlanValidationErrorCode =
  | "PLAN_WORK_SET_MISMATCH" | "WORK_OWNERSHIP" | "DUPLICATE_STABLE_KEY"
  | "DANGLING_DEPENDENCY" | "DEPENDENCY_CYCLE" | "INSUFFICIENT_ACCEPTANCE"
  | "EMPTY_HARD_ENVELOPE" | "TIER_ENVELOPE_EXCEEDED" | "TIER_DEPENDENCY_INVERSION" | "UNBOUNDED_PROMPT";

export interface PlanValidationIssue {
  code: PlanValidationErrorCode;
  path: string;
  message: string;
}

export interface PlanValidationResult {
  valid: boolean;
  issues: PlanValidationIssue[];
  topologicalOrder: string[];
}

const TIER_RANK: Record<ScopeTier, number> = { minimum: 0, standard: 1, stretch: 2 };

export class PlanValidator {
  validate(input: {
    plan: PlanVersion;
    workPackages: readonly WorkPackage[];
    availableByTier?: Partial<Record<ScopeTier, BudgetVector>>;
  }): PlanValidationResult {
    const plan = PlanVersionSchema.parse(input.plan);
    const packages = input.workPackages.map((workPackage) => WorkPackageSchema.parse(workPackage));
    const issues: PlanValidationIssue[] = [];
    const ids = new Set(packages.map((item) => item.id));
    const byId = new Map(packages.map((item) => [item.id, item]));
    if (ids.size !== packages.length || ids.size !== plan.workPackageIds.length || plan.workPackageIds.some((id) => !ids.has(id))) {
      issues.push({ code: "PLAN_WORK_SET_MISMATCH", path: "workPackageIds", message: "Plan workPackageIds must exactly match supplied packages" });
    }
    const stableKeys = new Set<string>();
    for (const item of packages) {
      if (item.programId !== plan.programId || item.planVersionId !== plan.id) {
        issues.push({ code: "WORK_OWNERSHIP", path: `workPackages.${item.id}`, message: "Work Package belongs to another Program or Plan" });
      }
      if (stableKeys.has(item.stableKey)) issues.push({ code: "DUPLICATE_STABLE_KEY", path: `workPackages.${item.id}.stableKey`, message: `Duplicate stableKey ${item.stableKey}` });
      stableKeys.add(item.stableKey);
      for (const dependency of item.dependsOn) {
        if (!ids.has(dependency)) issues.push({ code: "DANGLING_DEPENDENCY", path: `workPackages.${item.id}.dependsOn`, message: `Missing dependency ${dependency}` });
        const dependencyItem = byId.get(dependency);
        if (dependencyItem && TIER_RANK[dependencyItem.scopeTier] > TIER_RANK[item.scopeTier]) {
          issues.push({ code: "TIER_DEPENDENCY_INVERSION", path: `workPackages.${item.id}.dependsOn`, message: `${item.scopeTier} work cannot depend on ${dependencyItem.scopeTier} work` });
        }
      }
      if (item.mandatory && !acceptanceCriteriaAreSufficient(item.acceptanceCriteria)) {
        issues.push({ code: "INSUFFICIENT_ACCEPTANCE", path: `workPackages.${item.id}.acceptanceCriteria`, message: "Mandatory Work Package needs deterministic or human-verifiable acceptance" });
      }
      if (isZeroBudgetVector(item.hardEnvelope)) {
        issues.push({ code: "EMPTY_HARD_ENVELOPE", path: `workPackages.${item.id}.hardEnvelope`, message: "Work Package hard envelope must be non-zero" });
      }
      if (/continue\s+(until|forever)|直到.*(完成|做好)/iu.test(item.prompt)) {
        issues.push({ code: "UNBOUNDED_PROMPT", path: `workPackages.${item.id}.prompt`, message: "Prompt contains an unbounded continuation instruction" });
      }
    }

    const topologicalOrder: string[] = [];
    const state = new Map<WorkPackage["id"], 0 | 1 | 2>();
    const visit = (id: WorkPackage["id"]): void => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) {
        issues.push({ code: "DEPENDENCY_CYCLE", path: `workPackages.${id}.dependsOn`, message: "Dependency graph contains a cycle" });
        return;
      }
      state.set(id, 1);
      for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) visit(dependency);
      state.set(id, 2);
      topologicalOrder.push(id);
    };
    for (const item of packages) visit(item.id);

    for (const tier of ["minimum", "standard", "stretch"] as const) {
      const available = input.availableByTier?.[tier];
      if (!available) continue;
      const required = sumBudgetVectors(packages
        .filter((item) => TIER_RANK[item.scopeTier] <= TIER_RANK[tier])
        .map((item) => item.hardEnvelope));
      if (!budgetVectorFits(required, available)) issues.push({
        code: "TIER_ENVELOPE_EXCEEDED", path: `availableByTier.${tier}`,
        message: `${tier} Work Packages exceed the tier envelope`,
      });
    }
    return { valid: issues.length === 0, issues, topologicalOrder };
  }
}
