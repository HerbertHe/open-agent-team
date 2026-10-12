import type Database from "better-sqlite3";
import type { RuntimeExecutionAuthorization } from "../sandbox/interface";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionBarrier } from "./execution-barrier";

export class RuntimeExecutionGuardError extends Error {
  constructor(readonly code: "STALE_EXECUTION" | "INVALID_RESERVATION", message: string) {
    super(message);
    this.name = "RuntimeExecutionGuardError";
  }
}

/** Last-line admission check at the model/tool runtime boundary. */
export class RuntimeExecutionGuard {
  private readonly database: Database.Database;
  private readonly barrier: ExecutionBarrier;

  constructor(handle: ExecutionDatabase, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = handle.connection;
    this.barrier = new ExecutionBarrier(handle);
  }

  assertAllowed(input: RuntimeExecutionAuthorization): void {
    const { context } = input;
    try {
      this.barrier.assertAllowed(context.programId, context.executionEpoch);
    } catch (error) {
      throw new RuntimeExecutionGuardError("STALE_EXECUTION", error instanceof Error ? error.message : String(error));
    }
    const attempt = this.database.prepare(`SELECT a.work_package_id, a.status, a.execution_epoch, a.fencing_token,
        w.program_id, l.owner_id, l.expires_at
      FROM work_package_attempts a
      JOIN work_packages w ON w.id = a.work_package_id
      LEFT JOIN attempt_leases l ON l.attempt_id = a.id
      WHERE a.id = ?`).get(context.attemptId) as {
        work_package_id: string; status: string; execution_epoch: number; fencing_token: number;
        program_id: string; owner_id: string | null; expires_at: string | null;
      } | undefined;
    const now = this.now();
    if (!attempt
      || attempt.program_id !== context.programId
      || attempt.work_package_id !== context.workPackageId
      || attempt.execution_epoch !== context.executionEpoch
      || attempt.fencing_token !== context.fencingToken
      || attempt.owner_id !== input.agentId
      || !attempt.expires_at
      || attempt.expires_at <= now
      || !["leased", "running"].includes(attempt.status)) {
      throw new RuntimeExecutionGuardError("STALE_EXECUTION", "Attempt identity, lease owner, status, expiry, epoch or fencing token is stale");
    }
    if (context.reservationId) {
      const reservation = this.database.prepare(`SELECT r.state, a.program_id
        FROM budget_reservations r JOIN budget_accounts a ON a.id = r.account_id
        WHERE r.id = ?`).get(context.reservationId) as { state: string; program_id: string } | undefined;
      if (!reservation || reservation.program_id !== context.programId || reservation.state !== "active") {
        throw new RuntimeExecutionGuardError("INVALID_RESERVATION", "Execution budget reservation is missing, inactive or belongs to another program");
      }
    }
  }
}
