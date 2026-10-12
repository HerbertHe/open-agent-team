import type { UsageRecord } from "../orchestrator/usage-tracker";
import type { BudgetVector } from "./budget-types";

export interface CostBaselineSelector {
  taskClass: string;
  model: string;
  agentRole: string;
  toolProfile: string;
}

export interface CostBaseline {
  sampleCount: number;
  p50: BudgetVector;
  p90: BudgetVector;
  confidence: "uncalibrated" | "low" | "medium" | "high";
  outlierStrategy: "none" | "trim_each_tail_5_percent";
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

export function projectHistoricalCostBaseline(
  records: readonly UsageRecord[],
  selector: CostBaselineSelector,
): CostBaseline {
  const matched = records.filter((record) =>
    record.model === selector.model && record.agentRole === selector.agentRole &&
    (record.taskClass ?? "unknown") === selector.taskClass &&
    (record.toolProfile ?? "unknown") === selector.toolProfile &&
    [record.inputTokens, record.outputTokens, record.cost].every((value) => Number.isFinite(value) && value >= 0),
  );
  const trim = matched.length >= 20 ? Math.floor(matched.length * 0.05) : 0;
  const metric = (select: (record: UsageRecord) => number): number[] => {
    const sorted = matched.map(select).sort((left, right) => left - right);
    return trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
  };
  const input = metric((record) => Math.round(record.inputTokens));
  const output = metric((record) => Math.round(record.outputTokens));
  const money = metric((record) => Math.round(record.cost * 1_000_000));
  const calls = metric(() => 1);
  const vector = (quantile: number): BudgetVector => ({
    moneyMicros: percentile(money, quantile), inputTokens: percentile(input, quantile),
    outputTokens: percentile(output, quantile), modelCalls: percentile(calls, quantile),
  });
  const confidence = matched.length < 5 ? "uncalibrated" : matched.length < 20 ? "low" : matched.length < 50 ? "medium" : "high";
  return {
    sampleCount: matched.length,
    p50: vector(0.5), p90: vector(0.9), confidence,
    outlierStrategy: trim > 0 ? "trim_each_tail_5_percent" : "none",
  };
}
