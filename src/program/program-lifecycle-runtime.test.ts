import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { ModelCallService } from "../budget/model-call-service";
import { openExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { ProgramService } from "./program-service";
import { ProgramPlanningService } from "./program-planning-service";
import { ProgramExecutionCoordinator } from "./program-execution-coordinator";
import { ProgramVerificationRuntime } from "./program-verification-runtime";
import { ProgramLifecycleRuntime } from "./program-lifecycle-runtime";
import { ProgramCloseoutRuntime } from "./program-closeout-runtime";
import { ProgramControlService } from "./program-control-service";
import { ProgramWakeupRuntime } from "./program-wakeup-runtime";
import { ProgramRepository, PlanVersionRepository, WorkPackageRepository } from "./execution-repositories";
import { SuspensionSnapshotStore } from "./suspension-snapshot-store";
import { createDefaultAcceptanceValidators } from "./default-acceptance-validators";
import { ExecutionBarrier } from "./execution-barrier";
import { ProgramReadModel } from "./program-read-model";
import { EffectLedger } from "./effect-ledger";
import { ProgramIdSchema, AttemptIdSchema } from "./program-types";
import { BudgetLedger } from "../budget/budget-ledger";
import { canonicalModelRef, selectProgramModelAgent, type ProgramModelRoutingPolicy } from "./program-model-routing";
import { QueuedTaskStatusEnum, type QueuedTask } from "../types";
import type { InterruptibleRuntimeProvider } from "../sandbox/interface";

const T = "2026-10-16T00:00:00.000Z";
const price = (modelId: string, rate: number) => ({ providerId: "test", modelId, inputMicrosPerMillionTokens: rate, outputMicrosPerMillionTokens: rate });
const catalog = parseGlobalModelCatalog({ pricingRevision: "r1", models: { cheap: "test/model" }, pricing: {
  cheap: price("model", 1), premium: price("premium", 100),
} });

function fixture(maxReplans = 2) {
  const root = mkdtempSync(path.join(tmpdir(), "program-lifecycle-"));
  let handle = openExecutionDatabase(root); migrateExecutionDatabase(handle);
  new ProgramService(handle, true, catalog).createDraft({ id: "p", projectId: "project", goal: "ship", pricingSnapshotId: "prices", createdAt: T,
    allocation: { planning: {}, minimumDelivery: { modelCalls: 100 }, upgradePool: {}, validation: { modelCalls: 2 }, contingency: {}, closeout: { modelCalls: 2 } } });
  const planning = new ProgramPlanningService(handle, true);
  const work = (id: string, dependsOn: string[]) => ({ id, stableKey: id, title: id, prompt: `Implement ${id}`, targetAgentRole: "worker", dependsOn,
    scopeTier: "minimum", mandatory: true, priority: 1, hardEnvelope: { modelCalls: 1 }, acceptanceCriteria: [{ id: `file:${id}`, type: "file_exists", path: `${id}.txt` }] });
  planning.createPlan("p", { id: "plan", expectedProgramRevision: 0, createdBy: "admin", workPackages: [work("root", []), work("child", ["root"])] }, T);
  planning.evaluate("p", "plan", { expectedProgramRevision: 1, expectedPlanRevision: 0, seed: "lifecycle", samples: 100 }, T);
  planning.approve("p", "plan", { expectedProgramRevision: 2, expectedPlanRevision: 2, selectedTier: "minimum", confirmed: true, acceptUncalibratedRisk: true, approvedBy: "user" }, T);
  const tasks: QueuedTask[] = []; const calls: string[] = [];
  let now = T; let seconds = 0;
  const runtime: InterruptibleRuntimeProvider = {
    requestCheckpoint: async () => ({ acknowledged: false }),
    abortAttempt: async (_agent, id) => { calls.push(`abort:${id}`); return { acknowledged: true, providerRequests: [], toolCalls: [] }; },
    terminateSession: async () => {}, resetSession: async () => {}, describeSession: (agentId) => ({ agentId, workspacePath: root }),
  };
  function build() {
    const snapshots = new SuspensionSnapshotStore(handle, root);
    const validators = createDefaultAcceptanceValidators();
    const verifier = new ProgramVerificationRuntime(handle, (id) => tasks.find((task) => task.id === id), () => root, async () => {}, validators, () => now, { autoCloseout: false });
    const control = new ProgramControlService(handle, runtime, snapshots, true, (id) => verifier.cancel(id));
    const closeout = new ProgramCloseoutRuntime(handle, control, snapshots, (id) => verifier.cancel(id), async () => {});
    const lifecycle = new ProgramLifecycleRuntime(handle, async (id, at, reason) => { await closeout.close(id, at, reason); }, { maxReplans, validatorVersion: (type) => validators.versionFor(type) });
    const coordinator = new ProgramExecutionCoordinator(handle, {
      resolveAgent: () => "worker", modelRefForAgent: () => "test/model", getTask: (id) => tasks.find((task) => task.id === id),
      findTaskByConflictKey: (key) => [...tasks].reverse().find((task) => task.conflictKey === key),
      createTask: async (body) => { const task = { ...body, id: `task-${tasks.length}`, status: QueuedTaskStatusEnum.Queued, createdAt: now, updatedAt: now }; tasks.push(task); return task; },
    }, 1, { clock: () => now, verifyProgram: (id) => verifier.advance(id), maintainProgram: (id, at) => lifecycle.advance(id, at) });
    return { coordinator, lifecycle, closeout, control, snapshots };
  }
  let services = build();
  return { root, get handle() { return handle; }, tasks, calls, get services() { return services; }, clock: () => now,
    tick: async () => { now = new Date(Date.parse(T) + ++seconds * 1000).toISOString(); return services.coordinator.tick("p", now); },
    time: (value: number) => { seconds = value; now = new Date(Date.parse(T) + seconds * 1000).toISOString(); },
    reopen: () => { handle.close(); handle = openExecutionDatabase(root); migrateExecutionDatabase(handle); services = build(); },
    close: () => { handle.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("automatic retry and replan preserve verified work, remap dependencies, and close with snapshot and evidence", async () => {
  const f = fixture();
  try {
    await f.tick(); writeFileSync(path.join(f.root, "root.txt"), "verified root"); f.tasks[0].status = QueuedTaskStatusEnum.Completed;
    await f.tick(); assert.equal(f.tasks.length, 2);
    f.tasks[1].status = QueuedTaskStatusEnum.Failed; await f.tick(); assert.equal(f.tasks.length, 3);
    await f.tick(); assert.equal(f.tasks.length, 3); // no repeated observation/retry
    f.tasks[2].status = QueuedTaskStatusEnum.Failed; await f.tick();
    const program = new ProgramRepository(f.handle).get("p")!;
    assert.notEqual(program.activePlanVersionId, "plan");
    const plan = new PlanVersionRepository(f.handle).get(program.activePlanVersionId!)!;
    assert.equal(plan.parentVersionId, "plan"); assert.equal(plan.scopeTier, "minimum");
    const packages = new WorkPackageRepository(f.handle).listByPlan(plan.id);
    const root = packages.find((item) => item.stableKey === "root")!;
    const child = packages.find((item) => item.stableKey === "child")!;
    assert.equal(root.status, "completed"); assert.deepEqual(child.dependsOn, [root.id]);
    assert.equal(f.tasks.filter((task) => task.prompt === "Implement root").length, 1);
    assert.equal(f.tasks.length, 4);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM verification_evidence WHERE work_package_id=? AND passed=1").pluck().get(root.id), 1);
    assert.deepEqual(child.hardEnvelope, { modelCalls: 1 });
    writeFileSync(path.join(f.root, "child.txt"), "verified child"); f.tasks[3].status = QueuedTaskStatusEnum.Completed;
    await f.tick();
    assert.equal(new ProgramRepository(f.handle).get("p")?.status, "completed");
    const report = await f.services.closeout.close("p", f.clock(), "again");
    assert.deepEqual(report.mandatory, { total: 2, completed: 2, verified: 2 });
    assert.ok(report.snapshotId); assert.ok(report.budget?.length); assert.equal(report.unfinishedWork?.length, 0);
    assert.equal(f.services.snapshots.get(report.snapshotId!).manifest.mode, "cancel_closeout");
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM attempt_leases").pluck().get(), 0);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM program_closeouts").pluck().get(), 1);
    assert.equal((new ProgramReadModel(f.handle).get("p") as { closeoutReport: { outcome: string } }).closeoutReport.outcome, "completed");
  } finally { f.close(); }
});

test("replan persistence failure rolls back the entire plan switch and retries without duplicate inherited work", async () => {
  const f = fixture();
  try {
    await f.tick(); writeFileSync(path.join(f.root, "root.txt"), "verified root"); f.tasks[0].status = QueuedTaskStatusEnum.Completed;
    await f.tick(); f.tasks[1].status = QueuedTaskStatusEnum.Failed; await f.tick();
    f.tasks[2].status = QueuedTaskStatusEnum.Failed;
    f.handle.connection.exec("CREATE TEMP TRIGGER fail_plan_switch BEFORE UPDATE OF active_plan_version_id ON programs WHEN NEW.active_plan_version_id<>OLD.active_plan_version_id BEGIN SELECT RAISE(ABORT,'simulated crash'); END");
    await assert.rejects(() => f.tick(), /simulated crash/);
    assert.equal(new ProgramRepository(f.handle).get("p")?.activePlanVersionId, "plan");
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM plan_versions").pluck().get(), 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM work_packages").pluck().get(), 2);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM verification_evidence").pluck().get(), 1);
    f.handle.connection.exec("DROP TRIGGER fail_plan_switch"); await f.tick();
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM plan_versions").pluck().get(), 2);
    assert.equal(f.tasks.filter((task) => task.prompt === "Implement root").length, 1);
    assert.equal(f.tasks.length, 4);
  } finally { f.close(); }
});

