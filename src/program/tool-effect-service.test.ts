import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";
import { openExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { ProgramService } from "./program-service";
import { ProgramPlanningService } from "./program-planning-service";
import { ProgramExecutionCoordinator } from "./program-execution-coordinator";
import { ProgramVerificationRuntime } from "./program-verification-runtime";
import { parseGlobalModelCatalog } from "../models/global-models";
import { BudgetAccountRepository } from "../budget/budget-ledger";
import { QueuedTaskStatusEnum, type QueuedTask } from "../types";
import { ToolEffectService, registerExperimentalEffectRoutes } from "./tool-effect-service";
import { EffectLedger } from "./effect-ledger";
import { ExecutionBarrier } from "./execution-barrier";
import { ProgramRepository } from "./execution-repositories";
import type { ToolEffectRequest, RuntimeToolCall } from "./tool-effects-protocol";
import type { EffectStateAdapter } from "./effect-reconciler";
import { EffectReconciler } from "./effect-reconciler";
import { queryOatEffectState } from "./oat-effect-state-query";
const T = "2026-10-16T00:00:00.000Z";
const result = { content: [{ type: "text" as const, text: "SECRET_TOOL_OUTPUT" }], details: {} };

async function withFixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { f.handle.close(); rmSync(f.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "oat-tool-effects-"));
  const handle = openExecutionDatabase(root); migrateExecutionDatabase(handle);
  new ProgramService(handle, true, parseGlobalModelCatalog({})).createDraft({ id: "p", projectId: "project", goal: "ship", pricingSnapshotId: "prices", createdAt: T,
    allocation: { planning: {}, minimumDelivery: { toolCalls: 10 }, upgradePool: {}, validation: {}, contingency: {}, closeout: {} } });
  const plans = new ProgramPlanningService(handle, true);
  plans.createPlan("p", { id: "plan", expectedProgramRevision: 0, createdBy: "admin", workPackages: [{ id: "work", stableKey: "work", title: "ship", prompt: "Implement result",
    targetAgentRole: "worker", scopeTier: "minimum", mandatory: true, priority: 1, hardEnvelope: { toolCalls: 5 }, acceptanceCriteria: [{ id: "file", type: "file_exists", path: "result.txt" }] }] }, T);
  plans.evaluate("p", "plan", { expectedProgramRevision: 1, expectedPlanRevision: 0, seed: "tools", samples: 100 }, T);
  plans.approve("p", "plan", { expectedProgramRevision: 2, expectedPlanRevision: 2, selectedTier: "minimum", confirmed: true, acceptUncalibratedRisk: true, approvedBy: "user" }, T);
  let task: QueuedTask;
  const coordinator = new ProgramExecutionCoordinator(handle, { resolveAgent: () => "worker", getTask: () => task, findTaskByConflictKey: () => task,
    createTask: async (body) => { task = { ...body, id: "task", status: QueuedTaskStatusEnum.Running, createdAt: T, updatedAt: T } as QueuedTask; return task; } });
  await coordinator.tick("p", T);
  const service = new ToolEffectService(handle, "soft", undefined, "project", () => T, 20);
  const input = (toolName: string, toolCallId = "call"): RuntimeToolCall => ({ agentId: "worker", workspacePath: root, context: task!.executionContext!, toolName,
    toolCallId, params: { token: "SECRET_INPUT" }, permittedTools: new Set([toolName]), execute: async () => result });
  const builtin = (toolName: string, toolCallId: string, params = {}): Extract<ToolEffectRequest, { stage: "begin" }> => ({ stage: "begin",
    context: task!.executionContext!, toolName, toolCallId, params });
  return { root, handle, service, input, builtin, task: task!, coordinator };
}

test("custom execution is persisted before dispatch, replay-safe and charges one child budget unit", () => withFixture(async (f) => {
  let calls = 0;
  const input = { ...f.input("report-progress"), execute: async () => {
    calls++;
    assert.equal(f.service.list("p")[0]!.state, "dispatched");
    return result;
  } };
  assert.deepEqual(await f.service.execute(input), result);
  await assert.rejects(f.service.execute(input), /EFFECT_REPLAY_BLOCKED:confirmed/);
  await assert.rejects(f.service.execute({ ...input, params: { changed: true } }), /EFFECT_REQUEST_CONFLICT/);
  assert.equal(calls, 1);
  assert.equal(BudgetAccountRepository.from(f.handle).get("p:minimum")!.spent.toolCalls, 1);
  assert.equal(BudgetAccountRepository.from(f.handle).get("p:minimum")!.reserved.toolCalls, 4);
  const records = JSON.stringify(f.service.list("p"));
  assert.equal(records.includes("SECRET_INPUT"), false); assert.equal(records.includes("SECRET_TOOL_OUTPUT"), false);
}));

