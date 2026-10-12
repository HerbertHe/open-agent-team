import assert from "node:assert/strict";
import test from "node:test";
import { BudgetAllocationSchema, BudgetVectorSchema } from "../budget/budget-types";
import {
  assertAttemptTransition,
  assertPlanVersionTransition,
  assertProgramTransition,
  assertWorkPackageTransition,
  InvalidDomainTransitionError,
  PlanVersionSchema,
  ProgramSchema,
  WorkPackageAttemptSchema,
  WorkPackageSchema,
} from "./program-types";

const now = "2026-10-10T00:00:00.000Z";

const program = {
  id: "program-1",
  projectId: "project-1",
  goal: "Deliver a bounded feature",
  status: "draft",
  executionEpoch: 0,
  revision: 0,
  createdAt: now,
  updatedAt: now,
};

test("BLH-007 BudgetVector accepts only non-negative safe integers", () => {
  assert.deepEqual(BudgetVectorSchema.parse({ moneyMicros: 1_000_000, modelCalls: 3 }), {
    moneyMicros: 1_000_000,
    modelCalls: 3,
  });
  for (const invalid of [
    { moneyMicros: -1 },
    { inputTokens: 1.5 },
    { toolCalls: Number.MAX_SAFE_INTEGER + 1 },
    { externalUnits: { search: -1 } },
    { surprise: 1 },
  ]) assert.throws(() => BudgetVectorSchema.parse(invalid));
  assert.throws(() => BudgetAllocationSchema.parse({ planning: {}, surprise: {} }));
});

test("BLH-007 Program schema rejects unknown fields, bad IDs and temporal regression", () => {
  assert.equal(ProgramSchema.parse(program).id, "program-1");
  assert.equal(ProgramSchema.parse({
    ...program,
    createdAt: "2026-10-10T08:00:00+08:00",
    updatedAt: "2026-10-10T08:00:00+08:00",
  }).createdAt, now);
  assert.throws(() => ProgramSchema.parse({ ...program, surprise: true }));
  assert.throws(() => ProgramSchema.parse({ ...program, id: "bad id" }));
  assert.throws(() => ProgramSchema.parse({ ...program, executionEpoch: -1 }));
  assert.throws(() => ProgramSchema.parse({ ...program, updatedAt: "2026-10-09T00:00:00.000Z" }));
});

test("BLH-007 Plan schema rejects duplicate work IDs and self-parenting", () => {
  const plan = {
    id: "plan-1",
    programId: "program-1",
    version: 1,
    reason: "initial",
    scopeTier: "minimum",
    status: "draft",
    workPackageIds: ["work-1"],
    createdBy: "admin",
    revision: 0,
    createdAt: now,
  };
  assert.equal(PlanVersionSchema.parse(plan).version, 1);
  assert.throws(() => PlanVersionSchema.parse({ ...plan, workPackageIds: ["work-1", "work-1"] }));
  assert.throws(() => PlanVersionSchema.parse({ ...plan, parentVersionId: "plan-1" }));
});

test("BLH-007 Work Package schema enforces dependency and deadline invariants", () => {
  const workPackage = {
    id: "work-1",
    stableKey: "feature/core",
    programId: "program-1",
    planVersionId: "plan-1",
    title: "Implement core",
    prompt: "Implement the bounded core.",
    targetAgentRole: "worker",
    dependsOn: [],
    conflictKeys: ["src/core"],
    scopeTier: "minimum",
    mandatory: true,
    priority: 10,
    hardEnvelope: { outputTokens: 1_000, modelCalls: 2 },
    notBefore: now,
    deadlineAt: "2026-10-11T00:00:00.000Z",
    status: "planned",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  assert.equal(WorkPackageSchema.parse(workPackage).stableKey, "feature/core");
  assert.throws(() => WorkPackageSchema.parse({ ...workPackage, dependsOn: ["work-1"] }));
  assert.throws(() => WorkPackageSchema.parse({ ...workPackage, conflictKeys: ["same", "same"] }));
  assert.throws(() => WorkPackageSchema.parse({
    ...workPackage,
    deadlineAt: "2026-10-09T00:00:00.000Z",
  }));
});

test("BLH-007 Attempt schema rejects invalid counters and timestamps", () => {
  const attempt = {
    id: "attempt-1",
    workPackageId: "work-1",
    attemptNumber: 1,
    status: "created",
    executionEpoch: 0,
    fencingToken: 1,
    createdAt: now,
    updatedAt: now,
  };
  assert.equal(WorkPackageAttemptSchema.parse(attempt).attemptNumber, 1);
  assert.throws(() => WorkPackageAttemptSchema.parse({ ...attempt, fencingToken: 0 }));
  assert.throws(() => WorkPackageAttemptSchema.parse({ ...attempt, attemptNumber: 1.25 }));
});

test("BLH-007 state transition guards accept only explicit graph edges", () => {
  assert.doesNotThrow(() => assertProgramTransition("running", "interrupt_requested"));
  assert.doesNotThrow(() => assertPlanVersionTransition("validated", "active"));
  assert.doesNotThrow(() => assertWorkPackageTransition("verifying", "completed"));
  assert.doesNotThrow(() => assertAttemptTransition("uncertain", "failed"));

  for (const invalid of [
    () => assertProgramTransition("completed", "running"),
    () => assertPlanVersionTransition("rejected", "active"),
    () => assertWorkPackageTransition("completed", "runnable"),
    () => assertAttemptTransition("failed", "running"),
    () => assertProgramTransition("running", "running"),
  ]) assert.throws(invalid, InvalidDomainTransitionError);
});
