import { canonicalSimulationJson, integratedEvidenceDigest, hasIntegratedSimulationEvidence } from "./simulation-evidence";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseGlobalModelCatalog } from "../models/global-models";
import { BudgetLedger } from "../budget/budget-ledger";
import { ModelCallService } from "../budget/model-call-service";
import { QueuedTaskStatusEnum, type QueuedTask } from "../types";
import type { InterruptibleRuntimeProvider } from "../sandbox/interface";
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
import { SuspensionSnapshotStore } from "./suspension-snapshot-store";
import { ResumeService } from "./resume-service";
import { ToolEffectService } from "./tool-effect-service";
import { ProgramRepository } from "./execution-repositories";
import { SchedulerOwnership } from "./scheduler-ownership";
import { LeaseService } from "./lease-service";
import { ExecutionBarrier } from "./execution-barrier";
import { LateEventReducer } from "./late-event-reducer";
import { FaultInjectionHarness, InjectedCrashError, type FaultPoint } from "./fault-injection-harness";
import { ProgramMetrics } from "./program-metrics";
import { LongHorizonSimulator, VirtualClock, type LongHorizonSimulationResult } from "./long-horizon-simulator";

const DAY = 86_400_000;
const OWNER = "simulation:scheduler";
const hash = (value: unknown) => createHash("sha256").update(canonicalSimulationJson(value)).digest("hex");
const FAULTS: FaultPoint[] = ["reservation_after_account_update", "settlement_before_commit", "lease_after_acquire",
  "dispatch_after_provider_accept", "snapshot_after_manifest", "resume_after_epoch_increment"];

