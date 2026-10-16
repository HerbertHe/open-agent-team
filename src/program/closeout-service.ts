import { createHash } from "node:crypto";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionBarrier } from "./execution-barrier";
import { BudgetLedger, BudgetAccountRepository } from "../budget/budget-ledger";
import type { BudgetVector } from "../budget/budget-types";

export interface CloseoutReport {
  programId: string;
  outcome: "completed" | "incomplete";
  mandatory: { total: number; completed: number; verified: number };
  reservations: Record<string, number>;
  uncertainEffects: number;
  uncertainAttempts?: number;
  reasons: string[];
  createdAt: string;
  snapshotId?: string;
  unfinishedWork?: Array<{ id: string; stableKey: string; status: string; mandatory: boolean }>;
  budget?: Array<{ accountId: string; kind: string; limit: BudgetVector; spent: BudgetVector; reserved: BudgetVector }>;
  evidenceIds?: string[];
}

export class CloseoutService {
  private readonly barrier: ExecutionBarrier;
  constructor(private readonly handle: ExecutionDatabase) { this.barrier = new ExecutionBarrier(handle); }

  close(programId: string, nowInput: string, assertCurrent?: () => void): CloseoutReport {
    return this.handle.connection.transaction(() => { assertCurrent?.(); return this.closeInTransaction(programId, nowInput); }).immediate();
  }

  private closeInTransaction(programId: string, nowInput: string): CloseoutReport {
    const now = new Date(nowInput).toISOString();
    const program = this.handle.connection.prepare("SELECT execution_epoch,status,active_plan_version_id FROM programs WHERE id=?").get(programId) as { execution_epoch: number; status: string; active_plan_version_id: string | null } | undefined;
    if (!program) throw new Error("PROGRAM_NOT_FOUND");
    if (["completed", "incomplete", "cancelled"].includes(program.status)) {
      const row = this.handle.connection.prepare("SELECT report_json FROM program_closeouts WHERE program_id=?").get(programId) as { report_json: string } | undefined;
      if (!row) throw new Error("PROGRAM_ALREADY_TERMINAL");
      return JSON.parse(row.report_json) as CloseoutReport;
    }
    if (!this.barrier.isFrozen(programId)) this.barrier.freeze(programId, program.execution_epoch, "closeout", now);
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
      const unresolvedReservations = (reservations.created ?? 0) + (reservations.active ?? 0) + (reservations.uncertain ?? 0) + (reservations.expired ?? 0);
      const mandatory = this.handle.connection.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed FROM work_packages WHERE program_id=? AND mandatory=1
        AND (? IS NULL OR plan_version_id=?)
        AND (SELECT CASE p.scope_tier WHEN 'minimum' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END FROM plan_versions p WHERE p.id=plan_version_id)
          >= CASE json_extract(definition_json,'$.scopeTier') WHEN 'stretch' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END`).get(programId, program.active_plan_version_id, program.active_plan_version_id) as { total: number; completed: number | null };
      const verified = Number(this.handle.connection.prepare(`SELECT COUNT(*) FROM work_packages wp
        WHERE wp.program_id=? AND wp.mandatory=1 AND wp.status='completed'
          AND (? IS NULL OR wp.plan_version_id=?)
          AND EXISTS (SELECT 1 FROM acceptance_criteria ac WHERE ac.work_package_id=wp.id)
          AND (SELECT CASE p.scope_tier WHEN 'minimum' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END FROM plan_versions p WHERE p.id=wp.plan_version_id)
            >= CASE json_extract(wp.definition_json,'$.scopeTier') WHEN 'stretch' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END
          AND NOT EXISTS (
            SELECT 1 FROM acceptance_criteria ac
            WHERE ac.work_package_id=wp.id AND NOT EXISTS (SELECT 1 FROM verification_evidence ve
              WHERE ve.work_package_id=wp.id AND ve.criterion_id=ac.id AND ve.criterion_type=ac.type AND ve.passed=1
              AND (ve.artifact_digest IS NOT NULL OR ve.git_sha IS NOT NULL OR ve.criterion_type IN ('human_approval','external_state'))
              AND ve.attempt_id=(SELECT a.id FROM work_package_attempts a WHERE a.work_package_id=wp.id AND a.status='completed' ORDER BY a.attempt_number DESC LIMIT 1))
          )`).pluck().get(programId, program.active_plan_version_id, program.active_plan_version_id) ?? 0);
      const uncertainEffects = Number(this.handle.connection.prepare("SELECT COUNT(*) FROM effects WHERE program_id=? AND state='uncertain'").pluck().get(programId) ?? 0);
      const pendingEffects = Number(this.handle.connection.prepare("SELECT COUNT(*) FROM effects WHERE program_id=? AND state IN ('prepared','dispatched')").pluck().get(programId) ?? 0);
      const reasons: string[] = [];
      if ((mandatory.completed ?? 0) !== mandatory.total) reasons.push("mandatory_work_incomplete");
      if (verified !== mandatory.total) reasons.push("mandatory_evidence_missing");
      if (unresolvedReservations) reasons.push("reservation_state_unresolved");
      if (uncertainEffects) reasons.push("effect_state_uncertain");
      if (pendingEffects) reasons.push("effect_state_unresolved");
      const activeAttempts = Number(this.handle.connection.prepare(`SELECT COUNT(*) FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id
        WHERE w.program_id=? AND a.status IN ('leased','running','checkpointed','verifying')`).pluck().get(programId));
      if (activeAttempts) reasons.push("attempt_state_unresolved");
      const uncertainAttempts = Number(this.handle.connection.prepare(`SELECT COUNT(*) FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id
        WHERE w.program_id=? AND a.status IN ('uncertain','expired')`).pluck().get(programId));
      if (uncertainAttempts) reasons.push("attempt_state_uncertain");
      const outcome = reasons.length ? "incomplete" : "completed";
      const snapshotId = this.handle.connection.prepare("SELECT id FROM suspension_snapshots WHERE program_id=? ORDER BY execution_epoch DESC LIMIT 1").pluck().get(programId) as string | undefined;
      const unfinishedWork = this.handle.connection.prepare(`SELECT id,stable_key stableKey,status,mandatory FROM work_packages
        WHERE program_id=? AND plan_version_id=? AND status<>'completed' ORDER BY id`).all(programId, program.active_plan_version_id) as Array<{ id: string; stableKey: string; status: string; mandatory: number }>;
      const report: CloseoutReport = { programId, outcome, mandatory: { total: mandatory.total, completed: mandatory.completed ?? 0, verified }, reservations, uncertainEffects, uncertainAttempts, reasons, createdAt: now,
        ...(snapshotId ? { snapshotId } : {}), unfinishedWork: unfinishedWork.map((item) => ({ ...item, mandatory: Boolean(item.mandatory) })),
        budget: BudgetAccountRepository.from(this.handle).listByProgram(programId).map((account) => ({ accountId: account.id, kind: account.kind, limit: account.limit, spent: account.spent, reserved: account.reserved })),
        evidenceIds: this.handle.connection.prepare("SELECT id FROM verification_evidence WHERE program_id=? ORDER BY id").pluck().all(programId) as string[] };
      const id = `closeout:${createHash("sha256").update(programId).digest("hex")}`;
      this.handle.connection.prepare("INSERT INTO program_closeouts(id,program_id,outcome,report_json,created_at) VALUES(?,?,?,?,?)")
        .run(id, programId, outcome, JSON.stringify(report), now);
      this.handle.connection.prepare("UPDATE programs SET status=?,revision=revision+1,updated_at=? WHERE id=?").run(outcome, now, programId);
      return report;
    }).immediate();
  }
}
