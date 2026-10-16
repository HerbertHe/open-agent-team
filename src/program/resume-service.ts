import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import type { InterruptibleRuntimeProvider } from "../sandbox/interface";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import { ExecutionBarrier } from "./execution-barrier";
import { SuspensionSnapshotStore } from "./suspension-snapshot-store";
import { OpaqueIdSchema, ProgramIdSchema } from "./program-types";
import type { Express, Request, Response } from "express";
import { WorkPackageRepository } from "./execution-repositories";
import type { FaultPoint } from "./fault-injection-harness";
import { ExecutionRuntimeContextSchema, type ExecutionRuntimeContext } from "./execution-runtime-context";
import { WakeupService } from "./wakeup-service";

export interface ResumeDryRunReport {
  programId: string; snapshotId: string; blockingDrift: string[]; warnings: string[]; restartWorkPackageIds: string[];
  oldEpoch: number; proposedEpoch: number; requiresConfirmation: true; reportDigest: string;
}

export function registerExperimentalResumeRoute(app: Express, service: ResumeService, enabled: boolean): boolean {
  if (!enabled) return false;
  app.post("/api/experimental/programs/:id/resume-dry-run", (request: Request, response: Response) => {
    try { response.json(service.dryRun({ ...request.body, programId: String(request.params.id) })); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/experimental/programs/:id/resume", async (request: Request, response: Response) => {
    try {
      if (request.body?.report?.programId !== String(request.params.id)) throw new Error("Resume report Program mismatch");
      response.json(await service.resume(request.body));
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  return true;
}
export class ResumeService {
  private readonly database: Database.Database; private readonly barrier: ExecutionBarrier; private readonly audit: ExecutionAuditRepository;
  constructor(private readonly handle: ExecutionDatabase, private readonly snapshots: SuspensionSnapshotStore, private readonly runtime: InterruptibleRuntimeProvider,
    private readonly faultInjector?: (point: FaultPoint) => void, private readonly instanceId?: string, private readonly clock = () => new Date().toISOString()) {
    this.database = handle.connection; this.barrier = new ExecutionBarrier(handle); this.audit = new ExecutionAuditRepository(handle);
  }
  dryRun(input: { programId: string; snapshotId: string; currentGitSha?: string; currentArtifactDigests?: Record<string, string>; pricingChanged?: boolean; providerChanged?: boolean; permissionsChanged?: boolean }): ResumeDryRunReport {
    const programId = ProgramIdSchema.parse(input.programId); const { manifest } = this.snapshots.get(input.snapshotId);
    if (manifest.programId !== programId) throw new Error("Snapshot belongs to another Program");
    const program = this.database.prepare("SELECT status, execution_epoch FROM programs WHERE id=?").get(programId) as { status: string; execution_epoch: number } | undefined;
    if (!program || !["suspended", "suspended_uncertain"].includes(program.status)) throw new Error("Program is not suspended");
    const blockingDrift: string[] = []; const warnings: string[] = [];
    const runtimeOwner = this.database.prepare("SELECT owner_id FROM program_scheduler_leases WHERE program_id=?").pluck().get(programId) as string | undefined;
    if (this.instanceId && runtimeOwner && runtimeOwner !== this.instanceId) blockingDrift.push("foreign_runtime_owner");
    blockingDrift.push(...manifest.resumePreconditions);
    const uncertain = this.database.prepare("SELECT COUNT(*) FROM effects WHERE program_id=? AND state='uncertain'").pluck().get(programId) as number;
    if (uncertain > 0) blockingDrift.push("uncertain_effects");
    for (const workspace of manifest.workspaceStates) if (workspace.headSha) {
      const currentGitSha = input.currentGitSha ?? (() => { try { return execFileSync("git", ["-C", workspace.workspacePath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).trim(); } catch { return undefined; } })();
      if (!currentGitSha) blockingDrift.push(`git_sha_unavailable:${workspace.agentId}`);
      else if (workspace.headSha !== currentGitSha) blockingDrift.push(`git_sha:${workspace.agentId}`);
    }
    for (const artifact of manifest.artifacts) {
      const current = input.currentArtifactDigests?.[artifact.path];
      if (!current) blockingDrift.push(`artifact_unavailable:${artifact.path}`);
      else if (current !== artifact.digest) blockingDrift.push(`artifact:${artifact.path}`);
    }
    if (input.permissionsChanged) blockingDrift.push("permissions_changed");
    if (input.pricingChanged) warnings.push("pricing_changed_reestimate_required"); if (input.providerChanged) warnings.push("provider_changed_reprobe_required");
    const restartWorkPackageIds = manifest.workPackages.filter((item) => !["completed", "cancelled"].includes(item.status)).map((item) => item.id);
    const base = { programId, snapshotId: manifest.id, blockingDrift, warnings, restartWorkPackageIds, oldEpoch: program.execution_epoch, proposedEpoch: program.execution_epoch + 1, requiresConfirmation: true as const };
    return { ...base, reportDigest: createHash("sha256").update(JSON.stringify(base)).digest("hex") };
  }
  async resume(input: { requestId: string; expectedRevision: number; report: ResumeDryRunReport; confirmed: boolean; agentIds?: string[]; now: string }): Promise<{ executionEpoch: number; status: "running" }> {
    if (!input.confirmed) throw new Error("Resume requires explicit user confirmation");
    const report = input.report; if (report.blockingDrift.length) throw new Error(`Blocking drift: ${report.blockingDrift.join(",")}`);
    const { reportDigest, ...reportBody } = report;
    if (createHash("sha256").update(JSON.stringify(reportBody)).digest("hex") !== reportDigest) throw new Error("Resume report digest is invalid");
    const freshReport = this.dryRun({ programId: report.programId, snapshotId: report.snapshotId });
    if (freshReport.blockingDrift.length || freshReport.reportDigest !== report.reportDigest) throw new Error("Resume preconditions changed");
    const owner = this.database.prepare("SELECT owner_id,fencing_token FROM program_scheduler_leases WHERE program_id=?").get(report.programId) as { owner_id: string; fencing_token: number } | undefined;
    const assertOwner = () => {
      if (!this.instanceId) return;
      const current = this.database.prepare("SELECT owner_id,fencing_token,expires_at FROM program_scheduler_leases WHERE program_id=?").get(report.programId) as { owner_id: string; fencing_token: number; expires_at: string } | undefined;
      if (!owner && !current) return;
      if (!owner || !current || current.owner_id !== this.instanceId || current.fencing_token !== owner.fencing_token || current.expires_at <= this.clock()) throw new Error("RESUME_RUNTIME_OWNER_STALE");
    };
    const { manifest } = this.snapshots.get(report.snapshotId);
    const resetContexts = new Map<string, ExecutionRuntimeContext>();
    const epoch = this.database.transaction(() => {
      assertOwner();
      const row = this.database.prepare("SELECT revision, execution_epoch, status FROM programs WHERE id=?").get(report.programId) as { revision: number; execution_epoch: number; status: string };
      if (row.revision !== input.expectedRevision || row.execution_epoch !== report.oldEpoch || !["suspended", "suspended_uncertain"].includes(row.status)) throw new Error("REVISION_CONFLICT");
      const next = row.execution_epoch + 1;
      this.database.prepare("UPDATE programs SET status='reconciling', execution_epoch=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?")
        .run(next, input.now, report.programId, input.expectedRevision);
      this.barrier.freeze(report.programId, next, "resume_transition", input.now);
      const work = new WorkPackageRepository(this.handle);
      for (const workPackageId of report.restartWorkPackageIds) {
        let item = work.get(workPackageId); if (!item) continue;
        if (["running", "checkpointed", "verifying"].includes(item.status)) item = work.transitionStatus(item.id, item.revision, "failed", input.now);
        if (["leased", "failed"].includes(item.status)) item = work.transitionStatus(item.id, item.revision, "runnable", input.now);
        if (item.status !== "runnable") continue;
        const maxima = this.database.prepare("SELECT COALESCE(MAX(attempt_number),0) n, COALESCE(MAX(fencing_token),0) f FROM work_package_attempts WHERE work_package_id=?").get(item.id) as { n: number; f: number };
        const attemptId = `resume:${createHash("sha256").update(`${input.requestId}:${item.id}:${next}`).digest("hex")}`;
        this.database.prepare(`INSERT INTO work_package_attempts(id, work_package_id, attempt_number, status, execution_epoch, fencing_token, created_at, updated_at)
          VALUES(?, ?, ?, 'created', ?, ?, ?, ?)`)
          .run(attemptId, item.id, maxima.n + 1, next, maxima.f + 1, input.now, input.now);
        const snapshotWork = manifest.workPackages.find((entry) => entry.id === item.id);
        if (snapshotWork?.agentId) resetContexts.set(snapshotWork.agentId, ExecutionRuntimeContextSchema.parse({ programId: report.programId, workPackageId: item.id, attemptId, executionEpoch: next, fencingToken: maxima.f + 1, operationId: `resume:${input.requestId}:${item.id}` }));
      }
      return next;
    }).immediate();
    this.faultInjector?.("resume_after_epoch_increment");
    try {
      const authoritativeAgentIds = new Set(manifest.workspaceStates.map((workspace) => workspace.agentId));
      for (const agentId of authoritativeAgentIds) { assertOwner(); await this.runtime.resetSession(agentId, resetContexts.get(agentId)); assertOwner(); }
    } catch (error) {
      assertOwner();
      this.database.prepare("UPDATE programs SET status='suspended', revision=revision+1, updated_at=? WHERE id=? AND execution_epoch=?").run(input.now, report.programId, epoch);
      throw error;
    }
    this.database.transaction(() => {
      assertOwner();
      this.database.prepare("UPDATE programs SET status='running', revision=revision+1, updated_at=? WHERE id=? AND execution_epoch=? AND status='reconciling'").run(input.now, report.programId, epoch);
      this.barrier.release(report.programId, epoch, input.now);
      const planId = this.database.prepare("SELECT active_plan_version_id FROM programs WHERE id=?").pluck().get(report.programId) as string | null;
      if (planId) new WakeupService(this.handle).schedule({ programId: report.programId,
        dedupeKey: `resume-wakeup:${createHash("sha256").update(`${input.requestId}:${epoch}`).digest("hex")}`,
        wakeAt: input.now, createdAt: input.now, payload: { kind: "scheduler_tick", executionEpoch: epoch, planVersionId: planId } });
      this.audit.append({ id: `audit:${createHash("sha256").update(input.requestId).digest("hex")}`, programId: report.programId, actorType: "user", eventType: "program.resumed", requestId: OpaqueIdSchema.parse(input.requestId), metadata: { snapshotId: report.snapshotId, reportDigest: report.reportDigest, epoch }, createdAt: input.now });
    }).immediate();
    return { executionEpoch: epoch, status: "running" };
  }

  recoverInterrupted(now: string, onlyExpiredOwned = false): number {
    const result = this.database.prepare(`UPDATE programs SET status='suspended',revision=revision+1,updated_at=?
      WHERE status='reconciling' AND EXISTS (SELECT 1 FROM execution_barriers b WHERE b.program_id=programs.id AND b.active=1 AND b.reason='resume_transition')
      AND NOT EXISTS (SELECT 1 FROM program_scheduler_leases s WHERE s.program_id=programs.id AND s.expires_at>?)
      AND (?=0 OR EXISTS (SELECT 1 FROM program_scheduler_leases s WHERE s.program_id=programs.id))`)
      .run(new Date(now).toISOString(), new Date(now).toISOString(), onlyExpiredOwned ? 1 : 0);
    return result.changes;
  }
}
