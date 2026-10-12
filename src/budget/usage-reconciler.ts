import type { BudgetLedger, BudgetReservation } from "./budget-ledger";
import { createHash } from "node:crypto";
import type { BudgetVector } from "./budget-types";
import type { ModelUsageEstimate, PricingService } from "./pricing-service";

export type ProviderUsageQueryResult =
  | { status: "found"; sourceEventId: string; usage: ModelUsageEstimate }
  | { status: "not_found" }
  | { status: "unknown"; reason: string };

export interface ProviderUsageQuery {
  query(providerRequestId: string): Promise<ProviderUsageQueryResult>;
}

export type ReconciliationResult =
  | { action: "settled" | "released" | "conservative_settlement"; reservation: BudgetReservation }
  | { action: "already_final"; reservation: BudgetReservation };

export class UsageReconciler {
  constructor(
    private readonly ledger: BudgetLedger,
    private readonly pricing: PricingService,
    private readonly provider: ProviderUsageQuery,
  ) {}

  async reconcile(input: {
    reservationId: string;
    pricingSnapshotId: string;
    modelRef: string;
    now: string;
  }): Promise<ReconciliationResult> {
    const reservation = this.ledger.getReservation(input.reservationId);
    if (!reservation) throw new Error(`Reservation ${input.reservationId} was not found`);
    if (["settled", "reconciled"].includes(reservation.state)) return { action: "already_final", reservation };
    if (!reservation.providerRequestId) {
      return {
        action: "conservative_settlement",
        reservation: this.conservativeSettlement(reservation, input.now),
      };
    }
    let result: ProviderUsageQueryResult;
    try {
      result = await this.provider.query(reservation.providerRequestId);
    } catch (error) {
      result = { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.status === "found") {
      const actual = this.pricing.estimate(input.pricingSnapshotId, input.modelRef, result.usage);
      return {
        action: "settled",
        reservation: this.ledger.settle({
          reservationId: reservation.id,
          sourceEventId: result.sourceEventId,
          actual,
          pricingSnapshotId: input.pricingSnapshotId,
          createdAt: input.now,
        }),
      };
    }
    if (result.status === "not_found") {
      return {
        action: "released",
        reservation: this.ledger.release(reservation.id, reservation.revision, input.now),
      };
    }
    return {
      action: "conservative_settlement",
      reservation: this.conservativeSettlement(reservation, input.now),
    };
  }

  private conservativeSettlement(reservation: BudgetReservation, now: string): BudgetReservation {
    const upperBound: BudgetVector = reservation.reserved;
    return this.ledger.settle({
      reservationId: reservation.id,
      sourceEventId: `reconcile:${createHash("sha256").update(reservation.id).digest("hex")}`,
      actual: upperBound,
      createdAt: now,
    });
  }
}
