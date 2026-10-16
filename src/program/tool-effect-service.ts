import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Express, Request, Response } from "express";
import type { ExecutionDatabase } from "./execution-database";
import { RuntimeExecutionGuard } from "./runtime-execution-guard";
import { ToolGuard } from "./tool-guard";
import { EffectLedger, effectDigest, type Effect } from "./effect-ledger";
import { EffectReconciler, type EffectStateAdapter, type ProviderEffectState } from "./effect-reconciler";
import { BudgetLedger } from "../budget/budget-ledger";
import { budgetVectorFits } from "../budget/budget-types";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import { ProgramIdSchema } from "./program-types";
import { ToolEffectRequestSchema, type RuntimeToolCall, type ToolEffectRequest } from "./tool-effects-protocol";
import type { ToolResultPayload } from "../sandbox/agent-runner-ipc";

export const MANAGED_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit", "bash"]);
const DELEGATION_TOOLS = new Set(["create-task", "dispatch-worker-tasks", "assign-leader-task"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "query-tasks", "search-project-memory", "list-review-requests", "list-release-proposals"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const operationKey = (attemptId: string, toolCallId: string) => `tool:${hash(`${attemptId}:${toolCallId}`)}`;
const reservationId = (key: string) => `tool-reservation:${hash(key)}`;
const jsonObject = (input: unknown): Record<string, unknown> => {
  const normalized = JSON.parse(JSON.stringify(input ?? {})) as unknown;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) throw new Error("TOOL_ARGUMENTS_INVALID");
  return normalized as Record<string, unknown>;
};

/** Positive postcondition checks only: a missing/changed file never proves an operation was not applied. */
async function resolveFile(root: string, target: string, allowMissing: boolean): Promise<string> {
  const canonical = await fs.realpath(root);
  const resolved = path.resolve(canonical, target);
  const relative = path.relative(canonical, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("TOOL_TARGET_OUTSIDE_WORKSPACE");
  let current = canonical;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("TOOL_TARGET_SYMLINK_REJECTED"); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
  }
  return resolved;
}

export class ToolEffectService {
  private readonly effects: EffectLedger;
  private readonly budget: BudgetLedger;
  private readonly audit: ExecutionAuditRepository;
  private readonly active = new Map<string, { attemptId: string; programId: string }>();
  private readonly running = new Map<string, Promise<ToolResultPayload>>();
  private readonly adapters = new Map<string, EffectStateAdapter>();

  constructor(private readonly handle: ExecutionDatabase, private readonly mode: "shadow" | "soft" | "hard",
    private readonly queryCustom?: (effect: Effect) => Promise<ProviderEffectState>, private readonly projectId?: string,
    private readonly clock = () => new Date().toISOString(), private readonly timeoutMs = 30_000, private readonly instanceId?: string) {
    this.effects = new EffectLedger(handle); this.budget = BudgetLedger.from(handle); this.audit = new ExecutionAuditRepository(handle);
    for (const name of MANAGED_BUILTIN_TOOLS) this.adapters.set(name, { query: (effect) => this.queryFile(effect) });
  }

  private assertProgram(programId: string): void {
    const project = this.handle.connection.prepare("SELECT project_id FROM programs WHERE id=?").pluck().get(ProgramIdSchema.parse(programId));
    if (!project || (this.projectId !== undefined && project !== this.projectId)) throw new Error("PROGRAM_NOT_FOUND");
  }

  private async request(agentId: string, workspacePath: string, input: Extract<ToolEffectRequest, { stage: "begin" }>, builtin: boolean, virtualWorkspace?: string) {
    const params = input.params;
    const request: Record<string, unknown> = { agentId, parametersDigest: effectDigest(params), contextDigest: effectDigest(input.context),
      builtin, workspacePath, toolCallIdDigest: hash(input.toolCallId), parentReservationId: input.context.reservationId ?? null };
    if (builtin && ["write", "edit"].includes(input.toolName)) {
      const target = typeof params.path === "string" ? params.path : "";
      if (!target) throw new Error("TOOL_TARGET_MISSING");
      const mapped = virtualWorkspace && target.startsWith(`${virtualWorkspace}/`) ? target.slice(virtualWorkspace.length + 1) : target;
      const file = await resolveFile(workspacePath, mapped, true);
      request.target = path.relative(await fs.realpath(workspacePath), file);
      if (input.toolName === "write" && typeof params.content === "string") request.postimageDigest = hash(params.content);
      if (input.toolName === "edit" && typeof params.oldText === "string" && params.oldText.length && typeof params.newText === "string") {
        const stat = await fs.stat(file);
        if (stat.size <= 10 * 1024 * 1024) {
          const before = await fs.readFile(file, "utf8");
          if (before.split(params.oldText).length === 2) request.postimageDigest = hash(before.replace(params.oldText, params.newText));
        }
      }
    }
    // Persist only bounded identifiers/digests used by trusted state-query adapters.
    for (const name of ["proposalId", "reviewId", "id"] as const) if (typeof params[name] === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(params[name])) request[name] = params[name];
    if (input.toolName === "report-progress") request.progressDigest = effectDigest({ message: params.message, stage: params.stage ?? null });
    if (typeof params.approve === "boolean") request.approve = params.approve;
    return request;
  }

  private async begin(agentId: string, workspacePath: string, input: Extract<ToolEffectRequest, { stage: "begin" }>, permittedTools: ReadonlySet<string>, builtin: boolean, virtualWorkspace?: string): Promise<Effect> {
    this.assertProgram(input.context.programId);
    if (!permittedTools.has(input.toolName)) throw new Error("TOOL_PERMISSION_DENIED");
    new RuntimeExecutionGuard(this.handle, this.clock, this.instanceId).assertAllowed({ phase: "tool", agentId, context: input.context, toolName: input.toolName });
    if (DELEGATION_TOOLS.has(input.toolName) || (input.toolName === "review-worker-branch" && input.params.approve === false)) throw new Error("UNBUDGETED_DELEGATION_DENIED");
    // Replays do not re-read a mutable file preimage or re-run a tool.
    const key = operationKey(input.context.attemptId, input.toolCallId);
    const previous = this.effects.getByOperationKey(key);
    if (previous) {
      this.assertReplay(previous, agentId, input);
      throw new Error(`EFFECT_REPLAY_BLOCKED:${previous.state}:${key}`);
    }
    const request = await this.request(agentId, workspacePath, input, builtin, virtualWorkspace);
    const effect = this.handle.connection.transaction(() => {
      new RuntimeExecutionGuard(this.handle, this.clock, this.instanceId).assertAllowed({ phase: "tool", agentId, context: input.context, toolName: input.toolName });
      if (!permittedTools.has(input.toolName)) throw new Error("TOOL_PERMISSION_DENIED");
      if (this.effects.getByOperationKey(key)) throw new Error(`EFFECT_REPLAY_BLOCKED:concurrent:${key}`);
      const ambiguous = this.handle.connection.prepare(`SELECT operation_key FROM effects WHERE program_id=? AND effect_type=?
        AND state IN ('prepared','dispatched','uncertain') AND json_extract(request_json,'$.parametersDigest')=? LIMIT 1`)
        .pluck().get(input.context.programId, input.toolName, request.parametersDigest) as string | undefined;
      if (ambiguous) throw new Error(`EFFECT_OUTCOME_UNKNOWN:${ambiguous}`);
      const parent = input.context.reservationId ? this.budget.getReservation(input.context.reservationId) : undefined;
      if (!parent) throw new Error("TOOL_ENVELOPE_MISSING");
      const dispatch = this.handle.connection.prepare(`SELECT metadata_json FROM audit_events WHERE program_id=? AND event_type='program.work_dispatch_started'
        AND json_extract(metadata_json,'$.attemptId')=? LIMIT 1`).get(input.context.programId, input.context.attemptId) as { metadata_json: string } | undefined;
      if (!dispatch || JSON.parse(dispatch.metadata_json).reservationId !== parent.id) throw new Error("TOOL_ENVELOPE_IDENTITY_MISMATCH");
      const budgetAllowed = budgetVectorFits({ toolCalls: 1 }, parent.remaining);
      const impact = READ_TOOLS.has(input.toolName) ? "low" : ["write", "edit", "report-progress"].includes(input.toolName) ? "medium" : "high";
      const effect = new ToolGuard(this.handle).authorize({ agentId, instanceId: this.instanceId, context: input.context, toolName: input.toolName, permittedTools, budgetAllowed,
        mode: this.mode, impact, providerSupportsIdempotency: false, operationKey: key, request, effectId: `effect:${hash(key)}`, now: this.clock() });
      if (this.mode !== "shadow") {
        const reservation = this.budget.reserve({ id: reservationId(key), programId: effect.programId, accountId: parent.accountId,
          parentReservationId: parent.id, operationKey: `tool-budget:${hash(key)}`, amount: { toolCalls: 1 }, consumerClass: "execution", createdAt: this.clock() });
        this.budget.activate(reservation.id, reservation.revision, key, this.clock());
      }
      this.effects.transition(key, "dispatched", this.clock());
      this.audit.append({ id: `tool-start:${hash(key)}`, programId: effect.programId, attemptId: effect.attemptId, actorType: "service", actorId: agentId,
        eventType: "runtime.tool_dispatched", requestId: key, metadata: { toolName: effect.effectType, budgetWouldBlock: !budgetAllowed, mode: this.mode }, createdAt: this.clock() });
      return this.effects.getByOperationKey(key)!;
    }).immediate();
    if (!builtin) this.adapters.set(input.toolName, { query: (effect) => this.queryCustom?.(effect) ?? Promise.resolve({ state: "unknown", reason: "no_state_adapter" }) });
    this.active.set(key, { attemptId: effect.attemptId, programId: effect.programId });
    return effect;
  }

  private assertReplay(effect: Effect, agentId: string, request: ToolEffectRequest): void {
    if (effect.programId !== request.context.programId || effect.attemptId !== request.context.attemptId || effect.effectType !== request.toolName
      || effect.request.agentId !== agentId || effect.request.contextDigest !== effectDigest(request.context)
      || (request.stage === "begin" && effect.request.parametersDigest !== effectDigest(request.params))) throw new Error("EFFECT_REQUEST_CONFLICT");
  }

  private finish(effect: Effect, isError: boolean, resultDigest?: string): void {
    this.handle.connection.transaction(() => {
      const current = this.effects.getByOperationKey(effect.operationKey)!;
      if (["confirmed", "reconciled", "cancelled"].includes(current.state)) {
        if (resultDigest && current.receipt?.resultDigest && current.receipt.resultDigest !== resultDigest) throw new Error("EFFECT_RECEIPT_CONFLICT");
        this.settle(current); this.auditState(current);
        return;
      }
      if (isError) {
        if (current.state === "dispatched") this.effects.transition(current.operationKey, "uncertain", this.clock());
      } else this.effects.transition(current.operationKey, current.state === "uncertain" ? "reconciled" : "confirmed", this.clock(), {
        receipt: { outcome: "returned", resultDigest: resultDigest ?? null, evidence: "tool_completed" } });
      this.settle(effect);
      this.auditState(this.effects.getByOperationKey(effect.operationKey)!);
    }).immediate();
    this.active.delete(effect.operationKey);
  }

  private settle(effect: Effect): void {
    const reservation = this.budget.getReservation(reservationId(effect.operationKey));
    if (reservation && !["settled", "reconciled", "released"].includes(reservation.state)) this.budget.settle({ reservationId: reservation.id,
      sourceEventId: `tool-spend:${hash(effect.operationKey)}`, actual: { toolCalls: 1 }, createdAt: this.clock() });
  }

  private auditState(effect: Effect): void {
    const id = `tool-state:${hash(`${effect.operationKey}:${effect.state}:${effect.receiptDigest ?? "none"}`)}`;
    if (!this.audit.get(id)) this.audit.append({ id, programId: effect.programId, attemptId: effect.attemptId, actorType: "service",
      actorId: "tool-effect-service", eventType: `runtime.tool_effect_${effect.state}`, requestId: effect.operationKey,
      metadata: { toolName: effect.effectType, state: effect.state, receiptDigest: effect.receiptDigest ?? null }, createdAt: this.clock() });
  }

  async processBuiltin(agentId: string, workspacePath: string, raw: ToolEffectRequest, virtualWorkspace?: string): Promise<void> {
    const request = ToolEffectRequestSchema.parse(raw);
    if (request.stage === "begin") { await this.begin(agentId, workspacePath, request, MANAGED_BUILTIN_TOOLS, true, virtualWorkspace); return; }
    const effect = this.effects.getByOperationKey(operationKey(request.context.attemptId, request.toolCallId));
    if (!effect || effect.request.builtin !== true) throw new Error("EFFECT_NOT_STARTED");
    this.assertReplay(effect, agentId, request);
    // Late receipts can resolve effects/usage, never authorize new execution or advance Work Packages.
    this.finish(effect, request.isError, request.resultDigest);
  }

  async execute(input: RuntimeToolCall): Promise<ToolResultPayload> {
    const request = ToolEffectRequestSchema.parse({ stage: "begin", context: input.context, toolName: input.toolName, toolCallId: input.toolCallId, params: jsonObject(input.params) }) as Extract<ToolEffectRequest, { stage: "begin" }>;
    const key = operationKey(input.context.attemptId, input.toolCallId);
    const existing = this.effects.getByOperationKey(key);
    if (existing) {
      this.assertReplay(existing, input.agentId, request);
      const running = this.running.get(key);
      if (running && existing.state === "dispatched") return this.bounded(running, existing);
      throw new Error(`EFFECT_REPLAY_BLOCKED:${existing.state}:${key}`);
    }
    const effect = await this.begin(input.agentId, input.workspacePath, request, input.permittedTools, false);
    const run = Promise.resolve().then(() => {
      // No asynchronous gap between the last authorization and the actual function dispatch.
      new RuntimeExecutionGuard(this.handle, this.clock, this.instanceId).assertAllowed({ phase: "tool", agentId: input.agentId, context: input.context, toolName: input.toolName });
      return input.execute();
    }).then((result) => { this.finish(effect, false, effectDigest(jsonObject({ result }))); return result; }, (error) => { this.finish(effect, true); throw error; })
      .finally(() => { this.running.delete(key); this.active.delete(key); });
    this.running.set(key, run);
    void run.catch(() => undefined);
    return this.bounded(run, effect);
  }

  private async bounded(run: Promise<ToolResultPayload>, effect: Effect): Promise<ToolResultPayload> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([run, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { try { this.finish(effect, true); reject(new Error(`TOOL_RESULT_UNCERTAIN:${effect.operationKey}`)); } catch (error) { reject(error); } }, this.timeoutMs);
    })]); } finally { if (timer) clearTimeout(timer); }
  }

  private async queryFile(effect: Effect): Promise<ProviderEffectState> {
    if (typeof effect.request.workspacePath !== "string" || typeof effect.request.target !== "string" || typeof effect.request.postimageDigest !== "string") return { state: "unknown", reason: "no_postcondition_query" };
    try {
      const target = await resolveFile(effect.request.workspacePath, effect.request.target, false);
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return { state: "unknown", reason: "target_unqueryable" };
      const digest = createHash("sha256").update(await fs.readFile(target)).digest("hex");
      return digest === effect.request.postimageDigest ? { state: "confirmed", receipt: { evidence: "file_postcondition", postimageDigest: digest } }
        : { state: "unknown", reason: "postcondition_does_not_prove_outcome" };
    } catch { return { state: "unknown", reason: "target_unavailable" }; }
  }

  async reconcile(programId: string) {
    this.assertProgram(programId);
    // Register query routes for effects loaded after a process restart as well.
    for (const row of this.handle.connection.prepare("SELECT DISTINCT effect_type FROM effects WHERE program_id=?").all(programId) as Array<{ effect_type: string }>) {
      if (!this.adapters.has(row.effect_type)) this.adapters.set(row.effect_type, { query: (effect) => this.queryCustom?.(effect) ?? Promise.resolve({ state: "unknown", reason: "no_state_adapter" }) });
    }
    const skip = (effect: Effect) => this.active.has(effect.operationKey) || this.isForeignActive(effect);
    const result = await new EffectReconciler(this.handle, this.adapters).reconcile(programId, this.clock(), skip);
    for (const row of this.handle.connection.prepare("SELECT operation_key FROM effects WHERE program_id=? AND state IN ('confirmed','uncertain','reconciled')").all(programId) as Array<{ operation_key: string }>) {
      this.handle.connection.transaction(() => { const effect = this.effects.getByOperationKey(row.operation_key)!; if (skip(effect)) return; this.settle(effect); this.auditState(effect); }).immediate();
    }
    return result;
  }

  private isForeignActive(effect: Effect): boolean {
    if (!this.instanceId) return false;
    return Boolean(this.handle.connection.prepare(`SELECT 1 FROM attempt_execution_owners o
      JOIN program_scheduler_leases s ON s.program_id=o.program_id JOIN work_package_attempts a ON a.id=o.attempt_id
      WHERE o.attempt_id=? AND o.owner_id<>? AND s.owner_id=o.owner_id AND s.fencing_token=o.scheduler_fencing_token
      AND s.expires_at>? AND a.status IN ('leased','running','verifying','checkpointed')`)
      .get(effect.attemptId, this.instanceId, this.clock()));
  }

  async endAttempt(attemptId: string): Promise<void> {
    const programId = this.handle.connection.prepare("SELECT w.program_id FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id WHERE a.id=?").pluck().get(attemptId) as string | undefined;
    if (!programId) return;
    for (const [key, active] of this.active) if (active.attemptId === attemptId) { const effect = this.effects.getByOperationKey(key); if (effect) this.finish(effect, true); }
    await this.reconcile(programId);
  }

  async quiesce(programId: string): Promise<void> {
    for (const [key, active] of this.active) if (active.programId === programId) { const effect = this.effects.getByOperationKey(key); if (effect) this.finish(effect, true); }
    await this.reconcile(programId);
  }

  async quiesceAll(): Promise<void> {
    const ids = this.handle.connection.prepare("SELECT DISTINCT program_id FROM effects WHERE state IN ('dispatched','uncertain')").pluck().all() as string[];
    await Promise.all(ids.map((id) => this.quiesce(id)));
  }

  list(programId: string): Effect[] {
    this.assertProgram(programId);
    return (this.handle.connection.prepare("SELECT operation_key FROM effects WHERE program_id=? ORDER BY created_at DESC,id LIMIT 200").all(programId) as Array<{ operation_key: string }>).map((row) => this.effects.getByOperationKey(row.operation_key)!);
  }
}

export function registerExperimentalEffectRoutes(app: Express, service: ToolEffectService, enabled: boolean): boolean {
  if (!enabled) return false;
  app.get("/api/experimental/programs/:id/effects", (req: Request, res: Response) => {
    try { res.json(service.list(String(req.params.id))); } catch { res.status(404).json({ code: "PROGRAM_NOT_FOUND" }); }
  });
  app.post("/api/experimental/programs/:id/effects/reconcile", async (req: Request, res: Response) => {
    try { res.json(await service.reconcile(String(req.params.id))); } catch (error) { res.status(409).json({ code: "EFFECT_RECONCILIATION_FAILED", error: error instanceof Error ? error.message : String(error) }); }
  });
  return true;
}
