import type { BudgetExecutionConfig } from "../types";
import {
  evaluateRuntimeHookSpike,
  PI_RUNTIME_HOOK_COVERAGE,
  type RuntimeHookCapability,
} from "../sandbox/runtime-hook-capability";
import type {
  ProviderBudgetCapabilityName,
  ProviderBudgetCapabilityProfile,
} from "./provider-budget-capability";
import { PROVIDER_BUDGET_CAPABILITIES } from "./provider-budget-capability";

export type BudgetExecutionEffectiveMode = "disabled" | "none" | BudgetExecutionConfig["mode"];

export type BudgetExecutionPreflightBlocker =
  | {
    scope: "configuration";
    code: "NO_PROVIDER_SELECTED";
    detail: string;
  }
  | {
    scope: "runtime";
    code: "RUNTIME_HOOK_UNPROVEN";
    subject: RuntimeHookCapability["path"];
    detail: string;
  }
  | {
    scope: "provider";
    code: "PROVIDER_PROFILE_MISSING";
    providerId: string;
    detail: string;
  }
  | {
    scope: "provider";
    code: "PROVIDER_PROFILE_ID_MISMATCH";
    providerId: string;
    detail: string;
  }
  | {
    scope: "provider";
    code: "PROVIDER_CAPABILITY_UNPROVEN";
    providerId: string;
    subject: ProviderBudgetCapabilityName;
    detail: string;
  };

export interface BudgetExecutionPreflightInput {
  config: BudgetExecutionConfig;
  selectedProviderIds: readonly string[];
  providerProfiles: Readonly<Record<string, ProviderBudgetCapabilityProfile>>;
  runtimeCapabilities?: readonly RuntimeHookCapability[];
}

export interface BudgetExecutionPreflightResult {
  status: "disabled" | "ready" | "rejected";
  requestedMode: BudgetExecutionConfig["mode"];
  effectiveMode: BudgetExecutionEffectiveMode;
  hardGuaranteeActive: boolean;
  integrationStrategy: "sdk_model_runtime_wrapper";
  blockers: BudgetExecutionPreflightBlocker[];
  limitations: BudgetExecutionPreflightBlocker[];
}

function collectHardBlockers(input: BudgetExecutionPreflightInput): BudgetExecutionPreflightBlocker[] {
  const blockers: BudgetExecutionPreflightBlocker[] = [];
  const runtimeDecision = evaluateRuntimeHookSpike(input.runtimeCapabilities ?? PI_RUNTIME_HOOK_COVERAGE);
  for (const blocker of runtimeDecision.blockers) {
    blockers.push({
      scope: "runtime",
      code: "RUNTIME_HOOK_UNPROVEN",
      subject: blocker.path,
      detail: blocker.evidence,
    });
  }

  const providerIds = [...new Set(input.selectedProviderIds)].sort();
  if (providerIds.length === 0) {
    blockers.push({
      scope: "configuration",
      code: "NO_PROVIDER_SELECTED",
      detail: "Hard mode requires at least one explicitly selected Provider profile.",
    });
  }

  for (const providerId of providerIds) {
    const profile = input.providerProfiles[providerId];
    if (!profile) {
      blockers.push({
        scope: "provider",
        code: "PROVIDER_PROFILE_MISSING",
        providerId,
        detail: `No capability profile exists for Provider ${providerId}.`,
      });
      continue;
    }
    if (profile.providerId !== providerId) {
      blockers.push({
        scope: "provider",
        code: "PROVIDER_PROFILE_ID_MISMATCH",
        providerId,
        detail: `Capability profile identity ${profile.providerId} does not match selected Provider ${providerId}.`,
      });
      continue;
    }
    const unprovenCapabilities = PROVIDER_BUDGET_CAPABILITIES.filter((capability) => {
      const entry = profile.capabilities[capability];
      return !entry || entry.state !== "supported" || entry.confidence !== "verified";
    });
    for (const capability of unprovenCapabilities) {
      const entry = profile.capabilities[capability];
      blockers.push({
        scope: "provider",
        code: "PROVIDER_CAPABILITY_UNPROVEN",
        providerId,
        subject: capability,
        detail: entry
          ? `${capability} is ${entry.state} with ${entry.confidence} confidence.`
          : `${capability} is absent from the Provider profile.`,
      });
    }
  }
  return blockers;
}

/**
 * BLH-004 mode gate. Rejected hard requests deliberately use effectiveMode
 * "none"; callers must never silently continue in soft or shadow mode.
 */
export function evaluateBudgetExecutionPreflight(
  input: BudgetExecutionPreflightInput,
): BudgetExecutionPreflightResult {
  if (!input.config.enabled) {
    return {
      status: "disabled",
      requestedMode: input.config.mode,
      effectiveMode: "disabled",
      hardGuaranteeActive: false,
      integrationStrategy: "sdk_model_runtime_wrapper",
      blockers: [],
      limitations: [],
    };
  }

  const hardBlockers = collectHardBlockers(input);
  if (input.config.mode === "hard") {
    return hardBlockers.length === 0
      ? {
        status: "ready",
        requestedMode: "hard",
        effectiveMode: "hard",
        hardGuaranteeActive: true,
        integrationStrategy: "sdk_model_runtime_wrapper",
        blockers: [],
        limitations: [],
      }
      : {
        status: "rejected",
        requestedMode: "hard",
        effectiveMode: "none",
        hardGuaranteeActive: false,
        integrationStrategy: "sdk_model_runtime_wrapper",
        blockers: hardBlockers,
        limitations: hardBlockers,
      };
  }

  return {
    status: "ready",
    requestedMode: input.config.mode,
    effectiveMode: input.config.mode,
    hardGuaranteeActive: false,
    integrationStrategy: "sdk_model_runtime_wrapper",
    blockers: [],
    limitations: hardBlockers,
  };
}
