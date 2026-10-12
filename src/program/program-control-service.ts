import { createHash } from "node:crypto";
import { z } from "zod";
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import type { InterruptibleRuntimeProvider } from "../sandbox/interface";
import { simpleGit } from "simple-git";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import { ExecutionBarrier } from "./execution-barrier";
import { SuspensionSnapshotStore, SuspensionSnapshotManifestSchema } from "./suspension-snapshot-store";
import { OpaqueIdSchema, ProgramIdSchema } from "./program-types";
import { CheckpointStore } from "./checkpoint-store";
import { BudgetLedger } from "../budget/budget-ledger";

const Timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
export const InterruptProgramRequestSchema = z.object({ controlRequestId: OpaqueIdSchema, mode: z.enum(["graceful", "immediate", "cancel_closeout"]),
  reason: z.string().trim().min(1).max(10_000), expectedRevision: z.number().int().nonnegative(), requestedAt: Timestamp,
  attempts: z.array(z.object({ agentId: OpaqueIdSchema, attemptId: OpaqueIdSchema }).strict()).optional(),
}).strict();
export interface ProgramControlResult { requestId: string; programId: string; state: "suspended" | "suspended_uncertain" | "closing_out"; snapshotId: string; executionEpoch: number; uncertainAttempts: string[] }

