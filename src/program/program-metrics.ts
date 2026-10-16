import { randomUUID } from "node:crypto";
import { addBudgetVectors, budgetVectorFits } from "../budget/budget-types";
import type { ExecutionDatabase } from "./execution-database";

export type ProgramAlertCode = "BUDGET_OVERRUN" | "PROTECTED_RESERVE_USED" | "DUPLICATE_EFFECT" |
  "SNAPSHOT_FAILURE" | "UNCERTAIN_TOO_LONG" | "QUIESCE_TIMEOUT" | "LATE_EVENT_STATE_ADVANCE" | "RESUME_WITHOUT_PREFLIGHT";

// Metric dimensions are enumerated: even a syntactically safe token may be a credential.
const LABEL_VALUES: Record<string, readonly string[]> = {
  reason: ["io_error", "timeout", "invariant_violation"],
  component: ["ledger", "scheduler", "snapshot", "resume", "effects"],
};

export class ProgramMetrics {
  constructor(private readonly handle: ExecutionDatabase) {}

  snapshot(programId: string, nowInput = new Date().toISOString()): Record<string, number> {
    const one = (sql: string) => Number(this.handle.connection.prepare(sql).pluck().get(programId) ?? 0);
    const now = Date.parse(nowInput);
    if (!Number.isFinite(now)) throw new RangeError("Invalid metric timestamp");
    const oldestUnreconciled = this.handle.connection.prepare(`SELECT MIN(updated_at) FROM (
      SELECT updated_at FROM budget_reservations WHERE program_id=? AND state='uncertain'
      UNION ALL SELECT updated_at FROM effects WHERE program_id=? AND state='uncertain'
      UNION ALL SELECT a.updated_at FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id WHERE w.program_id=? AND a.status='uncertain')`).pluck().get(programId, programId, programId) as string | null;
    const accounts = this.handle.connection.prepare("SELECT limit_json,spent_json,reserved_json FROM budget_accounts WHERE program_id=?").all(programId) as Array<{ limit_json: string; spent_json: string; reserved_json: string }>;
    const overruns = accounts.filter((row) => {
      try { return !budgetVectorFits(addBudgetVectors(JSON.parse(row.spent_json), JSON.parse(row.reserved_json)), JSON.parse(row.limit_json)); }
      catch { return true; } // Invalid vectors and arithmetic overflow fail closed.
    }).length;
    return {
      budgetOverrun: overruns,
      duplicateExternalEffects: one("SELECT COUNT(*) FROM (SELECT request_id FROM audit_events WHERE program_id=? AND event_type='runtime.tool_dispatched' GROUP BY request_id HAVING COUNT(*)>1)"),
      uncertainAttempts: one("SELECT COUNT(*) FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id WHERE w.program_id=? AND a.status='uncertain'"),
      uncertainEffects: one("SELECT COUNT(*) FROM effects WHERE program_id=? AND state='uncertain'"),
      activeReservations: one("SELECT COUNT(*) FROM budget_reservations WHERE program_id=? AND state IN ('created','active')"),
      uncertainReservations: one("SELECT COUNT(*) FROM budget_reservations WHERE program_id=? AND state='uncertain'"),
      failedControls: one("SELECT COUNT(*) FROM program_control_requests WHERE program_id=? AND state='failed'"),
      quiesceAgeMs: (() => {
        const oldest = this.handle.connection.prepare("SELECT MIN(updated_at) FROM program_control_requests WHERE program_id=? AND state='quiescing'").pluck().get(programId) as string | null;
        return oldest ? Math.max(0, now - Date.parse(oldest)) : 0;
      })(),
      protectedExecutionReservations: one(`SELECT COUNT(*) FROM budget_reservations r JOIN budget_accounts a ON a.id=r.account_id
        WHERE r.program_id=? AND a.protected=1 AND (r.operation_key LIKE 'dispatch:%' OR r.operation_key LIKE 'model:%' OR r.operation_key LIKE 'tool-budget:%')`),
      resumesWithoutPreflight: one("SELECT COUNT(*) FROM audit_events WHERE program_id=? AND event_type='program.resumed' AND (json_extract(metadata_json,'$.reportDigest') IS NULL OR length(json_extract(metadata_json,'$.reportDigest'))<>64)"),
      deadLetterWakeups: one("SELECT COUNT(*) FROM execution_outbox WHERE aggregate_id=? AND event_type='program.wakeup_due' AND state='dead_letter'"),
      snapshots: one("SELECT COUNT(*) FROM suspension_snapshots WHERE program_id=?"),
      openAlerts: one("SELECT COUNT(*) FROM program_alerts WHERE program_id=? AND resolved_at IS NULL"),
      unreconciledReservationAgeMs: oldestUnreconciled ? Math.max(0, now - Date.parse(oldestUnreconciled)) : 0,
      lateEventAdvancedState: one("SELECT COUNT(*) FROM audit_events WHERE program_id=? AND event_type='runtime.event.applied' AND json_extract(metadata_json,'$.eventEpoch')<>json_extract(metadata_json,'$.currentEpoch')"),
    };
  }

