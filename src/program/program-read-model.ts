import type { Express, Request, Response } from "express";
import type { ExecutionDatabase } from "./execution-database";

export class ProgramReadModel {
  constructor(private readonly handle: ExecutionDatabase) {}

  list(projectId: string): unknown[] {
    return (this.handle.connection.prepare("SELECT id FROM programs WHERE project_id=? ORDER BY updated_at DESC").all(projectId) as Array<{ id: string }>).map((row) => this.get(row.id));
  }

  get(programId: string): unknown {
    const program = this.handle.connection.prepare("SELECT * FROM programs WHERE id=?").get(programId);
    if (!program) return undefined;
    const accounts = this.handle.connection.prepare("SELECT kind,limit_json,spent_json,reserved_json,protected FROM budget_accounts WHERE program_id=? ORDER BY kind").all(programId)
      .map((row: any) => ({ kind: row.kind, limit: JSON.parse(row.limit_json), spent: JSON.parse(row.spent_json), reserved: JSON.parse(row.reserved_json), protected: row.protected === 1 }));
    const packages = this.handle.connection.prepare("SELECT id,stable_key,status,mandatory,priority,definition_json FROM work_packages WHERE program_id=? ORDER BY priority DESC,id").all(programId)
      .map((row: any) => ({ id: row.id, stableKey: row.stable_key, status: row.status, mandatory: row.mandatory === 1, priority: row.priority, definition: JSON.parse(row.definition_json) }));
    const dependencies = this.handle.connection.prepare(`SELECT d.work_package_id workPackageId,d.depends_on_work_package_id dependsOn
      FROM work_package_dependencies d JOIN work_packages w ON w.id=d.work_package_id WHERE w.program_id=? ORDER BY d.work_package_id,d.depends_on_work_package_id`).all(programId);
    const timeline = this.handle.connection.prepare("SELECT event_type,reason,metadata_json,created_at FROM audit_events WHERE program_id=? ORDER BY created_at DESC,id DESC LIMIT 200").all(programId)
      .map((row: any) => ({ type: row.event_type, reason: row.reason ?? undefined, metadata: JSON.parse(row.metadata_json), at: row.created_at }));
    const uncertainty = {
      effects: Number(this.handle.connection.prepare("SELECT COUNT(*) FROM effects WHERE program_id=? AND state='uncertain'").pluck().get(programId) ?? 0),
      reservations: Number(this.handle.connection.prepare("SELECT COUNT(*) FROM budget_reservations WHERE program_id=? AND state='uncertain'").pluck().get(programId) ?? 0),
      attempts: Number(this.handle.connection.prepare(`SELECT COUNT(*) FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id
        WHERE w.program_id=? AND a.status='uncertain'`).pluck().get(programId) ?? 0),
    };
    const latestSnapshot = this.handle.connection.prepare("SELECT id,created_at FROM suspension_snapshots WHERE program_id=? ORDER BY created_at DESC LIMIT 1").get(programId);
    return { program, accounts, packages, dependencies, timeline, uncertainty, latestSnapshot, sourceOfTruth: "execution_database" };
  }
}

export function registerExperimentalProgramReadRoutes(app: Express, service: ProgramReadModel, enabled: boolean): boolean {
  if (!enabled) return false;
  app.get("/api/experimental/programs", (request: Request, response: Response) => {
    const projectId = String(request.query.projectId ?? "");
    if (!projectId) { response.status(400).json({ error: "projectId is required" }); return; }
    response.json(service.list(projectId));
  });
  app.get("/api/experimental/programs/:id/view", (request: Request, response: Response) => {
    const result = service.get(String(request.params.id));
    if (!result) { response.status(404).json({ error: "Program not found" }); return; }
    response.json(result);
  });
  return true;
}