export class ProgramControlService {
  private readonly database: Database.Database; private readonly barrier: ExecutionBarrier; private readonly audit: ExecutionAuditRepository; private readonly checkpoints: CheckpointStore;
  constructor(private readonly handle: ExecutionDatabase, private readonly runtime: InterruptibleRuntimeProvider,
    private readonly snapshots: SuspensionSnapshotStore, private readonly enabled: boolean) {
    this.database = handle.connection; this.barrier = new ExecutionBarrier(handle); this.audit = new ExecutionAuditRepository(handle); this.checkpoints = new CheckpointStore(handle);
  }
  async interrupt(programIdInput: string, inputRaw: z.input<typeof InterruptProgramRequestSchema>): Promise<ProgramControlResult> {
    if (!this.enabled) throw new Error("BUDGET_EXECUTION_DISABLED");
    const programId = ProgramIdSchema.parse(programIdInput); const input = InterruptProgramRequestSchema.parse(inputRaw);
    const existing = this.database.prepare("SELECT program_id, mode, state, result_json FROM program_control_requests WHERE request_id=?").get(input.controlRequestId) as { program_id: string; mode: string; state: string; result_json: string | null } | undefined;
    if (existing && (existing.program_id !== programId || existing.mode !== input.mode)) throw new Error("CONTROL_REQUEST_CONFLICT");
    if (existing?.state === "completed" && existing.result_json) return JSON.parse(existing.result_json) as ProgramControlResult;
    if (existing) throw new Error(`CONTROL_REQUEST_${existing.state.toUpperCase()}`);
    const transition = this.database.transaction(() => {
      const program = this.database.prepare("SELECT revision, execution_epoch, status FROM programs WHERE id=?").get(programId) as { revision: number; execution_epoch: number; status: string } | undefined;
      if (!program) throw new Error(`Program ${programId} not found`); if (program.revision !== input.expectedRevision) throw new Error("REVISION_CONFLICT");
      if (!["running", "waiting", "replanning"].includes(program.status)) throw new Error(`Program cannot be interrupted from ${program.status}`);
      const attempts = this.database.prepare(`SELECT a.id attempt_id,a.execution_epoch,a.fencing_token,a.work_package_id,l.owner_id agent_id
        FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id
        LEFT JOIN attempt_leases l ON l.attempt_id=a.id
        WHERE w.program_id=? AND a.status IN ('leased','running','checkpointed','verifying') ORDER BY a.id`).all(programId) as Array<{ attempt_id: string; execution_epoch: number; fencing_token: number; work_package_id: string; agent_id: string | null }>;
      const epoch = program.execution_epoch + 1;
      this.database.prepare(`INSERT INTO program_control_requests(request_id, program_id, mode, state, created_at, updated_at)
        VALUES(?, ?, ?, 'requested', ?, ?)`).run(input.controlRequestId, programId, input.mode, input.requestedAt, input.requestedAt);
      this.database.prepare(`UPDATE programs SET status='interrupt_requested', execution_epoch=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?`)
        .run(epoch, input.requestedAt, programId, input.expectedRevision);
      this.barrier.freeze(programId, epoch, input.reason, input.requestedAt);
      this.audit.append({ id: `audit:${createHash("sha256").update(input.controlRequestId).digest("hex")}`, programId, actorType: "user", eventType: "program.interrupt.requested",
        requestId: input.controlRequestId, reason: input.reason, metadata: { mode: input.mode, epoch }, createdAt: input.requestedAt });
      return { epoch, attempts };
    }).immediate();
    const nextEpoch = transition.epoch;
    this.setPhase(input.controlRequestId, programId, "quiescing", "quiescing", input.requestedAt);
    this.database.prepare("DELETE FROM attempt_leases WHERE attempt_id IN (SELECT id FROM work_package_attempts WHERE work_package_id IN (SELECT id FROM work_packages WHERE program_id=?))").run(programId);
    const checkpointDeadline = new Date(Date.parse(input.requestedAt) + 10_000).toISOString();
    const checkpointIds = new Map<string, string>();
    const uncertainAttempts = new Set<string>();
    if (input.mode === "graceful") await Promise.all(transition.attempts.map(async (item) => {
      if (!item.agent_id) { uncertainAttempts.add(item.attempt_id); return; }
      try {
        const result = await this.runtime.requestCheckpoint(item.agent_id, item.attempt_id, checkpointDeadline);
        if (!result.acknowledged || !result.state) { uncertainAttempts.add(item.attempt_id); return; }
        const checkpointId = `checkpoint:${createHash("sha256").update(`${input.controlRequestId}:${item.attempt_id}`).digest("hex")}`;
        this.checkpoints.save({ id: checkpointId, attemptId: item.attempt_id, executionEpoch: item.execution_epoch, fencingToken: item.fencing_token,
          state: result.state, createdAt: input.requestedAt, expiresAt: new Date(Date.parse(input.requestedAt) + 30 * 24 * 60 * 60 * 1000).toISOString() });
        checkpointIds.set(item.attempt_id, checkpointId);
      } catch { uncertainAttempts.add(item.attempt_id); }
    }));
    for (const item of transition.attempts) {
      const result = item.agent_id
        ? await this.runtime.abortAttempt(item.agent_id, item.attempt_id, input.reason).catch(() => ({ acknowledged: false, providerRequests: [], toolCalls: [] }))
        : { acknowledged: false, providerRequests: [], toolCalls: [] };
      if (!result.acknowledged) { uncertainAttempts.add(item.attempt_id); if (item.agent_id) await this.runtime.terminateSession(item.agent_id, input.reason).catch(() => undefined); }
      this.database.prepare(`UPDATE work_package_attempts SET status=?, updated_at=? WHERE id=? AND status IN ('leased','running','checkpointed','verifying')`)
        .run(result.acknowledged ? "aborted" : "uncertain", input.requestedAt, item.attempt_id);
    }
    this.setPhase(input.controlRequestId, programId, "snapshotting", "snapshotting", input.requestedAt);
    try {
      const snapshotId = `snapshot:${createHash("sha256").update(`${programId}:${nextEpoch}`).digest("hex")}`;
      const planId = this.database.prepare("SELECT active_plan_version_id FROM programs WHERE id=?").pluck().get(programId) as string;
      const revision = this.database.prepare("SELECT revision FROM programs WHERE id=?").pluck().get(programId) as number;
      const budgetRows = this.database.prepare("SELECT id, spent_json, reserved_json FROM budget_accounts WHERE program_id=? ORDER BY id").all(programId);
      const workRows = this.database.prepare("SELECT id, stable_key, status FROM work_packages WHERE program_id=? ORDER BY id").all(programId) as Array<{ id: string; stable_key: string; status: string }>;
      const activeByWork = new Map(transition.attempts.map((item) => [item.work_package_id, item]));
      const reservations = this.database.prepare("SELECT id FROM budget_reservations WHERE program_id=? AND state IN ('created','active','uncertain') ORDER BY id").pluck().all(programId) as string[];
      const effects = this.database.prepare("SELECT operation_key FROM effects WHERE program_id=? AND state='uncertain' ORDER BY operation_key").pluck().all(programId) as string[];
      const wakeups = this.database.prepare("SELECT id FROM wakeups WHERE program_id=? AND state='pending' ORDER BY id").pluck().all(programId) as string[];
      const externalReceipts = this.database.prepare("SELECT id FROM effects WHERE program_id=? AND receipt_digest IS NOT NULL ORDER BY id").pluck().all(programId) as string[];
      const workspaceStates = await Promise.all([...new Set(transition.attempts.map((item) => item.agent_id).filter((value): value is string => Boolean(value)))].map(async (agentId) => {
        const session = this.runtime.describeSession(agentId);
        if (!session) return undefined;
        const git = simpleGit(session.workspacePath);
        const headSha = await git.revparse(["HEAD"]).then((value) => value.trim()).catch(() => undefined);
        const dirty = await git.status().then((value) => value.files.length > 0).catch(() => true);
        return { agentId, workspacePath: session.workspacePath, ...(headSha ? { headSha } : {}), dirty };
      }));
      const manifest = SuspensionSnapshotManifestSchema.parse({ schemaVersion: 1, id: snapshotId, programId, planVersionId: planId, executionEpoch: nextEpoch,
        reason: input.reason, mode: input.mode, programRevision: revision, budgetStateDigest: createHash("sha256").update(JSON.stringify(budgetRows)).digest("hex"),
        activeReservations: reservations, uncertainOperations: effects, workPackages: workRows.map((row) => { const active = activeByWork.get(row.id); return { id: row.id, stableKey: row.stable_key, status: row.status,
          ...(active ? { attemptId: active.attempt_id, ...(active.agent_id ? { agentId: active.agent_id } : {}), fencingToken: active.fencing_token, ...(checkpointIds.get(active.attempt_id) ? { latestCheckpointId: checkpointIds.get(active.attempt_id) } : {}) } : {}) }; }),
        artifacts: [], workspaceStates: workspaceStates.filter((value): value is NonNullable<typeof value> => Boolean(value)), wakeups, externalReceipts, pendingApprovals: [], resumePreconditions: uncertainAttempts.size || effects.length ? ["reconcile_uncertain_operations"] : [], createdAt: input.requestedAt });
      this.snapshots.create(manifest);
      this.setPhase(input.controlRequestId, programId, "reconciling", "reconciling", input.requestedAt);
      const ledger = BudgetLedger.from(this.handle);
      const reservationRows = this.database.prepare("SELECT id,revision,state FROM budget_reservations WHERE program_id=? AND state IN ('created','active') ORDER BY CASE state WHEN 'created' THEN 0 ELSE 1 END,id").all(programId) as Array<{ id: string; revision: number; state: "created" | "active" }>;
      for (const reservation of reservationRows) {
        try { if (reservation.state === "created") ledger.release(reservation.id, reservation.revision, input.requestedAt); else ledger.markUncertain(reservation.id, reservation.revision, input.requestedAt); }
        catch { /* reflected by the final unresolved query below */ }
      }
      const unresolvedReservations = Number(this.database.prepare("SELECT COUNT(*) FROM budget_reservations WHERE program_id=? AND state IN ('created','active','uncertain')").pluck().get(programId) ?? 0);
      const state: ProgramControlResult["state"] = input.mode === "cancel_closeout" ? "closing_out" : uncertainAttempts.size || effects.length || unresolvedReservations ? "suspended_uncertain" : "suspended";
      const result: ProgramControlResult = { requestId: input.controlRequestId, programId, state, snapshotId, executionEpoch: nextEpoch, uncertainAttempts: [...uncertainAttempts] };
      this.database.transaction(() => {
        this.database.prepare("UPDATE programs SET status=?, revision=revision+1, updated_at=? WHERE id=?").run(state, input.requestedAt, programId);
        this.database.prepare("UPDATE program_control_requests SET state='completed', result_json=?, updated_at=? WHERE request_id=?").run(JSON.stringify(result), input.requestedAt, input.controlRequestId);
      }).immediate();
      return result;
    } catch (error) {
      this.database.prepare("UPDATE program_control_requests SET state='failed', result_json=?, updated_at=? WHERE request_id=?")
        .run(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), input.requestedAt, input.controlRequestId);
      throw error;
    }
  }
  status(programId: string, requestId: string): unknown {
    return this.database.prepare("SELECT * FROM program_control_requests WHERE program_id=? AND request_id=?")
      .get(ProgramIdSchema.parse(programId), OpaqueIdSchema.parse(requestId));
  }
  private setPhase(requestId: string, programId: string, requestState: string, programState: string, now: string): void {
    this.database.transaction(() => {
      this.database.prepare("UPDATE program_control_requests SET state=?, updated_at=? WHERE request_id=?").run(requestState, now, requestId);
      this.database.prepare("UPDATE programs SET status=?, revision=revision+1, updated_at=? WHERE id=?").run(programState, now, programId);
    }).immediate();
  }
}

export function registerExperimentalProgramControlRoutes(app: Express, service: ProgramControlService, enabled: boolean): boolean {
  if (!enabled) return false;
  app.post("/api/experimental/programs/:id/interrupt", async (request: Request, response: Response) => {
    try { response.json(await service.interrupt(String(request.params.id), request.body)); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/experimental/programs/:id/interrupt-status", (request: Request, response: Response) => {
    try {
      if (typeof request.query.requestId !== "string") throw new Error("requestId is required");
      const result = service.status(String(request.params.id), request.query.requestId);
      if (!result) { response.status(404).json({ error: "Control request not found" }); return; }
      response.json(result);
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  return true;
}

export function handleStructuredControlIntent(service: ProgramControlService, input: { controlIntent: "interrupt_program"; programId: string; request: z.input<typeof InterruptProgramRequestSchema> }): Promise<ProgramControlResult> {
  return service.interrupt(input.programId, input.request);
}
