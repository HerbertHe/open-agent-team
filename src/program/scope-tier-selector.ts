import type { AdmissionDecision } from "./admission-controller";
import type { ScopeTier } from "./program-types";

export interface ScopeTierSelection {
  status: "selected" | "awaiting_approval" | "rejected";
  selectedTier?: ScopeTier;
  reason: string;
}

export function selectScopeTier(decisions: Record<ScopeTier, AdmissionDecision>): ScopeTierSelection {
  const minimum = decisions.minimum;
  if (!minimum.calibrated) return { status: "awaiting_approval", selectedTier: "minimum", reason: "minimum_uncalibrated" };
  if (!minimum.feasible) return { status: "rejected", reason: "minimum_infeasible" };
  for (const tier of ["stretch", "standard", "minimum"] as const) {
    const decision = decisions[tier];
    if (decision.calibrated && decision.feasible) return { status: "selected", selectedTier: tier, reason: `${tier}_highest_feasible` };
  }
  return { status: "selected", selectedTier: "minimum", reason: "minimum_only" };
}
