import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { ExecutionAuditRepository } from "../program/execution-audit-repository";
import { ExecutionRuntimeContextSchema } from "../program/execution-runtime-context";
import { openExecutionDatabase } from "../program/execution-database";
import { migrateExecutionDatabase } from "../program/execution-migrations";
import { PlanVersionRepository, ProgramRepository, WorkPackageRepository } from "../program/execution-repositories";
import { PlanVersionSchema, ProgramSchema, WorkPackageSchema } from "../program/program-types";
import { BudgetAccountRepository, BudgetLedger, buildProgramAccountTree } from "./budget-ledger";
import { PricingService, pricingSnapshotFromCatalog } from "./pricing-service";
import { ShadowModelGuard } from "./shadow-model-guard";
import { UsageReconciler } from "./usage-reconciler";
import { ExecutionBarrier, ExecutionBarrierError } from "../program/execution-barrier";

const T0 = "2026-10-10T00:00:00.000Z";
const T1 = "2026-10-10T00:01:00.000Z";

function context(operationId: string) {
  return ExecutionRuntimeContextSchema.parse({
    programId: "program-1", workPackageId: "work-1", attemptId: "attempt-1",
    executionEpoch: 0, fencingToken: 1, operationId,
  });
}

test("BLH-017 shadow observes every call kind without blocking; soft reserves atomically", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-model-guard-"));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    new ProgramRepository(handle).create(ProgramSchema.parse({
      id: "program-1", projectId: "project-1", goal: "goal", status: "draft",
      executionEpoch: 0, revision: 0, createdAt: T0, updatedAt: T0,
    }));
    new PlanVersionRepository(handle).create(PlanVersionSchema.parse({
      id: "plan-1", programId: "program-1", version: 1, reason: "initial", scopeTier: "minimum",
      status: "draft", workPackageIds: ["work-1"], createdBy: "admin", revision: 0, createdAt: T0,
    }));
    new WorkPackageRepository(handle).create(WorkPackageSchema.parse({
      id: "work-1", stableKey: "work-1", programId: "program-1", planVersionId: "plan-1",
      title: "work", prompt: "work", targetAgentRole: "worker", dependsOn: [], conflictKeys: [],
      scopeTier: "minimum", mandatory: true, priority: 1, hardEnvelope: {}, status: "planned",
      revision: 0, createdAt: T0, updatedAt: T0,
    }));
    handle.connection.prepare(`
      INSERT INTO work_package_attempts(
        id, work_package_id, attempt_number, status, execution_epoch, fencing_token, created_at, updated_at
      ) VALUES('attempt-1', 'work-1', 1, 'created', 0, 1, ?, ?)
    `).run(T0, T0);
    BudgetAccountRepository.from(handle).createBatch(buildProgramAccountTree("program-1", {
      planning: {}, minimumDelivery: { moneyMicros: 1_000, inputTokens: 100, outputTokens: 100, modelCalls: 10 },
      upgradePool: {}, validation: {}, contingency: {}, closeout: {},
    }, T0));
    const catalog = parseGlobalModelCatalog({
      pricingRevision: "rev-1",
      pricing: { "p/m": { providerId: "p", modelId: "m", inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 } },
    });
    PricingService.from(handle).createSnapshot(pricingSnapshotFromCatalog("price-1", "program-1", catalog, T0));
    const audit = new ExecutionAuditRepository(handle);
    const guard = new ShadowModelGuard(handle, audit);
    for (const [index, callKind] of ["initial", "tool_continuation", "retry", "compaction", "internal"].entries()) {
      const decision = guard.evaluate({
        mode: "shadow", context: context(`shadow-${index}`), accountId: "program-1:minimum",
        consumerClass: "execution", pricingSnapshotId: "price-1", modelRef: "p/m",
        usageUpperBound: { inputTokens: 10, outputTokens: 200 }, currentCatalog: catalog,
        callKind: callKind as "initial", now: T0,
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.wouldBlock, true);
    }
    assert.equal(audit.findByProgram("program-1").length, 5);
    assert.deepEqual(BudgetAccountRepository.from(handle).get("program-1:minimum")?.reserved, {});

    const soft = guard.evaluate({
      mode: "soft", context: context("soft-1"), accountId: "program-1:minimum",
      consumerClass: "execution", pricingSnapshotId: "price-1", modelRef: "p/m",
      usageUpperBound: { inputTokens: 10, outputTokens: 10 }, currentCatalog: catalog,
      callKind: "retry", now: T0,
    });
    assert.equal(soft.allowed, true);
    assert.match(soft.reservationId ?? "", /^reservation:[a-f0-9]{64}$/);
    assert.equal(BudgetLedger.from(handle).getReservation(soft.reservationId!)?.state, "created");
    const barrier = new ExecutionBarrier(handle); barrier.freeze("program-1", 0, "pause", T0);
    const frozenGuard = new ShadowModelGuard(handle, audit, barrier);
    assert.throws(() => frozenGuard.evaluate({
      mode: "shadow", context: context("frozen-1"), accountId: "program-1:minimum", consumerClass: "execution",
      pricingSnapshotId: "price-1", modelRef: "p/m", usageUpperBound: { inputTokens: 1, outputTokens: 1 },
      currentCatalog: catalog, callKind: "initial", now: T0,
    }), (error) => error instanceof ExecutionBarrierError && error.code === "EXECUTION_FROZEN");
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});

