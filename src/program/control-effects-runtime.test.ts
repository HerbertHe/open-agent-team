import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionDatabase, type ExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { PlanVersionRepository, ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { PlanVersionSchema, ProgramSchema, WorkPackageSchema } from "./program-types";
import { CheckpointError, CheckpointStore } from "./checkpoint-store";
import { ExecutionBarrier, ExecutionBarrierError } from "./execution-barrier";
import { SuspensionSnapshotManifestSchema, SuspensionSnapshotStore, SnapshotError } from "./suspension-snapshot-store";
import { ProgramControlService, handleStructuredControlIntent, registerExperimentalProgramControlRoutes } from "./program-control-service";
import { ResumeService } from "./resume-service";
import { LateEventReducer } from "./late-event-reducer";
import { EffectLedger } from "./effect-ledger";
import { ToolGuard, ToolGuardError } from "./tool-guard";
import { ExecutionRuntimeContextSchema } from "./execution-runtime-context";
import type { InterruptibleRuntimeProvider } from "../sandbox/interface";
import { RuntimeExecutionGuard, RuntimeExecutionGuardError } from "./runtime-execution-guard";

const T0 = "2026-10-10T00:00:00.000Z"; const T1 = "2026-10-10T00:01:00.000Z";
const T2 = "2026-10-10T00:02:00.000Z"; const T3 = "2026-10-10T00:03:00.000Z";
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function withDb(name: string, run: (handle: ExecutionDatabase, root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`)); const handle = openExecutionDatabase(root); migrateExecutionDatabase(handle);
  return Promise.resolve(run(handle, root)).finally(() => { handle.close(); rmSync(root, { recursive: true, force: true }); });
}
function seed(handle: ExecutionDatabase): void {
  new ProgramRepository(handle).create(ProgramSchema.parse({ id: "program-1", projectId: "project-1", goal: "goal", status: "draft", executionEpoch: 0, revision: 0, createdAt: T0, updatedAt: T0 }));
  new PlanVersionRepository(handle).create(PlanVersionSchema.parse({ id: "plan-1", programId: "program-1", version: 1, reason: "initial", scopeTier: "minimum", status: "active", workPackageIds: ["work-1"], createdBy: "admin", revision: 0, createdAt: T0, activatedAt: T0 }));
  new WorkPackageRepository(handle).create(WorkPackageSchema.parse({ id: "work-1", stableKey: "work-1", programId: "program-1", planVersionId: "plan-1", title: "work", prompt: "work", targetAgentRole: "worker", dependsOn: [], conflictKeys: [], scopeTier: "minimum", mandatory: true, priority: 1, hardEnvelope: { modelCalls: 1 }, acceptanceCriteria: [{ id: "test", type: "command_exit_zero", command: "pnpm test", timeoutSeconds: 60 }], status: "running", revision: 0, createdAt: T0, updatedAt: T0 }));
  handle.connection.prepare("UPDATE programs SET status='running', active_plan_version_id='plan-1' WHERE id='program-1'").run();
  handle.connection.prepare(`INSERT INTO work_package_attempts(id, work_package_id, attempt_number, status, execution_epoch, fencing_token, started_at, created_at, updated_at)
    VALUES('attempt-1','work-1',1,'running',0,1,?,?,?)`).run(T0, T0, T0);
  handle.connection.prepare(`INSERT INTO attempt_leases(attempt_id, owner_id, fencing_token, acquired_at, heartbeat_at, expires_at)
    VALUES('attempt-1','worker-1',1,?,?,?)`).run(T0, T0, T3);
}

class FakeRuntime implements InterruptibleRuntimeProvider {
  readonly calls: string[] = []; constructor(private readonly acknowledge = true) {}
  async requestCheckpoint(agentId: string, attemptId: string): Promise<{ acknowledged: boolean; state: { objective: string; completedSteps: string[]; nextSteps: string[]; facts: Record<string, string>; artifactRefs: never[] } }> { this.calls.push(`checkpoint:${agentId}:${attemptId}`); return { acknowledged: true, state: { objective: "continue", completedSteps: [], nextSteps: ["resume"], facts: {}, artifactRefs: [] } }; }
  async abortAttempt(agentId: string, attemptId: string): Promise<{ acknowledged: boolean; providerRequests: string[]; toolCalls: string[] }> { this.calls.push(`abort:${agentId}:${attemptId}`); return { acknowledged: this.acknowledge, providerRequests: [], toolCalls: [] }; }
  async terminateSession(agentId: string): Promise<void> { this.calls.push(`terminate:${agentId}`); }
  async resetSession(agentId: string): Promise<void> { this.calls.push(`reset:${agentId}`); }
  describeSession(agentId: string): { agentId: string; workspacePath: string } | undefined { return { agentId, workspacePath: process.cwd() }; }
}

test("BLH-031 checkpoint enforces size, epoch/token, expiry and digest", () => withDb("checkpoint", (handle) => {
  seed(handle); const store = new CheckpointStore(handle, 512);
  const saved = store.save({ id: "cp-1", attemptId: "attempt-1", executionEpoch: 0, fencingToken: 1, state: { objective: "finish", completedSteps: ["a"], nextSteps: ["b"], facts: {}, artifactRefs: [] }, expiresAt: T2, createdAt: T0 });
  assert.equal(store.get(saved.id, T1)?.state.nextSteps[0], "b");
  assert.throws(() => store.get(saved.id, T3), (error) => error instanceof CheckpointError && error.code === "CHECKPOINT_EXPIRED");
  assert.throws(() => store.save({ ...saved, id: "cp-stale", fencingToken: 2 }), (error) => error instanceof CheckpointError && error.code === "CHECKPOINT_STALE");
  handle.connection.prepare("UPDATE execution_checkpoints SET digest=? WHERE id='cp-1'").run("0".repeat(64));
  assert.throws(() => store.get("cp-1", T1), (error) => error instanceof CheckpointError && error.code === "CHECKPOINT_CORRUPT");
}));

test("BLH-033 barrier is durable and rejects all old epochs", () => withDb("barrier", (handle) => {
  seed(handle); const barrier = new ExecutionBarrier(handle); barrier.assertAllowed("program-1", 0);
  handle.connection.prepare("UPDATE programs SET execution_epoch=1 WHERE id='program-1'").run(); barrier.freeze("program-1", 1, "pause", T1);
  assert.throws(() => barrier.assertAllowed("program-1", 0), (error) => error instanceof ExecutionBarrierError && error.code === "STALE_EPOCH");
  assert.throws(() => barrier.assertAllowed("program-1", 1), (error) => error instanceof ExecutionBarrierError && error.code === "EXECUTION_FROZEN");
  barrier.release("program-1", 1, T2); barrier.assertAllowed("program-1", 1);
}));

test("runtime boundary rejects frozen, expired and wrong-owner executions", () => withDb("runtime-guard", (handle) => {
  seed(handle);
  const context = ExecutionRuntimeContextSchema.parse({ programId: "program-1", workPackageId: "work-1", attemptId: "attempt-1", executionEpoch: 0, fencingToken: 1, operationId: "op-runtime" });
  const guard = new RuntimeExecutionGuard(handle, () => T1);
  guard.assertAllowed({ phase: "prompt", agentId: "worker-1", context });
  assert.throws(() => guard.assertAllowed({ phase: "tool", agentId: "worker-2", context, toolName: "edit" }), (error) => error instanceof RuntimeExecutionGuardError && error.code === "STALE_EXECUTION");
  const expired = new RuntimeExecutionGuard(handle, () => "2026-10-10T00:04:00.000Z");
  assert.throws(() => expired.assertAllowed({ phase: "prompt", agentId: "worker-1", context }), (error) => error instanceof RuntimeExecutionGuardError && error.code === "STALE_EXECUTION");
  new ExecutionBarrier(handle).freeze("program-1", 0, "pause", T1);
  assert.throws(() => guard.assertAllowed({ phase: "tool", agentId: "worker-1", context, toolName: "edit" }), (error) => error instanceof RuntimeExecutionGuardError && error.code === "STALE_EXECUTION");
}));

test("BLH-034 snapshot excludes unsafe files and detects manifest tampering", () => withDb("snapshot", (handle, root) => {
  seed(handle); const workspace = path.join(root, "workspace"); mkdirSync(workspace); writeFileSync(path.join(workspace, "result.txt"), "ok"); writeFileSync(path.join(workspace, ".env"), "SECRET=x");
  const store = new SuspensionSnapshotStore(handle, root); const base = SuspensionSnapshotManifestSchema.parse({ schemaVersion: 1, id: "snapshot-1", programId: "program-1", planVersionId: "plan-1", executionEpoch: 1, reason: "pause", mode: "graceful", programRevision: 1, budgetStateDigest: sha("budget"), activeReservations: [], uncertainOperations: [], workPackages: [], artifacts: [{ path: "result.txt", digest: sha("ok"), verified: true }], workspaceStates: [], wakeups: [], externalReceipts: [], pendingApprovals: [], resumePreconditions: [], createdAt: T1 });
  store.create(base, [{ workspaceRoot: workspace, relativePath: "result.txt" }]); assert.equal(store.get("snapshot-1").manifest.reason, "pause");
  const unsafe = { ...base, id: "snapshot-2", executionEpoch: 2, artifacts: [{ path: ".env", digest: sha("SECRET=x"), verified: false }] };
  assert.throws(() => store.create(unsafe, [{ workspaceRoot: workspace, relativePath: ".env" }]), (error) => error instanceof SnapshotError && error.code === "UNSAFE_ARTIFACT");
  const manifestPath = path.join(root, "execution", "snapshots", "snapshot-1", "manifest.json"); writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")} `);
  assert.throws(() => store.get("snapshot-1"), (error) => error instanceof SnapshotError && error.code === "SNAPSHOT_CORRUPT");
}));

