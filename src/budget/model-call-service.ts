import { createHash } from "node:crypto";
import { parseGlobalModelCatalog, type GlobalModelCatalog } from "../models/global-models";
import { isDeepStrictEqual } from "node:util";
import type { ExecutionDatabase } from "../program/execution-database";
import { ExecutionAuditRepository } from "../program/execution-audit-repository";
import { ExecutionBarrier } from "../program/execution-barrier";
import { RuntimeExecutionGuard } from "../program/runtime-execution-guard";
import { BudgetLedger } from "./budget-ledger";
import { ShadowModelGuard } from "./shadow-model-guard";
import { PricingService } from "./pricing-service";
import { UsageReconciler } from "./usage-reconciler";
import { ModelCallRequestSchema, type ModelCallRequest } from "./model-call-protocol";

const key = (operation: string) => createHash("sha256").update(operation).digest("hex");
type CallRecord = { agentId: string; modelRef: string; priceRef: string; snapshotId: string; reservationId?: string; request: ModelCallRequest };

/** The parent process owns all ledger writes; child runners never open Execution DB. */
export class ModelCallService {
  private readonly ledger: BudgetLedger;
  private readonly pricing: PricingService;
  private readonly audit: ExecutionAuditRepository;
  constructor(private readonly handle: ExecutionDatabase, private readonly mode: "shadow" | "soft" | "hard",
    private readonly loadCatalog: () => Promise<GlobalModelCatalog>, private readonly clock = () => new Date().toISOString(), private readonly instanceId?: string) {
    this.ledger = BudgetLedger.from(handle); this.pricing = PricingService.from(handle); this.audit = new ExecutionAuditRepository(handle);
  }

