import { z } from "zod";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import { AttemptIdSchema, OpaqueIdSchema, ProgramIdSchema } from "./program-types";

const TimestampSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const AuditEventInputSchema = z.object({
  id: OpaqueIdSchema,
  programId: ProgramIdSchema.optional(),
  attemptId: AttemptIdSchema.optional(),
  actorType: z.enum(["admin", "agent", "user", "system", "service"]),
  actorId: OpaqueIdSchema.optional(),
  eventType: OpaqueIdSchema,
  requestId: OpaqueIdSchema.optional(),
  reason: z.string().trim().min(1).max(10_000).optional(),
  before: JsonObjectSchema.optional(),
  after: JsonObjectSchema.optional(),
  metadata: JsonObjectSchema.default({}),
  createdAt: TimestampSchema,
}).strict();

export type AuditEventInput = z.input<typeof AuditEventInputSchema>;
export type AuditEvent = z.output<typeof AuditEventInputSchema>;

export interface AuditSanitizerLimits {
  maxDepth: number;
  maxStringLength: number;
  maxArrayLength: number;
  maxObjectKeys: number;
}

export const DEFAULT_AUDIT_SANITIZER_LIMITS: AuditSanitizerLimits = {
  maxDepth: 8,
  maxStringLength: 4_000,
  maxArrayLength: 100,
  maxObjectKeys: 100,
};

const SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "privatekey",
  "credential",
  "credentials",
  "cookie",
  "setcookie",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "bearertoken",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function sanitizeAuditValue(
  input: unknown,
  limits: AuditSanitizerLimits = DEFAULT_AUDIT_SANITIZER_LIMITS,
): unknown {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > limits.maxDepth) return "[TRUNCATED_DEPTH]";
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "string") {
      return value.length <= limits.maxStringLength
        ? value
        : `${value.slice(0, limits.maxStringLength)}[TRUNCATED]`;
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "undefined") return "[UNDEFINED]";
    if (typeof value === "function" || typeof value === "symbol") return `[${(typeof value).toUpperCase()}]`;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.slice(0, limits.maxArrayLength).map((item) => visit(item, depth + 1));
      if (value.length > limits.maxArrayLength) result.push(`[TRUNCATED_${value.length - limits.maxArrayLength}_ITEMS]`);
      return result;
    }
    const entries = Object.entries(value).slice(0, limits.maxObjectKeys);
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      result[key] = SECRET_KEYS.has(normalizedKey(key)) ? "[REDACTED]" : visit(item, depth + 1);
    }
    if (Object.keys(value).length > limits.maxObjectKeys) result.__truncatedKeys = true;
    return result;
  };
  return visit(input, 0);
}

interface AuditRow {
  id: string;
  program_id: string | null;
  attempt_id: string | null;
  actor_type: string;
  actor_id: string | null;
  event_type: string;
  request_id: string | null;
  reason: string | null;
  before_json: string | null;
  after_json: string | null;
  metadata_json: string;
  created_at: string;
}

function parseJsonObject(value: string): Record<string, unknown> {
  return JsonObjectSchema.parse(JSON.parse(value) as unknown);
}

function rowToEvent(row: AuditRow): AuditEvent {
  return AuditEventInputSchema.parse({
    id: row.id,
    ...(row.program_id ? { programId: row.program_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    actorType: row.actor_type,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    eventType: row.event_type,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.before_json ? { before: parseJsonObject(row.before_json) } : {}),
    ...(row.after_json ? { after: parseJsonObject(row.after_json) } : {}),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  });
}

export class ExecutionAuditRepository {
  private readonly database: Database.Database;

  constructor(handle: ExecutionDatabase) { this.database = handle.connection; }

  append(input: AuditEventInput): AuditEvent {
    const parsed = AuditEventInputSchema.parse(input);
    const event = AuditEventInputSchema.parse({
      ...parsed,
      ...(parsed.before ? { before: sanitizeAuditValue(parsed.before) } : {}),
      ...(parsed.after ? { after: sanitizeAuditValue(parsed.after) } : {}),
      metadata: sanitizeAuditValue(parsed.metadata),
    });
    this.database.prepare(`
      INSERT INTO audit_events(
        id, program_id, attempt_id, actor_type, actor_id, event_type, request_id,
        reason, before_json, after_json, metadata_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.programId ?? null, event.attemptId ?? null, event.actorType,
      event.actorId ?? null, event.eventType, event.requestId ?? null, event.reason ?? null,
      event.before ? JSON.stringify(event.before) : null,
      event.after ? JSON.stringify(event.after) : null,
      JSON.stringify(event.metadata), event.createdAt,
    );
    return event;
  }

  get(id: string): AuditEvent | undefined {
    const row = this.database.prepare("SELECT * FROM audit_events WHERE id = ?").get(id) as AuditRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  findByProgram(programId: string, limit = 100): AuditEvent[] {
    return this.query("program_id", ProgramIdSchema.parse(programId), limit);
  }

  findByAttempt(attemptId: string, limit = 100): AuditEvent[] {
    return this.query("attempt_id", AttemptIdSchema.parse(attemptId), limit);
  }

  findByRequestId(requestId: string, limit = 100): AuditEvent[] {
    return this.query("request_id", OpaqueIdSchema.parse(requestId), limit);
  }

  private query(column: "program_id" | "attempt_id" | "request_id", value: string, limit: number): AuditEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("limit must be between 1 and 1000");
    const rows = this.database.prepare(
      `SELECT * FROM audit_events WHERE ${column} = ? ORDER BY created_at, id LIMIT ?`,
    ).all(value, limit) as AuditRow[];
    return rows.map(rowToEvent);
  }
}
