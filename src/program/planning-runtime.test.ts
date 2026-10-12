import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionDatabase, type ExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { PlanVersionRepository, ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { PlanVersionSchema, ProgramSchema, WorkPackageSchema, type WorkPackage } from "./program-types";
import { PlanActivationService } from "./plan-activation-service";
import { PlanScheduler } from "./plan-scheduler";
import { LeaseError, LeaseService } from "./lease-service";
import { WakeupService } from "./wakeup-service";
import { TaskBoardProjectionWorker } from "./task-board-projection";
import { WorkPackageCostEstimator } from "./cost-estimator";
import { AdmissionController } from "./admission-controller";
import { PlanningArtifactConflictError, PlanningArtifactRepository } from "./planning-artifact-repository";

const T0 = "2026-10-10T00:00:00.000Z";
const T1 = "2026-10-10T00:01:00.000Z";
const T2 = "2026-10-10T00:02:00.000Z";
const T3 = "2026-10-10T00:03:00.000Z";

function work(id: string, options: Record<string, unknown> = {}): WorkPackage {
  return WorkPackageSchema.parse({
    id, stableKey: id, programId: "program-1", planVersionId: "plan-1", title: id, prompt: `Implement ${id}`,
    targetAgentRole: "worker", dependsOn: [], conflictKeys: [], scopeTier: "minimum", mandatory: true,
    priority: 1, hardEnvelope: { moneyMicros: 10 },
    acceptanceCriteria: [{ id: `${id}-test`, type: "command_exit_zero", command: "pnpm test", timeoutSeconds: 60 }],
    status: "planned", revision: 0, createdAt: T0, updatedAt: T0, ...options,
  });
}

function withDatabase(name: string, run: (handle: ExecutionDatabase) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`));
  const handle = openExecutionDatabase(root);
  migrateExecutionDatabase(handle);
  return Promise.resolve(run(handle)).finally(() => { handle.close(); rmSync(root, { recursive: true, force: true }); });
}

function seed(handle: ExecutionDatabase): { programs: ProgramRepository; plans: PlanVersionRepository; packages: WorkPackageRepository } {
  const programs = new ProgramRepository(handle); const plans = new PlanVersionRepository(handle); const packages = new WorkPackageRepository(handle);
  programs.create(ProgramSchema.parse({ id: "program-1", projectId: "project-1", goal: "ship", status: "planning", executionEpoch: 0, revision: 0, createdAt: T0, updatedAt: T0 }));
  plans.create(PlanVersionSchema.parse({ id: "plan-1", programId: "program-1", version: 1, reason: "initial", scopeTier: "stretch", status: "draft",
    workPackageIds: ["work-root", "work-child", "work-stretch"], createdBy: "admin", revision: 0, createdAt: T0 }));
  packages.createBatch([
    work("work-root", { priority: 10, conflictKeys: ["repo"] }),
    work("work-child", { dependsOn: ["work-root"] }),
    work("work-stretch", { scopeTier: "stretch", mandatory: false }),
  ]);
  plans.transitionStatus("plan-1", 0, "validated");
  return { programs, plans, packages };
}

test("BLH-026 activation validates and atomically exposes only selected runnable roots", () => withDatabase("activation", (handle) => {
  const { programs, plans, packages } = seed(handle); const service = new PlanActivationService(handle);
  assert.throws(() => service.activate({ programId: "program-1", planVersionId: "plan-1", expectedProgramRevision: 0, expectedPlanRevision: 1,
    selectedTier: "standard", approvedAt: T1, faultInjector: (point) => { if (point === "after_outbox") throw new Error("crash"); } }));
  assert.equal(plans.get("plan-1")?.status, "validated");
  assert.equal(programs.get("program-1")?.activePlanVersionId, undefined);
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM execution_outbox").pluck().get(), 0);
  const result = service.activate({ programId: "program-1", planVersionId: "plan-1", expectedProgramRevision: 0, expectedPlanRevision: 1, selectedTier: "standard", approvedAt: T1 });
  assert.equal(result.program.status, "admitted");
  assert.equal(result.program.activePlanVersionId, "plan-1");
  assert.equal(packages.get("work-root")?.status, "runnable");
  assert.equal(packages.get("work-child")?.status, "planned");
  assert.equal(packages.get("work-stretch")?.status, "cancelled");
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM execution_outbox").pluck().get(), 3);
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM acceptance_criteria").pluck().get(), 3);
}));

test("BLH-023/024 estimates and admission decisions are immutable restart-safe artifacts", () => withDatabase("planning-artifacts", (handle) => {
  seed(handle); const repository = new PlanningArtifactRepository(handle);
  const estimate = new WorkPackageCostEstimator().estimate({ workPackage: new WorkPackageRepository(handle).get("work-root")!, durationHintSeconds: 60 });
  repository.saveEstimate(estimate, T1);
  assert.deepEqual(repository.getEstimate("work-root"), estimate);
  assert.throws(() => repository.saveEstimate({ ...estimate, sampleSize: 1 }, T2), PlanningArtifactConflictError);
  const decision = new AdmissionController().evaluate({ workItems: [{ id: "work-root", dependsOn: [], estimate }], budgetLimit: { moneyMicros: 10 }, targetProbability: 0.9, seed: "seed-1" });
  repository.saveAdmissionDecision({ planVersionId: "plan-1", scopeTier: "minimum", decision, createdAt: T1 });
  assert.deepEqual(repository.getAdmissionDecision("plan-1", "minimum"), decision);
}));

test("BLH-027 selector is deterministic and enforces dependency, conflict, tier, capacity and budget", () => {
  const root = work("root", { status: "runnable", priority: 10, conflictKeys: ["repo"] });
  const other = work("other", { status: "runnable", priority: 5, conflictKeys: ["db"], hardEnvelope: { moneyMicros: 20 } });
  const dependent = work("dependent", { status: "runnable", priority: 20, dependsOn: ["missing"] });
  const result = new PlanScheduler().select({ packages: [other, dependent, root], programRunning: true, planActive: true, selectedTier: "standard",
    mode: "balanced", now: T1, maxConcurrency: 1, executionAvailable: { moneyMicros: 15 }, agentAvailable: () => true });
  assert.deepEqual(result.selected.map((item) => item.id), ["root"]);
  assert.ok(result.candidates.find((item) => item.workPackage.id === "dependent")?.blockedBy.includes("DEPENDENCY"));
  assert.ok(result.candidates.find((item) => item.workPackage.id === "other")?.blockedBy.includes("BUDGET"));
});

test("BLH-028 lease fencing rejects concurrent and expired owners", () => withDatabase("lease", (handle) => {
  const { programs, packages } = seed(handle); new PlanActivationService(handle).activate({ programId: "program-1", planVersionId: "plan-1", expectedProgramRevision: 0, expectedPlanRevision: 1, selectedTier: "minimum", approvedAt: T1 });
  programs.transitionStatus("program-1", 1, "running", T1);
  const leases = new LeaseService(handle);
  const first = leases.acquire({ workPackageId: "work-root", ownerId: "worker-a", now: T1, expiresAt: T2, attemptId: "attempt-1" });
  assert.throws(() => leases.acquire({ workPackageId: "work-root", ownerId: "worker-b", now: T1, expiresAt: T3 }), (error) => error instanceof LeaseError && error.code === "LEASE_UNAVAILABLE");
  const second = leases.acquire({ workPackageId: "work-root", ownerId: "worker-b", now: T2, expiresAt: T3, attemptId: "attempt-2" });
  assert.ok(second.fencingToken > first.fencingToken);
  assert.throws(() => leases.transition({ attemptId: first.id, ownerId: "worker-a", fencingToken: first.fencingToken, now: T2, status: "running" }),
    (error) => error instanceof LeaseError && error.code === "STALE_FENCE");
  assert.equal(packages.get("work-root")?.status, "leased");
}));

test("BLH-029 persistent wakeup dispatch is atomic and exactly-once by dedupe key", () => withDatabase("wakeup", (handle) => {
  seed(handle); const wakeups = new WakeupService(handle);
  wakeups.schedule({ id: "wake-1", programId: "program-1", dedupeKey: "daily-1", wakeAt: T1, payload: { reason: "retry" }, createdAt: T0 });
  assert.throws(() => wakeups.dispatchDue({ now: T1, faultInjector: () => { throw new Error("crash"); } }));
  assert.equal(handle.connection.prepare("SELECT state FROM wakeups WHERE id='wake-1'").pluck().get(), "pending");
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM execution_outbox").pluck().get(), 0);
  assert.equal(wakeups.dispatchDue({ now: T1 }).length, 1);
  assert.equal(wakeups.dispatchDue({ now: T3 }).length, 0);
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM execution_outbox WHERE event_type='program.wakeup_due'").pluck().get(), 1);
}));

test("BLH-030 Task Board projection failure is isolated and retryable", () => withDatabase("projection", async (handle) => {
  seed(handle); new PlanActivationService(handle).activate({ programId: "program-1", planVersionId: "plan-1", expectedProgramRevision: 0, expectedPlanRevision: 1, selectedTier: "minimum", approvedAt: T1 });
  handle.connection.prepare("UPDATE execution_outbox SET state='published', published_at=?").run(T1);
  let fail = true; const seen: string[] = [];
  const worker = new TaskBoardProjectionWorker(handle, { applyProjection: (item) => { if (fail) throw new Error("UI down"); seen.push(item.workPackageId); } });
  assert.deepEqual(await worker.projectPublished({ now: T2, limit: 1 }), { projected: 0, failed: 1 });
  assert.equal(new WorkPackageRepository(handle).get("work-root")?.status, "runnable");
  fail = false;
  assert.deepEqual(await worker.projectPublished({ now: T3, limit: 1 }), { projected: 1, failed: 0 });
  assert.equal(seen.length, 1);
}));
