import { createHash } from "node:crypto";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import { AttemptIdSchema, OpaqueIdSchema } from "./program-types";

const Timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
export const ContinuationStateSchema = z.object({
  objective: z.string().trim().min(1).max(20_000),
  completedSteps: z.array(z.string().max(2_000)).max(1_000),
  nextSteps: z.array(z.string().max(2_000)).max(1_000),
  facts: z.record(z.string().max(128), z.string().max(8_000)).default({}),
  artifactRefs: z.array(z.object({ path: z.string().max(4_096), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(2_000),
}).strict();
export type ContinuationState = z.infer<typeof ContinuationStateSchema>;
export const ExecutionCheckpointSchema = z.object({
  id: OpaqueIdSchema, attemptId: AttemptIdSchema, executionEpoch: z.number().int().nonnegative(), fencingToken: z.number().int().positive(),
  schemaVersion: z.literal(1), state: ContinuationStateSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(), expiresAt: Timestamp, createdAt: Timestamp,
}).strict();
export type ExecutionCheckpoint = z.infer<typeof ExecutionCheckpointSchema>;

export class CheckpointError extends Error {
  constructor(readonly code: "CHECKPOINT_TOO_LARGE" | "CHECKPOINT_CORRUPT" | "CHECKPOINT_EXPIRED" | "CHECKPOINT_STALE", message: string) { super(message); this.name = "CheckpointError"; }
}
interface Row { id: string; attempt_id: string; execution_epoch: number; fencing_token: number; schema_version: number; state_json: string; digest: string; size_bytes: number; expires_at: string; created_at: string }
function canonical(state: ContinuationState): string { return JSON.stringify(state); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export class CheckpointStore {
  private readonly database: Database.Database;
  constructor(handle: ExecutionDatabase, private readonly maxBytes = 256 * 1024) { this.database = handle.connection; }
  save(input: { id: string; attemptId: string; executionEpoch: number; fencingToken: number; state: ContinuationState; expiresAt: string; createdAt: string }): ExecutionCheckpoint {
    const state = ContinuationStateSchema.parse(input.state); const json = canonical(state); const sizeBytes = Buffer.byteLength(json);
    if (sizeBytes > this.maxBytes) throw new CheckpointError("CHECKPOINT_TOO_LARGE", `Checkpoint is ${sizeBytes} bytes`);
    const attempt = this.database.prepare("SELECT execution_epoch, fencing_token FROM work_package_attempts WHERE id = ?").get(input.attemptId) as { execution_epoch: number; fencing_token: number } | undefined;
    if (!attempt || attempt.execution_epoch !== input.executionEpoch || attempt.fencing_token !== input.fencingToken) throw new CheckpointError("CHECKPOINT_STALE", "Attempt epoch or fencing token is stale");
    const checkpoint = ExecutionCheckpointSchema.parse({ ...input, schemaVersion: 1, state, digest: digest(json), sizeBytes });
    this.database.prepare(`INSERT INTO execution_checkpoints(id, attempt_id, execution_epoch, fencing_token, schema_version, state_json, digest, size_bytes, expires_at, created_at)
      VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(checkpoint.id, checkpoint.attemptId, checkpoint.executionEpoch, checkpoint.fencingToken, json, checkpoint.digest, checkpoint.sizeBytes, checkpoint.expiresAt, checkpoint.createdAt);
    return checkpoint;
  }
  get(id: string, now: string): ExecutionCheckpoint | undefined {
    const row = this.database.prepare("SELECT * FROM execution_checkpoints WHERE id = ?").get(OpaqueIdSchema.parse(id)) as Row | undefined;
    if (!row) return undefined;
    if (Date.parse(row.expires_at) <= Date.parse(now)) throw new CheckpointError("CHECKPOINT_EXPIRED", `Checkpoint ${id} expired`);
    const state = ContinuationStateSchema.parse(JSON.parse(row.state_json) as unknown); const json = canonical(state);
    if (digest(json) !== row.digest || Buffer.byteLength(json) !== row.size_bytes) throw new CheckpointError("CHECKPOINT_CORRUPT", `Checkpoint ${id} failed digest verification`);
    return ExecutionCheckpointSchema.parse({ id: row.id, attemptId: row.attempt_id, executionEpoch: row.execution_epoch, fencingToken: row.fencing_token,
      schemaVersion: row.schema_version, state, digest: row.digest, sizeBytes: row.size_bytes, expiresAt: row.expires_at, createdAt: row.created_at });
  }
}
