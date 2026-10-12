import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import { WorkPackageRepository } from "./execution-repositories";
import { assertAttemptTransition, AttemptStatusSchema, OpaqueIdSchema, type AttemptStatus, type WorkPackageAttempt } from "./program-types";
import type { FaultPoint } from "./fault-injection-harness";

export class LeaseError extends Error {
  constructor(readonly code: "LEASE_UNAVAILABLE" | "STALE_FENCE" | "ATTEMPT_NOT_FOUND", message: string) {
    super(message);
    this.name = "LeaseError";
  }
}

interface AttemptRow {
  id: string; work_package_id: string; attempt_number: number; status: string; execution_epoch: number;
  fencing_token: number; failure_json: string | null; started_at: string | null; completed_at: string | null;
  created_at: string; updated_at: string;
}

function fromRow(row: AttemptRow): WorkPackageAttempt {
  return {
    id: row.id as WorkPackageAttempt["id"], workPackageId: row.work_package_id as WorkPackageAttempt["workPackageId"],
    attemptNumber: row.attempt_number, status: AttemptStatusSchema.parse(row.status), executionEpoch: row.execution_epoch,
    fencingToken: row.fencing_token, ...(row.failure_json ? { failure: JSON.parse(row.failure_json) as Record<string, unknown> } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export class LeaseService {
  private readonly database: Database.Database;
  private readonly work: WorkPackageRepository;
  constructor(handle: ExecutionDatabase, private readonly faultInjector?: (point: FaultPoint) => void) { this.database = handle.connection; this.work = new WorkPackageRepository(handle); }

  acquire(input: { workPackageId: string; ownerId: string; now: string; expiresAt: string; attemptId?: string }): WorkPackageAttempt {
    const ownerId = OpaqueIdSchema.parse(input.ownerId);
    const now = new Date(input.now).toISOString(); const expiresAt = new Date(input.expiresAt).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(now)) throw new RangeError("expiresAt must be later than now");
    return this.database.transaction(() => {
      let item = this.work.get(input.workPackageId);
      if (!item) throw new LeaseError("LEASE_UNAVAILABLE", "Work Package was not found");
      const existing = this.database.prepare(`
        SELECT a.*, l.expires_at FROM work_package_attempts a JOIN attempt_leases l ON l.attempt_id = a.id
        WHERE a.work_package_id = ? ORDER BY a.fencing_token DESC LIMIT 1
      `).get(item.id) as (AttemptRow & { expires_at: string }) | undefined;
      if (existing && existing.expires_at > now) throw new LeaseError("LEASE_UNAVAILABLE", "An unexpired lease already exists");
      if (existing) {
        this.database.prepare("UPDATE work_package_attempts SET status = 'expired', updated_at = ? WHERE id = ?").run(now, existing.id);
        this.database.prepare("DELETE FROM attempt_leases WHERE attempt_id = ?").run(existing.id);
        if (item.status === "leased") item = this.work.transitionStatus(item.id, item.revision, "runnable", now);
      }
      if (item.status !== "runnable") throw new LeaseError("LEASE_UNAVAILABLE", `Work Package is ${item.status}`);
      const maxima = this.database.prepare(`SELECT COALESCE(MAX(attempt_number),0) AS n, COALESCE(MAX(fencing_token),0) AS f
        FROM work_package_attempts WHERE work_package_id = ?`).get(item.id) as { n: number; f: number };
      const epoch = this.database.prepare("SELECT execution_epoch FROM programs WHERE id = ?").pluck().get(item.programId) as number;
      const id = OpaqueIdSchema.parse(input.attemptId ?? `attempt:${randomUUID()}`);
      this.database.prepare(`INSERT INTO work_package_attempts(
        id, work_package_id, attempt_number, status, execution_epoch, fencing_token, created_at, updated_at
      ) VALUES(?, ?, ?, 'leased', ?, ?, ?, ?)`)
        .run(id, item.id, maxima.n + 1, epoch, maxima.f + 1, now, now);
      this.database.prepare(`INSERT INTO attempt_leases(attempt_id, owner_id, fencing_token, acquired_at, heartbeat_at, expires_at)
        VALUES(?, ?, ?, ?, ?, ?)`)
        .run(id, ownerId, maxima.f + 1, now, now, expiresAt);
      this.work.transitionStatus(item.id, item.revision, "leased", now);
      this.faultInjector?.("lease_after_acquire");
      return fromRow(this.database.prepare("SELECT * FROM work_package_attempts WHERE id = ?").get(id) as AttemptRow);
    }).immediate();
  }

  renew(input: { attemptId: string; ownerId: string; fencingToken: number; now: string; expiresAt: string }): void {
    const now = new Date(input.now).toISOString(); const expiresAt = new Date(input.expiresAt).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(now)) throw new RangeError("expiresAt must be later than now");
    const result = this.database.prepare(`UPDATE attempt_leases SET heartbeat_at = ?, expires_at = ?
      WHERE attempt_id = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?`)
      .run(now, expiresAt, input.attemptId, input.ownerId, input.fencingToken, now);
    if (result.changes !== 1) throw new LeaseError("STALE_FENCE", "Lease owner, token or expiry is stale");
  }

  transition(input: { attemptId: string; ownerId: string; fencingToken: number; now: string; status: AttemptStatus }): WorkPackageAttempt {
    const now = new Date(input.now).toISOString();
    return this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM work_package_attempts WHERE id = ?").get(input.attemptId) as AttemptRow | undefined;
      if (!row) throw new LeaseError("ATTEMPT_NOT_FOUND", "Attempt was not found");
      const lease = this.database.prepare(`SELECT 1 FROM attempt_leases WHERE attempt_id = ? AND owner_id = ?
        AND fencing_token = ? AND expires_at > ?`).get(input.attemptId, input.ownerId, input.fencingToken, now);
      if (!lease || row.fencing_token !== input.fencingToken) throw new LeaseError("STALE_FENCE", "Attempt fencing token is stale");
      assertAttemptTransition(AttemptStatusSchema.parse(row.status), input.status);
      this.database.prepare(`UPDATE work_package_attempts SET status = ?, started_at = COALESCE(started_at, ?),
        completed_at = CASE WHEN ? IN ('completed','failed','aborted') THEN ? ELSE completed_at END, updated_at = ? WHERE id = ?`)
        .run(input.status, input.status === "running" ? now : null, input.status, now, now, input.attemptId);
      const item = this.work.get(row.work_package_id)!;
      if (input.status === "running" && item.status === "leased") this.work.transitionStatus(item.id, item.revision, "running", now);
      return fromRow(this.database.prepare("SELECT * FROM work_package_attempts WHERE id = ?").get(input.attemptId) as AttemptRow);
    }).immediate();
  }
}