  evaluateInvariants(programId: string, now: string, uncertainThresholdMs = 15 * 60_000): Record<string, number> {
    if (!Number.isFinite(uncertainThresholdMs) || uncertainThresholdMs < 0) throw new RangeError("Invalid uncertainty threshold");
    return this.handle.connection.transaction(() => {
      const metrics = this.snapshot(programId, now);
      const ensure = (code: ProgramAlertCode, condition: boolean, recoverable = false) => {
        if (condition) this.alert({ programId, code, severity: "critical", at: now });
        else if (recoverable) this.handle.connection.prepare("UPDATE program_alerts SET resolved_at=? WHERE program_id=? AND code=? AND resolved_at IS NULL").run(now, programId, code);
      };
      ensure("BUDGET_OVERRUN", metrics.budgetOverrun! > 0, true);
      ensure("DUPLICATE_EFFECT", metrics.duplicateExternalEffects! > 0);
      ensure("UNCERTAIN_TOO_LONG", metrics.unreconciledReservationAgeMs! > uncertainThresholdMs, true);
      ensure("QUIESCE_TIMEOUT", metrics.quiesceAgeMs! > 60_000, true);
      ensure("SNAPSHOT_FAILURE", metrics.failedControls! > 0);
      ensure("PROTECTED_RESERVE_USED", metrics.protectedExecutionReservations! > 0);
      ensure("LATE_EVENT_STATE_ADVANCE", metrics.lateEventAdvancedState! > 0);
      ensure("RESUME_WITHOUT_PREFLIGHT", metrics.resumesWithoutPreflight! > 0);
      return this.snapshot(programId, now);
    }).immediate();
  }

  /** Also scans terminal Programs: unresolved usage does not disappear at closeout. */
  evaluateAll(now = new Date().toISOString()): void {
    const programs = this.handle.connection.prepare("SELECT id FROM programs ORDER BY id").pluck().all() as string[];
    for (const id of programs) this.evaluateInvariants(id, now);
  }

  listAlerts(programId: string): unknown[] {
    return this.handle.connection.prepare("SELECT id,code,severity,labels_json,created_at,resolved_at FROM program_alerts WHERE program_id=? ORDER BY created_at DESC,id DESC LIMIT 200")
      .all(programId).map((row: any) => ({ id: row.id, code: row.code, severity: row.severity, labels: JSON.parse(row.labels_json), createdAt: row.created_at, resolvedAt: row.resolved_at }));
  }

  alert(input: { programId?: string; code: ProgramAlertCode; severity: "warning" | "critical"; labels?: Record<string, string>; at: string }): string {
    if (!["BUDGET_OVERRUN", "PROTECTED_RESERVE_USED", "DUPLICATE_EFFECT", "SNAPSHOT_FAILURE", "UNCERTAIN_TOO_LONG", "QUIESCE_TIMEOUT", "LATE_EVENT_STATE_ADVANCE", "RESUME_WITHOUT_PREFLIGHT"].includes(input.code)) throw new Error("INVALID_METRIC_CODE");
    const labels = input.labels ?? {};
    for (const [key, value] of Object.entries(labels)) {
      if (!Object.hasOwn(LABEL_VALUES, key) || !LABEL_VALUES[key]!.includes(value)) throw new Error("UNSAFE_METRIC_LABEL");
    }
    const at = new Date(input.at).toISOString();
    const json = JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))));
    return this.handle.connection.transaction(() => {
      const existing = this.handle.connection.prepare("SELECT id FROM program_alerts WHERE program_id IS ? AND code=? AND labels_json=? AND resolved_at IS NULL").pluck().get(input.programId ?? null, input.code, json) as string | undefined;
      if (existing) {
        if (input.severity === "critical") this.handle.connection.prepare("UPDATE program_alerts SET severity='critical' WHERE id=?").run(existing);
        return existing;
      }
      const id = `alert:${randomUUID()}`;
      this.handle.connection.prepare("INSERT INTO program_alerts(id,program_id,code,severity,labels_json,created_at) VALUES(?,?,?,?,?,?)")
        .run(id, input.programId ?? null, input.code, input.severity, json, at);
      return id;
    }).immediate();
  }
}
