type ContentBlock = {
  type?: unknown;
  thinkingSignature?: unknown;
};

type AssistantMessage = {
  role?: unknown;
  content?: unknown;
};

export type DeepSeekReplayApi = "openai-completions" | "openai-responses";

function isOpenAIReasoningItemSignature(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(value) as { type?: unknown; id?: unknown };
    return parsed.type === "reasoning" && typeof parsed.id === "string";
  } catch {
    return false;
  }
}

function normalizeMessage(message: unknown, api: DeepSeekReplayApi): number {
  if (!message || typeof message !== "object") return 0;
  const assistant = message as AssistantMessage;
  if (assistant.role !== "assistant" || !Array.isArray(assistant.content)) return 0;
  let changed = 0;
  for (const rawBlock of assistant.content) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as ContentBlock;
    if (block.type !== "thinking" || typeof block.thinkingSignature !== "string") continue;
    const isResponsesItem = isOpenAIReasoningItemSignature(block.thinkingSignature);
    if (api === "openai-completions" && isResponsesItem) {
      // Chat Completions treats the signature as a dynamic response field name.
      block.thinkingSignature = "reasoning_content";
      changed += 1;
    } else if (api === "openai-responses" && !isResponsesItem) {
      // Responses unconditionally JSON.parse()s this value. A Chat Completions
      // field name such as `reasoning_content` is not a Responses reasoning
      // item and must not survive a protocol transition.
      delete block.thinkingSignature;
      changed += 1;
    }
  }
  return changed;
}

/** Normalize messages in-place before AgentSession stores/replays them. */
export function normalizeDeepSeekReplaySignatures(
  event: Record<string, unknown>,
  api: DeepSeekReplayApi,
): number {
  let changed = 0;
  changed += normalizeMessage(event.message, api);
  if (Array.isArray(event.messages)) {
    for (const message of event.messages) changed += normalizeMessage(message, api);
  }
  const assistantEvent = event.assistantMessageEvent;
  if (assistantEvent && typeof assistantEvent === "object") {
    changed += normalizeMessage((assistantEvent as { partial?: unknown }).partial, api);
  }
  return changed;
}
