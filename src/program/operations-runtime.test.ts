import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { openExecutionDatabase, type ExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { decideBudgetMode } from "./budget-health";
import { RuleBasedModelRouter } from "./model-router";
import { FaultInjectionHarness, InjectedCrashError } from "./fault-injection-harness";
import { ProgramMetrics } from "./program-metrics";
import { EffectLedger } from "./effect-ledger";
import { EffectReconciler } from "./effect-reconciler";
import { AcceptanceValidatorRegistry } from "./acceptance-criteria";
import { VerificationService } from "./verification-service";
import { CloseoutService } from "./closeout-service";
import { Replanner } from "./replanner";
import { AttemptIdSchema, ProgramIdSchema, WorkPackageSchema } from "./program-types";

const T = "2026-10-10T00:00:00.000Z";
const DIGEST = "a".repeat(64);
function withDb(name: string, run: (handle: ExecutionDatabase) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`)); const handle = openExecutionDatabase(root); migrateExecutionDatabase(handle, { appliedAt: T });
  return Promise.resolve(run(handle)).finally(() => { handle.close(); rmSync(root, { recursive: true, force: true }); });
}
function seed(handle: ExecutionDatabase, status = "running"): void {
  handle.connection.prepare("INSERT INTO programs(id,project_id,goal,status,active_plan_version_id,created_at,updated_at) VALUES('p','project','goal',?,NULL,?,?)").run(status, T, T);
  handle.connection.prepare("INSERT INTO plan_versions(id,program_id,version,scope_tier,status,plan_json,created_at,activated_at) VALUES('plan','p',1,'minimum','active','{}',?,?)").run(T, T);
  handle.connection.prepare("UPDATE programs SET active_plan_version_id='plan' WHERE id='p'").run();
  handle.connection.prepare("INSERT INTO work_packages(id,program_id,plan_version_id,stable_key,status,mandatory,definition_json,created_at,updated_at) VALUES('w','p','plan','stable','verifying',1,'{}',?,?)").run(T, T);
  handle.connection.prepare("INSERT INTO work_package_attempts(id,work_package_id,attempt_number,status,execution_epoch,fencing_token,created_at,updated_at) VALUES('a','w',1,'verifying',0,1,?,?)").run(T, T);
}

test("BLH-042 budget health selects explainable modes and never exposes protected partitions", () => {
  assert.equal(decideBudgetMode({ executionAvailable: { moneyMicros: 150 }, projectedMandatoryRemaining: { moneyMicros: 100 } }).mode, "explore");
  assert.equal(decideBudgetMode({ executionAvailable: { moneyMicros: 119 }, projectedMandatoryRemaining: { moneyMicros: 100 } }).mode, "commit");
  const closeout = decideBudgetMode({ executionAvailable: { moneyMicros: 99 }, projectedMandatoryRemaining: { moneyMicros: 100 } });
  assert.equal(closeout.mode, "closeout"); assert.equal(closeout.executionAvailable.moneyMicros, 99); assert.match(closeout.reasons[0]!, /coverage/);
});

test("BLH-043 replanning inherits verified stable work and repeated failures cross the threshold", async () => withDb("replan", (handle) => {
  seed(handle); const replanner = new Replanner(handle, 2);
  assert.equal(replanner.recordFailure({ programId: "p", failureClass: "provider", at: T }), 1);
  const count = replanner.recordFailure({ programId: "p", failureClass: "provider", at: T });
  const base = WorkPackageSchema.parse({ id: "old", stableKey: "same", programId: "p", planVersionId: "plan", title: "x", prompt: "x", targetAgentRole: "worker", dependsOn: [], conflictKeys: [], scopeTier: "minimum", mandatory: true, priority: 1, hardEnvelope: {}, acceptanceCriteria: [{ id: "c", type: "file_exists", path: "x" }], status: "completed", revision: 0, createdAt: T, updatedAt: T });
  const proposed = WorkPackageSchema.parse({ ...base, id: "new", status: "planned" });
  const decision = replanner.plan({ previous: [base], proposed: [proposed], mode: "commit", failureCount: count });
  assert.equal(decision.shouldReplan, true); assert.deepEqual(decision.inheritedCompleted, ["new"]); assert.equal(decision.retained[0]!.status, "completed");
}));

test("BLH-044 model routing ignores prompt upgrades and rejects unknown prices", () => {
  const price = { providerId: "x", modelId: "cheap", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1, cacheReadMicrosPerMillionTokens: 0, cacheWriteMicrosPerMillionTokens: 0, fixedRequestMicros: 0 };
  const router = new RuleBasedModelRouter(parseGlobalModelCatalog({ pricingRevision: "r1", pricing: { cheap: price } }));
  assert.equal(router.route({ candidates: [{ modelRef: "cheap", capabilities: ["code"], maximumRisk: "high", qualityTier: 1 }, { modelRef: "unpriced", capabilities: ["code"], maximumRisk: "high", qualityTier: 1 }], requiredCapabilities: ["code"], risk: "high", mode: "commit", promptRequestedModel: "unpriced" }).modelRef, "cheap");
  assert.throws(() => router.route({ candidates: [{ modelRef: "unpriced", capabilities: [], maximumRisk: "low", qualityTier: 0 }], requiredCapabilities: [], risk: "low", mode: "closeout" }), /NO_PRICED/);
});

test("BLH-041 effect reconciliation is idempotent and unknown high-impact effects never retry", async () => withDb("effects", async (handle) => {
  seed(handle); const ledger = new EffectLedger(handle);
  ledger.prepare({ id: "e", programId: ProgramIdSchema.parse("p"), attemptId: AttemptIdSchema.parse("a"), operationKey: "op", effectType: "mail", impact: "high", request: { to: "x" }, executionEpoch: 0, fencingToken: 1, createdAt: T });
  ledger.transition("op", "dispatched", T, { providerRequestId: "provider-1" });
  const unknown = new EffectReconciler(handle, new Map([["mail", { query: async () => ({ state: "unknown" as const, reason: "timeout" }) }]]));
  assert.equal((await unknown.reconcile("p", T)).unresolved[0]!.state, "uncertain");
  const confirmed = new EffectReconciler(handle, new Map([["mail", { query: async () => ({ state: "confirmed" as const, receipt: { id: "sent" } }) }]]));
  assert.equal((await confirmed.reconcile("p", T)).reconciled, 1); assert.equal(ledger.getByOperationKey("op")!.state, "reconciled");
  assert.equal((await confirmed.reconcile("p", T)).reconciled, 0);
}));

test("BLH-041 one failing provider adapter does not abort the remaining reconciliation batch", async () => withDb("effects-isolation", async (handle) => {
  seed(handle); const ledger = new EffectLedger(handle);
  for (const key of ["op-fail", "op-ok"]) {
    ledger.prepare({ id: `e-${key}`, programId: ProgramIdSchema.parse("p"), attemptId: AttemptIdSchema.parse("a"), operationKey: key, effectType: "mail", impact: "high", request: { key }, executionEpoch: 0, fencingToken: 1, createdAt: T });
    ledger.transition(key, "dispatched", T, { providerRequestId: `provider-${key}` });
  }
  const adapters = new Map([["mail", { query: async (effect: import("./effect-ledger").Effect) => {
    if (effect.operationKey === "op-fail") throw new Error("provider unavailable");
    return { state: "confirmed" as const, receipt: { id: "ok" } };
  } }]]);
  const result = await new EffectReconciler(handle, adapters).reconcile("p", T);
  assert.equal(result.reconciled, 1); assert.equal(result.unresolved.length, 1); assert.equal(ledger.getByOperationKey("op-ok")?.state, "confirmed");
}));

test("BLH-045 verifier persists evidence bound to an artifact and rejects self-report-only proof", async () => withDb("verify", async (handle) => {
  seed(handle); const registry = new AcceptanceValidatorRegistry();
  registry.register("file_exists", "v1", async () => ({ passed: true, validatorVersion: "v1", artifactDigest: DIGEST, details: {} }));
  const result = await new VerificationService(handle, registry).verify({ programId: "p", workPackageId: "w", attemptId: "a", criteria: [{ id: "file", type: "file_exists", path: "result" }], workspacePath: "/tmp", createdAt: T });
  assert.equal(result.passed, true); assert.equal(handle.connection.prepare("SELECT artifact_digest FROM verification_evidence").pluck().get(), DIGEST);
  const conflicting = new AcceptanceValidatorRegistry();
  conflicting.register("file_exists", "v2", async () => ({ passed: false, validatorVersion: "v2", artifactDigest: "b".repeat(64), details: {} }));
  await assert.rejects(() => new VerificationService(handle, conflicting).verify({ programId: "p", workPackageId: "w", attemptId: "a", criteria: [{ id: "file", type: "file_exists", path: "result" }], workspacePath: "/tmp", createdAt: T }), /EVIDENCE_CONFLICT/);
}));

test("BLH-046 closeout never reports full delivery without mandatory evidence", async () => withDb("closeout", (handle) => {
  seed(handle); handle.connection.prepare("UPDATE work_packages SET status='completed' WHERE id='w'").run();
  const report = new CloseoutService(handle).close("p", T); assert.equal(report.outcome, "incomplete"); assert.ok(report.reasons.includes("mandatory_evidence_missing"));
}));

test("BLH-049 metrics reject secret-like free-form labels and expose invariant counters", async () => withDb("metrics", (handle) => {
  seed(handle); const metrics = new ProgramMetrics(handle); assert.equal(metrics.snapshot("p").uncertainEffects, 0);
  assert.throws(() => metrics.alert({ programId: "p", code: "SNAPSHOT_FAILURE", severity: "critical", labels: { prompt: "contains spaces and secrets" }, at: T }), /UNSAFE/);
  metrics.alert({ programId: "p", code: "SNAPSHOT_FAILURE", severity: "critical", labels: { reason: "io_error" }, at: T }); assert.equal(metrics.snapshot("p").openAlerts, 1);
}));

test("BLH-050 one-shot crash points support restart-safe idempotency probes", () => {
  const harness = new FaultInjectionHarness(); harness.arm("dispatch_after_provider_accept");
  assert.throws(() => harness.hit("dispatch_after_provider_accept"), InjectedCrashError); assert.doesNotThrow(() => harness.hit("dispatch_after_provider_accept"));
});