test("completed work without all bound evidence cannot be inherited or silently replayed", async () => {
  const f = fixture();
  try {
    await f.tick(); writeFileSync(path.join(f.root, "root.txt"), "verified root"); f.tasks[0].status = QueuedTaskStatusEnum.Completed;
    await f.tick(); f.tasks[1].status = QueuedTaskStatusEnum.Failed; await f.tick();
    f.handle.connection.prepare("DELETE FROM verification_evidence WHERE work_package_id='root'").run();
    f.tasks[2].status = QueuedTaskStatusEnum.Failed; await f.tick();
    assert.equal(new ProgramRepository(f.handle).get("p")?.status, "incomplete");
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM plan_versions").pluck().get(), 1);
    assert.equal(f.tasks.filter((task) => task.prompt === "Implement root").length, 1);
    const report = await f.services.closeout.close("p", f.clock(), "again");
    assert.ok(report.reasons.includes("mandatory_evidence_missing"));
  } finally { f.close(); }
});

test("cancelled mandatory work inside the approved tier is incomplete rather than disappearing from delivery totals", async () => {
  const f = fixture();
  try {
    await f.tick(); f.tasks[0].status = QueuedTaskStatusEnum.Cancelled;
    const child = new WorkPackageRepository(f.handle).get("child")!;
    new WorkPackageRepository(f.handle).transitionStatus(child.id, child.revision, "cancelled", f.clock());
    await f.tick();
    assert.equal(new ProgramRepository(f.handle).get("p")?.status, "incomplete");
    const report = await f.services.closeout.close("p", f.clock(), "again");
    assert.equal(report.mandatory.total, 2); assert.equal(report.mandatory.completed, 0);
  } finally { f.close(); }
});

