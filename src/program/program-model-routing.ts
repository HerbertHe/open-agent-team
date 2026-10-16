import type { GlobalModelCatalog } from "../models/global-models";
import { RuleBasedModelRouter, type ModelRouteCandidate } from "./model-router";
import type { BudgetMode } from "./plan-scheduler";
import type { ExecutionDatabase } from "./execution-database";
import { PricingService } from "../budget/pricing-service";
import { isDeepStrictEqual } from "node:util";

export interface ProgramModelRoutingPolicy {
  candidates: ModelRouteCandidate[];
  requiredCapabilities: string[];
  risk: "low" | "medium" | "high";
}

export function canonicalModelRef(ref: string): string { return ref.includes("/") ? ref : `anthropic/${ref}`; }

/** Select an already configured idle Agent. No Prompt or model-generated field
 * can add a candidate or change its capabilities, risk limit or quality tier. */
export function selectProgramModelAgent(handle: ExecutionDatabase, catalog: GlobalModelCatalog,
  policy: ProgramModelRoutingPolicy | undefined, input: {
    programId: string; mode: BudgetMode; agents: Array<{ id: string; modelRef: string }>;
  }): { agentId: string; modelRef: string; reason: string } | undefined {
  if (!input.agents.length) return undefined;
  if (!policy) {
    const agent = input.agents[0]!;
    return { agentId: agent.id, modelRef: canonicalModelRef(agent.modelRef), reason: "configured Agent model; dynamic routing disabled" };
  }
  const snapshotId = handle.connection.prepare("SELECT id FROM pricing_snapshots WHERE program_id=? ORDER BY created_at,id LIMIT 1").pluck().get(input.programId) as string | undefined;
  if (!snapshotId) return undefined;
  const snapshot = PricingService.from(handle).getSnapshot(snapshotId)!;
  const prices: GlobalModelCatalog["pricing"] = {};
  for (const [alias, price] of Object.entries(snapshot.prices)) {
    const canonical = `${price.providerId}/${price.modelId}`;
    // Both the immutable Program snapshot and current catalogue must agree.
    const current = catalog.pricing[alias] ?? catalog.pricing[canonical];
    if (current && isDeepStrictEqual(current, price)) prices[canonical] = current;
  }
  const candidates = policy.candidates.map((candidate) => ({ ...candidate, modelRef: canonicalModelRef(catalog.models[candidate.modelRef] ?? candidate.modelRef) }))
    .filter((candidate) => input.agents.some((agent) => canonicalModelRef(agent.modelRef) === candidate.modelRef));
  try {
    const route = new RuleBasedModelRouter({ ...catalog, pricing: prices }).route({ candidates,
      requiredCapabilities: policy.requiredCapabilities, risk: policy.risk, mode: input.mode });
    const agent = input.agents.find((candidate) => canonicalModelRef(candidate.modelRef) === route.modelRef)!;
    return { agentId: agent.id, ...route };
  } catch (error) {
    if (error instanceof Error && error.message === "NO_PRICED_MODEL_ROUTE") return undefined;
    throw error;
  }
}
