import { addBudgetVectors, budgetVectorFits, type BudgetVector } from "../budget/budget-types";
import type { WorkPackageCostEstimate } from "./cost-estimator";
import { z } from "zod";

export interface AdmissionWorkItem {
  id: string;
  dependsOn: string[];
  estimate: WorkPackageCostEstimate;
}

export const AdmissionDecisionSchema = z.object({
  calibrated: z.boolean(), feasible: z.boolean(), requiresHumanApproval: z.boolean(),
  jointProbability: z.number().min(0).max(1).optional(), budgetProbability: z.number().min(0).max(1).optional(),
  deadlineProbability: z.number().min(0).max(1).optional(), acceptanceProbability: z.number().min(0).max(1).optional(),
  targetProbability: z.number().positive().max(1), samples: z.number().int().positive(), seed: z.string().min(1).max(256),
}).strict();
export type AdmissionDecision = z.infer<typeof AdmissionDecisionSchema>;

function seedFromString(value: string): number {
  let hash = 2166136261;
  for (const character of value) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function randomGenerator(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function interpolate(p50: number, p90: number, hardMax: number, value: number): number {
  if (value <= 0.5) return Math.ceil(p50 * value / 0.5);
  if (value <= 0.9) return Math.ceil(p50 + (p90 - p50) * (value - 0.5) / 0.4);
  return Math.ceil(p90 + (hardMax - p90) * (value - 0.9) / 0.1);
}

function sampleVector(estimate: WorkPackageCostEstimate, value: number): BudgetVector {
  const output: BudgetVector = {};
  for (const key of ["moneyMicros", "inputTokens", "outputTokens", "modelCalls", "toolCalls"] as const) {
    const sampled = interpolate(estimate.p50[key] ?? 0, estimate.p90[key] ?? 0, estimate.hardMax[key] ?? 0, value);
    if (sampled > 0) output[key] = sampled;
  }
  const external: Record<string, number> = {};
  for (const key of Object.keys(estimate.hardMax.externalUnits ?? {})) {
    const sampled = interpolate(
      estimate.p50.externalUnits?.[key] ?? 0,
      estimate.p90.externalUnits?.[key] ?? 0,
      estimate.hardMax.externalUnits?.[key] ?? 0,
      value,
    );
    if (sampled > 0) external[key] = sampled;
  }
  if (Object.keys(external).length) output.externalUnits = external;
  return output;
}

export class AdmissionController {
  evaluate(input: {
    workItems: readonly AdmissionWorkItem[];
    budgetLimit: BudgetVector;
    fixedBudget?: BudgetVector;
    deadlineSeconds?: number;
    fixedDurationSeconds?: number;
    targetProbability: number;
    samples?: number;
    seed: string;
  }): AdmissionDecision {
    const samples = input.samples ?? 10_000;
    if (!Number.isSafeInteger(samples) || samples < 100) throw new RangeError("samples must be at least 100");
    if (!(input.targetProbability > 0 && input.targetProbability <= 1)) throw new RangeError("targetProbability must be in (0,1]");
    const byId = new Map(input.workItems.map((item) => [item.id, item]));
    if (byId.size !== input.workItems.length) throw new Error("Admission work item IDs must be unique");
    for (const item of input.workItems) for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`Admission item ${item.id} has missing dependency ${dependency}`);
    }
    const visiting = new Set<string>(); const visited = new Set<string>(); const ordered: AdmissionWorkItem[] = [];
    const visit = (item: AdmissionWorkItem): void => {
      if (visited.has(item.id)) return;
      if (visiting.has(item.id)) throw new Error(`Admission dependency cycle at ${item.id}`);
      visiting.add(item.id);
      for (const dependency of item.dependsOn) visit(byId.get(dependency)!);
      visiting.delete(item.id); visited.add(item.id); ordered.push(item);
    };
    for (const item of input.workItems) visit(item);
    if (input.workItems.some((item) => item.estimate.confidence === "uncalibrated")) {
      return { calibrated: false, feasible: false, requiresHumanApproval: true, targetProbability: input.targetProbability, samples, seed: input.seed };
    }
    const random = randomGenerator(seedFromString(input.seed));
    let budgetPass = 0;
    let deadlinePass = 0;
    let acceptancePass = 0;
    let jointPass = 0;
    for (let sample = 0; sample < samples; sample++) {
      const groupFactors = new Map<string, number>();
      let total = input.fixedBudget ?? {};
      const finishes = new Map<string, number>();
      let accepted = true;
      for (const item of ordered) {
        const group = item.estimate.riskGroup;
        const shared = groupFactors.get(group) ?? random();
        groupFactors.set(group, shared);
        const correlated = Math.min(1, 0.7 * shared + 0.3 * random());
        total = addBudgetVectors(total, sampleVector(item.estimate, correlated));
        const start = Math.max(0, ...item.dependsOn.map((dependency) => finishes.get(dependency) ?? 0));
        const duration = interpolate(
          item.estimate.durationSeconds.p50,
          item.estimate.durationSeconds.p90,
          item.estimate.durationSeconds.hardMax,
          correlated,
        );
        finishes.set(item.id, start + duration);
        const successDraw = Math.min(1, 0.7 * shared + 0.3 * random());
        if (successDraw > item.estimate.successProbability) accepted = false;
      }
      const withinBudget = budgetVectorFits(total, input.budgetLimit);
      const finish = (input.fixedDurationSeconds ?? 0) + Math.max(0, ...finishes.values());
      const withinDeadline = input.deadlineSeconds === undefined || finish <= input.deadlineSeconds;
      if (withinBudget) budgetPass++;
      if (withinDeadline) deadlinePass++;
      if (accepted) acceptancePass++;
      if (withinBudget && withinDeadline && accepted) jointPass++;
    }
    const jointProbability = jointPass / samples;
    return {
      calibrated: true,
      feasible: jointProbability >= input.targetProbability,
      requiresHumanApproval: false,
      jointProbability,
      budgetProbability: budgetPass / samples,
      deadlineProbability: deadlinePass / samples,
      acceptanceProbability: acceptancePass / samples,
      targetProbability: input.targetProbability,
      samples,
      seed: input.seed,
    };
  }
}
