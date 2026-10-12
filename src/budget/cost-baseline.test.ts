import assert from "node:assert/strict";
import test from "node:test";
import type { UsageRecord } from "../orchestrator/usage-tracker";
import { projectHistoricalCostBaseline } from "./cost-baseline";

test("BLH-019 historical projection reports sample count, percentiles, confidence and outlier policy", () => {
  const records: UsageRecord[] = Array.from({ length: 20 }, (_, index) => ({
    ts: "2026-10-10T00:00:00.000Z", projectName: "project", agentId: `agent-${index}`,
    agentRole: "worker", model: "p/m", inputTokens: index === 19 ? 1_000_000 : 100 + index,
    outputTokens: 50 + index, cacheReadTokens: 0, cacheWriteTokens: 0,
    cost: index === 19 ? 1_000 : 0.01 + index / 10_000,
    taskClass: "coding", toolProfile: "standard", durationMs: 100, succeeded: true,
  }));
  const before = JSON.stringify(records);
  const baseline = projectHistoricalCostBaseline(records, {
    taskClass: "coding", model: "p/m", agentRole: "worker", toolProfile: "standard",
  });
  assert.equal(baseline.sampleCount, 20);
  assert.equal(baseline.confidence, "medium");
  assert.equal(baseline.outlierStrategy, "trim_each_tail_5_percent");
  assert.ok((baseline.p90.inputTokens ?? 0) < 1_000_000);
  assert.equal(JSON.stringify(records), before);
  assert.equal(projectHistoricalCostBaseline(records.slice(0, 3), {
    taskClass: "coding", model: "p/m", agentRole: "worker", toolProfile: "standard",
  }).confidence, "uncalibrated");
});
