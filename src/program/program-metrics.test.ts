import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { ProgramMetrics } from "./program-metrics";
import { ProgramService } from "./program-service";
import { ProgramReadModel } from "./program-read-model";
import { parseGlobalModelCatalog } from "../models/global-models";
import { BudgetLedger } from "../budget/budget-ledger";
import { ExecutionAuditRepository } from "./execution-audit-repository";

const T = "2026-10-16T00:00:00.000Z";
const LATER = "2026-10-16T01:00:00.000Z";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "program-metrics-"));
  const db = openExecutionDatabase(root); migrateExecutionDatabase(db);
  new ProgramService(db, true, parseGlobalModelCatalog({})).createDraft({ id: "p", projectId: "project", goal: "verify", createdAt: T, pricingSnapshotId: "prices",
    allocation: { planning: {}, minimumDelivery: { modelCalls: 10, externalUnits: { pages: 10 } }, upgradePool: {}, validation: { modelCalls: 2 }, contingency: {}, closeout: {} } });
  return { db, metrics: new ProgramMetrics(db), close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("metrics include reserved external dimensions, coalesce alerts and resolve repaired gauges", () => {
  const f = fixture();
  try {
    f.db.connection.prepare("UPDATE budget_accounts SET spent_json=?,reserved_json=? WHERE id='p:minimum'")
      .run(JSON.stringify({ externalUnits: { pages: 7 } }), JSON.stringify({ externalUnits: { pages: 4 } }));
    assert.equal(f.metrics.evaluateInvariants("p", T).openAlerts, 1);
    f.metrics.evaluateInvariants("p", LATER);
    assert.equal(f.metrics.snapshot("p").openAlerts, 1);
    f.db.connection.prepare("UPDATE budget_accounts SET reserved_json='{}' WHERE id='p:minimum'").run();
    assert.equal(f.metrics.evaluateInvariants("p", LATER).openAlerts, 0);
    assert.equal((f.metrics.listAlerts("p")[0] as any).resolvedAt, LATER);
  } finally { f.close(); }
});

test("healthy long-running reservations do not alert; old uncertainty does, including terminal Programs", () => {
  const f = fixture();
  try {
    const ledger = BudgetLedger.from(f.db);
    ledger.reserve({ id: "r", programId: "p", accountId: "p:minimum", operationKey: "op", amount: { modelCalls: 1 }, consumerClass: "execution", createdAt: T });
    assert.equal(f.metrics.evaluateInvariants("p", LATER).openAlerts, 0);
    f.db.connection.prepare("UPDATE budget_reservations SET state='uncertain' WHERE id='r'").run();
    f.db.connection.prepare("UPDATE programs SET status='incomplete' WHERE id='p'").run();
    f.metrics.evaluateAll(LATER);
    assert.equal(f.metrics.snapshot("p", LATER).openAlerts, 1);
    assert.equal(f.metrics.snapshot("p", T).unreconciledReservationAgeMs, 0);
    ledger.settle({ reservationId: "r", sourceEventId: "reported", actual: { modelCalls: 1 }, createdAt: LATER });
    assert.equal(f.metrics.evaluateInvariants("p", LATER).openAlerts, 0);
    assert.throws(() => f.metrics.snapshot("p", "invalid"), /timestamp/);
  } finally { f.close(); }
});

test("alert labels cannot smuggle prompts or credentials and dedupe persists across connections", () => {
  const f = fixture(); const other = openExecutionDatabase(path.dirname(path.dirname(f.db.databasePath)));
  try {
    for (const labels of ([{ prompt: "safe-looking-secret" }, { reason: "sk-credential" }, { component: "user-data" }] as Record<string, string>[])) {
      assert.throws(() => f.metrics.alert({ programId: "p", code: "SNAPSHOT_FAILURE", severity: "warning", labels, at: T }), /UNSAFE/);
    }
    const input = { programId: "p", code: "SNAPSHOT_FAILURE" as const, severity: "warning" as const, labels: { reason: "io_error" }, at: T };
    const id = f.metrics.alert(input);
    assert.equal(new ProgramMetrics(other).alert({ ...input, severity: "critical", at: LATER }), id);
    assert.equal((f.metrics.listAlerts("p")[0] as any).severity, "critical");
    const view = new ProgramReadModel(f.db).get("p") as any;
    assert.equal(view.metrics.openAlerts, 1); assert.equal(view.alerts[0].id, id);
  } finally { other.close(); f.close(); }
});

test("duplicate dispatch and unsafe resume audit records raise sticky invariant alerts", () => {
  const f = fixture();
  try {
    const audit = new ExecutionAuditRepository(f.db);
    for (const id of ["one", "two"]) audit.append({ id, programId: "p", actorType: "system", eventType: "runtime.tool_dispatched", requestId: "same-operation", createdAt: T });
    audit.append({ id: "late", programId: "p", actorType: "system", eventType: "runtime.event.applied", metadata: { eventEpoch: 0, currentEpoch: 1 }, createdAt: T });
    audit.append({ id: "resume", programId: "p", actorType: "system", eventType: "program.resumed", metadata: {}, createdAt: T });
    assert.equal(f.metrics.evaluateInvariants("p", T).openAlerts, 3);
    assert.deepEqual((f.metrics.listAlerts("p") as any[]).map((a) => a.code).sort(), ["DUPLICATE_EFFECT", "LATE_EVENT_STATE_ADVANCE", "RESUME_WITHOUT_PREFLIGHT"]);
    assert.equal(f.metrics.evaluateInvariants("p", LATER).openAlerts, 3);
  } finally { f.close(); }
});

test("failed snapshot and overdue quiesce alert without exposing stored error text", () => {
  const f = fixture();
  try {
    f.db.connection.prepare("INSERT INTO program_control_requests(request_id,program_id,mode,state,result_json,created_at,updated_at) VALUES('failed','p','graceful','failed',?,?,?)")
      .run(JSON.stringify({ error: "SECRET_PROVIDER_MESSAGE" }), T, T);
    f.db.connection.prepare("INSERT INTO program_control_requests(request_id,program_id,mode,state,created_at,updated_at) VALUES('stuck','p','immediate','quiescing',?,?)").run(T, T);
    assert.equal(f.metrics.evaluateInvariants("p", LATER).openAlerts, 2);
    assert.equal(JSON.stringify(f.metrics.listAlerts("p")).includes("SECRET_PROVIDER_MESSAGE"), false);
    f.db.connection.prepare("UPDATE program_control_requests SET state='completed' WHERE request_id='stuck'").run();
    assert.equal(f.metrics.evaluateInvariants("p", LATER).openAlerts, 1);
  } finally { f.close(); }
});

test("protected validation spending is allowed; execution reservations in that partition alert", () => {
  const f = fixture();
  try {
    const ledger = BudgetLedger.from(f.db);
    ledger.reserve({ id: "validation", programId: "p", accountId: "p:validation", operationKey: "validation:proof", amount: { modelCalls: 1 }, consumerClass: "validation", createdAt: T });
    assert.equal(f.metrics.evaluateInvariants("p", T).openAlerts, 0);
    // Corrupt the durable row to prove the detector can recognize a bypass of the Ledger guard.
    f.db.connection.prepare("UPDATE budget_reservations SET operation_key='dispatch:illegal' WHERE id='validation'").run();
    assert.equal(f.metrics.evaluateInvariants("p", T).protectedExecutionReservations, 1);
    assert.equal((f.metrics.listAlerts("p")[0] as any).code, "PROTECTED_RESERVE_USED");
  } finally { f.close(); }
});