test("repeated failure limit is finite and does not create an unapproved scope or borrow protected budget", async () => {
  const f = fixture(1);
  try {
    await f.tick();
    for (let n = 0; n < 4; n++) { f.tasks.at(-1)!.status = QueuedTaskStatusEnum.Failed; await f.tick(); }
    assert.equal(new ProgramRepository(f.handle).get("p")?.status, "incomplete");
    assert.equal(f.tasks.length, 4);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM plan_versions").pluck().get(), 2);
    const report = await f.services.closeout.close("p", f.clock(), "again");
    assert.ok(report.reasons.includes("mandatory_work_incomplete"));
    assert.ok(report.unfinishedWork?.length);
    for (const account of report.budget!.filter((item) => ["validation", "closeout"].includes(item.kind))) assert.deepEqual(account.reserved, {});
  } finally { f.close(); }
});

test("insufficient execution partition stops live work, records uncertainty and saves a recovery point", async () => {
  const f = fixture();
  try {
    await f.tick();
    // One held root envelope plus another reservation leaves no room for child work.
    BudgetLedger.from(f.handle).reserve({ id: "held", programId: "p", accountId: "p:minimum", operationKey: "held", amount: { modelCalls: 99 }, consumerClass: "execution", createdAt: f.clock() });
    await f.tick();
    assert.ok(f.calls.some((call) => call.startsWith("abort:")));
    assert.equal(new ProgramRepository(f.handle).get("p")?.status, "incomplete");
    const report = await f.services.closeout.close("p", f.clock(), "again");
    assert.ok(report.snapshotId); assert.ok(report.reasons.includes("reservation_state_unresolved"));
    assert.equal(report.reservations.active ?? 0, 0); assert.ok(report.reservations.uncertain);
    assert.equal(f.tasks.length, 1);
  } finally { f.close(); }
});

