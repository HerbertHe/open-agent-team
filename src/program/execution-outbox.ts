import { z } from "zod";
import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import type { ExecutionDatabase } from "./execution-database";
import { OpaqueIdSchema } from "./program-types";

const TimestampSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const ExecutionOutboxEventSchema = z.object({
  id: OpaqueIdSchema,
  dedupeKey: OpaqueIdSchema,
  aggregateType: OpaqueIdSchema,
  aggregateId: OpaqueIdSchema,
  eventType: OpaqueIdSchema,
  payload: z.record(z.string(), z.unknown()),
  availableAt: TimestampSchema,
  createdAt: TimestampSchema,
}).strict();

export type ExecutionOutboxEvent = z.infer<typeof ExecutionOutboxEventSchema>;
export type ExecutionOutboxState = "pending" | "publishing" | "published" | "dead_letter";

export interface ClaimedOutboxEvent extends ExecutionOutboxEvent {
  state: "publishing";
  attempts: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  publishedAt?: string;
  lastError?: string;
}

interface OutboxRow {
  id: string;
  dedupe_key: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload_json: string;
  state: ExecutionOutboxState;
  attempts: number;
  available_at: string;
  created_at: string;
  published_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
}

export type ExecutionOutboxErrorCode =
  | "OUTBOX_NOT_FOUND"
  | "OUTBOX_DEDUPE_CONFLICT"
  | "OUTBOX_LEASE_CONFLICT"
  | "OUTBOX_CORRUPT_ROW";

export class ExecutionOutboxError extends Error {
  constructor(readonly code: ExecutionOutboxErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExecutionOutboxError";
  }
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return z.record(z.string(), z.unknown()).parse(parsed);
  } catch (error) {
    throw new ExecutionOutboxError("OUTBOX_CORRUPT_ROW", "Outbox payload is not a JSON object", { cause: error });
  }
}

function rowToEvent(row: OutboxRow): ExecutionOutboxEvent {
  return ExecutionOutboxEventSchema.parse({
    id: row.id,
    dedupeKey: row.dedupe_key,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: parsePayload(row.payload_json),
    availableAt: row.available_at,
    createdAt: row.created_at,
  });
}

function sameEvent(left: ExecutionOutboxEvent, right: ExecutionOutboxEvent): boolean {
  return isDeepStrictEqual(left, right);
}

