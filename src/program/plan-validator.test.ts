import assert from "node:assert/strict";
import test from "node:test";
import { PlanValidator } from "./plan-validator";
import { PlanVersionSchema, WorkPackageSchema } from "./program-types";

const T0 = "2026-10-10T00:00:00.000Z";
function work(id: string, dependsOn: string[] = []) {
  return WorkPackageSchema.parse({
    id, stableKey: id, programId: "program-1", planVersionId: "plan-1", title: id,
    prompt: `Implement ${id}`, targetAgentRole: "worker", dependsOn, conflictKeys: [],
    scopeTier: "minimum", mandatory: true, priority: 1, hardEnvelope: { moneyMicros: 10 },
    acceptanceCriteria: [{ id: `${id}-test`, type: "command_exit_zero", command: "pnpm test", timeoutSeconds: 60 }],
    status: "planned", revision: 0, createdAt: T0, updatedAt: T0,
  });
}
const plan = PlanVersionSchema.parse({
  id: "plan-1", programId: "program-1", version: 1, reason: "initial", scopeTier: "minimum",
  status: "draft", workPackageIds: ["work-1", "work-2"], createdBy: "admin", revision: 0, createdAt: T0,
});

test("BLH-022 validator accepts a bounded DAG and returns deterministic order", () => {
  const result = new PlanValidator().validate({
    plan, workPackages: [work("work-2", ["work-1"]), work("work-1")],
    availableByTier: { minimum: { moneyMicros: 20 } },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.topologicalOrder, ["work-1", "work-2"]);
});

test("BLH-022 validator rejects cycles, dangling dependencies, duplicate keys and weak acceptance", () => {
  const first = work("work-1", ["work-2"]);
  const second = WorkPackageSchema.parse({
    ...work("work-2", ["work-1"]), stableKey: "work-1",
    acceptanceCriteria: [{ id: "judge", type: "llm_judge", rubricId: "quality", minimumScore: 0.9, requiresCorroboration: true }],
  });
  const result = new PlanValidator().validate({ plan, workPackages: [first, second], availableByTier: { minimum: { moneyMicros: 10 } } });
  const codes = new Set(result.issues.map((issue) => issue.code));
  assert.ok(codes.has("DEPENDENCY_CYCLE"));
  assert.ok(codes.has("DUPLICATE_STABLE_KEY"));
  assert.ok(codes.has("INSUFFICIENT_ACCEPTANCE"));
  assert.ok(codes.has("TIER_ENVELOPE_EXCEEDED"));
  const dangling = new PlanValidator().validate({ plan, workPackages: [work("work-1", ["missing"]), work("work-2")] });
  assert.ok(dangling.issues.some((issue) => issue.code === "DANGLING_DEPENDENCY"));
});
