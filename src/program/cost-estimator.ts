import { z } from "zod";
import type { CostBaseline } from "../budget/cost-baseline";
import { BudgetVectorSchema, budgetVectorFits, type BudgetVector } from "../budget/budget-types";
import { WorkPackageSchema, type WorkPackage } from "./program-types";

export const ScalarCostIntervalSchema = z.object({
  p50: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  p90: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  p95: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hardMax: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((value) => value.p50 <= value.p90 && value.p90 <= value.p95 && value.p95 <= value.hardMax, {
  message: "Cost interval percentiles must be monotonic",
});
export type ScalarCostInterval = z.infer<typeof ScalarCostIntervalSchema>;

export const WorkPackageCostEstimateSchema = z.object({
  workPackageId: z.string().trim().min(1).max(128),
  p50: BudgetVectorSchema, p90: BudgetVectorSchema, p95: BudgetVectorSchema, hardMax: BudgetVectorSchema,
  durationSeconds: ScalarCostIntervalSchema,
  confidence: z.enum(["uncalibrated", "low", "medium", "high"]),
  sampleSize: z.number().int().nonnegative(), estimatorVersion: z.string().trim().min(1).max(128),
  riskGroup: z.string().trim().min(1).max(128), successProbability: z.number().positive().max(1),
}).strict();
export type WorkPackageCostEstimate = z.infer<typeof WorkPackageCostEstimateSchema>;

function scaleVector(vector: BudgetVector, numerator: number, denominator = 100): BudgetVector {
  const scale = (value: number) => Number((BigInt(value) * BigInt(numerator) + BigInt(denominator - 1)) / BigInt(denominator));
  const output: BudgetVector = {};
  for (const key of ["moneyMicros", "inputTokens", "outputTokens", "modelCalls", "toolCalls"] as const) {
    if (vector[key] !== undefined) output[key] = scale(vector[key]!);
  }
  if (vector.externalUnits) output.externalUnits = Object.fromEntries(Object.entries(vector.externalUnits).map(([key, value]) => [key, scale(value)]));
  return BudgetVectorSchema.parse(output);
}

function maxVector(left: BudgetVector, right: BudgetVector): BudgetVector {
  const output: BudgetVector = {};
  for (const key of ["moneyMicros", "inputTokens", "outputTokens", "modelCalls", "toolCalls"] as const) {
    const value = Math.max(left[key] ?? 0, right[key] ?? 0);
    if (value > 0) output[key] = value;
  }
  const external: Record<string, number> = {};
  for (const key of new Set([...Object.keys(left.externalUnits ?? {}), ...Object.keys(right.externalUnits ?? {})])) {
    const value = Math.max(left.externalUnits?.[key] ?? 0, right.externalUnits?.[key] ?? 0);
    if (value > 0) external[key] = value;
  }
  if (Object.keys(external).length) output.externalUnits = external;
  return BudgetVectorSchema.parse(output);
}

export class WorkPackageCostEstimator {
  constructor(readonly estimatorVersion = "work-package-cost-v1") {}

  estimate(input: {
    workPackage: WorkPackage;
    baseline?: CostBaseline;
    durationHintSeconds?: number;
    riskGroup?: string;
    successProbability?: number;
  }): WorkPackageCostEstimate {
    const workPackage = WorkPackageSchema.parse(input.workPackage);
    const hardMax = workPackage.hardEnvelope;
    const coldP50 = scaleVector(hardMax, 40);
    const coldP90 = scaleVector(hardMax, 80);
    const baselineP50 = input.baseline ? maxVector(input.baseline.p50, coldP50) : coldP50;
    const baselineP90 = input.baseline ? maxVector(input.baseline.p90, baselineP50) : coldP90;
    if (!budgetVectorFits(baselineP90, hardMax)) throw new Error(`Historical P90 exceeds hard envelope for ${workPackage.id}`);
    const p95 = maxVector(baselineP90, scaleVector(hardMax, 90));
    const duration = Math.max(1, Math.round(input.durationHintSeconds ?? 600));
    const durationSeconds = ScalarCostIntervalSchema.parse({
      p50: Math.ceil(duration * 0.5), p90: Math.ceil(duration * 0.8),
      p95: Math.ceil(duration * 0.9), hardMax: duration,
    });
    const successProbability = input.successProbability ?? (input.baseline?.confidence === "high" ? 0.95 : 0.85);
    if (!(successProbability > 0 && successProbability <= 1)) throw new RangeError("successProbability must be in (0,1]");
    return WorkPackageCostEstimateSchema.parse({
      workPackageId: workPackage.id,
      p50: baselineP50,
      p90: baselineP90,
      p95,
      hardMax,
      durationSeconds,
      confidence: input.baseline?.confidence ?? "uncalibrated",
      sampleSize: input.baseline?.sampleCount ?? 0,
      estimatorVersion: this.estimatorVersion,
      riskGroup: input.riskGroup ?? workPackage.stableKey,
      successProbability,
    });
  }
}
