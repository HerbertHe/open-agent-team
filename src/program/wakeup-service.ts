import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ExecutionDatabase } from "./execution-database";
import { insertExecutionOutboxEvent } from "./execution-outbox";
import { OpaqueIdSchema, ProgramIdSchema } from "./program-types";

const Timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
export const WakeupSchema = z.object({
  id: OpaqueIdSchema, programId: ProgramIdSchema, dedupeKey: OpaqueIdSchema, wakeAt: Timestamp,
  priority: z.number().int(), state: z.enum(["pending", "dispatched", "dead_letter"]),
  payload: z.record(z.string(), z.unknown()), outboxEventId: OpaqueIdSchema.optional(),
  createdAt: Timestamp, updatedAt: Timestamp, dispatchedAt: Timestamp.optional(),
}).strict();
export type Wakeup = z.infer<typeof WakeupSchema>;

interface WakeupRow { id: string; program_id: string; dedupe_key: string; wake_at: string; priority: number; state: string; payload_json: string; outbox_event_id: string | null; created_at: string; updated_at: string; dispatched_at: string | null }
function fromRow(row: WakeupRow): Wakeup { return WakeupSchema.parse({
  id: row.id, programId: row.program_id, dedupeKey: row.dedupe_key, wakeAt: row.wake_at, priority: row.priority,
  state: row.state, payload: JSON.parse(row.payload_json) as unknown, ...(row.outbox_event_id ? { outboxEventId: row.outbox_event_id } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at, ...(row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {}),
}); }
function eventId(key: string): string { return `evt:${createHash("sha256").update(key).digest("hex")}`; }
function outboxDedupeKey(key: string): string { return `wakeup:${createHash("sha256").update(key).digest("hex")}`; }

export class WakeupService {
  private readonly database: Database.Database;
  constructor(handle: ExecutionDatabase) { this.database = handle.connection; }

  schedule(input: { id?: string; programId: string; dedupeKey: string; wakeAt: string; priority?: number; payload: Record<string, unknown>; createdAt: string }): Wakeup {
    const candidate = WakeupSchema.parse({ id: input.id ?? `wakeup:${randomUUID()}`, programId: input.programId, dedupeKey: input.dedupeKey,
      wakeAt: input.wakeAt, priority: input.priority ?? 0, state: "pending", payload: input.payload, createdAt: input.createdAt, updatedAt: input.createdAt });
    this.database.prepare(`INSERT INTO wakeups(id, program_id, dedupe_key, wake_at, priority, state, payload_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(candidate.id, candidate.programId, candidate.dedupeKey, candidate.wakeAt, candidate.priority, JSON.stringify(candidate.payload), candidate.createdAt, candidate.updatedAt);
    const existing = fromRow(this.database.prepare("SELECT * FROM wakeups WHERE dedupe_key = ?").get(candidate.dedupeKey) as WakeupRow);
    if (existing.programId !== candidate.programId || existing.wakeAt !== candidate.wakeAt || JSON.stringify(existing.payload) !== JSON.stringify(candidate.payload)) {
      throw new Error(`Wakeup dedupe conflict: ${candidate.dedupeKey}`);
    }
    return existing;
  }

  dispatchDue(input: { now: string; limit?: number; faultInjector?: (point: "after_outbox") => void }): Wakeup[] {
    const now = Timestamp.parse(input.now);
    return this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT * FROM wakeups WHERE state = 'pending' AND wake_at <= ?
        ORDER BY wake_at, priority DESC, id LIMIT ?`).all(now, input.limit ?? 100) as WakeupRow[];
      const dispatched: Wakeup[] = [];
      for (const row of rows) {
        const wakeup = fromRow(row);
        const key = outboxDedupeKey(wakeup.dedupeKey);
        const id = eventId(key);
        insertExecutionOutboxEvent(this.database, { id, dedupeKey: key, aggregateType: "program", aggregateId: wakeup.programId,
          eventType: "program.wakeup_due", payload: { ...wakeup.payload, wakeupId: wakeup.id }, availableAt: now, createdAt: now });
        input.faultInjector?.("after_outbox");
        this.database.prepare(`UPDATE wakeups SET state = 'dispatched', outbox_event_id = ?, dispatched_at = ?, updated_at = ?
          WHERE id = ? AND state = 'pending'`).run(id, now, now, wakeup.id);
        dispatched.push(fromRow(this.database.prepare("SELECT * FROM wakeups WHERE id = ?").get(wakeup.id) as WakeupRow));
      }
      return dispatched;
    }).immediate();
  }
}