test("BLH-050 snapshot crash is retryable without duplicate rows", () => withDb("snapshot-crash", (handle, root) => {
  seed(handle); const store = new SuspensionSnapshotStore(handle, root);
  const manifest = SuspensionSnapshotManifestSchema.parse({ schemaVersion: 1, id: "snapshot-crash", programId: "program-1", planVersionId: "plan-1", executionEpoch: 1, reason: "pause", mode: "immediate", programRevision: 1, budgetStateDigest: sha("budget"), activeReservations: [], uncertainOperations: [], workPackages: [], artifacts: [], workspaceStates: [], wakeups: [], externalReceipts: [], pendingApprovals: [], resumePreconditions: [], createdAt: T1 });
  assert.throws(() => store.create(manifest, [], (point) => { if (point === "snapshot_after_manifest") throw new Error("crash"); }), /crash/);
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM suspension_snapshots").pluck().get(), 0);
  assert.equal(store.create(manifest).manifest.id, "snapshot-crash");
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM suspension_snapshots").pluck().get(), 1);
}));

test("BLH-032/035/036 interrupt freezes, aborts, snapshots and is request-id idempotent", () => withDb("control", async (handle, root) => {
  seed(handle); const runtime = new FakeRuntime(); const snapshots = new SuspensionSnapshotStore(handle, root); const service = new ProgramControlService(handle, runtime, snapshots, true);
  const request = { controlRequestId: "control-1", mode: "graceful" as const, reason: "user pause", expectedRevision: 0, requestedAt: T1 };
  const result = await handleStructuredControlIntent(service, { controlIntent: "interrupt_program", programId: "program-1", request });
  assert.equal(result.state, "suspended"); assert.deepEqual(runtime.calls, ["checkpoint:worker-1:attempt-1", "abort:worker-1:attempt-1"]);
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM attempt_leases").pluck().get(), 0); assert.equal(new ExecutionBarrier(handle).isFrozen("program-1"), true);
  assert.deepEqual(await service.interrupt("program-1", request), result); assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM suspension_snapshots").pluck().get(), 1);
  assert.equal(registerExperimentalProgramControlRoutes({} as never, service, false), false);
}));

