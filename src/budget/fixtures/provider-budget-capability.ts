import type { ProviderCapabilityEvidence } from "../provider-budget-capability";

const observedAt = "2026-10-10T00:00:00.000Z";

export const fullyVerifiedProviderEvidence: readonly ProviderCapabilityEvidence[] = [
  { capability: "pricing_upper_bound", state: "supported", confidence: "verified", source: "billing_reconciliation", observedAt, detail: "Versioned price ceiling reconciled against billing." },
  { capability: "usage_receipt", state: "supported", confidence: "verified", source: "provider_probe", observedAt, detail: "Usage receipt returned for the completed request." },
  { capability: "max_output_tokens", state: "supported", confidence: "verified", source: "provider_probe", observedAt, detail: "Provider enforced the requested output ceiling." },
  { capability: "idempotency_key", state: "supported", confidence: "verified", source: "provider_probe", observedAt, detail: "Repeated key returned the original logical operation." },
  { capability: "request_status_query", state: "supported", confidence: "verified", source: "provider_probe", observedAt, detail: "Request state was queryable by stable request ID." },
  { capability: "request_abort", state: "supported", confidence: "verified", source: "provider_probe", observedAt, detail: "Provider acknowledged cancellation and exposed final state." },
] as const;

export const partialProviderEvidence: readonly ProviderCapabilityEvidence[] = [
  { capability: "usage_receipt", state: "supported", confidence: "observed", source: "runtime_probe", observedAt, detail: "Usage was observed on a successful response but is not contractual." },
  { capability: "max_output_tokens", state: "supported", confidence: "verified", source: "provider_probe", observedAt, detail: "Provider enforced the requested output ceiling." },
  { capability: "request_status_query", state: "unsupported", confidence: "verified", source: "provider_probe", observedAt, detail: "Provider has no request lookup endpoint." },
] as const;
