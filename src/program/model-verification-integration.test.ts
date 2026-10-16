import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { ModelCallService } from "../budget/model-call-service";
import { BudgetAccountRepository, BudgetLedger } from "../budget/budget-ledger";
import { openExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { ProgramService } from "./program-service";
import { ProgramPlanningService } from "./program-planning-service";
import { ProgramExecutionCoordinator } from "./program-execution-coordinator";
import { ProgramVerificationRuntime } from "./program-verification-runtime";
import { ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { AcceptanceValidatorRegistry } from "./acceptance-criteria";
import { createDefaultAcceptanceValidators, runVerificationProcess } from "./default-acceptance-validators";
import { ProgramControlService } from "./program-control-service";
import { SuspensionSnapshotStore } from "./suspension-snapshot-store";
import { ExecutionBarrier } from "./execution-barrier";
import { QueuedTaskStatusEnum, type QueuedTask } from "../types";
import type { ModelCallRequest } from "../budget/model-call-protocol";

const T = "2026-10-15T01:00:00.000Z";
const envelope = { moneyMicros: 1_000, inputTokens: 1_000, outputTokens: 1_000, modelCalls: 10 };
const limit = { moneyMicros: 10_000, inputTokens: 10_000, outputTokens: 10_000, modelCalls: 100 };
const catalog = parseGlobalModelCatalog({ pricingRevision: "r1", models: { worker: "test/model" }, pricing: { worker: {
  providerId: "test", modelId: "model", inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000,
} } });

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, mode: "soft" | "shadow" = "soft") {
  const f = await setup(mode);
  try { await run(f); } finally { f.handle.close(); rmSync(f.root, { recursive: true, force: true }); }
}
async function setup(mode: "soft" | "shadow") {
  const root = mkdtempSync(path.join(tmpdir(), "program-metering-verification-"));
  const handle = openExecutionDatabase(root); migrateExecutionDatabase(handle);
  new ProgramService(handle, true, catalog).createDraft({ id: "p", projectId: "project", goal: "ship", pricingSnapshotId: "prices", createdAt: T,
    allocation: { planning: {}, minimumDelivery: limit, upgradePool: {}, validation: {}, contingency: {}, closeout: {} } });
  const planning = new ProgramPlanningService(handle, true);
  const work = (id: string, dependsOn: string[]) => ({ id, stableKey: id, title: id, prompt: `Implement ${id}`, targetAgentRole: "worker", dependsOn,
    scopeTier: "minimum", mandatory: true, priority: 1, hardEnvelope: envelope, acceptanceCriteria: [{ id: `file:${id}`, type: "file_exists", path: `${id}.txt` }] });
  planning.createPlan("p", { id: "plan", expectedProgramRevision: 0, createdBy: "admin", workPackages: [work("root", []), work("child", ["root"])] }, T);
  planning.evaluate("p", "plan", { expectedProgramRevision: 1, expectedPlanRevision: 0, seed: "metering", samples: 100 }, T);
  planning.approve("p", "plan", { expectedProgramRevision: 2, expectedPlanRevision: 2, selectedTier: "minimum", confirmed: true, acceptUncalibratedRisk: true, approvedBy: "user" }, T);
  const tasks = new Map<string, QueuedTask>();
  let currentCatalog = catalog;
  const models = new ModelCallService(handle, mode, async () => currentCatalog, () => T);
  const verifier = new ProgramVerificationRuntime(handle, (id) => tasks.get(id), () => root, (attempt) => models.reconcileAttempt(attempt), undefined, () => T);
  const coordinator = new ProgramExecutionCoordinator(handle, {
    resolveAgent: () => "worker-0", getTask: (id) => tasks.get(id), findTaskByConflictKey: (key) => [...tasks.values()].find((task) => task.conflictKey === key),
    createTask: async (body) => {
      const task = { ...body, id: `task-${tasks.size}`, status: QueuedTaskStatusEnum.Queued, createdAt: T, updatedAt: T } as QueuedTask;
      tasks.set(task.id, task); return task;
    },
  }, 1, { reconcileAttempt: (attempt) => models.reconcileAttempt(attempt), verifyProgram: (program) => verifier.advance(program) });
  await coordinator.tick("p", T);
  const task = tasks.get("task-0")!;
  const begin = (id: string): Extract<ModelCallRequest, { stage: "begin" }> => ({ stage: "begin", context: { ...task.executionContext!, operationId: id },
    modelRef: "test/model", callKind: "initial", usageUpperBound: { inputTokens: 100, outputTokens: 50 } });
  const invoke = (request: ModelCallRequest) => models.processCall("worker-0", "test/model", request);
  return { root, handle, models, tasks, task, begin, invoke, verifier, coordinator, changeCatalog: (value: typeof catalog) => { currentCatalog = value; } };
}

test("each model continuation reserves inside the task envelope and usage settles exactly once", () => fixture(async (f) => {
  const request = f.begin("model:first");
  const ledger = BudgetLedger.from(f.handle);
  await f.invoke(request);
  assert.deepEqual(BudgetAccountRepository.from(f.handle).get("p:minimum")!.reserved, envelope);
  const finish = { stage: "finish" as const, context: request.context, modelRef: request.modelRef, outcome: "reported" as const, usage: { inputTokens: 10, outputTokens: 5 } };
  await f.invoke(finish); await f.invoke(finish);
  await assert.rejects(f.invoke({ ...finish, usage: { inputTokens: 11, outputTokens: 5 } }), /MODEL_USAGE_CONFLICT/);
  const account = BudgetAccountRepository.from(f.handle).get("p:minimum")!;
  assert.equal(account.spent.moneyMicros, 15); assert.equal(account.spent.modelCalls, 1);
  assert.equal(ledger.getReservation(f.task.executionContext!.reservationId!)!.remaining.moneyMicros, 985);
  await f.invoke({ ...f.begin("model:continuation"), callKind: "tool_continuation" });
  assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM budget_reservations WHERE parent_reservation_id IS NOT NULL").pluck().get(), 2);
  await assert.rejects(f.invoke(request), /ALREADY_DISPATCHED/);
}));

test("soft blocks exhausted envelopes, changed prices, wrong owners and stale epochs", () => fixture(async (f) => {
  await assert.rejects(f.invoke({ ...f.begin("model:expensive"), usageUpperBound: { inputTokens: 2_000, outputTokens: 1 } }), /MODEL_BUDGET_DENIED/);
  f.changeCatalog({ ...catalog, pricingRevision: "r2" });
  await assert.rejects(f.invoke(f.begin("model:price-drift")), /PRICING_CHANGED/);
  f.changeCatalog(catalog);
  await assert.rejects(f.models.processCall("wrong-owner", "test/model", f.begin("model:owner")), /stale/i);
  new ExecutionBarrier(f.handle).freeze("p", 0, "test", T);
  await assert.rejects(f.invoke(f.begin("model:stale")), /frozen|epoch/i);
}));

test("shadow observes missing pricing without consuming call reservations or blocking", () => fixture(async (f) => {
  const request = { ...f.begin("model:shadow"), modelRef: "unpriced/model" };
  await f.models.processCall("worker-0", "unpriced/model", request);
  await f.models.processCall("worker-0", "unpriced/model", { stage: "finish", context: request.context, modelRef: request.modelRef, outcome: "unknown" });
  assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM budget_reservations WHERE parent_reservation_id IS NOT NULL").pluck().get(), 0);
  const audit = f.handle.connection.prepare("SELECT after_json FROM audit_events WHERE event_type='budget.model_guard'").pluck().get() as string;
  assert.equal(JSON.parse(audit).wouldBlock, true);
}, "shadow"));

test("lost model result is conservatively reconciled once; late usage after barrier cannot advance work", () => fixture(async (f) => {
  const request = f.begin("model:lost");
  await f.invoke(request);
  await f.models.reconcileAttempt(f.task.executionContext!.attemptId);
  await f.models.reconcileAttempt(f.task.executionContext!.attemptId);
  assert.equal(BudgetAccountRepository.from(f.handle).get("p:minimum")!.spent.moneyMicros, 150);
  new ExecutionBarrier(f.handle).freeze("p", 0, "stop", T);
  await f.invoke({ stage: "finish", context: request.context, modelRef: request.modelRef, outcome: "reported", usage: { inputTokens: 2, outputTokens: 1 } });
  assert.equal(BudgetAccountRepository.from(f.handle).get("p:minimum")!.spent.moneyMicros, 150);
  assert.equal(new WorkPackageRepository(f.handle).get("root")!.status, "running");
}));

test("automatic verification completes evidence-bound work, unlocks dependencies and closes Program", () => fixture(async (f) => {
  const request = f.begin("model:result"); await f.invoke(request);
  await f.invoke({ stage: "finish", context: request.context, modelRef: request.modelRef, outcome: "reported", usage: { inputTokens: 4, outputTokens: 2 } });
  writeFileSync(path.join(f.root, "root.txt"), "root result");
  f.task.status = QueuedTaskStatusEnum.Completed;
  const tick = await f.coordinator.tick("p", T);
  assert.equal(new WorkPackageRepository(f.handle).get("root")!.status, "completed");
  assert.equal(tick.dispatched[0]!.workPackageId, "child");
  assert.equal(f.handle.connection.prepare("SELECT artifact_digest FROM verification_evidence").pluck().get()?.toString().length, 64);
  writeFileSync(path.join(f.root, "child.txt"), "child result");
  f.tasks.get("task-1")!.status = QueuedTaskStatusEnum.Completed;
  await f.coordinator.tick("p", T);
  assert.equal(new ProgramRepository(f.handle).get("p")!.status, "completed");
  assert.equal(BudgetAccountRepository.from(f.handle).get("p:minimum")!.spent.moneyMicros, 6);
  assert.deepEqual(BudgetAccountRepository.from(f.handle).get("p:minimum")!.reserved, {});
  assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM verification_evidence WHERE passed=1").pluck().get(), 2);
  await f.coordinator.tick("p", T);
  assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM program_closeouts").pluck().get(), 1);
}));

test("agent completion without the required artifact fails verification and never unlocks its child", () => fixture(async (f) => {
  f.task.status = QueuedTaskStatusEnum.Completed;
  await f.coordinator.tick("p", T);
  assert.equal(new WorkPackageRepository(f.handle).get("root")!.status, "failed");
  assert.equal(new WorkPackageRepository(f.handle).get("child")!.status, "planned");
  assert.equal(f.handle.connection.prepare("SELECT passed FROM verification_evidence").pluck().get(), 0);
  assert.equal(new ProgramRepository(f.handle).get("p")!.status, "running");
}));

test("review-pending work keeps its lease and cannot complete before task review is finished", () => fixture(async (f) => {
  writeFileSync(path.join(f.root, "root.txt"), "exists but review is pending");
  f.task.status = QueuedTaskStatusEnum.ReviewPending;
  await f.coordinator.tick("p", T);
  assert.equal(new WorkPackageRepository(f.handle).get("root")!.status, "running");
  assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM verification_evidence").pluck().get(), 0);
}));

test("interrupt waits for an in-flight verifier to stop before writing its snapshot", () => fixture(async (f) => {
  const plain = new ProgramExecutionCoordinator(f.handle, { resolveAgent: () => undefined, getTask: (id) => f.tasks.get(id), findTaskByConflictKey: () => undefined,
    createTask: async () => { throw new Error("unexpected"); } });
  f.task.status = QueuedTaskStatusEnum.Completed; await plain.tick("p", T);
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  let stopped = false;
  const registry = new AcceptanceValidatorRegistry();
  registry.register("file_exists", "wait-v1", async (_criterion, input) => {
    started();
    await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
    return { passed: true, validatorVersion: "wait-v1", artifactDigest: "a".repeat(64), details: {} };
  });
  const verifier = new ProgramVerificationRuntime(f.handle, (id) => f.tasks.get(id), () => f.root, async () => {}, registry, () => T);
  const running = verifier.advance("p"); await ready;
  const snapshots = new SuspensionSnapshotStore(f.handle, f.root);
  const create = snapshots.create.bind(snapshots);
  snapshots.create = (...args) => { assert.equal(stopped, true); return create(...args); };
  const runtime = { requestCheckpoint: async () => ({ acknowledged: false }), abortAttempt: async () => ({ acknowledged: true, providerRequests: [], toolCalls: [] }),
    terminateSession: async () => {}, resetSession: async () => {}, describeSession: () => undefined };
  await new ProgramControlService(f.handle, runtime, snapshots, true, (id) => verifier.cancel(id)).interrupt("p", {
    controlRequestId: "interrupt-verification", mode: "immediate", reason: "test", expectedRevision: new ProgramRepository(f.handle).get("p")!.revision, requestedAt: T,
  });
  await running;
  assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM verification_evidence").pluck().get(), 0);
}));

test("a barrier raised during verification prevents evidence and completion commits", () => fixture(async (f) => {
  // Let the coordinator perform only its ordinary transition to verifying.
  const plain = new ProgramExecutionCoordinator(f.handle, { resolveAgent: () => undefined, getTask: (id) => f.tasks.get(id), findTaskByConflictKey: () => undefined,
    createTask: async () => { throw new Error("unexpected dispatch"); } });
  f.task.status = QueuedTaskStatusEnum.Completed; await plain.tick("p", T);
  const validators = new AcceptanceValidatorRegistry();
  validators.register("file_exists", "interrupt-v1", async () => {
    new ExecutionBarrier(f.handle).freeze("p", 0, "pause-during-verify", T);
    return { passed: true, validatorVersion: "interrupt-v1", artifactDigest: "a".repeat(64), details: {} };
  });
  await new ProgramVerificationRuntime(f.handle, (id) => f.tasks.get(id), () => f.root, async () => {}, validators, () => T).advance("p");
  assert.equal(new WorkPackageRepository(f.handle).get("root")!.status, "verifying");
  assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM verification_evidence").pluck().get(), 0);
}));

test("default validators reject traversal and symlinks, execute bounded commands and inspect test reports", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "program-validators-"));
  try {
    const registry = createDefaultAcceptanceValidators();
    writeFileSync(path.join(root, "result"), "ok"); symlinkSync(path.join(root, "result"), path.join(root, "link"));
    for (const target of ["../outside", "link"]) assert.equal((await registry.verify({ id: "file", type: "file_exists", path: target }, { workspacePath: root })).passed, false);
    assert.equal((await registry.verify({ id: "command", type: "command_exit_zero", command: "exit 0", timeoutSeconds: 1 }, { workspacePath: root })).passed, true);
    assert.equal((await registry.verify({ id: "command", type: "command_exit_zero", command: "exit 1", timeoutSeconds: 1 }, { workspacePath: root })).passed, false);
    const controller = new AbortController();
    const running = runVerificationProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], root, 30, controller.signal);
    controller.abort(); assert.equal((await running).passed, false);
    writeFileSync(path.join(root, "report.json"), JSON.stringify({ passed: 3, failed: 0 }));
    assert.equal((await registry.verify({ id: "report", type: "test_report", path: "report.json", minimumPassed: 3, maximumFailed: 0 }, { workspacePath: root })).passed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