/** Runs only in a fresh temporary directory. External responses are deterministic test doubles. */
export class IntegratedLongHorizonSimulator {
  async run(input: { seed: string; days?: number; programs?: number; startAt?: string }): Promise<LongHorizonSimulationResult> {
    const days = input.days ?? 90; const count = input.programs ?? 2;
    if (!input.seed || input.seed.length > 256) throw new RangeError("A seed of 1..256 characters is required");
    if (!Number.isInteger(days) || days < 90 || days > 366) throw new RangeError("Integrated simulation supports 90..366 days");
    if (!Number.isInteger(count) || count < 2 || count > 16) throw new RangeError("Integrated simulation supports 2..16 Programs");
    const startAt = new VirtualClock(input.startAt ?? "2026-01-01T00:00:00.000Z").now();
    const clock = new VirtualClock(startAt);
    const root = mkdtempSync(path.join(tmpdir(), "oat-integrated-simulation-"));
    let db = openExecutionDatabase(root); migrateExecutionDatabase(db, { appliedAt: clock.now() });
    const tasks: QueuedTask[] = []; // Test adapter survives simulated runtime restarts, like an external durable dispatcher.
    const deliveries = new Map<string, number>();
    const faultHarness = new FaultInjectionHarness(); const faults: string[] = [];
    const trace: unknown[] = [{ seed: input.seed, days, programs: count, startAt }];
    const events: Record<string, number> = {};
    const event = (key: string) => { events[key] = (events[key] ?? 0) + 1; };
    const inject = (point: FaultPoint) => {
      try { faultHarness.hit(point); } catch (error) { faults.push(point); event("injectedCrashes"); throw error; }
    };
    const catalog = parseGlobalModelCatalog({ pricingRevision: "simulation-v1", models: { worker: "test/model" }, pricing: { worker: {
      providerId: "test", modelId: "model", inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000,
    } } });
    let currentCatalog = catalog;
    const providerFaults = [429, 500, 402];
    const runtime: InterruptibleRuntimeProvider = {
      requestCheckpoint: async () => ({ acknowledged: false }),
      abortAttempt: async () => ({ acknowledged: true, providerRequests: [], toolCalls: [] }),
      terminateSession: async () => {}, resetSession: async () => {}, describeSession: () => undefined,
    };
    const programIds = Array.from({ length: count }, (_, i) => `simulation:p${i}`);
    const offset = Number.parseInt(hash(input.seed).slice(0, 4), 16) % 4;
    writeFileSync(path.join(root, ".env"), "SIMULATION_SECRET_DO_NOT_COPY");
    try {
    for (const [i, id] of programIds.entries()) {
      new ProgramService(db, true, catalog).createDraft({ id, projectId: "simulation", goal: "verify simulated delivery", pricingSnapshotId: `${id}:price`, createdAt: clock.now(),
        allocation: { planning: {}, minimumDelivery: { moneyMicros: 100_000, inputTokens: 100_000, outputTokens: 100_000, modelCalls: 100, toolCalls: 100 },
          upgradePool: {}, validation: { modelCalls: 2 }, contingency: {}, closeout: { modelCalls: 2 } } });
      const plans = new ProgramPlanningService(db, true);
      const workDays = [offset, 30, 60, days - 1];
      plans.createPlan(id, { id: `${id}:plan`, expectedProgramRevision: 0, createdBy: "simulation", workPackages: workDays.map((day, n) => ({
        id: `${id}:w${n}`, stableKey: `${id}:w${n}`, title: `stage ${n}`, prompt: "produce the required artifact", targetAgentRole: "worker",
        dependsOn: n ? [`${id}:w${n - 1}`] : [], notBefore: new Date(Date.parse(startAt) + day * DAY).toISOString(),
        scopeTier: "minimum", mandatory: true, priority: 1, hardEnvelope: { moneyMicros: 2_000, inputTokens: 1_000, outputTokens: 1_000, modelCalls: 5, toolCalls: 2 },
        acceptanceCriteria: [{ id: `file-${n}`, type: "file_exists", path: `p${i}-w${n}.txt` }],
      })) }, clock.now());
      plans.evaluate(id, `${id}:plan`, { expectedProgramRevision: 1, expectedPlanRevision: 0, seed: input.seed, samples: 100 }, clock.now());
      // The harness is the explicit approving user; no production approvals are generated.
      plans.approve(id, `${id}:plan`, { expectedProgramRevision: 2, expectedPlanRevision: 2, selectedTier: "minimum", confirmed: true,
        acceptUncalibratedRisk: true, approvedBy: "simulation-user" }, clock.now());
      event("approvedPlans");
    }
    } catch (error) { db.close(); rmSync(root, { recursive: true, force: true }); throw error; }
    function build() {
      const models = new ModelCallService(db, "soft", async () => currentCatalog, () => clock.now(), OWNER);
      const effects = new ToolEffectService(db, "soft", undefined, "simulation", () => clock.now(), undefined, OWNER);
      const snapshots = new SuspensionSnapshotStore(db, root);
      const settle = async (id: string) => { await models.reconcileAttempt(id); await effects.endAttempt(id); };
      const verifier = new ProgramVerificationRuntime(db, (id) => tasks.find((t) => t.id === id), () => root, settle, undefined, () => clock.now(), { autoCloseout: false });
      const control = new ProgramControlService(db, runtime, snapshots, true, (id) => verifier.cancel(id), OWNER);
      const closeout = new ProgramCloseoutRuntime(db, control, snapshots, (id) => verifier.cancel(id), settle);
      const lifecycle = new ProgramLifecycleRuntime(db, async (id, at, reason, current) => { await closeout.close(id, at, reason, current); });
      const coordinator = new ProgramExecutionCoordinator(db, {
        resolveAgent: (work) => `worker-${work.programId.split("p").at(-1)}`, modelRefForAgent: () => "test/model", getTask: (id) => tasks.find((t) => t.id === id),
        findTaskByConflictKey: (key) => [...tasks].reverse().find((t) => t.conflictKey === key),
        createTask: async (body) => { const task = { ...body, id: `sim-task-${tasks.length}`, status: QueuedTaskStatusEnum.Queued, createdAt: clock.now(), updatedAt: clock.now() }; tasks.push(task); event("dispatches"); return task; },
      }, count, { clock: () => clock.now(), instanceId: OWNER, faultInjector: inject, reconcileAttempt: settle,
        verifyProgram: (id, current) => verifier.advance(id, current), maintainProgram: (id, at, current) => lifecycle.advance(id, at, current) });
      const wakeups = new ProgramWakeupRuntime(db, (id, at) => coordinator.tick(id, at), () => clock.now(), 10_000,
        (error) => { if (!(error instanceof InjectedCrashError)) throw error; }, OWNER);
      const resume = new ResumeService(db, snapshots, runtime, inject, OWNER, () => clock.now());
      return { models, effects, snapshots, verifier, control, closeout, coordinator, wakeups, resume };
    }
    let services: ReturnType<typeof build>;
    try { services = build(); } catch (error) { db.close(); rmSync(root, { recursive: true, force: true }); throw error; }
    const reopen = async () => {
      await services.wakeups.stop(); await services.coordinator.stop(); db.close();
      db = openExecutionDatabase(root); migrateExecutionDatabase(db, { appliedAt: clock.now() }); services = build();
      event("restarts"); assert.equal(db.health().quickCheck, "ok");
    };
    let observedBudgetOverrun = 0;
    let staleExecutions = 0; let lateAdvances = 0; let resumeViolations = 0; let secretLeaks = 0; let unexplained = 0;
    try {
      // Exercise transactional rollback at the actual Ledger and Lease fault seams.
      const ledger = new BudgetLedger(db.connection, inject);
      const reservation = { id: "simulation:probe", programId: programIds[0]!, accountId: `${programIds[0]}:minimum`, operationKey: "simulation:probe",
        amount: { modelCalls: 1 }, consumerClass: "execution" as const, createdAt: clock.now() };
      faultHarness.arm("reservation_after_account_update");
      assert.throws(() => ledger.reserve(reservation), InjectedCrashError);
      assert.equal(ledger.getReservation(reservation.id), undefined);
      ledger.reserve(reservation);
      faultHarness.arm("settlement_before_commit");
      const settlement = { reservationId: reservation.id, sourceEventId: "simulation:spend", actual: { modelCalls: 1 }, createdAt: clock.now() };
      assert.throws(() => ledger.settle(settlement), InjectedCrashError);
      assert.equal(db.connection.prepare("SELECT COUNT(*) FROM spend_events WHERE source_event_id='simulation:spend'").pluck().get(), 0);
      ledger.settle(settlement); ledger.settle(settlement);
      const firstWork = `${programIds[0]}:w0`;
      faultHarness.arm("lease_after_acquire");
      assert.throws(() => new LeaseService(db, inject).acquire({ workPackageId: firstWork, ownerId: "probe", now: clock.now(), expiresAt: new Date(Date.parse(clock.now()) + 60_000).toISOString() }), InjectedCrashError);
      assert.equal(db.connection.prepare("SELECT COUNT(*) FROM attempt_leases").pluck().get(), 0);
      await reopen(); faultHarness.arm("dispatch_after_provider_accept");
      let snapshotId = ""; let retriedFailures = 0;
      for (let day = 0; day < days; day++) {
        const dayStart = Date.parse(startAt) + day * DAY;
        if (Date.parse(clock.now()) < dayStart) clock.advance(dayStart - Date.parse(clock.now()));
        if (day === 31 || day === 67) { const logical = clock.logicalNow(); clock.rollback(6 * 3_600_000); assert.equal(clock.logicalNow(), logical); event("clockRollbacks"); }
        if (day === 20) {
          // No live task here: pause between two notBefore windows.
          const original = services.snapshots.create.bind(services.snapshots);
          faultHarness.arm("snapshot_after_manifest");
          services.snapshots.create = (manifest, sources) => {
            try { return original(manifest, sources, inject); }
            catch (error) { if (!(error instanceof InjectedCrashError)) throw error; return original(manifest, sources); }
          };
          const program = new ProgramRepository(db).get(programIds[0]!)!;
          const result = await services.control.interrupt(program.id, { controlRequestId: "simulation:pause", mode: "graceful", reason: "simulation pause",
            expectedRevision: program.revision, requestedAt: clock.now() });
          snapshotId = result.snapshotId; event("suspends");
          const before = tasks.length; await services.wakeups.poll(); assert.equal(tasks.length, before); event("approvalDelays");
        }
        if (day === 21) {
          const id = programIds[0]!;
          const ownership = new SchedulerOwnership(db, OWNER);
          const claim = ownership.claim(id, clock.now())!; ownership.finish(claim);
          const report = services.resume.dryRun({ programId: id, snapshotId });
          assert.deepEqual(report.blockingDrift, []);
          faultHarness.arm("resume_after_epoch_increment");
          await assert.rejects(services.resume.resume({ requestId: "simulation:resume-crash", report, confirmed: true, expectedRevision: new ProgramRepository(db).get(id)!.revision, now: clock.now() }), InjectedCrashError);
          await reopen(); assert.equal(services.resume.recoverInterrupted(clock.now()), 1);
          assert.equal(new ExecutionBarrier(db).isFrozen(id), true);
          const nextOwnership = new SchedulerOwnership(db, OWNER);
          const nextClaim = nextOwnership.claim(id, clock.now())!; nextOwnership.finish(nextClaim);
          const fresh = services.resume.dryRun({ programId: id, snapshotId });
          await services.resume.resume({ requestId: "simulation:resume", report: fresh, confirmed: true, expectedRevision: new ProgramRepository(db).get(id)!.revision, now: clock.now() });
          event("resumes");
          const result = new LateEventReducer(db).apply({ id: "simulation:late", programId: id, executionEpoch: report.oldEpoch, kind: "state", payload: { status: "completed" }, now: clock.now() });
          lateAdvances += Number(result === "applied_to_state"); event("lateEvents");
        }
        if (day > 0 && day % 13 === 0) await reopen();
        if (day === 45) {
          const backup = path.join(root, "backup.db"); await db.connection.backup(backup);
          await services.wakeups.stop(); await services.coordinator.stop(); const target = db.databasePath; db.close();
          copyFileSync(backup, target); db = openExecutionDatabase(root); migrateExecutionDatabase(db); services = build(); event("backupRestores");
        }
        // Several ticks per day process completion, retries and persisted delivery recovery.
        for (let turn = 0; turn < 8; turn++) {
          await services.wakeups.poll(); clock.advance(10_000);
          for (const task of tasks.filter((item) => item.status === QueuedTaskStatusEnum.Queued).sort((a, b) => a.executionContext!.workPackageId.localeCompare(b.executionContext!.workPackageId))) {
            const context = task.executionContext!; const agent = task.targetAgentId!;
            if (context.programId === programIds[1] && day >= 30 && day < 35 && retriedFailures < 2) {
              task.status = QueuedTaskStatusEnum.Failed; retriedFailures++; event("workerDisappearances"); continue;
            }
            const begin = { stage: "begin" as const, context: { ...context, operationId: `simulation:model:${task.id}` }, modelRef: "test/model",
              callKind: "initial" as const, usageUpperBound: { inputTokens: 100, outputTokens: 50 } };
            if (day >= 60) {
              currentCatalog = { ...catalog, pricingRevision: "simulation-v2" };
              await assert.rejects(services.models.processCall(agent, "test/model", begin), /PRICING_CHANGED/); currentCatalog = catalog; event("priceChanges");
            }
            if (providerFaults.length) {
              const status = providerFaults.shift()!;
              const failed = { ...begin, context: { ...begin.context, operationId: `${begin.context.operationId}:provider-${status}` } };
              await services.models.processCall(agent, "test/model", failed);
              const fakeProvider = async () => { throw Object.assign(new Error("simulated provider error"), { status }); };
              await assert.rejects(fakeProvider(), (error: any) => error.status === status);
              await services.models.processCall(agent, "test/model", { stage: "finish", context: failed.context, modelRef: "test/model", outcome: "unknown" });
              event(`provider${status}`);
            }
            await services.models.processCall(agent, "test/model", begin);
            await services.models.processCall(agent, "test/model", { stage: "finish", context: begin.context, modelRef: "test/model", outcome: "reported", usage: { inputTokens: 4 + offset, outputTokens: 2 } });
            event("modelCalls");
            // Observe real gateway rejection before the external receiver can run.
            const definition = JSON.parse(db.connection.prepare("SELECT definition_json FROM work_packages WHERE id=?").pluck().get(context.workPackageId) as string);
            const execute = async () => { const key = definition.stableKey; deliveries.set(key, (deliveries.get(key) ?? 0) + 1); return { content: [{ type: "text" as const, text: "ok" }], details: {} }; };
            const tool = { agentId: agent, workspacePath: root, context, toolName: "report-progress", toolCallId: `simulation:tool:${task.id}`, params: {}, permittedTools: new Set(["report-progress"]), execute };
            const before = [...deliveries.values()].reduce((a, b) => a + b, 0);
            await assert.rejects(services.effects.execute({ ...tool, context: { ...context, fencingToken: context.fencingToken + 100 } }), /stale/i);
            await assert.rejects(services.effects.execute({ ...tool, permittedTools: new Set() }), /PERMISSION/);
            staleExecutions += [...deliveries.values()].reduce((a, b) => a + b, 0) - before; event("staleFencingProbes");
            await services.effects.execute(tool);
            await assert.rejects(services.effects.execute(tool), /REPLAY_BLOCKED/); event("effectReplayProbes");
            writeFileSync(path.join(root, definition.acceptanceCriteria[0].path), `artifact:${input.seed}:${definition.stableKey}`);
            task.status = QueuedTaskStatusEnum.Completed;
          }
        }
        const metrics = new ProgramMetrics(db);
        for (const id of programIds) {
          const values = metrics.evaluateInvariants(id, clock.now());
          observedBudgetOverrun = Math.max(observedBudgetOverrun, values.budgetOverrun!);
          const program = new ProgramRepository(db).get(id)!;
          trace.push({ day, program: id, status: program.status, epoch: program.executionEpoch, metrics: values });
          if (!["running", "waiting", "admitted", "suspended", "completed", "replanning"].includes(program.status)) unexplained++;
        }
      }
      const scalar = (sql: string) => Number(db.connection.prepare(sql).pluck().get() ?? 0);
      const measurements = {
        programs: scalar("SELECT COUNT(*) FROM programs"), completedPrograms: scalar("SELECT COUNT(*) FROM programs WHERE status='completed'"),
        spendEvents: scalar("SELECT COUNT(*) FROM spend_events"), effects: scalar("SELECT COUNT(*) FROM effects WHERE state IN ('confirmed','reconciled')"),
        evidence: scalar("SELECT COUNT(*) FROM verification_evidence WHERE passed=1"), snapshots: scalar("SELECT COUNT(*) FROM suspension_snapshots"),
        resumes: scalar("SELECT COUNT(*) FROM audit_events WHERE event_type='program.resumed'"), wakeups: scalar("SELECT COUNT(*) FROM audit_events WHERE event_type='program.wakeup_consumed'"),
        modelCalls: scalar("SELECT COUNT(*) FROM audit_events WHERE event_type='budget.model_call_started'"),
        openAlerts: scalar("SELECT COUNT(*) FROM program_alerts WHERE resolved_at IS NULL"),
        unresolvedReservations: scalar("SELECT COUNT(*) FROM budget_reservations WHERE state IN ('created','active','uncertain')"),
        replans: scalar("SELECT COUNT(*) FROM plan_versions WHERE version>1"), closeouts: scalar("SELECT COUNT(*) FROM program_closeouts"),
      };
      const snapshotIds = db.connection.prepare("SELECT id FROM suspension_snapshots").pluck().all() as string[];
      writeFileSync(path.join(root, ".env"), "SIMULATION_SECRET_DO_NOT_COPY");
      for (const id of snapshotIds) {
        const { manifest } = services.snapshots.get(id);
        secretLeaks += Number(JSON.stringify(manifest).includes("SIMULATION_SECRET_DO_NOT_COPY"));
        // Exercise the deny-list using a real secret-named artifact; no artifact may be copied.
        const contents = readFileSync(path.join(root, ".env"));
        assert.throws(() => services.snapshots.create({ ...manifest, id: `${id}:unsafe`, artifacts: [{ path: ".env", digest: createHash("sha256").update(contents).digest("hex"), verified: false }] }, [{ workspaceRoot: root, relativePath: ".env" }]), /Unsafe/);
        event("snapshotSecretProbes");
      }
      const scanSnapshot = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) scanSnapshot(file);
          else secretLeaks += Number(readFileSync(file).includes(Buffer.from("SIMULATION_SECRET_DO_NOT_COPY")));
        }
      };
      scanSnapshot(path.join(root, "execution", "snapshots"));
      const metrics = new ProgramMetrics(db); const allMetrics = programIds.map((id) => metrics.snapshot(id, clock.now()));
      resumeViolations += allMetrics.reduce((sum, m) => sum + m.resumesWithoutPreflight!, 0);
      const invariants = {
        budgetOverrun: Math.max(observedBudgetOverrun, allMetrics.reduce((sum, m) => sum + m.budgetOverrun!, 0)),
        duplicateExternalEffects: [...deliveries.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0),
        staleFencingExternalEffects: staleExecutions, lateEventAdvancedState: lateAdvances + allMetrics.reduce((sum, m) => sum + m.lateEventAdvancedState!, 0),
        snapshotSecretLeak: secretLeaks, resumeWithoutPreflight: resumeViolations, unexplainedProgramsAfterRestart: unexplained,
      };
      const integration = { runnerVersion: 1 as const, measurements, faults: [...faults].sort(), digest: "" };
      const passed = Object.values(invariants).every((n) => n === 0) && measurements.completedPrograms === count && measurements.closeouts === count && measurements.openAlerts === 0 && measurements.unresolvedReservations === 0 && FAULTS.every((point) => faults.includes(point));
      const result: LongHorizonSimulationResult = { evidenceLevel: "integrated", seed: input.seed, virtualDays: days, programs: count, events, invariants, passed,
        traceDigest: hash({ trace, integration, invariants }), integration };
      integration.digest = integratedEvidenceDigest(result);
      result.traceDigest = hash({ trace, integration, invariants });
      result.passed = result.passed && hasIntegratedSimulationEvidence(result);
      new LongHorizonSimulator().persist(db, "simulation:result", result, clock.now());
      return result;
    } finally {
      await services.wakeups.stop(); await services.coordinator.stop(); await services.verifier.cancelAll(); db.close(); rmSync(root, { recursive: true, force: true });
    }
  }
}
