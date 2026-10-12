import assert from "node:assert/strict";
import test from "node:test";
import { ProviderCompatibleTypeEnum } from "../types";
import { PI_RUNTIME_HOOK_COVERAGE } from "../sandbox/runtime-hook-capability";
import { fullyVerifiedProviderEvidence } from "./fixtures/provider-budget-capability";
import { evaluateBudgetExecutionPreflight } from "./hard-mode-preflight";
import {
  applyProviderCapabilityEvidence,
  createConservativeProviderBudgetCapabilityProfile,
} from "./provider-budget-capability";

const conservativeProvider = createConservativeProviderBudgetCapabilityProfile("openai", {
  compatible_type: ProviderCompatibleTypeEnum.OpenAI,
});

const verifiedProvider = applyProviderCapabilityEvidence(
  conservativeProvider,
  fullyVerifiedProviderEvidence,
);

const fullySupportedRuntime = PI_RUNTIME_HOOK_COVERAGE.map((capability) => ({
  ...capability,
  support: "supported" as const,
}));

test("BLH-004 disabled mode registers no effective execution mode", () => {
  const result = evaluateBudgetExecutionPreflight({
    config: { enabled: false, mode: "hard" },
    selectedProviderIds: ["openai"],
    providerProfiles: { openai: verifiedProvider },
    runtimeCapabilities: fullySupportedRuntime,
  });
  assert.equal(result.status, "disabled");
  assert.equal(result.effectiveMode, "disabled");
  assert.equal(result.hardGuaranteeActive, false);
});

test("BLH-004 shadow and soft are ready but expose hard limitations", () => {
  for (const mode of ["shadow", "soft"] as const) {
    const result = evaluateBudgetExecutionPreflight({
      config: { enabled: true, mode },
      selectedProviderIds: ["openai"],
      providerProfiles: { openai: conservativeProvider },
    });
    assert.equal(result.status, "ready");
    assert.equal(result.effectiveMode, mode);
    assert.equal(result.hardGuaranteeActive, false);
    assert.ok(result.limitations.length >= 8);
    assert.deepEqual(result.blockers, []);
  }
});

test("BLH-004 current evidence rejects hard without silently downgrading", () => {
  const result = evaluateBudgetExecutionPreflight({
    config: { enabled: true, mode: "hard" },
    selectedProviderIds: ["openai"],
    providerProfiles: { openai: conservativeProvider },
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.effectiveMode, "none");
  assert.equal(result.hardGuaranteeActive, false);
  assert.ok(result.blockers.some((item) => item.scope === "runtime" && item.subject === "provider_internal_retry"));
  assert.ok(result.blockers.some((item) => item.scope === "provider" && item.code === "PROVIDER_CAPABILITY_UNPROVEN"));
});

test("BLH-004 hard is ready only when both Runtime and every selected Provider pass", () => {
  const result = evaluateBudgetExecutionPreflight({
    config: { enabled: true, mode: "hard" },
    selectedProviderIds: ["openai", "openai"],
    providerProfiles: { openai: verifiedProvider },
    runtimeCapabilities: fullySupportedRuntime,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.effectiveMode, "hard");
  assert.equal(result.hardGuaranteeActive, true);
  assert.deepEqual(result.blockers, []);
});

test("BLH-004 missing or empty Provider selection fails closed", () => {
  const none = evaluateBudgetExecutionPreflight({
    config: { enabled: true, mode: "hard" },
    selectedProviderIds: [],
    providerProfiles: {},
    runtimeCapabilities: fullySupportedRuntime,
  });
  assert.ok(none.blockers.some((item) => item.code === "NO_PROVIDER_SELECTED"));

  const missing = evaluateBudgetExecutionPreflight({
    config: { enabled: true, mode: "hard" },
    selectedProviderIds: ["missing"],
    providerProfiles: {},
    runtimeCapabilities: fullySupportedRuntime,
  });
  assert.ok(missing.blockers.some((item) => item.code === "PROVIDER_PROFILE_MISSING"));
});

test("BLH-004 rejects a profile stored under the wrong Provider identity", () => {
  const result = evaluateBudgetExecutionPreflight({
    config: { enabled: true, mode: "hard" },
    selectedProviderIds: ["gateway"],
    providerProfiles: { gateway: verifiedProvider },
    runtimeCapabilities: fullySupportedRuntime,
  });
  assert.equal(result.status, "rejected");
  assert.ok(result.blockers.some((item) => item.code === "PROVIDER_PROFILE_ID_MISMATCH"));
});
