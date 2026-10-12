import { addBudgetVectors, budgetVectorFits, type BudgetVector } from "../budget/budget-types";
import type { ScopeTier, WorkPackage } from "./program-types";

export type BudgetMode = "explore" | "balanced" | "commit" | "closeout";
export type SchedulerBlockReason = "PROGRAM_NOT_RUNNING" | "PLAN_NOT_ACTIVE" | "TIER_DISABLED" | "DEPENDENCY" |
  "NOT_BEFORE" | "DEADLINE" | "CONFLICT" | "CONCURRENCY" | "AGENT_UNAVAILABLE" | "BUDGET" | "STATUS";

export interface SchedulerCandidate { workPackage: WorkPackage; blockedBy: SchedulerBlockReason[] }

const RANK: Record<ScopeTier, number> = { minimum: 0, standard: 1, stretch: 2 };

export class PlanScheduler {
  select(input: {
    packages: readonly WorkPackage[];
    programRunning: boolean;
    planActive: boolean;
    selectedTier: ScopeTier;
    mode: BudgetMode;
    now: string;
    maxConcurrency: number;
    executionAvailable: BudgetVector;
    agentAvailable: (workPackage: WorkPackage) => boolean;
  }): { selected: WorkPackage[]; candidates: SchedulerCandidate[] } {
    const active = input.packages.filter((item) => ["leased", "running", "checkpointed", "verifying"].includes(item.status));
    const completed = new Set(input.packages.filter((item) => item.status === "completed").map((item) => item.id));
    const heldKeys = new Set(active.flatMap((item) => item.conflictKeys));
    const remainingSlots = Math.max(0, input.maxConcurrency - active.length);
    let committed: BudgetVector = {};
    const permittedTier = input.mode === "explore" ? input.selectedTier : input.mode === "balanced" ? (RANK[input.selectedTier] > 1 ? "standard" : input.selectedTier) : "minimum";
    const ordered = [...input.packages].sort((left, right) =>
      right.priority - left.priority ||
      (left.deadlineAt ? Date.parse(left.deadlineAt) : Number.MAX_SAFE_INTEGER) - (right.deadlineAt ? Date.parse(right.deadlineAt) : Number.MAX_SAFE_INTEGER) ||
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
    const selected: WorkPackage[] = [];
    const candidates: SchedulerCandidate[] = [];
    for (const item of ordered) {
      const blockedBy: SchedulerBlockReason[] = [];
      if (!input.programRunning) blockedBy.push("PROGRAM_NOT_RUNNING");
      if (!input.planActive) blockedBy.push("PLAN_NOT_ACTIVE");
      if (input.mode === "closeout" || RANK[item.scopeTier] > RANK[permittedTier] || (input.mode === "commit" && !item.mandatory)) blockedBy.push("TIER_DISABLED");
      if (!item.dependsOn.every((id) => completed.has(id))) blockedBy.push("DEPENDENCY");
      if (item.notBefore && Date.parse(item.notBefore) > Date.parse(input.now)) blockedBy.push("NOT_BEFORE");
      if (item.deadlineAt && Date.parse(item.deadlineAt) <= Date.parse(input.now)) blockedBy.push("DEADLINE");
      if (item.conflictKeys.some((key) => heldKeys.has(key))) blockedBy.push("CONFLICT");
      if (selected.length >= remainingSlots) blockedBy.push("CONCURRENCY");
      if (!input.agentAvailable(item)) blockedBy.push("AGENT_UNAVAILABLE");
      if (!budgetVectorFits(addBudgetVectors(committed, item.hardEnvelope), input.executionAvailable)) blockedBy.push("BUDGET");
      if (item.status !== "runnable") blockedBy.push("STATUS");
      if (blockedBy.length === 0) {
        selected.push(item);
        committed = addBudgetVectors(committed, item.hardEnvelope);
        for (const key of item.conflictKeys) heldKeys.add(key);
      }
      candidates.push({ workPackage: item, blockedBy });
    }
    return { selected, candidates };
  }
}
