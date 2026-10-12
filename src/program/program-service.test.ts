import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express } from "express";
import { parseGlobalModelCatalog } from "../models/global-models";
import { BudgetAccountRepository, BudgetLedger, BudgetLedgerError } from "../budget/budget-ledger";
import { PricingService } from "../budget/pricing-service";
import { openExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { ProgramFeatureDisabledError, ProgramService, registerExperimentalProgramRoutes } from "./program-service";

const T0 = "2026-10-10T00:00:00.000Z";
const T1 = "2026-10-10T00:01:00.000Z";
const allocation = {
  planning: { moneyMicros: 10 }, minimumDelivery: { moneyMicros: 100 }, upgradePool: { moneyMicros: 20 },
  validation: { moneyMicros: 30 }, contingency: { moneyMicros: 10 }, closeout: { moneyMicros: 10 },
};
const catalog = parseGlobalModelCatalog({ pricingRevision: "rev-1", pricing: {} });

test("BLH-020 disabled service exposes no routes and rejects direct use", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-program-disabled-"));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    const service = new ProgramService(handle, false, catalog);
    let registrations = 0;
    const app = new Proxy({}, { get: () => () => { registrations++; } }) as Express;
    assert.equal(registerExperimentalProgramRoutes(app, service, false), false);
    assert.equal(registrations, 0);
    assert.throws(() => service.getDraft("program-1"), ProgramFeatureDisabledError);
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});

test("BLH-020 draft creation atomically creates Program, account tree and pricing snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-program-service-"));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    const service = new ProgramService(handle, true, catalog);
    const input = { id: "program-1", projectId: "project-1", goal: "goal", allocation, pricingSnapshotId: "price-1", createdAt: T0 };
    assert.throws(() => service.createDraft(input, {
      faultInjector: (point) => { if (point === "after_pricing") throw new Error("crash"); },
    }));
    assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM programs").pluck().get(), 0);
    assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM budget_accounts").pluck().get(), 0);
    assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM pricing_snapshots").pluck().get(), 0);

    const created = service.createDraft(input);
    assert.equal(created.status, "draft");
    assert.equal(BudgetAccountRepository.from(handle).listByProgram("program-1").length, 8);
    assert.equal(PricingService.from(handle).getSnapshot("price-1")?.programId, "program-1");
    assert.equal(service.listDrafts("project-1").length, 1);
    const updated = service.updateDraft("program-1", { expectedRevision: 0, goal: "new goal", updatedAt: T1 });
    assert.equal(updated.goal, "new goal");
    service.deleteDraft("program-1", 1);
    assert.equal(service.getDraft("program-1"), undefined);
    assert.equal(handle.connection.prepare("SELECT status FROM programs WHERE id = 'program-1'").pluck().get(), "cancelled");
    assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM budget_accounts").pluck().get(), 8);
    assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM pricing_snapshots").pluck().get(), 1);
    assert.throws(() => BudgetLedger.from(handle).reserve({
      id: "after-delete", programId: "program-1", accountId: "program-1:minimum",
      operationKey: "after-delete", amount: { moneyMicros: 1 }, consumerClass: "execution", createdAt: T1,
    }), (error) => error instanceof BudgetLedgerError && error.code === "INVALID_RESERVATION_STATE");
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});
