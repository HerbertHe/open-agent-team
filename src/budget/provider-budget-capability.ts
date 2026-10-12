import { z } from "zod";
import type { ProviderConfig, TeamFileProvidersConfig } from "../types";

export const ProviderBudgetCapabilityNameSchema = z.enum([
  "pricing_upper_bound",
  "usage_receipt",
  "max_output_tokens",
  "idempotency_key",
  "request_status_query",
  "request_abort",
]);

export type ProviderBudgetCapabilityName = z.infer<typeof ProviderBudgetCapabilityNameSchema>;
export type ProviderBudgetCapabilityState = "supported" | "unsupported" | "unknown";

export const PROVIDER_BUDGET_CAPABILITIES = ProviderBudgetCapabilityNameSchema.options;

export const ProviderCapabilityEvidenceSchema = z.object({
  capability: ProviderBudgetCapabilityNameSchema,
  state: z.enum(["supported", "unsupported", "unknown"]),
  confidence: z.enum(["declared", "observed", "verified"]),
  source: z.enum(["configuration", "runtime_probe", "provider_probe", "billing_reconciliation"]),
  observedAt: z.string().datetime({ offset: true }),
  detail: z.string().trim().min(1).max(500),
}).strict();

export type ProviderCapabilityEvidence = z.infer<typeof ProviderCapabilityEvidenceSchema>;

export interface ProviderBudgetCapabilityEntry {
  state: ProviderBudgetCapabilityState;
  confidence: "none" | ProviderCapabilityEvidence["confidence"];
  evidence?: ProviderCapabilityEvidence;
}

export interface ProviderBudgetCapabilityProfile {
  providerId: string;
  compatibleType: ProviderConfig["compatible_type"];
  endpointKind: "provider_default" | "custom";
  hasCredentialReference: boolean;
  capabilities: Record<ProviderBudgetCapabilityName, ProviderBudgetCapabilityEntry>;
  providerHardModeEligible: boolean;
  providerHardModeBlockers: ProviderBudgetCapabilityName[];
  probeStatus: "not_run" | "completed" | "failed";
  evaluatedAt: string;
}

export interface SafeProviderProbeDescriptor {
  providerId: string;
  compatibleType: ProviderConfig["compatible_type"];
  endpointKind: ProviderBudgetCapabilityProfile["endpointKind"];
  hasCredentialReference: boolean;
}

export interface ProviderBudgetCapabilityProbe {
  probe(descriptor: SafeProviderProbeDescriptor): Promise<readonly ProviderCapabilityEvidence[]>;
}

const HARD_MODE_REQUIREMENTS: readonly ProviderBudgetCapabilityName[] = PROVIDER_BUDGET_CAPABILITIES;

function unknownCapabilities(): Record<ProviderBudgetCapabilityName, ProviderBudgetCapabilityEntry> {
  return Object.fromEntries(PROVIDER_BUDGET_CAPABILITIES.map((name) => [name, {
    state: "unknown",
    confidence: "none",
  }])) as Record<ProviderBudgetCapabilityName, ProviderBudgetCapabilityEntry>;
}

function safeDescriptor(providerId: string, config: ProviderConfig): SafeProviderProbeDescriptor {
  return {
    providerId,
    compatibleType: config.compatible_type,
    endpointKind: config.base_url ? "custom" : "provider_default",
    hasCredentialReference: Boolean(config.api_key),
  };
}

function evaluate(profile: Omit<ProviderBudgetCapabilityProfile, "providerHardModeEligible" | "providerHardModeBlockers">): ProviderBudgetCapabilityProfile {
  const providerHardModeBlockers = HARD_MODE_REQUIREMENTS.filter((name) => {
    const entry = profile.capabilities[name];
    return entry.state !== "supported" || entry.confidence !== "verified";
  });
  return {
    ...profile,
    providerHardModeEligible: providerHardModeBlockers.length === 0,
    providerHardModeBlockers,
  };
}

/**
 * Configuration proves identity and endpoint shape only. It never proves a
 * billable capability, so every budget-sensitive field starts as unknown.
 */
export function createConservativeProviderBudgetCapabilityProfile(
  providerId: string,
  config: ProviderConfig,
  evaluatedAt = new Date().toISOString(),
): ProviderBudgetCapabilityProfile {
  const descriptor = safeDescriptor(providerId, config);
  return evaluate({
    ...descriptor,
    capabilities: unknownCapabilities(),
    probeStatus: "not_run",
    evaluatedAt,
  });
}

export function applyProviderCapabilityEvidence(
  base: ProviderBudgetCapabilityProfile,
  evidenceItems: readonly ProviderCapabilityEvidence[],
  evaluatedAt = new Date().toISOString(),
): ProviderBudgetCapabilityProfile {
  const capabilities = { ...base.capabilities };
  const seen = new Set<ProviderBudgetCapabilityName>();

  for (const rawEvidence of evidenceItems) {
    const evidence = ProviderCapabilityEvidenceSchema.parse(rawEvidence);
    if (seen.has(evidence.capability)) {
      throw new Error(`Duplicate provider capability evidence: ${evidence.capability}`);
    }
    seen.add(evidence.capability);

    // A static config declaration is not verification of provider behavior.
    const state = evidence.source === "configuration" && evidence.state === "supported"
      ? "unknown"
      : evidence.state;
    const confidence = state === "unknown" && evidence.source === "configuration"
      ? "declared"
      : evidence.confidence;
    capabilities[evidence.capability] = { state, confidence, evidence };
  }

  return evaluate({
    providerId: base.providerId,
    compatibleType: base.compatibleType,
    endpointKind: base.endpointKind,
    hasCredentialReference: base.hasCredentialReference,
    capabilities,
    probeStatus: "completed",
    evaluatedAt,
  });
}

export async function probeConfiguredProviderCapabilities(
  providers: TeamFileProvidersConfig,
  probe?: ProviderBudgetCapabilityProbe,
  evaluatedAt = new Date().toISOString(),
): Promise<Record<string, ProviderBudgetCapabilityProfile>> {
  const profiles: Record<string, ProviderBudgetCapabilityProfile> = {};
  for (const [providerId, config] of Object.entries(providers)) {
    const base = createConservativeProviderBudgetCapabilityProfile(providerId, config, evaluatedAt);
    if (!probe) {
      profiles[providerId] = base;
      continue;
    }
    try {
      const evidence = await probe.probe(safeDescriptor(providerId, config));
      profiles[providerId] = applyProviderCapabilityEvidence(base, evidence, evaluatedAt);
    } catch {
      profiles[providerId] = evaluate({
        providerId: base.providerId,
        compatibleType: base.compatibleType,
        endpointKind: base.endpointKind,
        hasCredentialReference: base.hasCredentialReference,
        capabilities: base.capabilities,
        probeStatus: "failed",
        evaluatedAt,
      });
    }
  }
  return profiles;
}
