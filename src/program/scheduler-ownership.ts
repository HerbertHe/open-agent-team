import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import { OpaqueIdSchema, ProgramIdSchema } from "./program-types";

export class SchedulerOwnershipError extends Error {
  constructor(readonly code: "SCHEDULER_FENCED" | "RESOURCE_BUSY", message: string) { super(message); this.name = "SchedulerOwnershipError"; }
}
export interface SchedulerClaim { programId: string; ownerId: string; fencingToken: number; tickId: string }
interface LeaseRow { owner_id: string; fencing_token: number; expires_at: string; tick_id: string | null; tick_expires_at: string | null }

/** Program ownership outlives an individual tick. A separate tick id prevents
 * two coordinators with the same configured instance id from overlapping. */
export class SchedulerOwnership {
  constructor(private readonly handle: ExecutionDatabase, readonly ownerId: string, readonly ttlMs = 60_000) {
    OpaqueIdSchema.parse(ownerId);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 100) throw new RangeError("Invalid scheduler lease TTL");
  }

  claim(programId: string, now: string): SchedulerClaim | undefined {
    ProgramIdSchema.parse(programId); now = new Date(now).toISOString();
    return this.handle.connection.transaction(() => {
      const row = this.handle.connection.prepare("SELECT * FROM program_scheduler_leases WHERE program_id=?").get(programId) as LeaseRow | undefined;
      if (row && row.expires_at > now && (row.owner_id !== this.ownerId || (row.tick_id && row.tick_expires_at! > now))) return undefined;
      const fence = row ? row.fencing_token + (row.owner_id !== this.ownerId || row.expires_at <= now || (row.tick_id && row.tick_expires_at! <= now) ? 1 : 0) : 1;
      const claim = { programId, ownerId: this.ownerId, fencingToken: fence, tickId: `tick:${randomUUID()}` };
      const expires = new Date(Math.max(Date.parse(now) + this.ttlMs, row?.owner_id === this.ownerId && row.expires_at > now ? Date.parse(row.expires_at) : 0)).toISOString();
      this.handle.connection.prepare(`INSERT INTO program_scheduler_leases(program_id,owner_id,fencing_token,expires_at,tick_id,tick_expires_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(program_id) DO UPDATE SET owner_id=excluded.owner_id,fencing_token=excluded.fencing_token,
        expires_at=excluded.expires_at,tick_id=excluded.tick_id,tick_expires_at=excluded.tick_expires_at,updated_at=excluded.updated_at`)
        .run(programId, this.ownerId, fence, expires, claim.tickId, expires, now);
      return claim;
    }).immediate();
  }

  assertCurrent(claim: SchedulerClaim, now: string): void {
    const valid = this.handle.connection.prepare(`SELECT 1 FROM program_scheduler_leases WHERE program_id=? AND owner_id=?
      AND fencing_token=? AND tick_id=? AND expires_at>? AND tick_expires_at>?`)
      .get(claim.programId, claim.ownerId, claim.fencingToken, claim.tickId, now, now);
    if (!valid) throw new SchedulerOwnershipError("SCHEDULER_FENCED", "Scheduler ownership, tick or lease is stale");
  }

  renew(programId: string, fence: number, now: string, tickId?: string): boolean {
    const expires = new Date(Date.parse(now) + this.ttlMs).toISOString();
    const result = this.handle.connection.prepare(`UPDATE program_scheduler_leases SET expires_at=MAX(expires_at,?),
      tick_expires_at=CASE WHEN ? IS NOT NULL THEN MAX(tick_expires_at,?) ELSE tick_expires_at END,updated_at=?
      WHERE program_id=? AND owner_id=? AND fencing_token=? AND expires_at>? AND (? IS NULL OR (tick_id=? AND tick_expires_at>?))`)
      .run(expires, tickId ?? null, expires, now, programId, this.ownerId, fence, now, tickId ?? null, tickId ?? null, now);
    return result.changes === 1;
  }

  finish(claim: SchedulerClaim): void {
    this.handle.connection.prepare(`UPDATE program_scheduler_leases SET tick_id=NULL,tick_expires_at=NULL
      WHERE program_id=? AND owner_id=? AND fencing_token=? AND tick_id=?`)
      .run(claim.programId, claim.ownerId, claim.fencingToken, claim.tickId);
  }

  relinquish(now: string): void {
    this.handle.connection.prepare("UPDATE program_scheduler_leases SET expires_at=?,tick_id=NULL,tick_expires_at=NULL WHERE owner_id=?")
      .run(new Date(now).toISOString(), this.ownerId);
  }

  bindAttempt(attemptId: string, claim: SchedulerClaim): void {
    this.handle.connection.prepare(`INSERT INTO attempt_execution_owners(attempt_id,program_id,owner_id,scheduler_fencing_token) VALUES(?,?,?,?)`)
      .run(attemptId, claim.programId, claim.ownerId, claim.fencingToken);
  }

  resourceAvailable(projectId: string, resourceKey: string): boolean {
    return !this.handle.connection.prepare(`SELECT 1 FROM execution_resource_claims c JOIN work_package_attempts a ON a.id=c.attempt_id
      WHERE c.project_id=? AND c.resource_key=? AND (a.status NOT IN ('completed','failed','aborted') OR EXISTS (
        SELECT 1 FROM effects e WHERE e.attempt_id=a.id AND e.state IN ('prepared','dispatched','uncertain')))`)
      .get(projectId, resourceKey);
  }

  claimResources(projectId: string, keys: string[], attemptId: string): void {
    this.handle.connection.prepare(`DELETE FROM execution_resource_claims WHERE attempt_id IN (
      SELECT a.id FROM work_package_attempts a WHERE a.status IN ('completed','failed','aborted') AND NOT EXISTS (
        SELECT 1 FROM effects e WHERE e.attempt_id=a.id AND e.state IN ('prepared','dispatched','uncertain')))`)
      .run();
    for (const key of new Set(keys)) {
      const result = this.handle.connection.prepare(`INSERT INTO execution_resource_claims(project_id,resource_key,attempt_id)
        VALUES(?,?,?) ON CONFLICT(project_id,resource_key) DO NOTHING`).run(projectId, key, attemptId);
      if (!result.changes) throw new SchedulerOwnershipError("RESOURCE_BUSY", `Resource ${key} is held by another attempt`);
    }
  }
}

/** Read the durable binding rather than trusting owner/fence supplied by a child.
 * Unbound pre-v7 attempts remain usable only until a coordinator owns the Program. */
export function assertAttemptSchedulerOwnership(database: Database.Database, attemptId: string, programId: string, now: string, instanceId?: string): void {
  const binding = database.prepare("SELECT program_id,owner_id,scheduler_fencing_token FROM attempt_execution_owners WHERE attempt_id=?")
    .get(attemptId) as { program_id: string; owner_id: string; scheduler_fencing_token: number } | undefined;
  const lease = database.prepare("SELECT * FROM program_scheduler_leases WHERE program_id=?").get(programId) as LeaseRow | undefined;
  if (!binding && !lease) return;
  if (!binding || !lease || binding.program_id !== programId || binding.owner_id !== lease.owner_id
    || binding.scheduler_fencing_token !== lease.fencing_token || lease.expires_at <= now || (instanceId && binding.owner_id !== instanceId)) {
    throw new SchedulerOwnershipError("SCHEDULER_FENCED", "Attempt belongs to a stale or foreign scheduler instance");
  }
}
