import type { GlobalModelCatalog } from "../models/global-models";
import type { BudgetMode } from "./plan-scheduler";

export interface ModelRouteCandidate {
  modelRef: string;
  capabilities: string[];
  maximumRisk: "low" | "medium" | "high";
  qualityTier: number;
}

const RISK = { low: 0, medium: 1, high: 2 } as const;

export class RuleBasedModelRouter {
  constructor(private readonly catalog: GlobalModelCatalog) {}
  route(input: {
    candidates: readonly ModelRouteCandidate[];
    requiredCapabilities: readonly string[];
    risk: "low" | "medium" | "high";
    mode: BudgetMode;
    promptRequestedModel?: string;
  }): { modelRef: string; reason: string } {
    const maxTier = input.mode === "closeout" ? 0 : input.mode === "commit" ? 1 : Number.POSITIVE_INFINITY;
    const eligible = input.candidates.filter((candidate) =>
      candidate.qualityTier <= maxTier && RISK[candidate.maximumRisk] >= RISK[input.risk] &&
      input.requiredCapabilities.every((capability) => candidate.capabilities.includes(capability)) &&
      this.catalog.pricing[candidate.modelRef] !== undefined,
    ).sort((a, b) => {
      const ap = this.catalog.pricing[a.modelRef]!; const bp = this.catalog.pricing[b.modelRef]!;
      return (ap.fixedRequestMicros + ap.inputMicrosPerMillionTokens + ap.outputMicrosPerMillionTokens) -
        (bp.fixedRequestMicros + bp.inputMicrosPerMillionTokens + bp.outputMicrosPerMillionTokens) || a.modelRef.localeCompare(b.modelRef);
    });
    if (!eligible.length) throw new Error("NO_PRICED_MODEL_ROUTE");
    const selected = eligible[0]!;
    return { modelRef: selected.modelRef, reason: `rule-selected priced route for ${input.risk} risk in ${input.mode} mode` };
  }
}