test("concurrent deliveries cannot execute a side effect twice", () => withFixture(async (f) => {
  let calls = 0; let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const input = { ...f.input("report-progress"), execute: async () => { calls++; await wait; return result; } };
  const first = f.service.execute(input);
  // A duplicate can either attach to an in-flight delivery or be rejected by the durable CAS.
  const second = f.service.execute(input);
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length >= 1, true);
  assert.equal(calls, 1); assert.equal(f.service.list("p").length, 1);
}));

test("permission, fencing, owner, budget and unbudgeted delegation deny before any tool execution", () => withFixture(async (f) => {
  let calls = 0; const execute = async () => { calls++; return result; };
  await assert.rejects(f.service.execute({ ...f.input("unknown"), permittedTools: new Set(), execute }), /TOOL_PERMISSION_DENIED/);
  await assert.rejects(f.service.execute({ ...f.input("report-progress"), agentId: "wrong", execute }), /stale/i);
  const input = f.input("report-progress");
  await assert.rejects(f.service.execute({ ...input, context: { ...input.context, fencingToken: 99 }, execute }), /stale/i);
  await assert.rejects(f.service.execute({ ...f.input("create-task"), execute }), /UNBUDGETED_DELEGATION_DENIED/);
  for (let i = 0; i < 5; i++) await f.service.execute(f.input("report-progress", `unit-${i}`));
  await assert.rejects(f.service.execute({ ...f.input("report-progress", "exhausted"), execute }), /budget.*exhausted/i);
  assert.equal(calls, 0);
}));

test("timeout is uncertain, never retries, and a late receipt resolves it without double spending", () => withFixture(async (f) => {
  let release!: () => void;
  const input = { ...f.input("push-release"), execute: async () => { await new Promise<void>((resolve) => { release = resolve; }); return result; } };
  await assert.rejects(f.service.execute(input), /TOOL_RESULT_UNCERTAIN/);
  assert.equal(f.service.list("p")[0]!.state, "uncertain");
  await assert.rejects(f.service.execute(input), /EFFECT_REPLAY_BLOCKED:uncertain/);
  await assert.rejects(f.service.execute({ ...input, toolCallId: "new-id-same-ambiguous-request" }), /EFFECT_OUTCOME_UNKNOWN/);
  release(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.service.list("p")[0]!.state, "reconciled");
  assert.equal(BudgetAccountRepository.from(f.handle).get("p:minimum")!.spent.toolCalls, 1);
}));

test("builtin write has real file-state reconciliation after missing receipt and service restart", () => withFixture(async (f) => {
  const begin = f.builtin("write", "write-1", { path: "result.txt", content: "private file contents" });
  await f.service.processBuiltin("worker", f.root, begin);
  writeFileSync(path.join(f.root, "result.txt"), "private file contents");
  const restarted = new ToolEffectService(f.handle, "soft", undefined, "project", () => T);
  const reconciliation = await restarted.reconcile("p");
  assert.equal(reconciliation.reconciled, 1);
  assert.equal(restarted.list("p")[0]!.state, "confirmed");
  assert.equal(restarted.list("p")[0]!.receipt?.evidence, "file_postcondition");
  assert.equal(JSON.stringify(restarted.list("p")).includes("private file contents"), false);
  await assert.rejects(restarted.processBuiltin("worker", f.root, begin), /EFFECT_REPLAY_BLOCKED/);
  assert.equal(BudgetAccountRepository.from(f.handle).get("p:minimum")!.spent.toolCalls, 1);
}));

test("unqueryable commands remain uncertain; neither restart nor reconciliation reruns them", () => withFixture(async (f) => {
  const begin = f.builtin("bash", "shell", { command: "send irreversible operation" });
  await f.service.processBuiltin("worker", f.root, begin);
  const restarted = new ToolEffectService(f.handle, "soft", undefined, "project", () => T);
  assert.equal((await restarted.reconcile("p")).unresolved.length, 1);
  assert.equal(restarted.list("p")[0]!.state, "uncertain");
  await assert.rejects(restarted.processBuiltin("worker", f.root, begin), /EFFECT_REPLAY_BLOCKED:uncertain/);
}));

test("builtin guard validates paths, container path mapping and stale context before dispatch", () => withFixture(async (f) => {
  await assert.rejects(f.service.processBuiltin("worker", f.root, f.builtin("write", "outside", { path: "../outside", content: "x" })), /OUTSIDE_WORKSPACE/);
  symlinkSync(f.root, path.join(f.root, "link"));
  await assert.rejects(f.service.processBuiltin("worker", f.root, f.builtin("write", "symlink", { path: "link/file", content: "x" })), /SYMLINK_REJECTED/);
  await f.service.processBuiltin("worker", f.root, f.builtin("write", "container", { path: "/workspace/result.txt", content: "x" }), "/workspace");
  new ExecutionBarrier(f.handle).freeze("p", 0, "stop", T);
  await assert.rejects(f.service.processBuiltin("worker", f.root, f.builtin("read", "stale", { path: "result.txt" })), /frozen|stale/i);
}));

