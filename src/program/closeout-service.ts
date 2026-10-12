import { createHash } from "node:crypto";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionBarrier } from "./execution-barrier";
import { BudgetLedger } from "../budget/budget-ledger";

export interface CloseoutReport {
  programId: string;
  outcome: "completed" | "incomplete";
  mandatory: { total: number; completed: number; verified: number };
  reservations: Record<string, number>;
  uncertainEffects: number;
  reasons: string[];
  createdAt: string;
}

export class CloseoutService {
  private readonly barrier: ExecutionBarrier;
  constructor(private readonly handle: ExecutionDatabase) { this.barrier = new ExecutionBarrier(handle); }

  close(programId: string, nowInput: string): CloseoutReport {
    const now = new Date(nowInput).toISOString();
    const program = this.handle.connection.prepare("SELECT execution_epoch,status FROM programs WHERE id=?").get(programId) as { execution_epoch: number; status: string } | undefined;
    if (!program) throw new Error("PROGRAM_NOT_FOUND");
    if (["completed", "incomplete", "cancelled"].includes(program.status)) {
      const row = this.handle.connection.prepare("SELECT report_json FROM program_closeouts WHERE program_id=?").get(programId) as { report_json: string } | undefined;
      if (!row) throw new Error("PROGRAM_ALREADY_TERMINAL");
      return JSON.parse(row.report_json) as CloseoutReport;
    }
    this.barrier.freeze(programId, program.execution_epoch, "closeout", now);
    const ledger = BudgetLedger.from(this.handle);
    const activeReservations = this.handle.connection.prepare("SELECT id,revision FROM budget_reservations WHERE program_id=? AND state='active' ORDER BY id").all(programId) as Array<{ id: string; revision: number }>;
    for (const reservation of activeReservations) ledger.markUncertain(reservation.id, reservation.revision, now);
    // A reservation that never became active has no provider request to reconcile.
    // Release children before parents; retrying the bounded set handles nested envelopes.
    let releasable = this.handle.connection.prepare("SELECT id,revision FROM budget_reservations WHERE program_id=? AND state='created' ORDER BY id").all(programId) as Array<{ id: string; revision: number }>;
    while (releasable.length) {
      const remaining: typeof releasable = []; let progressed = false;
      for (const reservation of releasable) {
        try { ledger.release(reservation.id, reservation.revision, now); progressed = true; }
        catch { remaining.push(reservation); }
      }
      if (!progressed) break;
      releasable = remaining.map((reservation) => ({ ...reservation, revision: Number(this.handle.connection.prepare("SELECT revision FROM budget_reservations WHERE id=?").pluck().get(reservation.id)) }));
    }
    return this.handle.connection.transaction(() => {
      this.handle.connection.prepare("UPDATE programs SET status='closing_out',revision=revision+1,updated_at=? WHERE id=?").run(now, programId);
      const reservationRows = this.handle.connection.prepare("SELECT state,COUNT(*) count FROM budget_reservations WHERE program_id=? GROUP BY state").all(programId) as Array<{ state: string; count: number }>;
      const reservations = Object.fromEntries(reservationRows.map((row) => [row.state, row.count]));
      const unresolvedReservations = (reservations.created ?? 0) + (reservations.active ?? 0) + (reservations.uncertain ?? 0);
      const mandatory = this.handle.connection.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed FROM work_packages WHERE program_id=? AND mandatory=1`).get(programId) as { total: number; completed: number | null };
      const verified = Number(this.handle.connection.prepare(`SELECT COUNT(*) FROM work_packages wp
        WHERE wp.program_id=? AND wp.mandatory=1 AND wp.status='completed'
          AND EXISTS (SELECT 1 FROM acceptance_criteria ac WHERE ac.work_package_id=wp.id)
          AND NOT EXISTS (
            SELECT 1 FROM acceptance_criteria ac
            LEFT JOIN verification_evidence ve ON ve.work_package_id=wp.id AND ve.criterion_id=ac.id
            WHERE ac.work_package_id=wp.id AND (ve.id IS NULL OR ve.passed=0)
          )`).pluck().get(programId) ?? 0);
      const uncertainEffects = Number(this.handle.connection.prepare("SELECT COUNT(*) FROM effects WHERE program_id=? AND state='uncertain'").pluck().get(programId) ?? 0);
      const reasons: string[] = [];
      if ((mandatory.completed ?? 0) !== mandatory.total) reasons.push("mandatory_work_incomplete");
      if (verified !== mandatory.total) reasons.push("mandatory_evidence_missing");
      if (unresolvedReservations) reasons.push("reservation_state_unresolved");
      if (uncertainEffects) reasons.push("effect_state_uncertain");
      const outcome = reasons.length ? "incomplete" : "completed";
      const report: CloseoutReport = { programId, outcome, mandatory: { total: mandatory.total, completed: mandatory.completed ?? 0, verified }, reservations, uncertainEffects, reasons, createdAt: now };
      const id = `closeout:${createHash("sha256").update(programId).digest("hex")}`;
      this.handle.connection.prepare("INSERT INTO program_closeouts(id,program_id,outcome,report_json,created_at) VALUES(?,?,?,?,?)")
        .run(id, programId, outcome, JSON.stringify(report), now);
      this.handle.connection.prepare("UPDATE programs SET status=?,revision=revision+1,updated_at=? WHERE id=?").run(outcome, now, programId);
      return report;
    }).immediate();
  }
}
