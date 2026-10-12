import assert from "node:assert/strict";
import test from "node:test";
import { ProviderCompatibleTypeEnum } from "../types";
import { fullyVerifiedProviderEvidence, partialProviderEvidence } from "./fixtures/provider-budget-capability";
import {
  applyProviderCapabilityEvidence,
  createConservativeProviderBudgetCapabilityProfile,
  probeConfiguredProviderCapabilities,
  type ProviderBudgetCapabilityProbe,
} from "./provider-budget-capability";

const provider = {
  compatible_type: ProviderCompatibleTypeEnum.OpenAI,
  base_url: "https://user:password@api.example.test/v1",
  api_key: "never-persist-this-secret",
};

test("BLH-003 configuration alone leaves every billable capability unknown", () => {
  const profile = createConservativeProviderBudgetCapabilityProfile("gateway", provider, "2026-10-10T00:00:00.000Z");
  assert.equal(profile.providerHardModeEligible, false);
  assert.equal(profile.providerHardModeBlockers.length, 6);
  assert.ok(Object.values(profile.capabilities).every((entry) => entry.state === "unknown"));
  const serialized = JSON.stringify(profile);
  assert.equal(serialized.includes("never-persist-this-secret"), false);
  assert.equal(serialized.includes("user:password"), false);
});

test("BLH-003 hard mode requires verified support for every required capability", () => {
  const base = createConservativeProviderBudgetCapabilityProfile("gateway", provider);
  const partial = applyProviderCapabilityEvidence(base, partialProviderEvidence);
  assert.equal(partial.providerHardModeEligible, false);
  assert.ok(partial.providerHardModeBlockers.includes("usage_receipt"));
  assert.ok(partial.providerHardModeBlockers.includes("request_status_query"));

  const verified = applyProviderCapabilityEvidence(base, fullyVerifiedProviderEvidence);
  assert.equal(verified.providerHardModeEligible, true);
  assert.deepEqual(verified.providerHardModeBlockers, []);
});

test("BLH-003 static configuration cannot self-attest a supported capability", () => {
  const base = createConservativeProviderBudgetCapabilityProfile("gateway", provider);
  const profile = applyProviderCapabilityEvidence(base, [{
    capability: "usage_receipt",
    state: "supported",
    confidence: "verified",
    source: "configuration",
    observedAt: "2026-10-10T00:00:00.000Z",
    detail: "User configuration claims usage support.",
  }]);
  assert.equal(profile.capabilities.usage_receipt.state, "unknown");
  assert.equal(profile.providerHardModeEligible, false);
});

test("BLH-003 probe receives a secret-free descriptor", async () => {
  let received: unknown;
  const probe: ProviderBudgetCapabilityProbe = {
    probe: async (descriptor) => {
      received = descriptor;
      return fullyVerifiedProviderEvidence;
    },
  };
  const profiles = await probeConfiguredProviderCapabilities({ gateway: provider }, probe, "2026-10-10T00:00:00.000Z");
  assert.equal(profiles.gateway?.providerHardModeEligible, true);
  assert.deepEqual(received, {
    providerId: "gateway",
    compatibleType: ProviderCompatibleTypeEnum.OpenAI,
    endpointKind: "custom",
    hasCredentialReference: true,
  });
});

test("BLH-003 probe failure remains unknown and fails closed", async () => {
  const profiles = await probeConfiguredProviderCapabilities({ gateway: provider }, {
    probe: async () => { throw new Error("secret-bearing provider error"); },
  });
  const profile = profiles.gateway;
  assert.equal(profile?.probeStatus, "failed");
  assert.equal(profile?.providerHardModeEligible, false);
  assert.ok(Object.values(profile?.capabilities ?? {}).every((entry) => entry.state === "unknown"));
  assert.equal(JSON.stringify(profile).includes("secret-bearing"), false);
});

test("BLH-003 rejects duplicate evidence for deterministic profiles", () => {
  const base = createConservativeProviderBudgetCapabilityProfile("gateway", provider);
  assert.throws(() => applyProviderCapabilityEvidence(base, [
    fullyVerifiedProviderEvidence[0]!,
    fullyVerifiedProviderEvidence[0]!,
  ]), /Duplicate provider capability evidence/);
});