test("finish after an interrupt can reconcile the effect but cannot advance the Work Package", () => withFixture(async (f) => {
  const begin = f.builtin("write", "late", { path: "result.txt", content: "ok" });
  await f.service.processBuiltin("worker", f.root, begin);
  new ExecutionBarrier(f.handle).freeze("p", 0, "stop", T);
  await f.service.quiesce("p");
  assert.equal(f.service.list("p")[0]!.state, "uncertain");
  await f.service.processBuiltin("worker", f.root, { stage: "finish", context: begin.context, toolName: "write", toolCallId: "late", isError: false, resultDigest: "a".repeat(64) });
  assert.equal(f.service.list("p")[0]!.state, "reconciled");
  assert.equal(f.handle.connection.prepare("SELECT status FROM work_packages WHERE id='work'").pluck().get(), "running");
}));

test("unresolved effects prevent automatic final completion until their real receipt arrives", () => withFixture(async (f) => {
  const begin = f.builtin("bash", "pending", { command: "remote work" }); await f.service.processBuiltin("worker", f.root, begin);
  f.task.status = QueuedTaskStatusEnum.Completed; await f.coordinator.tick("p", T);
  writeFileSync(path.join(f.root, "result.txt"), "ok");
  const verifier = new ProgramVerificationRuntime(f.handle, () => f.task, () => f.root, (attempt) => f.service.endAttempt(attempt), undefined, () => T);
  await verifier.advance("p");
  assert.equal(new ProgramRepository(f.handle).get("p")!.status, "running");
  assert.equal(f.service.list("p")[0]!.state, "uncertain");
  await f.service.processBuiltin("worker", f.root, { stage: "finish", context: begin.context, toolName: "bash", toolCallId: "pending", isError: false, resultDigest: "b".repeat(64) });
  await verifier.advance("p");
  assert.equal(new ProgramRepository(f.handle).get("p")!.status, "completed");
}));

test("reconciler re-reads state after asynchronous provider queries and preserves authoritative outcome", () => withFixture(async (f) => {
  const begin = f.builtin("bash", "race", { command: "work" }); await f.service.processBuiltin("worker", f.root, begin);
  const effect = f.service.list("p")[0]!; const ledger = new EffectLedger(f.handle);
  const adapter: EffectStateAdapter = { query: async () => {
    ledger.transition(effect.operationKey, "confirmed", T, { receipt: { from: "live_callback" } });
    return { state: "not_applied", receipt: { outcome: "applied" } };
  } };
  await new EffectReconciler(f.handle, new Map([["bash", adapter]])).reconcile("p", T);
  assert.equal(ledger.getByOperationKey(effect.operationKey)!.receipt?.from, "live_callback");
}));

test("custom state adapter recovers persisted task progress without re-running the tool", () => withFixture(async (f) => {
  f.task.lastProgress = { message: "stored progress", stage: "build", at: T };
  const input = { ...f.input("report-progress"), params: { message: "stored progress", stage: "build" }, execute: async () => { throw new Error("response lost after persisting progress"); } };
  await assert.rejects(f.service.execute(input), /response lost/);
  const store = { getTasks: () => [f.task], listReleaseProposals: async () => [], listReviewRequests: async () => [] };
  const restarted = new ToolEffectService(f.handle, "soft", (effect) => queryOatEffectState(store, effect), "project", () => T);
  assert.equal((await restarted.reconcile("p")).reconciled, 1);
  assert.equal(restarted.list("p")[0]!.receipt?.evidence, "task_progress");
  assert.equal(restarted.list("p")[0]!.state, "reconciled");
}));

test("shadow records would-block tool budget; hard refuses uncontrolled high-impact tools", () => withFixture(async (f) => {
  assert.equal(registerExperimentalEffectRoutes({} as Express, f.service, false), false);
  const shadow = new ToolEffectService(f.handle, "shadow", undefined, "project", () => T);
  for (let i = 0; i < 6; i++) await shadow.execute(f.input("report-progress", `shadow-${i}`));
  assert.deepEqual(BudgetAccountRepository.from(f.handle).get("p:minimum")!.spent, {});
  const hard = new ToolEffectService(f.handle, "hard", undefined, "project", () => T);
  await assert.rejects(hard.execute(f.input("push-release", "hard")), /Hard mode rejects/);
}));

test("query timeout keeps an operation uncertain and does not dispatch a retry", () => withFixture(async (f) => {
  await f.service.processBuiltin("worker", f.root, f.builtin("bash", "query-timeout", { command: "action" }));
  const never: EffectStateAdapter = { query: async () => new Promise(() => {}) };
  const result = await new EffectReconciler(f.handle, new Map([["bash", never]]), 5).reconcile("p", T);
  assert.equal(result.unresolved[0]!.state, "uncertain");
  assert.equal(f.service.list("p").length, 1);
}));
