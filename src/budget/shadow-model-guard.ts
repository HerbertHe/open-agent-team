import type { ExecutionRuntimeContext } from "../program/execution-runtime-context";
import { createHash } from "node:crypto";
import type { ExecutionAuditRepository } from "../program/execution-audit-repository";
import type { GlobalModelCatalog } from "../models/global-models";
import {
  BudgetAccountRepository,
  BudgetLedger,
  BudgetLedgerError,
  type BudgetConsumerClass,
} from "./budget-ledger";
import { addBudgetVectors, budgetVectorFits, subtractBudgetVectors, type BudgetVector } from "./budget-types";
import { PricingService, type ModelUsageEstimate } from "./pricing-service";
import type { ExecutionBarrier } from "../program/execution-barrier";

export type ModelCallKind = "initial" | "tool_continuation" | "retry" | "compaction" | "internal";
export type GuardMode = "shadow" | "soft" | "hard";

export interface ModelGuardDecision {
  allowed: boolean;
  wouldBlock: boolean;
  reason: "ALLOWED" | "INSUFFICIENT_BUDGET" | "PRICING_CHANGED" | "MODEL_PRICE_MISSING";
  estimatedMaximum: BudgetVector;
  reservationId?: string;
}

export class ShadowModelGuard {
  private readonly accounts: BudgetAccountRepository;
  private readonly ledger: BudgetLedger;
  private readonly pricing: PricingService;

  constructor(
    databaseHandle: Parameters<typeof BudgetAccountRepository.from>[0],
    private readonly audit?: ExecutionAuditRepository,
    private readonly barrier?: ExecutionBarrier,
  ) {
    this.accounts = BudgetAccountRepository.from(databaseHandle);
    this.ledger = BudgetLedger.from(databaseHandle);
    this.pricing = PricingService.from(databaseHandle);
  }

  evaluate(input: {
    mode: GuardMode;
    context: ExecutionRuntimeContext;
    accountId: string;
    consumerClass: BudgetConsumerClass;
    pricingSnapshotId: string;
    modelRef: string;
    usageUpperBound: ModelUsageEstimate;
    currentCatalog: GlobalModelCatalog;
    callKind: ModelCallKind;
    now: string;
  }): ModelGuardDecision {
    this.barrier?.assertAllowed(input.context.programId, input.context.executionEpoch);
    const priceCheck = this.pricing.verifyCurrentPrice(input.pricingSnapshotId, input.modelRef, input.currentCatalog);
    const estimatedMaximum = this.pricing.getSnapshot(input.pricingSnapshotId)?.prices[input.modelRef]
      ? this.pricing.estimate(input.pricingSnapshotId, input.modelRef, input.usageUpperBound) : {};
    const account = this.accounts.get(input.accountId);
    if (!account) throw new BudgetLedgerError("BUDGET_NOT_FOUND", `Account ${input.accountId} was not found`);
    const committed = addBudgetVectors(account.spent, account.reserved);
    const parent = input.context.reservationId ? this.ledger.getReservation(input.context.reservationId) : undefined;
    const available = parent ? parent.remaining : budgetVectorFits(committed, account.limit) ? subtractBudgetVectors(account.limit, committed) : {};
    const reason: ModelGuardDecision["reason"] = !priceCheck.allowed
      ? priceCheck.reason ?? "MODEL_PRICE_MISSING"
      : budgetVectorFits(estimatedMaximum, available) ? "ALLOWED" : "INSUFFICIENT_BUDGET";
    const wouldBlock = reason !== "ALLOWED";
    let reservationId: string | undefined;
    if (!wouldBlock && input.mode !== "shadow") {
      const operationHash = createHash("sha256").update(input.context.operationId).digest("hex");
      reservationId = `reservation:${operationHash}`;
      this.ledger.reserve({
        id: reservationId,
        programId: input.context.programId,
        accountId: input.accountId,
        ...(parent ? { parentReservationId: parent.id } : {}),
        operationKey: `model:${operationHash}`,
        amount: estimatedMaximum,
        consumerClass: input.consumerClass,
        createdAt: input.now,
      });
    }
    const decision: ModelGuardDecision = {
      allowed: input.mode === "shadow" || !wouldBlock,
      wouldBlock,
      reason,
      estimatedMaximum,
      ...(reservationId ? { reservationId } : {}),
    };
    const auditId = `guard:${createHash("sha256").update(input.context.operationId).digest("hex")}`;
    if (this.audit && !this.audit.get(auditId)) this.audit.append({
      id: auditId,
      programId: input.context.programId,
      attemptId: input.context.attemptId,
      actorType: "system",
      eventType: "budget.model_guard",
      requestId: input.context.operationId,
      after: { ...decision },
      metadata: { callKind: input.callKind, mode: input.mode, modelRef: input.modelRef },
      createdAt: input.now,
    });
    return decision;
  }
}
