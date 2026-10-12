import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import { AttemptIdSchema, OpaqueIdSchema, ProgramIdSchema } from "./program-types";
import type { FaultPoint } from "./fault-injection-harness";

const Timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const Json = z.record(z.string(), z.unknown());
export const EffectSchema = z.object({
  id: OpaqueIdSchema, programId: ProgramIdSchema, attemptId: AttemptIdSchema, operationKey: OpaqueIdSchema,
  effectType: OpaqueIdSchema, impact: z.enum(["low", "medium", "high"]), state: z.enum(["prepared", "dispatched", "confirmed", "uncertain", "reconciled", "cancelled"]),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/), request: Json, providerRequestId: OpaqueIdSchema.optional(),
  receiptDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), receipt: Json.optional(), executionEpoch: z.number().int().nonnegative(),
  fencingToken: z.number().int().positive(), createdAt: Timestamp, updatedAt: Timestamp,
}).strict();
export type Effect = z.infer<typeof EffectSchema>;
const TRANSITIONS: Record<Effect["state"], Effect["state"][]> = { prepared: ["dispatched", "cancelled"], dispatched: ["confirmed", "uncertain"], confirmed: [], uncertain: ["reconciled"], reconciled: [], cancelled: [] };
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function effectDigest(value: Record<string, unknown>): string { return createHash("sha256").update(stable(value)).digest("hex"); }
interface Row { id: string; program_id: string; attempt_id: string; operation_key: string; effect_type: string; impact: string; state: string; request_digest: string; request_json: string; provider_request_id: string | null; receipt_digest: string | null; receipt_json: string | null; execution_epoch: number; fencing_token: number; created_at: string; updated_at: string }
function fromRow(row: Row): Effect { return EffectSchema.parse({ id: row.id, programId: row.program_id, attemptId: row.attempt_id, operationKey: row.operation_key, effectType: row.effect_type, impact: row.impact, state: row.state, requestDigest: row.request_digest, request: JSON.parse(row.request_json), ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}), ...(row.receipt_digest ? { receiptDigest: row.receipt_digest } : {}), ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) } : {}), executionEpoch: row.execution_epoch, fencingToken: row.fencing_token, createdAt: row.created_at, updatedAt: row.updated_at }); }
export class EffectLedgerError extends Error { constructor(readonly code: "EFFECT_CONFLICT" | "EFFECT_NOT_FOUND" | "INVALID_EFFECT_STATE", message: string) { super(message); this.name = "EffectLedgerError"; } }

export class EffectLedger {
  private readonly database: Database.Database; constructor(handle: ExecutionDatabase, private readonly faultInjector?: (point: FaultPoint) => void) { this.database = handle.connection; }
  prepare(input: Omit<Effect, "state" | "requestDigest" | "createdAt" | "updatedAt"> & { createdAt: string }): Effect {
    const request = Json.parse(input.request); const candidate = EffectSchema.parse({ ...input, request, requestDigest: effectDigest(request), state: "prepared", createdAt: input.createdAt, updatedAt: input.createdAt });
    const result = this.database.prepare(`INSERT INTO effects(id, program_id, attempt_id, operation_key, effect_type, impact, state, request_digest, request_json, execution_epoch, fencing_token, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?) ON CONFLICT(operation_key) DO NOTHING`)
      .run(candidate.id, candidate.programId, candidate.attemptId, candidate.operationKey, candidate.effectType, candidate.impact, candidate.requestDigest, JSON.stringify(candidate.request), candidate.executionEpoch, candidate.fencingToken, candidate.createdAt, candidate.updatedAt);
    if (result.changes === 0) {
      const existing = this.getByOperationKey(candidate.operationKey)!;
      if (!isDeepStrictEqual(existing.request, candidate.request) || existing.attemptId !== candidate.attemptId || existing.effectType !== candidate.effectType) throw new EffectLedgerError("EFFECT_CONFLICT", `Operation key ${candidate.operationKey} identifies another effect`);
      return existing;
    }
    return candidate;
  }
  getByOperationKey(key: string): Effect | undefined { const row = this.database.prepare("SELECT * FROM effects WHERE operation_key=?").get(OpaqueIdSchema.parse(key)) as Row | undefined; return row ? fromRow(row) : undefined; }
  transition(operationKey: string, state: Effect["state"], now: string, details: { providerRequestId?: string; receipt?: Record<string, unknown> } = {}): Effect {
    const current = this.getByOperationKey(operationKey); if (!current) throw new EffectLedgerError("EFFECT_NOT_FOUND", `Effect ${operationKey} not found`);
    if (!TRANSITIONS[current.state].includes(state)) throw new EffectLedgerError("INVALID_EFFECT_STATE", `${current.state} -> ${state}`);
    const receipt = details.receipt ? Json.parse(details.receipt) : undefined;
    this.database.prepare(`UPDATE effects SET state=?, provider_request_id=COALESCE(?,provider_request_id), receipt_digest=COALESCE(?,receipt_digest),
      receipt_json=COALESCE(?,receipt_json), updated_at=? WHERE operation_key=? AND state=?`)
      .run(state, details.providerRequestId ?? null, receipt ? effectDigest(receipt) : null, receipt ? JSON.stringify(receipt) : null, new Date(now).toISOString(), current.operationKey, current.state);
    if (state === "dispatched") this.faultInjector?.("dispatch_after_provider_accept");
    return this.getByOperationKey(current.operationKey)!;
  }
}
