import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import { ProgramIdSchema } from "./program-types";
import { createHash } from "node:crypto";
import { insertExecutionOutboxEvent } from "./execution-outbox";

export class ExecutionBarrierError extends Error {
  constructor(readonly code: "EXECUTION_FROZEN" | "STALE_EPOCH", message: string) { super(message); this.name = "ExecutionBarrierError"; }
}
export class ExecutionBarrier {
  private readonly database: Database.Database;
  constructor(handle: ExecutionDatabase) { this.database = handle.connection; }
  freeze(programIdInput: string, executionEpoch: number, reason: string, now: string): void {
    const programId = ProgramIdSchema.parse(programIdInput);
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO execution_barriers(program_id, execution_epoch, active, reason, created_at, updated_at)
        VALUES(?, ?, 1, ?, ?, ?) ON CONFLICT(program_id) DO UPDATE SET execution_epoch=excluded.execution_epoch, active=1,
        reason=excluded.reason, revision=execution_barriers.revision+1, updated_at=excluded.updated_at`)
        .run(programId, executionEpoch, reason.slice(0, 10_000), now, now);
      const key = `barrier:${programId}:${executionEpoch}:freeze`; const hash = createHash("sha256").update(key).digest("hex");
      insertExecutionOutboxEvent(this.database, { id: `evt:${hash}`, dedupeKey: `barrier:${hash}`, aggregateType: "program", aggregateId: programId,
        eventType: "program.execution_frozen", payload: { executionEpoch, reason }, availableAt: now, createdAt: now });
    }).immediate();
  }
  release(programIdInput: string, executionEpoch: number, now: string): void {
    const programId = ProgramIdSchema.parse(programIdInput);
    this.database.transaction(() => {
      const result = this.database.prepare(`UPDATE execution_barriers SET active=0, revision=revision+1, updated_at=?
        WHERE program_id=? AND execution_epoch=? AND active=1`).run(now, programId, executionEpoch);
      if (result.changes !== 1) throw new ExecutionBarrierError("STALE_EPOCH", "Cannot release a barrier from another epoch");
      const key = `barrier:${programId}:${executionEpoch}:release`; const hash = createHash("sha256").update(key).digest("hex");
      insertExecutionOutboxEvent(this.database, { id: `evt:${hash}`, dedupeKey: `barrier:${hash}`, aggregateType: "program", aggregateId: programId,
        eventType: "program.execution_released", payload: { executionEpoch }, availableAt: now, createdAt: now });
    }).immediate();
  }
  assertAllowed(programIdInput: string, executionEpoch: number): void {
    const programId = ProgramIdSchema.parse(programIdInput);
    const programEpoch = this.database.prepare("SELECT execution_epoch FROM programs WHERE id=?").pluck().get(programId) as number | undefined;
    if (programEpoch !== executionEpoch) throw new ExecutionBarrierError("STALE_EPOCH", `Expected epoch ${programEpoch}, received ${executionEpoch}`);
    const barrier = this.database.prepare("SELECT active FROM execution_barriers WHERE program_id=? AND execution_epoch=?").pluck().get(programId, executionEpoch) as number | undefined;
    if (barrier === 1) throw new ExecutionBarrierError("EXECUTION_FROZEN", `Program ${programId} is frozen`);
  }
  isFrozen(programId: string): boolean { return this.database.prepare("SELECT active FROM execution_barriers WHERE program_id=?").pluck().get(programId) === 1; }
}
