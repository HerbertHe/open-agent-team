import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionDatabase, type ExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { ProgramRepository, PlanVersionRepository, WorkPackageRepository } from "./execution-repositories";
import { ProgramSchema, PlanVersionSchema, WorkPackageSchema } from "./program-types";
import { BudgetAccountRepository, buildProgramAccountTree, BudgetLedger } from "../budget/budget-ledger";
import { SchedulerOwnership, assertAttemptSchedulerOwnership } from "./scheduler-ownership";
import { ProgramExecutionCoordinator } from "./program-execution-coordinator";
import { ProgramVerificationRuntime } from "./program-verification-runtime";
import { RuntimeExecutionGuard } from "./runtime-execution-guard";
import { ExecutionOutboxRepository } from "./execution-outbox";
import { ToolGuard } from "./tool-guard";
import { ModelCallService } from "../budget/model-call-service";
import { PricingService, pricingSnapshotFromCatalog } from "../budget/pricing-service";
import { parseGlobalModelCatalog } from "../models/global-models";
import { AcceptanceValidatorRegistry } from "./acceptance-criteria";
import { ProgramControlService } from "./program-control-service";
import { SuspensionSnapshotStore } from "./suspension-snapshot-store";
import { ResumeService } from "./resume-service";
import { ExecutionBarrier } from "./execution-barrier";
import { ToolEffectService } from "./tool-effect-service";
import { EffectLedger } from "./effect-ledger";
import { AttemptIdSchema, ProgramIdSchema } from "./program-types";
import { QueuedTaskStatusEnum, type QueuedTask } from "../types";
import type { ExecutionRuntimeContext } from "./execution-runtime-context";

const T = "2026-10-16T00:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T) + seconds * 1000).toISOString();
const catalog = parseGlobalModelCatalog({ pricingRevision: "r1", pricing: { "test/model": {
  providerId: "test", modelId: "model", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1,
} } });

function seed(handle: ExecutionDatabase, id = "p", conflicts = ["repo"]) {
  new ProgramRepository(handle).create(ProgramSchema.parse({ id, projectId: "project", goal: "ship", status: "admitted", executionEpoch: 0, revision: 0, createdAt: T, updatedAt: T }));
  new PlanVersionRepository(handle).create(PlanVersionSchema.parse({ id: `${id}-plan`, programId: id, version: 1, reason: "initial", scopeTier: "minimum", status: "active", workPackageIds: [`${id}-work`], createdBy: "user", revision: 0, createdAt: T, activatedAt: T }));
  handle.connection.prepare("UPDATE programs SET active_plan_version_id=? WHERE id=?").run(`${id}-plan`, id);
  new WorkPackageRepository(handle).create(WorkPackageSchema.parse({ id: `${id}-work`, stableKey: "work", programId: id, planVersionId: `${id}-plan`, title: "work", prompt: "Implement bounded work", targetAgentRole: "worker", dependsOn: [], conflictKeys: conflicts, scopeTier: "minimum", mandatory: true, priority: 1,
    hardEnvelope: { modelCalls: 3, moneyMicros: 100, inputTokens: 100, outputTokens: 100 }, acceptanceCriteria: [{ id: "file", type: "file_exists", path: "result.txt" }], status: "runnable", revision: 0, createdAt: T, updatedAt: T }));
  BudgetAccountRepository.from(handle).createBatch(buildProgramAccountTree(id, { planning: {}, minimumDelivery: { modelCalls: 10, moneyMicros: 1000, inputTokens: 1000, outputTokens: 1000 }, upgradePool: {}, validation: {}, contingency: {}, closeout: {} }, T));
  PricingService.from(handle).createSnapshot(pricingSnapshotFromCatalog(`${id}-prices`, id, catalog, T));
}