test("BLH-018 reconciler settles queryable usage and charges the upper bound when unknown", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-reconciler-"));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    new ProgramRepository(handle).create(ProgramSchema.parse({
      id: "program-1", projectId: "project-1", goal: "goal", status: "draft",
      executionEpoch: 0, revision: 0, createdAt: T0, updatedAt: T0,
    }));
    BudgetAccountRepository.from(handle).createBatch(buildProgramAccountTree("program-1", {
      planning: {}, minimumDelivery: { moneyMicros: 1_000, inputTokens: 100, outputTokens: 100, modelCalls: 10 },
      upgradePool: {}, validation: {}, contingency: {}, closeout: {},
    }, T0));
    const catalog = parseGlobalModelCatalog({
      pricingRevision: "rev-1",
      pricing: { "p/m": { providerId: "p", modelId: "m", inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 } },
    });
    const pricing = PricingService.from(handle);
    pricing.createSnapshot(pricingSnapshotFromCatalog("price-1", "program-1", catalog, T0));
    const ledger = BudgetLedger.from(handle);
    let found = ledger.reserve({
      id: "reservation-found", programId: "program-1", accountId: "program-1:minimum", operationKey: "found-op",
      amount: { moneyMicros: 20, inputTokens: 10, outputTokens: 10, modelCalls: 1 }, consumerClass: "execution", createdAt: T0,
    });
    found = ledger.activate(found.id, found.revision, "request-found", T0);
    const foundReconciler = new UsageReconciler(ledger, pricing, {
      query: async () => ({ status: "found", sourceEventId: "provider-usage-1", usage: { inputTokens: 4, outputTokens: 3 } }),
    });
    const settled = await foundReconciler.reconcile({ reservationId: found.id, pricingSnapshotId: "price-1", modelRef: "p/m", now: T1 });
    assert.equal(settled.action, "settled");
    assert.deepEqual(settled.reservation.settled, { moneyMicros: 7, inputTokens: 4, outputTokens: 3, modelCalls: 1 });

    let unknown = ledger.reserve({
      id: "reservation-unknown", programId: "program-1", accountId: "program-1:minimum", operationKey: "unknown-op",
      amount: { moneyMicros: 10, inputTokens: 5, outputTokens: 5, modelCalls: 1 }, consumerClass: "execution", createdAt: T0,
    });
    unknown = ledger.activate(unknown.id, unknown.revision, "request-unknown", T0);
    const unknownReconciler = new UsageReconciler(ledger, pricing, { query: async () => ({ status: "unknown", reason: "timeout" }) });
    const conservative = await unknownReconciler.reconcile({ reservationId: unknown.id, pricingSnapshotId: "price-1", modelRef: "p/m", now: T1 });
    assert.equal(conservative.action, "conservative_settlement");
    assert.deepEqual(conservative.reservation.settled, unknown.reserved);
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});
