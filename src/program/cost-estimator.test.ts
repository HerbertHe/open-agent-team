import assert from "node:assert/strict";
import test from "node:test";
import { WorkPackageCostEstimator } from "./cost-estimator";
import { WorkPackageSchema } from "./program-types";

const work = WorkPackageSchema.parse({
  id: "work-1", stableKey: "feature", programId: "program-1", planVersionId: "plan-1",
  title: "feature", prompt: "Implement feature", targetAgentRole: "worker", dependsOn: [], conflictKeys: [],
  scopeTier: "minimum", mandatory: true, priority: 1,
  hardEnvelope: { moneyMicros: 100, inputTokens: 1_000, modelCalls: 10 },
  acceptanceCriteria: [{ id: "tests", type: "command_exit_zero", command: "pnpm test", timeoutSeconds: 60 }],
  status: "planned", revision: 0, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
});

test("BLH-023 estimator emits P50/P90/HardMax, version and confidence", () => {
  const estimate = new WorkPackageCostEstimator("estimator-test-v1").estimate({
    workPackage: work,
    baseline: {
      sampleCount: 25, p50: { moneyMicros: 30, inputTokens: 300, modelCalls: 2 },
      p90: { moneyMicros: 70, inputTokens: 700, modelCalls: 7 }, confidence: "medium",
      outlierStrategy: "trim_each_tail_5_percent",
    },
    durationHintSeconds: 100,
  });
  assert.deepEqual(estimate.p50, { moneyMicros: 40, inputTokens: 400, modelCalls: 4 });
  assert.deepEqual(estimate.p90, { moneyMicros: 70, inputTokens: 700, modelCalls: 7 });
  assert.deepEqual(estimate.hardMax, work.hardEnvelope);
  assert.equal(estimate.confidence, "medium");
  assert.equal(estimate.estimatorVersion, "estimator-test-v1");
  assert.throws(() => new WorkPackageCostEstimator().estimate({
    workPackage: work,
    baseline: { sampleCount: 5, p50: {}, p90: { moneyMicros: 101 }, confidence: "low", outlierStrategy: "none" },
  }), /exceeds hard envelope/);
});
