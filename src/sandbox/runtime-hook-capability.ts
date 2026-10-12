/** BLH-002 spike result. This module records evidence; it is not on the runtime path. */
export type RuntimeHookSupport = "supported" | "partial" | "unsupported";

export interface RuntimeHookCapability {
  path: "initial_model_call" | "tool_continuation" | "provider_internal_retry" |
    "manual_compaction" | "auto_compaction" | "branch_summary" |
    "provider_request_preflight" | "provider_response" | "session_abort" |
    "usage_and_request_identity";
  support: RuntimeHookSupport;
  hardModeBlocker: boolean;
  evidence: string;
}

/**
 * Evidence derived from pi-coding-agent 0.84's public declarations and SDK
 * composition. Keep this conservative: partial evidence must never become a
 * hard-mode capability merely because the happy path works.
 */
export const PI_RUNTIME_HOOK_COVERAGE: readonly RuntimeHookCapability[] = [
  {
    path: "initial_model_call",
    support: "supported",
    hardModeBlocker: false,
    evidence: "createAgentSession installs one Agent streamFn that delegates to the injected ModelRuntime.streamSimple.",
  },
  {
    path: "tool_continuation",
    support: "supported",
    hardModeBlocker: false,
    evidence: "Agent continuations reuse the same Agent.streamFunction after tool results.",
  },
  {
    path: "provider_internal_retry",
    support: "partial",
    hardModeBlocker: true,
    evidence: "maxRetries is passed beneath the streamSimple boundary; the public contract has no guaranteed hook for every provider retry attempt.",
  },
  {
    path: "manual_compaction",
    support: "supported",
    hardModeBlocker: false,
    evidence: "AgentSession.compact passes this.agent.streamFunction to the summarizer.",
  },
  {
    path: "auto_compaction",
    support: "supported",
    hardModeBlocker: false,
    evidence: "AgentSession auto-compaction passes this.agent.streamFunction to the summarizer.",
  },
  {
    path: "branch_summary",
    support: "supported",
    hardModeBlocker: false,
    evidence: "Branch summarization is configured with this.agent.streamFunction.",
  },
  {
    path: "provider_request_preflight",
    support: "supported",
    hardModeBlocker: false,
    evidence: "The SDK exposes before_provider_request and calls it before the provider stream is consumed.",
  },
  {
    path: "provider_response",
    support: "supported",
    hardModeBlocker: false,
    evidence: "The SDK exposes after_provider_response with HTTP status and headers.",
  },
  {
    path: "session_abort",
    support: "supported",
    hardModeBlocker: false,
    evidence: "AgentSession publicly exposes abort(): Promise<void> and waitForIdle().",
  },
  {
    path: "usage_and_request_identity",
    support: "partial",
    hardModeBlocker: true,
    evidence: "Terminal messages expose usage, but the public hooks do not guarantee a provider request ID and authoritative billable usage for every provider.",
  },
] as const;

export interface RuntimeHookSpikeDecision {
  hardModeEligible: boolean;
  supportedPaths: number;
  partialPaths: number;
  blockers: RuntimeHookCapability[];
}

export function evaluateRuntimeHookSpike(
  capabilities: readonly RuntimeHookCapability[] = PI_RUNTIME_HOOK_COVERAGE,
): RuntimeHookSpikeDecision {
  const blockers = capabilities.filter((item) => item.hardModeBlocker && item.support !== "supported");
  return {
    hardModeEligible: blockers.length === 0,
    supportedPaths: capabilities.filter((item) => item.support === "supported").length,
    partialPaths: capabilities.filter((item) => item.support === "partial").length,
    blockers,
  };
}