test("durable closing_out finalization resumes through the wakeup worker after restart", async () => {
  const f = fixture();
  try {
    await f.tick();
    const program = new ProgramRepository(f.handle).get("p")!;
    await f.services.control.interrupt("p", { controlRequestId: "operator-close", mode: "cancel_closeout", reason: "stop", expectedRevision: program.revision, requestedAt: f.clock() });
    assert.equal(new ProgramRepository(f.handle).get("p")?.status, "closing_out");
    f.reopen(); f.time(62);
    const wakeups = new ProgramWakeupRuntime(f.handle, (id, now) => f.services.coordinator.tick(id, now), f.clock);
    await wakeups.poll(); await wakeups.stop();
    assert.equal(new ProgramRepository(f.handle).get("p")?.status, "incomplete");
    assert.equal(f.tasks.length, 1); assert.equal(new ExecutionBarrier(f.handle).isFrozen("p"), true);
    const report = await f.services.closeout.close("p", f.clock(), "retry"); assert.ok(report.snapshotId);
  } finally { f.close(); }
});

test("model routing uses priced capability/risk rules and idle configured agents, with no prompt upgrade", async () => {
  const f = fixture();
  try {
    const policy: ProgramModelRoutingPolicy = { requiredCapabilities: ["code"], risk: "medium", candidates: [
      { modelRef: "cheap", capabilities: ["code"], maximumRisk: "high", qualityTier: 1 },
      { modelRef: "test/premium", capabilities: ["code"], maximumRisk: "high", qualityTier: 2 },
      { modelRef: "test/unknown", capabilities: ["code"], maximumRisk: "high", qualityTier: 0 },
    ] };
    const input = { programId: "p", mode: "commit" as const, agents: [{ id: "premium", modelRef: "test/premium" }, { id: "cheap", modelRef: "test/model" }, { id: "unknown", modelRef: "test/unknown" }] };
    assert.equal(selectProgramModelAgent(f.handle, catalog, policy, input)?.agentId, "cheap");
    assert.equal(selectProgramModelAgent(f.handle, catalog, policy, { ...input, agents: [input.agents[0]!] }), undefined);
    assert.equal(selectProgramModelAgent(f.handle, catalog, { ...policy, risk: "high", candidates: policy.candidates.map((item) => ({ ...item, maximumRisk: "low" })) }, input), undefined);
    const drift = parseGlobalModelCatalog({ ...catalog, pricing: { cheap: price("model", 2) } });
    assert.equal(selectProgramModelAgent(f.handle, drift, policy, input), undefined);
    assert.equal(canonicalModelRef("legacy"), "anthropic/legacy");
    await f.tick();
    const call = new ModelCallService(f.handle, "shadow", async () => catalog, f.clock);
    await assert.rejects(() => call.processCall("worker", "test/premium", { stage: "begin", context: { ...f.tasks[0].executionContext!, operationId: "prompt-upgrade" },
      modelRef: "test/premium", callKind: "initial", usageUpperBound: { inputTokens: 1, outputTokens: 1 } }), /MODEL_ROUTE_IDENTITY_MISMATCH/);
  } finally { f.close(); }
});

test("a failed task with a confirmed high-impact effect is not automatically replayed", async () => {
  const f = fixture();
  try {
    await f.tick();
    const context = f.tasks[0].executionContext!;
    const effects = new EffectLedger(f.handle);
    effects.prepare({ id: "sent", programId: ProgramIdSchema.parse("p"), attemptId: AttemptIdSchema.parse(context.attemptId),
      operationKey: "sent", effectType: "external-send", impact: "high", request: { digest: "already-sent" },
      executionEpoch: context.executionEpoch, fencingToken: context.fencingToken, createdAt: f.clock() });
    effects.transition("sent", "dispatched", f.clock()); effects.transition("sent", "confirmed", f.clock(), { receipt: { id: "external-1" } });
    f.tasks[0].status = QueuedTaskStatusEnum.Failed; await f.tick();
    assert.equal(f.tasks.length, 1);
    assert.equal(new ProgramRepository(f.handle).get("p")?.status, "incomplete");
    const report = await f.services.closeout.close("p", f.clock(), "again");
    assert.equal(f.services.snapshots.get(report.snapshotId!).manifest.reason, "high_impact_effect_before_failure");
  } finally { f.close(); }
});
