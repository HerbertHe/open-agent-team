import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionRuntimeContextSchema, roundTripExecutionRuntimeContext } from "./execution-runtime-context";
import type { MainToChild } from "../sandbox/agent-runner-ipc";

test("BLH-016 execution context survives local and Docker JSON IPC while ordinary tasks omit it", () => {
  const context = ExecutionRuntimeContextSchema.parse({
    programId: "program-1", workPackageId: "work-1", attemptId: "attempt-1",
    executionEpoch: 3, fencingToken: 9, operationId: "operation-1", reservationId: "reservation-1",
  });
  assert.deepEqual(roundTripExecutionRuntimeContext(context), context);
  const start: MainToChild = {
    type: "start",
    spec: { id: "agent-1", role: "worker", name: "worker", branch: "branch", workspacePath: "/workspace", model: "p/m" },
    agentDir: "/agent", toolDefs: [], executionContext: context,
  };
  const decoded = JSON.parse(JSON.stringify(start)) as MainToChild;
  assert.equal(decoded.type === "start" ? decoded.executionContext?.fencingToken : undefined, 9);
  const ordinary: MainToChild = { ...start, executionContext: undefined };
  assert.equal(ordinary.type === "start" ? ordinary.executionContext : "bad", undefined);
  assert.throws(() => ExecutionRuntimeContextSchema.parse({ ...context, fencingToken: 0 }));
});