const childSource = `
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { openExecutionDatabase } from './src/program/execution-database.ts';
import { migrateExecutionDatabase } from './src/program/execution-migrations.ts';
import { ProgramExecutionCoordinator } from './src/program/program-execution-coordinator.ts';
const root=process.env.TEST_STATE_ROOT, owner=process.env.TEST_OWNER;
const db=openExecutionDatabase(root); migrateExecutionDatabase(db);
let now=${JSON.stringify(T)}, release;
const tasks=new Map();
const coordinator=new ProgramExecutionCoordinator(db,{
  resolveAgent:()=>process.env.TEST_AGENT ?? 'worker',
  getTask:(id)=>tasks.get(id),
  findTaskByConflictKey:(key)=>[...tasks.values()].find(t=>t.conflictKey===key),
  modelRefForAgent:()=> 'test/model',
  createTask:async(body)=>{
    const task={...body,id:'task-'+owner,status:'queued',createdAt:now,updatedAt:now}; tasks.set(task.id,task);
    appendFileSync(path.join(root,'external-dispatches.jsonl'),JSON.stringify(task)+'\\n');
    const pending=new Promise(resolve=>{release=resolve}); process.send({type:'creating',task});
    if(process.env.TEST_HOLD==='1') await pending;
    return task;
  }
},1,{instanceId:owner,clock:()=>now});
process.on('message',async(message)=>{
  if(message.type==='time') {now=message.now;process.send({type:'time-set'});}
  if(message.type==='release') release?.();
  if(message.type==='tick') {
    if(message.now) now=message.now;
    try {process.send({type:'result',result:await coordinator.tick(message.programId ?? 'p',now)});}
    catch(error){process.send({type:'result',error:String(error),code:error.code});}
  }
  if(message.type==='stop'){await coordinator.stop();db.close();process.exit(0);}
});
process.send({type:'ready'});
`;
type Message = { type: string; [key: string]: any };
function waitFor(child: ChildProcess, type: string): Promise<Message> {
  const result = new Promise<Message>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Child timed out waiting for ${type}`)); }, 15_000);
    const message = (value: Message) => { if (value.type === type) { cleanup(); resolve(value); } };
    const exit = (code: number | null) => { cleanup(); reject(new Error(`Child exited ${code} before ${type}`)); };
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); };
    child.on("message", message); child.on("exit", exit);
  });
  void result.catch(() => undefined);
  return result;
}
async function start(root: string, owner: string, hold = false, agent = "worker") {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
    cwd: process.cwd(), env: { ...process.env, TEST_STATE_ROOT: root, TEST_OWNER: owner, TEST_HOLD: hold ? "1" : "0", TEST_AGENT: agent },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = ""; child.stderr!.on("data", (value) => { stderr += value; });
  try { await waitFor(child, "ready"); } catch (error) { child.kill("SIGKILL"); throw new Error(`${error}: ${stderr}`); }
  return child;
}
async function command(child: ChildProcess, message: Message, resultType = "result") {
  const result = waitFor(child, resultType); child.send(message); return result;
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cross-instance-"));
  const handle = openExecutionDatabase(root); migrateExecutionDatabase(handle); seed(handle);
  return { root, handle, close: () => { handle.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
  child.send({ type: "release" });
  child.send({ type: "stop" }); await exited; clearTimeout(deadline);
}

test("two real processes cannot compensate or double-dispatch while another instance is creating a task", { timeout: 20_000 }, async () => {
  const f = fixture(); let a: ChildProcess | undefined; let b: ChildProcess | undefined;
  try {
    [a, b] = await Promise.all([start(f.root, "instance-a", true), start(f.root, "instance-b")]);
    const creating = waitFor(a, "creating"); const resultA = waitFor(a, "result"); a.send({ type: "tick" }); await creating;
    const resultB = await command(b, { type: "tick" }); assert.equal(resultB.result.mode, "standby");
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM work_package_attempts").pluck().get(), 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM budget_reservations").pluck().get(), 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM audit_events WHERE event_type='program.work_dispatch_failed'").pluck().get(), 0);
    a.send({ type: "release" }); assert.equal((await resultA).result.dispatched.length, 1);
    assert.equal(readFileSync(path.join(f.root, "external-dispatches.jsonl"), "utf8").trim().split("\n").length, 1);
  } finally { await stop(a); await stop(b); f.close(); }
});

test("expired instance is fenced after takeover; unknown remote dispatch retains budget, accepts late usage and never replays", { timeout: 20_000 }, async () => {
  const f = fixture(); let a: ChildProcess | undefined; let b: ChildProcess | undefined;
  try {
    [a, b] = await Promise.all([start(f.root, "instance-a", true), start(f.root, "instance-b")]);
    const creating = waitFor(a, "creating"); const resultA = waitFor(a, "result"); a.send({ type: "tick" });
    const { task } = await creating; const context = task.executionContext as ExecutionRuntimeContext;
    const models = new ModelCallService(f.handle, "soft", async () => catalog, () => T, "instance-a");
    const request = { stage: "begin" as const, context: { ...context, operationId: "accepted-provider-call" }, modelRef: "test/model", callKind: "initial" as const,
      usageUpperBound: { inputTokens: 1, outputTokens: 1 } };
    await models.processCall("worker", "test/model", request);
    const takeover = await command(b, { type: "tick", now: at(61) });
    assert.equal(takeover.result.dispatched.length, 0);
    assert.equal(f.handle.connection.prepare("SELECT status FROM work_package_attempts WHERE id=?").pluck().get(context.attemptId), "uncertain");
    assert.equal(BudgetLedger.from(f.handle).getReservation(context.reservationId!)?.state, "uncertain");
    assert.throws(() => new RuntimeExecutionGuard(f.handle, () => at(61), "instance-a").assertAllowed({ phase: "model", agentId: "worker", context }), /stale|foreign/i);
    assert.throws(() => new ToolGuard(f.handle).authorize({ context, agentId: "worker", instanceId: "instance-a", toolName: "write", permittedTools: new Set(["write"]), budgetAllowed: true,
      mode: "soft", impact: "medium", providerSupportsIdempotency: false, operationKey: "stale-write", effectId: "stale-write", request: {}, now: at(61) }), /stale|foreign/i);
    await command(a, { type: "time", now: at(61) }, "time-set"); a.send({ type: "release" });
    assert.equal((await resultA).code, "SCHEDULER_FENCED");
    await models.processCall("worker", "test/model", { stage: "finish", context: request.context, modelRef: request.modelRef, outcome: "reported", usage: { inputTokens: 1, outputTokens: 1 } });
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM spend_events").pluck().get(), 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM audit_events WHERE event_type='program.work_dispatched'").pluck().get(), 0);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM audit_events WHERE event_type='program.work_dispatch_uncertain'").pluck().get(), 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM work_package_attempts").pluck().get(), 1);
    assert.equal(f.handle.connection.prepare("SELECT fencing_token FROM program_scheduler_leases WHERE program_id='p'").pluck().get(), 2);
  } finally { await stop(a); await stop(b); f.close(); }
});

test("different Programs coordinate project resource claims across real processes without leaking reservations", { timeout: 20_000 }, async () => {
  const f = fixture(); seed(f.handle, "other"); let a: ChildProcess | undefined; let b: ChildProcess | undefined;
  try {
    [a, b] = await Promise.all([start(f.root, "instance-a", true, "worker-a"), start(f.root, "instance-b", false, "worker-b")]);
    const creating = waitFor(a, "creating"); const resultA = waitFor(a, "result"); a.send({ type: "tick" }); await creating;
    const blocked = await command(b, { type: "tick", programId: "other" });
    assert.equal(blocked.result.dispatched.length, 0);
    assert.equal(BudgetAccountRepository.from(f.handle).get("other:minimum")?.reserved.modelCalls ?? 0, 0);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM work_package_attempts").pluck().get(), 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM execution_resource_claims").pluck().get(), 2);
    a.send({ type: "release" }); await resultA;
  } finally { await stop(a); await stop(b); f.close(); }
});

test("owner lease renewals cannot resurrect an expired fence and late finish cannot release the successor tick", () => {
  const f = fixture();
  try {
    const a = new SchedulerOwnership(f.handle, "a"); const b = new SchedulerOwnership(f.handle, "b");
    const first = a.claim("p", T)!;
    assert.equal(b.claim("p", at(59)), undefined);
    assert.equal(a.renew("p", first.fencingToken, at(61), first.tickId), false);
    const next = b.claim("p", at(61))!;
    a.finish(first); a.relinquish(at(62));
    assert.doesNotThrow(() => b.assertCurrent(next, at(62)));
    assert.throws(() => a.assertCurrent(first, at(62)), /stale/);
    assert.equal(next.fencingToken, 2);
  } finally { f.close(); }
});

test("outbox consumers on a standby instance cannot steal the current scheduler's wakeup", () => {
  const f = fixture();
  try {
    const owner = new SchedulerOwnership(f.handle, "a"); owner.finish(owner.claim("p", T)!);
    const outbox = new ExecutionOutboxRepository(f.handle);
    outbox.enqueue({ id: "wake-event", dedupeKey: "wake-event", aggregateType: "program", aggregateId: "p", eventType: "program.wakeup_due", payload: {}, availableAt: T, createdAt: T });
    assert.equal(outbox.claimNext({ workerId: "b", now: at(1), leaseExpiresAt: at(61), eventType: "program.wakeup_due", schedulerOwnerId: "b" }), undefined);
    assert.equal(outbox.get("wake-event")?.attempts, 0);
    assert.equal(outbox.claimNext({ workerId: "a", now: at(1), leaseExpiresAt: at(61), eventType: "program.wakeup_due", schedulerOwnerId: "a" })?.id, "wake-event");
  } finally { f.close(); }
});

test("verification result from an expired scheduler cannot complete work or persist success evidence", async () => {
  const f = fixture(); const other = openExecutionDatabase(f.root); let now = T;
  try {
    const tasks = new Map<string, QueuedTask>(); let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { started = resolve; });
    const registry = new AcceptanceValidatorRegistry(); registry.register("file_exists", "test-v1", async () => { started(); await gate; return { passed: true, validatorVersion: "test-v1", artifactDigest: "a".repeat(64), details: {} }; });
    const verifier = new ProgramVerificationRuntime(f.handle, (id) => tasks.get(id), () => f.root, async () => {}, registry, () => now, { autoCloseout: false });
    const a = new ProgramExecutionCoordinator(f.handle, { resolveAgent: () => "worker", getTask: (id) => tasks.get(id), findTaskByConflictKey: () => undefined,
      createTask: async (body) => { const task = { ...body, id: "task", status: QueuedTaskStatusEnum.Queued, createdAt: T, updatedAt: T }; tasks.set(task.id, task); return task; } },
    1, { instanceId: "a", clock: () => now, verifyProgram: (id, check) => verifier.advance(id, check) });
    await a.tick("p", T); tasks.get("task")!.status = QueuedTaskStatusEnum.Completed;
    const verifying = a.tick("p", T); const rejected = assert.rejects(verifying, /stale/i); await entered;
    now = at(61);
    const b = new ProgramExecutionCoordinator(other, { resolveAgent: () => "worker", getTask: () => undefined, findTaskByConflictKey: () => undefined,
      createTask: async () => { throw new Error("Must not replay unknown work"); } }, 1, { instanceId: "b", clock: () => now });
    await b.tick("p", now); release(); await rejected;
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM verification_evidence").pluck().get(), 0);
    assert.equal(new WorkPackageRepository(f.handle).get("p-work")?.status, "replanning_required");
    assert.throws(() => assertAttemptSchedulerOwnership(f.handle.connection, tasks.get("task")!.executionContext!.attemptId, "p", now, "a"), /foreign|stale/);
  } finally { other.close(); f.close(); }
});

test("Agent occupancy is exclusive across Programs even without shared conflict keys", async () => {
  const f = fixture(); seed(f.handle, "other", []); const second = openExecutionDatabase(f.root);
  const tasks = new Map<string, QueuedTask>();
  const dispatcher = { resolveAgent: () => "worker", getTask: (id: string) => tasks.get(id), findTaskByConflictKey: () => undefined,
    createTask: async (body: any): Promise<QueuedTask> => { const task = { ...body, id: `task-${tasks.size}`, status: QueuedTaskStatusEnum.Queued, createdAt: T, updatedAt: T }; tasks.set(task.id, task); return task; } };
  try {
    const a = new ProgramExecutionCoordinator(f.handle, dispatcher, 1, { instanceId: "a", clock: () => T });
    const b = new ProgramExecutionCoordinator(second, dispatcher, 1, { instanceId: "b", clock: () => T });
    await a.tick("p", T); assert.equal((await b.tick("other", T)).dispatched.length, 0);
    assert.equal(tasks.size, 1); tasks.get("task-0")!.status = QueuedTaskStatusEnum.Failed;
    await a.tick("p", T); assert.equal((await b.tick("other", T)).dispatched.length, 1);
    assert.equal(tasks.size, 2);
  } finally { second.close(); f.close(); }
});

test("dispatch staging failure rolls back audit, budget, attempt, lease, binding and resource claims together", async () => {
  const f = fixture(); const tasks: QueuedTask[] = [];
  try {
    const c = new ProgramExecutionCoordinator(f.handle, { resolveAgent: () => "worker", getTask: () => undefined, findTaskByConflictKey: () => undefined,
      createTask: async (body): Promise<QueuedTask> => { const task = { ...body, id: "task", status: QueuedTaskStatusEnum.Queued, createdAt: T, updatedAt: T }; tasks.push(task); return task; } }, 1, { clock: () => T });
    f.handle.connection.exec("CREATE TEMP TRIGGER fail_claim BEFORE INSERT ON execution_resource_claims BEGIN SELECT RAISE(ABORT,'claim persistence failed'); END");
    await assert.rejects(() => c.tick("p", T), /claim persistence failed/);
    for (const table of ["work_package_attempts", "attempt_leases", "attempt_execution_owners", "execution_resource_claims", "budget_reservations"]) {
      assert.equal(f.handle.connection.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
    }
    assert.equal(BudgetAccountRepository.from(f.handle).get("p:minimum")?.reserved.modelCalls ?? 0, 0);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM audit_events WHERE event_type='program.work_dispatch_started'").pluck().get(), 0);
    assert.equal(new WorkPackageRepository(f.handle).get("p-work")?.status, "runnable");
    f.handle.connection.exec("DROP TRIGGER fail_claim"); assert.equal((await c.tick("p", T)).dispatched.length, 1);
  } finally { f.close(); }
});

test("interrupt on another instance freezes remote work without aborting an unrelated local Agent with the same name", async () => {
  const f = fixture(); const second = openExecutionDatabase(f.root); let task: QueuedTask | undefined;
  try {
    const a = new ProgramExecutionCoordinator(f.handle, { resolveAgent: () => "worker", getTask: () => task, findTaskByConflictKey: () => task,
      createTask: async (body) => task = { ...body, id: "task", status: QueuedTaskStatusEnum.Queued, createdAt: T, updatedAt: T } }, 1, { instanceId: "a", clock: () => T });
    await a.tick("p", T);
    const calls: string[] = [];
    const control = new ProgramControlService(second, {
      requestCheckpoint: async () => { calls.push("checkpoint"); return { acknowledged: true }; },
      abortAttempt: async () => { calls.push("abort"); return { acknowledged: true, providerRequests: [], toolCalls: [] }; },
      terminateSession: async () => { calls.push("terminate"); }, resetSession: async () => {},
      describeSession: (agentId) => ({ agentId, workspacePath: f.root }),
    }, new SuspensionSnapshotStore(second, f.root), true, undefined, "b");
    const program = new ProgramRepository(second).get("p")!;
    const stopped = await control.interrupt("p", { controlRequestId: "remote-stop", mode: "immediate", reason: "pause", expectedRevision: program.revision, requestedAt: T });
    assert.deepEqual(calls, []); assert.equal(stopped.state, "suspended_uncertain");
    assert.equal(stopped.uncertainAttempts.length, 1);
    assert.throws(() => new RuntimeExecutionGuard(f.handle, () => T, "a").assertAllowed({ phase: "tool", agentId: "worker", context: task!.executionContext! }), /epoch|frozen|stale/i);
  } finally { second.close(); f.close(); }
});

test("two fresh processes can initialize and validate the same execution schema concurrently", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "concurrent-schema-")); let a: ChildProcess | undefined; let b: ChildProcess | undefined;
  try {
    [a, b] = await Promise.all([start(root, "a"), start(root, "b")]);
    const db = openExecutionDatabase(root);
    try {
      assert.equal(db.connection.pragma("user_version", { simple: true }), 7);
      assert.deepEqual(migrateExecutionDatabase(db).appliedVersions, []);
      assert.equal(db.connection.prepare("SELECT COUNT(*) FROM execution_schema_migrations").pluck().get(), 7);
      assert.deepEqual(db.connection.pragma("foreign_key_check"), []);
    } finally { db.close(); }
  } finally { await stop(a); await stop(b); rmSync(root, { recursive: true, force: true }); }
});

test("standby effect reconciliation never turns another live instance's active tool into uncertain", async () => {
  const f = fixture(); let now = T; let task: QueuedTask | undefined;
  try {
    const coordinator = new ProgramExecutionCoordinator(f.handle, { resolveAgent: () => "worker", getTask: () => task, findTaskByConflictKey: () => task,
      createTask: async (body) => task = { ...body, id: "task", status: QueuedTaskStatusEnum.Queued, createdAt: T, updatedAt: T } }, 1, { instanceId: "a", clock: () => now });
    await coordinator.tick("p", T);
    const effects = new EffectLedger(f.handle); const context = task!.executionContext!;
    effects.prepare({ id: "remote-tool", programId: ProgramIdSchema.parse("p"), attemptId: AttemptIdSchema.parse(context.attemptId), operationKey: "remote-tool", effectType: "external-test",
      impact: "high", request: {}, executionEpoch: 0, fencingToken: context.fencingToken, createdAt: T });
    effects.transition("remote-tool", "dispatched", T);
    let queries = 0;
    const service = new ToolEffectService(f.handle, "shadow", async () => { queries++; return { state: "unknown", reason: "no_local_task" }; }, "project", () => now, undefined, "b");
    await service.reconcile("p"); await service.quiesceAll();
    assert.equal(queries, 0); assert.equal(effects.getByOperationKey("remote-tool")?.state, "dispatched");
    now = at(61); await service.reconcile("p");
    assert.equal(queries, 1); assert.equal(effects.getByOperationKey("remote-tool")?.state, "uncertain");
  } finally { f.close(); }
});

test("startup recovery does not roll back a live foreign resume and a foreign instance cannot reset its sessions", async () => {
  const f = fixture();
  try {
    const owner = new SchedulerOwnership(f.handle, "a"); owner.finish(owner.claim("p", T)!);
    f.handle.connection.prepare("UPDATE programs SET status='reconciling' WHERE id='p'").run();
    new ExecutionBarrier(f.handle).freeze("p", 0, "resume_transition", T);
    const snapshots = new SuspensionSnapshotStore(f.handle, f.root);
    snapshots.create({ schemaVersion: 1, id: "snapshot", programId: ProgramIdSchema.parse("p"), planVersionId: "p-plan" as any, executionEpoch: 0,
      reason: "pause", mode: "immediate", programRevision: 0, budgetStateDigest: "a".repeat(64), activeReservations: [], uncertainOperations: [],
      workPackages: [], artifacts: [], workspaceStates: [], wakeups: [], externalReceipts: [], pendingApprovals: [], resumePreconditions: [], createdAt: T });
    let resets = 0;
    const resume = new ResumeService(f.handle, snapshots, { requestCheckpoint: async () => ({ acknowledged: false }),
      abortAttempt: async () => ({ acknowledged: false, providerRequests: [], toolCalls: [] }), terminateSession: async () => {},
      resetSession: async () => { resets++; }, describeSession: () => undefined }, undefined, "b");
    assert.equal(resume.recoverInterrupted(at(10)), 0);
    assert.equal(new ProgramRepository(f.handle).get("p")?.status, "reconciling");
    assert.equal(resume.recoverInterrupted(at(61), true), 1);
    const report = resume.dryRun({ programId: "p", snapshotId: "snapshot" });
    assert.ok(report.blockingDrift.includes("foreign_runtime_owner"));
    await assert.rejects(() => resume.resume({ requestId: "foreign-resume", expectedRevision: 1, report, confirmed: true, now: at(61) }), /Blocking drift/);
    assert.equal(resets, 0);
  } finally { f.close(); }
});

test("a reused local Task ID with another Attempt context cannot be reconciled as successful work", async () => {
  const f = fixture(); let task: QueuedTask | undefined; let creates = 0;
  try {
    const coordinator = new ProgramExecutionCoordinator(f.handle, { resolveAgent: () => "worker", getTask: () => task, findTaskByConflictKey: () => task,
      createTask: async (body) => { creates++; return task = { ...body, id: "same-local-id", status: QueuedTaskStatusEnum.Queued, createdAt: T, updatedAt: T }; } },
    1, { instanceId: "a", clock: () => T });
    await coordinator.tick("p", T);
    const reservationId = task!.executionContext!.reservationId!;
    task = { ...task!, status: QueuedTaskStatusEnum.Completed, executionContext: { ...task!.executionContext!, attemptId: "foreign-attempt" as any } };
    const result = await coordinator.tick("p", T);
    assert.equal(result.reconciled[0]?.status, "uncertain");
    assert.equal(new WorkPackageRepository(f.handle).get("p-work")?.status, "replanning_required");
    assert.equal(BudgetLedger.from(f.handle).getReservation(reservationId)?.state, "uncertain");
    assert.equal(creates, 1);
  } finally { f.close(); }
});
