import { createHash } from "node:crypto";
import type { ExecutionDatabase } from "./execution-database";

export type ProgramAlertCode = "BUDGET_OVERRUN" | "PROTECTED_RESERVE_USED" | "DUPLICATE_EFFECT" |
  "SNAPSHOT_FAILURE" | "UNCERTAIN_TOO_LONG" | "QUIESCE_TIMEOUT" | "LATE_EVENT_STATE_ADVANCE" | "RESUME_WITHOUT_PREFLIGHT";

const SAFE_LABEL = /^[A-Za-z0-9._:/-]{1,128}$/;

export class ProgramMetrics {
  constructor(private readonly handle: ExecutionDatabase) {}

  snapshot(programId: string, nowInput = new Date().toISOString()): Record<string, number> {
    const one = (sql: string) => Number(this.handle.connection.prepare(sql).pluck().get(programId) ?? 0);
    const now = Date.parse(nowInput);
    const oldestUnreconciled = this.handle.connection.prepare("SELECT MIN(created_at) FROM budget_reservations WHERE program_id=? AND state IN ('created','active','uncertain')").pluck().get(programId) as string | null;
    const accounts = this.handle.connection.prepare("SELECT limit_json,spent_json FROM budget_accounts WHERE program_id=?").all(programId) as Array<{ limit_json: string; spent_json: string }>;
    const overruns = accounts.filter((row) => {
      const limit = JSON.parse(row.limit_json) as Record<string, number>; const spent = JSON.parse(row.spent_json) as Record<string, number>;
      return Object.entries(spent).some(([key, value]) => typeof value === "number" && value > (limit[key] ?? 0));
    }).length;
    return {
      budgetOverrun: overruns,
      duplicateExternalEffects: one("SELECT COUNT(*) FROM (SELECT operation_key FROM effects WHERE program_id=? GROUP BY operation_key HAVING COUNT(*)>1)"),
      uncertainEffects: one("SELECT COUNT(*) FROM effects WHERE program_id=? AND state='uncertain'"),
      activeReservations: one("SELECT COUNT(*) FROM budget_reservations WHERE program_id=? AND state IN ('created','active')"),
      uncertainReservations: one("SELECT COUNT(*) FROM budget_reservations WHERE program_id=? AND state='uncertain'"),
      snapshots: one("SELECT COUNT(*) FROM suspension_snapshots WHERE program_id=?"),
      openAlerts: one("SELECT COUNT(*) FROM program_alerts WHERE program_id=? AND resolved_at IS NULL"),
      unreconciledReservationAgeMs: oldestUnreconciled ? Math.max(0, now - Date.parse(oldestUnreconciled)) : 0,
      lateEventAdvancedState: one("SELECT COUNT(*) FROM audit_events WHERE program_id=? AND event_type='runtime.event.applied' AND json_extract(metadata_json,'$.eventEpoch')<>json_extract(metadata_json,'$.currentEpoch')"),
    };
  }

  evaluateInvariants(programId: string, now: string, uncertainThresholdMs = 15 * 60_000): Record<string, number> {
    const metrics = this.snapshot(programId, now);
    const ensure = (code: ProgramAlertCode, condition: boolean) => {
      if (!condition) return;
      const exists = this.handle.connection.prepare("SELECT 1 FROM program_alerts WHERE program_id=? AND code=? AND resolved_at IS NULL").get(programId, code);
      if (!exists) this.alert({ programId, code, severity: "critical", at: now });
    };
    ensure("BUDGET_OVERRUN", metrics.budgetOverrun! > 0);
    ensure("DUPLICATE_EFFECT", metrics.duplicateExternalEffects! > 0);
    ensure("UNCERTAIN_TOO_LONG", metrics.unreconciledReservationAgeMs! > uncertainThresholdMs);
    ensure("LATE_EVENT_STATE_ADVANCE", metrics.lateEventAdvancedState! > 0);
    return metrics;
  }

  alert(input: { programId?: string; code: ProgramAlertCode; severity: "warning" | "critical"; labels?: Record<string, string>; at: string }): string {
    const labels = input.labels ?? {};
    for (const [key, value] of Object.entries(labels)) {
      if (!SAFE_LABEL.test(key) || !SAFE_LABEL.test(value)) throw new Error("UNSAFE_METRIC_LABEL");
    }
    const id = `alert:${createHash("sha256").update(`${input.programId ?? "global"}:${input.code}:${input.at}`).digest("hex")}`;
    this.handle.connection.prepare("INSERT INTO program_alerts(id,program_id,code,severity,labels_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, input.programId ?? null, input.code, input.severity, JSON.stringify(labels), new Date(input.at).toISOString());
    return id;
  }
}