/** Insert inside the caller's transaction. Reusing a dedupe key is allowed only for the exact same event. */
export function insertExecutionOutboxEvent(
  database: Database.Database,
  input: ExecutionOutboxEvent,
): ExecutionOutboxEvent {
  const event = ExecutionOutboxEventSchema.parse(input);
  const result = database.prepare(`
    INSERT INTO execution_outbox(
      id, dedupe_key, aggregate_type, aggregate_id, event_type, payload_json, available_at, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).run(
    event.id,
    event.dedupeKey,
    event.aggregateType,
    event.aggregateId,
    event.eventType,
    JSON.stringify(event.payload),
    event.availableAt,
    event.createdAt,
  );
  if (result.changes === 1) return event;

  const row = database.prepare("SELECT * FROM execution_outbox WHERE dedupe_key = ?").get(event.dedupeKey) as OutboxRow;
  const existing = rowToEvent(row);
  if (!sameEvent(existing, event)) {
    throw new ExecutionOutboxError(
      "OUTBOX_DEDUPE_CONFLICT",
      `Dedupe key ${event.dedupeKey} already identifies a different event`,
    );
  }
  return existing;
}

export class ExecutionOutboxRepository {
  private readonly database: Database.Database;

  constructor(handle: ExecutionDatabase) {
    this.database = handle.connection;
  }

  enqueue(input: ExecutionOutboxEvent): ExecutionOutboxEvent {
    return this.database.transaction(() => insertExecutionOutboxEvent(this.database, input)).immediate();
  }

  get(id: string): (ExecutionOutboxEvent & {
    state: ExecutionOutboxState;
    attempts: number;
    publishedAt?: string;
    leaseOwner?: string;
    leaseExpiresAt?: string;
    lastError?: string;
  }) | undefined {
    const row = this.database.prepare("SELECT * FROM execution_outbox WHERE id = ?").get(id) as OutboxRow | undefined;
    if (!row) return undefined;
    return {
      ...rowToEvent(row),
      state: row.state,
      attempts: row.attempts,
      ...(row.published_at ? { publishedAt: row.published_at } : {}),
      ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
      ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
    };
  }

  claimNext(input: { workerId: string; now: string; leaseExpiresAt: string }): ClaimedOutboxEvent | undefined {
    const workerId = OpaqueIdSchema.parse(input.workerId);
    const now = TimestampSchema.parse(input.now);
    const leaseExpiresAt = TimestampSchema.parse(input.leaseExpiresAt);
    if (Date.parse(leaseExpiresAt) <= Date.parse(now)) throw new RangeError("leaseExpiresAt must be later than now");

    return this.database.transaction(() => {
      const candidate = this.database.prepare(`
        SELECT id FROM execution_outbox
        WHERE (state = 'pending' AND available_at <= ?)
           OR (state = 'publishing' AND lease_expires_at <= ?)
        ORDER BY available_at, created_at, id
        LIMIT 1
      `).get(now, now) as { id: string } | undefined;
      if (!candidate) return undefined;
      const updated = this.database.prepare(`
        UPDATE execution_outbox
        SET state = 'publishing', attempts = attempts + 1,
            lease_owner = ?, lease_expires_at = ?, last_error = NULL
        WHERE id = ? AND (
          (state = 'pending' AND available_at <= ?) OR
          (state = 'publishing' AND lease_expires_at <= ?)
        )
        RETURNING *
      `).get(workerId, leaseExpiresAt, candidate.id, now, now) as OutboxRow | undefined;
      if (!updated) return undefined;
      const claimed: ClaimedOutboxEvent = {
        ...rowToEvent(updated),
        state: "publishing",
        attempts: updated.attempts,
        leaseOwner: workerId,
        leaseExpiresAt,
        ...(updated.published_at ? { publishedAt: updated.published_at } : {}),
      };
      return claimed;
    }).immediate();
  }

  markPublished(id: string, workerId: string, publishedAt: string): void {
    const result = this.database.prepare(`
      UPDATE execution_outbox
      SET state = 'published', published_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE id = ? AND state = 'publishing' AND lease_owner = ?
    `).run(TimestampSchema.parse(publishedAt), OpaqueIdSchema.parse(id), OpaqueIdSchema.parse(workerId));
    if (result.changes !== 1) {
      throw new ExecutionOutboxError("OUTBOX_LEASE_CONFLICT", `Worker ${workerId} does not own outbox event ${id}`);
    }
  }

  markFailed(input: {
    id: string;
    workerId: string;
    availableAt: string;
    error: string;
    maxAttempts: number;
  }): ExecutionOutboxState {
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) throw new RangeError("maxAttempts must be positive");
    const id = OpaqueIdSchema.parse(input.id);
    const workerId = OpaqueIdSchema.parse(input.workerId);
    const availableAt = TimestampSchema.parse(input.availableAt);
    return this.database.transaction(() => {
      const row = this.database.prepare(
        "SELECT attempts FROM execution_outbox WHERE id = ? AND state = 'publishing' AND lease_owner = ?",
      ).get(id, workerId) as { attempts: number } | undefined;
      if (!row) throw new ExecutionOutboxError("OUTBOX_LEASE_CONFLICT", `Worker ${workerId} does not own outbox event ${id}`);
      const state: ExecutionOutboxState = row.attempts >= input.maxAttempts ? "dead_letter" : "pending";
      this.database.prepare(`
        UPDATE execution_outbox
        SET state = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?
        WHERE id = ? AND state = 'publishing' AND lease_owner = ?
      `).run(state, availableAt, input.error.slice(0, 10_000), id, workerId);
      return state;
    }).immediate();
  }
}

export type OutboxDeliveryResult = "idle" | "published" | "retry_scheduled" | "dead_letter";

export class ExecutionOutboxWorker {
  constructor(
    private readonly repository: ExecutionOutboxRepository,
    private readonly publisher: (event: ClaimedOutboxEvent) => void | Promise<void>,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async deliverNext(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    retryAt: string;
    maxAttempts: number;
  }): Promise<OutboxDeliveryResult> {
    const event = this.repository.claimNext(input);
    if (!event) return "idle";
    try {
      await this.publisher(event);
      this.repository.markPublished(event.id, input.workerId, this.clock());
      return "published";
    } catch (error) {
      const state = this.repository.markFailed({
        id: event.id,
        workerId: input.workerId,
        availableAt: input.retryAt,
        error: error instanceof Error ? error.message : String(error),
        maxAttempts: input.maxAttempts,
      });
      return state === "dead_letter" ? "dead_letter" : "retry_scheduled";
    }
  }
}
