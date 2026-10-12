import assert from "node:assert/strict";
import test from "node:test";
import { AdmissionController, type AdmissionDecision } from "./admission-controller";
import type { WorkPackageCostEstimate } from "./cost-estimator";
import { selectScopeTier } from "./scope-tier-selector";

function estimate(id: string, confidence: WorkPackageCostEstimate["confidence"] = "medium"): WorkPackageCostEstimate {
  return {
    workPackageId: id, p50: { moneyMicros: 40 }, p90: { moneyMicros: 80 }, p95: { moneyMicros: 90 },
    hardMax: { moneyMicros: 100 }, durationSeconds: { p50: 40, p90: 80, p95: 90, hardMax: 100 },
    confidence, sampleSize: 30, estimatorVersion: "v1", riskGroup: "shared-risk", successProbability: 0.95,
  };
}

test("BLH-024 Monte Carlo admission is reproducible and reports joint probability", () => {
  const controller = new AdmissionController();
  const input = {
    workItems: [{ id: "a", dependsOn: [], estimate: estimate("a") }, { id: "b", dependsOn: ["a"], estimate: estimate("b") }],
    budgetLimit: { moneyMicros: 170 }, deadlineSeconds: 170, targetProbability: 0.5, samples: 2_000, seed: "plan-1:minimum",
  };
  const first = controller.evaluate(input);
  const second = controller.evaluate(input);
  assert.deepEqual(first, second);
  assert.deepEqual(controller.evaluate({ ...input, workItems: [...input.workItems].reverse() }), first);
  assert.ok(first.jointProbability! <= first.budgetProbability!);
  assert.ok(first.jointProbability! <= first.deadlineProbability!);
  assert.ok(first.jointProbability! <= first.acceptanceProbability!);
  assert.equal(controller.evaluate({ ...input, workItems: [{ id: "a", dependsOn: [], estimate: estimate("a", "uncalibrated") }] }).requiresHumanApproval, true);
  assert.throws(() => controller.evaluate({ ...input, workItems: [{ id: "a", dependsOn: ["missing"], estimate: estimate("a", "uncalibrated") }] }), /missing dependency/);
  assert.throws(() => controller.evaluate({ ...input, workItems: [
    { id: "a", dependsOn: ["b"], estimate: estimate("a") }, { id: "b", dependsOn: ["a"], estimate: estimate("b") },
  ] }), /dependency cycle/);
});

test("BLH-025 tier selection rejects an infeasible minimum and otherwise chooses the highest feasible tier", () => {
  const decision = (feasible: boolean): AdmissionDecision => ({
    calibrated: true, feasible, requiresHumanApproval: false, jointProbability: feasible ? 0.95 : 0.2,
    budgetProbability: 1, deadlineProbability: 1, acceptanceProbability: 0.95,
    targetProbability: 0.9, samples: 1000, seed: "seed",
  });
  assert.deepEqual(selectScopeTier({ minimum: decision(false), standard: decision(false), stretch: decision(false) }), {
    status: "rejected", reason: "minimum_infeasible",
  });
  assert.equal(selectScopeTier({ minimum: decision(true), standard: decision(true), stretch: decision(false) }).selectedTier, "standard");
});
