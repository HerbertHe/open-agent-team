import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionDatabase } from "../program/execution-database";
import { migrateExecutionDatabase } from "../program/execution-migrations";
import { ProgramRepository } from "../program/execution-repositories";
import { ProgramSchema } from "../program/program-types";
import {
  BudgetAccountRepository,
  BudgetLedger,
  BudgetLedgerError,
  buildProgramAccountTree,
} from "./budget-ledger";

const T0 = "2026-10-10T00:00:00.000Z";
const T1 = "2026-10-10T00:01:00.000Z";
const allocation = {
  planning: { moneyMicros: 10 }, minimumDelivery: { moneyMicros: 100 },
  upgradePool: { moneyMicros: 20 }, validation: { moneyMicros: 30 },
  contingency: { moneyMicros: 10 }, closeout: { moneyMicros: 10 },
};

function setup(name: string) {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`));
  const handle = openExecutionDatabase(root);
  migrateExecutionDatabase(handle);
  new ProgramRepository(handle).create(ProgramSchema.parse({
    id: "program-1", projectId: "project-1", goal: "goal", status: "draft",
    executionEpoch: 0, revision: 0, createdAt: T0, updatedAt: T0,
  }));
  BudgetAccountRepository.from(handle).createBatch(buildProgramAccountTree("program-1", allocation, T0));
  return { root, handle };
}

test("BLH-012 account tree enforces parent limits and protected partitions", () => {
  const { root, handle } = setup("oat-budget-accounts");
  try {
    const accounts = BudgetAccountRepository.from(handle);
    assert.equal(accounts.listByProgram("program-1").length, 8);
    assert.deepEqual(accounts.get("program-1:budget")?.limit, { moneyMicros: 180 });
    const ledger = BudgetLedger.from(handle);
    assert.throws(() => ledger.reserve({
      id: "reservation-protected", programId: "program-1", accountId: "program-1:validation",
      operationKey: "op-protected", amount: { moneyMicros: 1 }, consumerClass: "execution", createdAt: T0,
    }), (error) => error instanceof BudgetLedgerError && error.code === "PROTECTED_PARTITION");
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});

test("BLH-013 operation keys are idempotent and reservations cannot oversell", () => {
  const { root, handle } = setup("oat-budget-reserve");
  try {
    const ledger = BudgetLedger.from(handle);
    const input = {
      id: "reservation-1", programId: "program-1", accountId: "program-1:minimum",
      operationKey: "op-1", amount: { moneyMicros: 70 }, consumerClass: "execution" as const, createdAt: T0,
    };
    assert.deepEqual(ledger.reserve(input), ledger.reserve(input));
    assert.throws(() => ledger.reserve({ ...input, id: "reservation-other", amount: { moneyMicros: 60 } }),
      (error) => error instanceof BudgetLedgerError && error.code === "BUDGET_CONFLICT");
    assert.throws(() => ledger.reserve({
      ...input, id: "reservation-2", operationKey: "op-2", amount: { moneyMicros: 31 },
    }), (error) => error instanceof BudgetLedgerError && error.code === "BUDGET_EXCEEDED");
    assert.deepEqual(BudgetAccountRepository.from(handle).get("program-1:minimum")?.reserved, { moneyMicros: 70 });
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});

test("BLH-014 child settlement avoids double reservation and duplicate usage", () => {
  const { root, handle } = setup("oat-budget-settle");
  try {
    const ledger = BudgetLedger.from(handle);
    let envelope = ledger.reserve({
      id: "envelope-1", programId: "program-1", accountId: "program-1:minimum",
      operationKey: "envelope-op", amount: { moneyMicros: 80 }, consumerClass: "execution", createdAt: T0,
    });
    envelope = ledger.activate(envelope.id, envelope.revision, "envelope-request", T0);
    let child = ledger.reserve({
      id: "call-1", programId: "program-1", accountId: "program-1:minimum",
      parentReservationId: envelope.id, operationKey: "call-op", amount: { moneyMicros: 60 },
      consumerClass: "execution", createdAt: T0,
    });
    child = ledger.activate(child.id, child.revision, "provider-request-1", T0);
    const settled = ledger.settle({
      reservationId: child.id, sourceEventId: "usage-1", actual: { moneyMicros: 50 }, createdAt: T1,
    });
    assert.equal(settled.state, "settled");
    assert.deepEqual(BudgetAccountRepository.from(handle).get("program-1:minimum"), {
      ...BudgetAccountRepository.from(handle).get("program-1:minimum"),
      spent: { moneyMicros: 50 }, reserved: { moneyMicros: 30 },
    });
    assert.deepEqual(ledger.settle({
      reservationId: child.id, sourceEventId: "usage-1", actual: { moneyMicros: 50 }, createdAt: T1,
    }), settled);
    const refreshedEnvelope = ledger.getReservation(envelope.id)!;
    ledger.release(refreshedEnvelope.id, refreshedEnvelope.revision, T1);
    const account = BudgetAccountRepository.from(handle).get("program-1:minimum")!;
    assert.deepEqual(account.spent, { moneyMicros: 50 });
    assert.deepEqual(account.reserved, {});
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});

test("BLH-014 late usage after release is reconciled without hiding factual spend", () => {
  const { root, handle } = setup("oat-budget-late");
  try {
    const ledger = BudgetLedger.from(handle);
    const reservation = ledger.reserve({
      id: "reservation-late", programId: "program-1", accountId: "program-1:minimum",
      operationKey: "op-late", amount: { moneyMicros: 10 }, consumerClass: "execution", createdAt: T0,
    });
    ledger.release(reservation.id, reservation.revision, T0);
    const reconciled = ledger.settle({
      reservationId: reservation.id, sourceEventId: "usage-late", actual: { moneyMicros: 5 }, createdAt: T1,
    });
    assert.equal(reconciled.state, "reconciled");
    assert.deepEqual(BudgetAccountRepository.from(handle).get("program-1:minimum")?.spent, { moneyMicros: 5 });
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});