test("BLH-037 resume dry-run requires confirmation, resets Session and creates a new epoch", () => withDb("resume", async (handle, root) => {
  seed(handle); const runtime = new FakeRuntime(); const snapshots = new SuspensionSnapshotStore(handle, root); const control = new ProgramControlService(handle, runtime, snapshots, true);
  const suspended = await control.interrupt("program-1", { controlRequestId: "control-resume", mode: "immediate", reason: "pause", expectedRevision: 0, requestedAt: T1, attempts: [{ agentId: "worker-1", attemptId: "attempt-1" }] });
  const resume = new ResumeService(handle, snapshots, runtime); const report = resume.dryRun({ programId: "program-1", snapshotId: suspended.snapshotId });
  assert.equal(report.requiresConfirmation, true); assert.deepEqual(report.blockingDrift, []);
  await assert.rejects(() => resume.resume({ requestId: "resume-0", expectedRevision: 5, report, confirmed: false, agentIds: ["worker-1"], now: T2 }), /confirmation/);
  const revision = handle.connection.prepare("SELECT revision FROM programs WHERE id='program-1'").pluck().get() as number;
  const result = await resume.resume({ requestId: "resume-1", expectedRevision: revision, report, confirmed: true, agentIds: ["worker-1"], now: T2 });
  assert.equal(result.executionEpoch, 2); assert.ok(runtime.calls.includes("reset:worker-1")); new ExecutionBarrier(handle).assertAllowed("program-1", 2);
  const resumedAttempt = handle.connection.prepare("SELECT execution_epoch, fencing_token FROM work_package_attempts WHERE id LIKE 'resume:%'").get() as { execution_epoch: number; fencing_token: number };
  assert.equal(resumedAttempt.execution_epoch, 2); assert.ok(resumedAttempt.fencing_token > 1);
}));