  async processCall(agentId: string, configuredModel: string, raw: ModelCallRequest): Promise<{ mode: "shadow" | "soft" }> {
    if (this.mode === "hard") throw new Error("HARD_MODEL_CALL_UNSUPPORTED");
    const request = ModelCallRequestSchema.parse(raw);
    if (request.modelRef !== (configuredModel.includes("/") ? configuredModel : `anthropic/${configuredModel}`)) throw new Error("MODEL_IDENTITY_MISMATCH");
    const catalog = request.stage === "begin" ? await this.loadCatalog().catch((error) => {
      if (this.mode !== "shadow") throw error;
      return parseGlobalModelCatalog({});
    }) : undefined;
    const now = this.clock();
    const result: { mode: "shadow" | "soft"; denied?: string } = this.handle.connection.transaction(() => {
      const id = `model-begin:${key(request.context.operationId)}`;
      const previous = this.audit.get(id);
      if (request.stage === "begin") {
        new RuntimeExecutionGuard(this.handle, this.clock, this.instanceId).assertAllowed({ phase: "model", agentId, context: request.context });
        if (previous) throw new Error("MODEL_OPERATION_ALREADY_DISPATCHED");
        const snapshotId = this.handle.connection.prepare("SELECT id FROM pricing_snapshots WHERE program_id=? ORDER BY created_at,id LIMIT 1").pluck().get(request.context.programId) as string | undefined;
        if (!snapshotId) throw new Error("PRICING_SNAPSHOT_MISSING");
        const parent = request.context.reservationId ? this.ledger.getReservation(request.context.reservationId) : undefined;
        if (!parent) throw new Error("MODEL_ENVELOPE_MISSING");
        const dispatch = this.handle.connection.prepare(`SELECT metadata_json FROM audit_events WHERE program_id=?
          AND event_type='program.work_dispatch_started' AND json_extract(metadata_json,'$.attemptId')=? LIMIT 1`)
          .get(request.context.programId, request.context.attemptId) as { metadata_json: string } | undefined;
        if (!dispatch || JSON.parse(dispatch.metadata_json).reservationId !== parent.id) throw new Error("MODEL_ENVELOPE_IDENTITY_MISMATCH");
        const selectedModel = JSON.parse(dispatch.metadata_json).modelRef as string | undefined;
        if (selectedModel && selectedModel !== request.modelRef) throw new Error("MODEL_ROUTE_IDENTITY_MISMATCH");
        const snapshot = this.pricing.getSnapshot(snapshotId)!;
        const candidates = Object.keys(snapshot.prices).filter((ref) => ref === request.modelRef || catalog!.models[ref] === request.modelRef
          || `${snapshot.prices[ref]!.providerId}/${snapshot.prices[ref]!.modelId}` === request.modelRef);
        const priceRef = snapshot.prices[request.modelRef] ? request.modelRef : candidates.length === 1 ? candidates[0]! : request.modelRef;
        const decision = new ShadowModelGuard(this.handle, this.audit, new ExecutionBarrier(this.handle)).evaluate({
          mode: this.mode, context: request.context, accountId: parent.accountId, consumerClass: "execution", pricingSnapshotId: snapshotId,
          modelRef: priceRef, usageUpperBound: request.usageUpperBound, currentCatalog: catalog!, callKind: request.callKind, now,
        });
        if (!decision.allowed) return { mode: "soft" as const, denied: decision.reason };
        if (decision.reservationId) {
          const reserved = this.ledger.getReservation(decision.reservationId)!;
          this.ledger.activate(reserved.id, reserved.revision, request.context.operationId, now);
        }
        this.audit.append({ id, programId: request.context.programId, attemptId: request.context.attemptId, actorType: "service", actorId: agentId,
          eventType: "budget.model_call_started", requestId: request.context.operationId,
          metadata: { agentId, modelRef: request.modelRef, priceRef, snapshotId, request, ...(decision.reservationId ? { reservationId: decision.reservationId } : {}) }, createdAt: now });
      } else {
        if (!previous) throw new Error("MODEL_CALL_NOT_STARTED");
        const record = previous.metadata as unknown as CallRecord;
        if (record.agentId !== agentId || record.modelRef !== request.modelRef
          || JSON.stringify(record.request.context) !== JSON.stringify(request.context)) throw new Error("MODEL_CALL_IDENTITY_MISMATCH");
        const finishId = `model-finish:${key(request.context.operationId)}`;
        const priorFinish = this.audit.get(finishId);
        if (priorFinish && (priorFinish.metadata.outcome !== request.outcome || !isDeepStrictEqual(priorFinish.metadata.usage, request.usage ?? null))) throw new Error("MODEL_USAGE_CONFLICT");
        // Finish does not re-authorize execution: late usage remains accountable after a barrier.
        if (record.reservationId) {
          new UsageReconciler(this.ledger, this.pricing, { query: async () => ({ status: "unknown", reason: "not_used_for_reported_usage" }) })
            .applyResult({ reservationId: record.reservationId, pricingSnapshotId: record.snapshotId, modelRef: record.priceRef, now },
              request.outcome === "reported" && request.usage
                ? { status: "found", sourceEventId: `model-usage:${key(request.context.operationId)}`, usage: request.usage }
                : { status: "unknown", reason: "provider_usage_unavailable" });
        }
        if (!this.audit.get(finishId)) this.audit.append({ id: finishId, programId: request.context.programId, attemptId: request.context.attemptId,
          actorType: "service", actorId: agentId, eventType: "budget.model_call_finished", requestId: request.context.operationId,
          metadata: { outcome: request.outcome, usage: request.usage ?? null, metering: "sdk_reported_not_authoritative", modelRef: request.modelRef }, createdAt: now });
      }
      return { mode: this.mode as "shadow" | "soft" };
    }).immediate();
    if (result.denied) throw new Error(`MODEL_BUDGET_DENIED:${result.denied}`);
    return { mode: result.mode };
  }

  async reconcileAttempt(attemptId: string): Promise<void> {
    const rows = this.handle.connection.prepare(`SELECT metadata_json FROM audit_events b WHERE attempt_id=? AND event_type='budget.model_call_started'
      AND NOT EXISTS (SELECT 1 FROM audit_events f WHERE f.request_id=b.request_id AND f.event_type='budget.model_call_finished')`).all(attemptId) as Array<{ metadata_json: string }>;
    for (const row of rows) {
      const record = JSON.parse(row.metadata_json) as CallRecord;
      if (record.reservationId) await new UsageReconciler(this.ledger, this.pricing, { query: async () => ({ status: "unknown", reason: "runner_ended_without_usage" }) })
        .reconcile({ reservationId: record.reservationId, pricingSnapshotId: record.snapshotId, modelRef: record.priceRef, now: this.clock() });
    }
  }
}
