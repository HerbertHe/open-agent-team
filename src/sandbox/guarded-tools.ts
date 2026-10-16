import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExecutionRuntimeContext } from "../program/execution-runtime-context";
import type { ToolEffectRequest } from "../program/tool-effects-protocol";
import { effectDigest } from "../program/effect-ledger";

/** Custom OAT tools are guarded in the parent; SDK builtins/extensions use this seam. */
export function installGuardedTools(agent: AgentSession["agent"], getContext: () => ExecutionRuntimeContext | undefined,
  customNames: ReadonlySet<string>, exchange: (request: ToolEffectRequest) => Promise<void>): void {
  const before = agent.beforeToolCall?.bind(agent);
  const after = agent.afterToolCall?.bind(agent);
  const contexts = new Map<string, ExecutionRuntimeContext>();
  agent.beforeToolCall = async (input, signal) => {
    // Agent core selects the tool and retains the validated args object before invoking this hook.
    const toolName = input.toolCall.name; const toolCallId = input.toolCall.id; const args = input.args;
    const result = await before?.(input, signal);
    if (result?.block || signal?.aborted || customNames.has(toolName)) return result;
    const context = getContext();
    if (!context) return result;
    await exchange({ stage: "begin", context, toolName, toolCallId,
      params: JSON.parse(JSON.stringify(args ?? {})) });
    contexts.set(toolCallId, { ...context });
    return result;
  };
  agent.afterToolCall = async (input, signal) => {
    const context = contexts.get(input.toolCall.id);
    contexts.delete(input.toolCall.id);
    if (context) await exchange({ stage: "finish", context, toolName: input.toolCall.name, toolCallId: input.toolCall.id,
      isError: input.isError, resultDigest: effectDigest(JSON.parse(JSON.stringify({ result: input.result }))) });
    return after?.(input, signal);
  };
}