test("BLH-050 startup recovery fail-closes interrupted resume", () => withDb("resume-recovery", (handle, root) => {
  seed(handle); handle.connection.prepare("UPDATE programs SET status='reconciling' WHERE id='program-1'").run();
  new ExecutionBarrier(handle).freeze("program-1", 0, "resume_transition", T1);
  const resume = new ResumeService(handle, new SuspensionSnapshotStore(handle, root), new FakeRuntime());
  assert.equal(resume.recoverInterrupted(T2), 1);
  assert.equal(handle.connection.prepare("SELECT status FROM programs WHERE id='program-1'").pluck().get(), "suspended");
}));

test("BLH-038 old epoch state is ignored while usage remains reconcilable", () => withDb("late", (handle) => {
  seed(handle); handle.connection.prepare("UPDATE programs SET execution_epoch=1 WHERE id='program-1'").run(); const reducer = new LateEventReducer(handle);
  assert.equal(reducer.apply({ id: "late-state", programId: "program-1", attemptId: "attempt-1", executionEpoch: 0, fencingToken: 1, kind: "state", payload: { status: "completed" }, now: T1 }), "ignored_for_state");
  assert.equal(reducer.apply({ id: "late-usage", programId: "program-1", attemptId: "attempt-1", executionEpoch: 0, fencingToken: 1, kind: "usage", payload: { tokens: 10 }, now: T1 }), "applied_to_ledger_only");
}));

test("BLH-039/040 effect ledger and Tool Guard block stale tokens and uncontrolled hard effects", () => withDb("effects", (handle) => {
  seed(handle); const guard = new ToolGuard(handle); const context = ExecutionRuntimeContextSchema.parse({ programId: "program-1", workPackageId: "work-1", attemptId: "attempt-1", executionEpoch: 0, fencingToken: 1, operationId: "op-1" });
  const prepared = guard.authorize({ context, toolName: "send-email", permittedTools: new Set(["send-email"]), budgetAllowed: true, mode: "soft", impact: "high", providerSupportsIdempotency: false, operationKey: "effect-1", request: { to: "a@example.com" }, effectId: "effect-id-1", now: T1 });
  const ledger = new EffectLedger(handle); assert.equal(ledger.transition(prepared.operationKey, "dispatched", T1, { providerRequestId: "provider-1" }).state, "dispatched");
  assert.equal(ledger.transition(prepared.operationKey, "confirmed", T2, { receipt: { delivered: true } }).receiptDigest?.length, 64);
  assert.throws(() => guard.authorize({ context: { ...context, fencingToken: 2 }, toolName: "send-email", permittedTools: new Set(["send-email"]), budgetAllowed: true, mode: "soft", impact: "low", providerSupportsIdempotency: true, operationKey: "effect-2", request: {}, effectId: "effect-id-2", now: T1 }), (error) => error instanceof ToolGuardError && error.code === "STALE_EXECUTION");
  assert.throws(() => guard.authorize({ context, toolName: "send-email", permittedTools: new Set(["send-email"]), budgetAllowed: true, mode: "hard", impact: "high", providerSupportsIdempotency: false, operationKey: "effect-3", request: {}, effectId: "effect-id-3", now: T1 }), (error) => error instanceof ToolGuardError && error.code === "HIGH_IMPACT_UNCONTROLLED");
}));
