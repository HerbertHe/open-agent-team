import { createHash } from "node:crypto";
import type { ExecutionDatabase } from "./execution-database";
import { ProgramControlService } from "./program-control-service";
import { ProgramRepository } from "./execution-repositories";
import { SuspensionSnapshotStore } from "./suspension-snapshot-store";
import { CloseoutService, type CloseoutReport } from "./closeout-service";

/** Stop through the same durable control protocol as a user interruption, then
 * reconcile usage/effects and publish the final report. A frozen closing_out
 * Program can resume finalization after a process restart. */
export class ProgramCloseoutRuntime {
  constructor(private readonly handle: ExecutionDatabase, private readonly control: ProgramControlService,
    private readonly snapshots: SuspensionSnapshotStore,
    private readonly quiesce: (programId: string) => Promise<void>,
    private readonly reconcileAttempt: (attemptId: string) => Promise<void>) {}

  async close(programId: string, now: string, reason: string, assertCurrent?: () => void): Promise<CloseoutReport> {
    assertCurrent?.();
    let program = new ProgramRepository(this.handle).get(programId);
    if (!program) throw new Error("PROGRAM_NOT_FOUND");
    if (["completed", "incomplete", "cancelled"].includes(program.status)) return new CloseoutService(this.handle).close(programId, now);
    if (program.status !== "closing_out") {
      const requestId = `auto-closeout:${createHash("sha256").update(`${programId}:${program.executionEpoch}`).digest("hex")}`;
      await this.control.interrupt(programId, { controlRequestId: requestId, mode: "cancel_closeout", reason,
        expectedRevision: program.revision, requestedAt: now }, assertCurrent);
      assertCurrent?.();
      program = new ProgramRepository(this.handle).get(programId)!;
    }
    const row = this.handle.connection.prepare(`SELECT result_json FROM program_control_requests WHERE program_id=? AND mode='cancel_closeout'
      AND state='completed' ORDER BY created_at DESC LIMIT 1`).get(programId) as { result_json: string } | undefined;
    if (!row) throw new Error("CLOSEOUT_RECOVERY_POINT_MISSING");
    const { snapshotId } = JSON.parse(row.result_json) as { snapshotId: string };
    const { manifest } = this.snapshots.get(snapshotId);
    if (manifest.programId !== programId || manifest.executionEpoch !== program.executionEpoch || manifest.planVersionId !== program.activePlanVersionId) throw new Error("CLOSEOUT_RECOVERY_POINT_STALE");
    await this.quiesce(programId);
    assertCurrent?.();
    const attempts = this.handle.connection.prepare("SELECT a.id FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id WHERE w.program_id=? ORDER BY a.id").pluck().all(programId) as string[];
    for (const attemptId of attempts) { await this.reconcileAttempt(attemptId); assertCurrent?.(); }
    return new CloseoutService(this.handle).close(programId, now, assertCurrent);
  }
}
