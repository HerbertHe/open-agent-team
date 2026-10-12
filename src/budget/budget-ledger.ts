import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "../program/execution-database";
import type { FaultPoint } from "../program/fault-injection-harness";
import { OpaqueIdSchema, ProgramIdSchema } from "../program/program-types";
import {
  BudgetAllocationSchema,
  BudgetVectorSchema,
  addBudgetVectors,
  budgetVectorFits,
  isZeroBudgetVector,
  subtractBudgetVectors,
  sumBudgetVectors,
  type BudgetAllocation,
  type BudgetVector,
} from "./budget-types";

const TimestampSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
export const BudgetAccountKindSchema = z.enum([
  "root", "planning", "execution", "minimum", "upgrade_pool", "standard", "stretch",
  "validation", "contingency", "closeout",
]);
export type BudgetAccountKind = z.infer<typeof BudgetAccountKindSchema>;

export const BudgetAccountSchema = z.object({
  id: OpaqueIdSchema,
  programId: ProgramIdSchema,
  parentAccountId: OpaqueIdSchema.optional(),
  kind: BudgetAccountKindSchema,
  limit: BudgetVectorSchema,
  spent: BudgetVectorSchema,
  reserved: BudgetVectorSchema,
  protected: z.boolean(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type BudgetAccount = z.infer<typeof BudgetAccountSchema>;

export const ReservationStateSchema = z.enum([
  "created", "active", "settled", "released", "uncertain", "reconciled", "rejected", "expired",
]);
export type ReservationState = z.infer<typeof ReservationStateSchema>;

export const BudgetReservationSchema = z.object({
  id: OpaqueIdSchema,
  programId: ProgramIdSchema,
  accountId: OpaqueIdSchema,
  parentReservationId: OpaqueIdSchema.optional(),
  operationKey: OpaqueIdSchema,
  state: ReservationStateSchema,
  reserved: BudgetVectorSchema,
  settled: BudgetVectorSchema.optional(),
  remaining: BudgetVectorSchema,
  providerRequestId: OpaqueIdSchema.optional(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

export type BudgetConsumerClass = "planning" | "execution" | "validation" | "contingency" | "closeout";
export type BudgetLedgerErrorCode =
  | "BUDGET_NOT_FOUND" | "BUDGET_CONFLICT" | "BUDGET_EXCEEDED" | "PROTECTED_PARTITION"
  | "INVALID_RESERVATION_STATE" | "ACTIVE_CHILD_RESERVATIONS";

export class BudgetLedgerError extends Error {
  constructor(readonly code: BudgetLedgerErrorCode, message: string) {
    super(message);
    this.name = "BudgetLedgerError";
  }
}

interface AccountRow {
  id: string; program_id: string; parent_account_id: string | null; kind: string;
  limit_json: string; spent_json: string; reserved_json: string; protected: number;
  revision: number; created_at: string; updated_at: string;
}
interface ReservationRow {
  id: string; program_id: string; account_id: string; parent_reservation_id: string | null;
  operation_key: string; state: string; reserved_json: string; settled_json: string | null;
  remaining_json: string; provider_request_id: string | null; revision: number;
  created_at: string; updated_at: string;
}

function parseVector(json: string): BudgetVector {
  return BudgetVectorSchema.parse(JSON.parse(json) as unknown);
}
function accountFromRow(row: AccountRow): BudgetAccount {
  return BudgetAccountSchema.parse({
    id: row.id, programId: row.program_id,
    ...(row.parent_account_id ? { parentAccountId: row.parent_account_id } : {}),
    kind: row.kind, limit: parseVector(row.limit_json), spent: parseVector(row.spent_json),
    reserved: parseVector(row.reserved_json), protected: row.protected === 1, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}
function reservationFromRow(row: ReservationRow): BudgetReservation {
  return BudgetReservationSchema.parse({
    id: row.id, programId: row.program_id, accountId: row.account_id,
    ...(row.parent_reservation_id ? { parentReservationId: row.parent_reservation_id } : {}),
    operationKey: row.operation_key, state: row.state, reserved: parseVector(row.reserved_json),
    ...(row.settled_json ? { settled: parseVector(row.settled_json) } : {}),
    remaining: parseVector(row.remaining_json),
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

const ALLOWED_KINDS: Record<BudgetConsumerClass, readonly BudgetAccountKind[]> = {
  planning: ["planning"],
  execution: ["execution", "minimum", "upgrade_pool", "standard", "stretch"],
  validation: ["validation"],
  contingency: ["contingency"],
  closeout: ["closeout"],
};

export class BudgetAccountRepository {
  constructor(private readonly database: Database.Database) {}

  static from(handle: ExecutionDatabase): BudgetAccountRepository {
    return new BudgetAccountRepository(handle.connection);
  }

  createBatch(inputs: readonly BudgetAccount[]): BudgetAccount[] {
    const accounts = inputs.map((input) => BudgetAccountSchema.parse(input));
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
      throw new BudgetLedgerError("BUDGET_CONFLICT", "Duplicate account ID in batch");
    }
    const byId = new Map(accounts.map((account) => [account.id, account]));
    for (const account of accounts) {
      if (account.kind === "root" && account.parentAccountId) throw new BudgetLedgerError("BUDGET_CONFLICT", "Root account cannot have a parent");
      if (account.kind !== "root" && (!account.parentAccountId || !byId.has(account.parentAccountId))) {
        throw new BudgetLedgerError("BUDGET_CONFLICT", `Account ${account.id} has a missing parent`);
      }
      if (!budgetVectorFits(addBudgetVectors(account.spent, account.reserved), account.limit)) {
        throw new BudgetLedgerError("BUDGET_EXCEEDED", `Account ${account.id} starts over limit`);
      }
    }
    for (const parent of accounts) {
      const childTotal = sumBudgetVectors(accounts.filter((item) => item.parentAccountId === parent.id).map((item) => item.limit));
      if (!budgetVectorFits(childTotal, parent.limit)) {
        throw new BudgetLedgerError("BUDGET_EXCEEDED", `Children exceed parent account ${parent.id}`);
      }
    }
    return this.database.transaction(() => {
      const statement = this.database.prepare(`
        INSERT INTO budget_accounts(
          id, program_id, parent_account_id, kind, limit_json, spent_json, reserved_json,
          protected, revision, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const account of accounts) statement.run(
        account.id, account.programId, account.parentAccountId ?? null, account.kind,
        JSON.stringify(account.limit), JSON.stringify(account.spent), JSON.stringify(account.reserved),
        Number(account.protected), account.revision, account.createdAt, account.updatedAt,
      );
      return accounts;
    }).immediate();
  }

  get(id: string): BudgetAccount | undefined {
    const row = this.database.prepare("SELECT * FROM budget_accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? accountFromRow(row) : undefined;
  }

  listByProgram(programId: string): BudgetAccount[] {
    return (this.database.prepare(
      "SELECT * FROM budget_accounts WHERE program_id = ? ORDER BY id",
    ).all(ProgramIdSchema.parse(programId)) as AccountRow[]).map(accountFromRow);
  }
}

export function buildProgramAccountTree(
  programIdInput: string,
  allocationInput: BudgetAllocation,
  createdAtInput: string,
): BudgetAccount[] {
  const programId = ProgramIdSchema.parse(programIdInput);
  const allocation = BudgetAllocationSchema.parse(allocationInput);
  const createdAt = TimestampSchema.parse(createdAtInput);
  const accountId = (kind: BudgetAccountKind | "budget") => {
    const readable = `${programId}:${kind}`;
    return readable.length <= 128
      ? readable
      : `acct:${createHash("sha256").update(programId).digest("hex").slice(0, 32)}:${kind}`;
  };
  const rootId = accountId("budget");
  const executionLimit = addBudgetVectors(allocation.minimumDelivery, allocation.upgradePool);
  const definitions: Array<[BudgetAccountKind, string | undefined, BudgetVector, boolean]> = [
    ["root", undefined, sumBudgetVectors(Object.values(allocation)), false],
    ["planning", rootId, allocation.planning, true],
    ["execution", rootId, executionLimit, false],
    ["minimum", accountId("execution"), allocation.minimumDelivery, false],
    ["upgrade_pool", accountId("execution"), allocation.upgradePool, false],
    ["validation", rootId, allocation.validation, true],
    ["contingency", rootId, allocation.contingency, true],
    ["closeout", rootId, allocation.closeout, true],
  ];
  return definitions.map(([kind, parentAccountId, limit, protectedAccount]) => BudgetAccountSchema.parse({
    id: kind === "root" ? rootId : accountId(kind),
    programId,
    ...(parentAccountId ? { parentAccountId } : {}),
    kind, limit, spent: {}, reserved: {}, protected: protectedAccount,
    revision: 0, createdAt, updatedAt: createdAt,
  }));
}

export class BudgetLedger {
  private readonly accounts: BudgetAccountRepository;
  constructor(private readonly database: Database.Database, private readonly faultInjector?: (point: FaultPoint) => void) {
    this.accounts = new BudgetAccountRepository(database);
  }

  static from(handle: ExecutionDatabase): BudgetLedger { return new BudgetLedger(handle.connection); }

  getReservation(id: string): BudgetReservation | undefined {
    const row = this.database.prepare("SELECT * FROM budget_reservations WHERE id = ?").get(id) as ReservationRow | undefined;
    return row ? reservationFromRow(row) : undefined;
  }

  reserve(input: {
    id: string; programId: string; accountId: string; parentReservationId?: string;
    operationKey: string; amount: BudgetVector; consumerClass: BudgetConsumerClass; createdAt: string;
  }): BudgetReservation {
    const parsed = {
      id: OpaqueIdSchema.parse(input.id), programId: ProgramIdSchema.parse(input.programId),
      accountId: OpaqueIdSchema.parse(input.accountId),
      ...(input.parentReservationId ? { parentReservationId: OpaqueIdSchema.parse(input.parentReservationId) } : {}),
      operationKey: OpaqueIdSchema.parse(input.operationKey), amount: BudgetVectorSchema.parse(input.amount),
      consumerClass: input.consumerClass, createdAt: TimestampSchema.parse(input.createdAt),
    };
    if (isZeroBudgetVector(parsed.amount)) throw new BudgetLedgerError("BUDGET_CONFLICT", "Reservation amount must be non-zero");
    return this.database.transaction(() => {
      const existingRow = this.database.prepare(
        "SELECT * FROM budget_reservations WHERE operation_key = ?",
      ).get(parsed.operationKey) as ReservationRow | undefined;
      if (existingRow) {
        const existing = reservationFromRow(existingRow);
        if (existing.id !== parsed.id || existing.accountId !== parsed.accountId ||
            existing.parentReservationId !== parsed.parentReservationId || !isDeepStrictEqual(existing.reserved, parsed.amount)) {
          throw new BudgetLedgerError("BUDGET_CONFLICT", `operationKey ${parsed.operationKey} was reused with different input`);
        }
        return existing;
      }
      const account = this.accounts.get(parsed.accountId);
      if (!account || account.programId !== parsed.programId) throw new BudgetLedgerError("BUDGET_NOT_FOUND", `Account ${parsed.accountId} was not found`);
      const programStatus = this.database.prepare("SELECT status FROM programs WHERE id = ?").pluck().get(parsed.programId) as string | undefined;
      if (!programStatus || ["completed", "incomplete", "cancelled"].includes(programStatus)) {
        throw new BudgetLedgerError("INVALID_RESERVATION_STATE", `Program ${parsed.programId} cannot create reservations in state ${programStatus ?? "missing"}`);
      }
      if (!ALLOWED_KINDS[parsed.consumerClass].includes(account.kind)) {
        throw new BudgetLedgerError("PROTECTED_PARTITION", `${parsed.consumerClass} cannot consume ${account.kind}`);
      }
      if (parsed.parentReservationId) {
        const parent = this.getReservation(parsed.parentReservationId);
        if (!parent || parent.accountId !== account.id || !["created", "active"].includes(parent.state)) {
          throw new BudgetLedgerError("INVALID_RESERVATION_STATE", "Parent reservation is unavailable");
        }
        if (!budgetVectorFits(parsed.amount, parent.remaining)) throw new BudgetLedgerError("BUDGET_EXCEEDED", "Parent reservation is exhausted");
        const nextRemaining = subtractBudgetVectors(parent.remaining, parsed.amount);
        this.database.prepare(`
          UPDATE budget_reservations SET remaining_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(JSON.stringify(nextRemaining), parsed.createdAt, parent.id, parent.revision);
      } else {
        const available = subtractBudgetVectors(account.limit, addBudgetVectors(account.spent, account.reserved));
        if (!budgetVectorFits(parsed.amount, available)) throw new BudgetLedgerError("BUDGET_EXCEEDED", `Account ${account.id} has insufficient budget`);
        this.updateAccount(account, account.spent, addBudgetVectors(account.reserved, parsed.amount), parsed.createdAt);
      }
      this.faultInjector?.("reservation_after_account_update");
      const reservation = BudgetReservationSchema.parse({
        id: parsed.id, programId: parsed.programId, accountId: parsed.accountId,
        ...(parsed.parentReservationId ? { parentReservationId: parsed.parentReservationId } : {}),
        operationKey: parsed.operationKey, state: "created", reserved: parsed.amount,
        remaining: parsed.amount, revision: 0, createdAt: parsed.createdAt, updatedAt: parsed.createdAt,
      });
      this.insertReservation(reservation);
      return reservation;
    }).immediate();
  }

  activate(id: string, expectedRevision: number, providerRequestId: string, updatedAt: string): BudgetReservation {
    return this.transition(id, expectedRevision, ["created"], "active", providerRequestId, updatedAt);
  }

  markUncertain(id: string, expectedRevision: number, updatedAt: string): BudgetReservation {
    return this.transition(id, expectedRevision, ["created", "active"], "uncertain", undefined, updatedAt);
  }

  release(id: string, expectedRevision: number, updatedAtInput: string): BudgetReservation {
    const updatedAt = TimestampSchema.parse(updatedAtInput);
    return this.database.transaction(() => {
      const reservation = this.requireReservation(id);
      if (reservation.revision !== expectedRevision) throw new BudgetLedgerError("BUDGET_CONFLICT", "Reservation revision conflict");
      if (!["created", "active", "uncertain", "expired"].includes(reservation.state)) {
        if (reservation.state === "released") return reservation;
        throw new BudgetLedgerError("INVALID_RESERVATION_STATE", `Cannot release ${reservation.state}`);
      }
      const activeChildren = this.database.prepare(`
        SELECT COUNT(*) FROM budget_reservations
        WHERE parent_reservation_id = ? AND state IN ('created','active','uncertain','expired')
      `).pluck().get(reservation.id) as number;
      if (activeChildren > 0) throw new BudgetLedgerError("ACTIVE_CHILD_RESERVATIONS", "Reservation has active children");
      const account = this.requireAccount(reservation.accountId);
      if (reservation.parentReservationId) {
        const parent = this.requireReservation(reservation.parentReservationId);
        this.updateReservationRemaining(parent, addBudgetVectors(parent.remaining, reservation.remaining), updatedAt);
      } else {
        this.updateAccount(account, account.spent, subtractBudgetVectors(account.reserved, reservation.remaining), updatedAt);
      }
      return this.finalizeReservation(reservation, "released", {}, updatedAt);
    }).immediate();
  }

  settle(input: {
    reservationId: string; sourceEventId: string; actual: BudgetVector;
    pricingSnapshotId?: string; createdAt: string;
  }): BudgetReservation {
    const sourceEventId = OpaqueIdSchema.parse(input.sourceEventId);
    const actual = BudgetVectorSchema.parse(input.actual);
    const createdAt = TimestampSchema.parse(input.createdAt);
    return this.database.transaction(() => {
      const existingSpend = this.database.prepare(
        "SELECT reservation_id, actual_json FROM spend_events WHERE source_event_id = ?",
      ).get(sourceEventId) as { reservation_id: string; actual_json: string } | undefined;
      if (existingSpend) {
        if (existingSpend.reservation_id !== input.reservationId || !isDeepStrictEqual(parseVector(existingSpend.actual_json), actual)) {
          throw new BudgetLedgerError("BUDGET_CONFLICT", `sourceEventId ${sourceEventId} was reused`);
        }
        return this.requireReservation(input.reservationId);
      }
      const reservation = this.requireReservation(input.reservationId);
      if (["settled", "reconciled"].includes(reservation.state)) {
        if (!isDeepStrictEqual(reservation.settled, actual)) throw new BudgetLedgerError("BUDGET_CONFLICT", "Conflicting late usage");
        return reservation;
      }
      if (!budgetVectorFits(actual, reservation.reserved)) throw new BudgetLedgerError("BUDGET_EXCEEDED", "Actual usage exceeds hard reservation");
      const account = this.requireAccount(reservation.accountId);
      let nextState: ReservationState = "settled";
      if (reservation.state === "released") {
        this.updateAccount(account, addBudgetVectors(account.spent, actual), account.reserved, createdAt);
        nextState = "reconciled";
      } else if (reservation.parentReservationId) {
        const parent = this.requireReservation(reservation.parentReservationId);
        const unused = subtractBudgetVectors(reservation.reserved, actual);
        this.updateReservationRemaining(parent, addBudgetVectors(parent.remaining, unused), createdAt);
        this.updateAccount(account, addBudgetVectors(account.spent, actual), subtractBudgetVectors(account.reserved, actual), createdAt);
      } else {
        this.updateAccount(
          account,
          addBudgetVectors(account.spent, actual),
          subtractBudgetVectors(account.reserved, reservation.remaining),
          createdAt,
        );
      }
      this.database.prepare(`
        INSERT INTO spend_events(id, reservation_id, source_event_id, actual_json, pricing_snapshot_id, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(`spend:${createHash("sha256").update(sourceEventId).digest("hex")}`, reservation.id, sourceEventId, JSON.stringify(actual), input.pricingSnapshotId ?? null, createdAt);
      this.faultInjector?.("settlement_before_commit");
      return this.finalizeReservation(reservation, nextState, actual, createdAt);
    }).immediate();
  }

  private transition(
    id: string, expectedRevision: number, allowed: ReservationState[], nextState: ReservationState,
    providerRequestId: string | undefined, updatedAtInput: string,
  ): BudgetReservation {
    const updatedAt = TimestampSchema.parse(updatedAtInput);
    return this.database.transaction(() => {
      const current = this.requireReservation(id);
      if (current.revision !== expectedRevision) throw new BudgetLedgerError("BUDGET_CONFLICT", "Reservation revision conflict");
      if (!allowed.includes(current.state)) throw new BudgetLedgerError("INVALID_RESERVATION_STATE", `${current.state} -> ${nextState}`);
      this.database.prepare(`
        UPDATE budget_reservations SET state = ?, provider_request_id = COALESCE(?, provider_request_id),
          revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?
      `).run(nextState, providerRequestId ? OpaqueIdSchema.parse(providerRequestId) : null, updatedAt, id, expectedRevision);
      return this.requireReservation(id);
    }).immediate();
  }

  private requireAccount(id: string): BudgetAccount {
    const account = this.accounts.get(id);
    if (!account) throw new BudgetLedgerError("BUDGET_NOT_FOUND", `Account ${id} was not found`);
    return account;
  }
  private requireReservation(id: string): BudgetReservation {
    const reservation = this.getReservation(id);
    if (!reservation) throw new BudgetLedgerError("BUDGET_NOT_FOUND", `Reservation ${id} was not found`);
    return reservation;
  }
  private updateAccount(account: BudgetAccount, spent: BudgetVector, reserved: BudgetVector, updatedAt: string): void {
    const result = this.database.prepare(`
      UPDATE budget_accounts SET spent_json = ?, reserved_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(JSON.stringify(spent), JSON.stringify(reserved), updatedAt, account.id, account.revision);
    if (result.changes !== 1) throw new BudgetLedgerError("BUDGET_CONFLICT", `Account ${account.id} changed concurrently`);
  }
  private updateReservationRemaining(reservation: BudgetReservation, remaining: BudgetVector, updatedAt: string): void {
    const result = this.database.prepare(`
      UPDATE budget_reservations SET remaining_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(JSON.stringify(remaining), updatedAt, reservation.id, reservation.revision);
    if (result.changes !== 1) throw new BudgetLedgerError("BUDGET_CONFLICT", `Reservation ${reservation.id} changed concurrently`);
  }
  private finalizeReservation(
    reservation: BudgetReservation, state: ReservationState, settled: BudgetVector, updatedAt: string,
  ): BudgetReservation {
    const result = this.database.prepare(`
      UPDATE budget_reservations
      SET state = ?, settled_json = ?, remaining_json = '{}', revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(state, JSON.stringify(settled), updatedAt, reservation.id, reservation.revision);
    if (result.changes !== 1) throw new BudgetLedgerError("BUDGET_CONFLICT", `Reservation ${reservation.id} changed concurrently`);
    return this.requireReservation(reservation.id);
  }
  private insertReservation(reservation: BudgetReservation): void {
    this.database.prepare(`
      INSERT INTO budget_reservations(
        id, program_id, account_id, parent_reservation_id, operation_key, state,
        reserved_json, settled_json, remaining_json, provider_request_id, revision, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reservation.id, reservation.programId, reservation.accountId, reservation.parentReservationId ?? null,
      reservation.operationKey, reservation.state, JSON.stringify(reservation.reserved),
      reservation.settled ? JSON.stringify(reservation.settled) : null, JSON.stringify(reservation.remaining),
      reservation.providerRequestId ?? null, reservation.revision, reservation.createdAt, reservation.updatedAt,
    );
  }
}
