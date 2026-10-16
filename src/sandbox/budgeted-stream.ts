import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExecutionRuntimeContext } from "../program/execution-runtime-context";
import type { ModelCallRequest } from "../budget/model-call-protocol";

/** Reuse the SDK stream seam, including its tool continuations, compaction and summaries. */
export function installBudgetedStream(agent: AgentSession["agent"], getContext: () => ExecutionRuntimeContext | undefined,
  exchange: (request: ModelCallRequest) => Promise<{ mode: "shadow" | "soft" }>): void {
  const original = agent.streamFunction.bind(agent);
  let previousAttempt: string | undefined;
  agent.streamFunction = async (model, context, options) => {
    const execution = getContext();
    if (!execution) return original(model, context, options);
    const callContext = { ...execution, operationId: `model:${randomUUID()}` };
    const modelRef = `${model.provider}/${model.id}`;
    const last = context.messages.at(-1);
    const callKind = last?.role === "toolResult" ? "tool_continuation" : previousAttempt !== execution.attemptId ? "initial" : "internal";
    previousAttempt = execution.attemptId;
    const outputLimit = Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens);
    const approved = await exchange({ stage: "begin", context: callContext, modelRef, callKind,
      usageUpperBound: { inputTokens: model.contextWindow, outputTokens: outputLimit,
        cacheReadTokens: model.contextWindow, cacheWriteTokens: model.contextWindow } });
    let completed: Promise<void> | undefined;
    const finish = (message?: { stopReason: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } }) => {
      completed ??= exchange({ stage: "finish", context: callContext, modelRef,
        ...(message && !["error", "aborted"].includes(message.stopReason) && message.usage.totalTokens > 0
          ? { outcome: "reported" as const, usage: { inputTokens: message.usage.input, outputTokens: message.usage.output,
            cacheReadTokens: message.usage.cacheRead, cacheWriteTokens: message.usage.cacheWrite } }
          : { outcome: "unknown" as const }) }).then(() => undefined).catch((error) => {
            if (approved.mode !== "shadow") throw error;
          });
      return completed;
    };
    try {
      // A managed SDK invocation never hides automatic provider retries beneath one reservation.
      // SDK/session retries re-enter this seam and obtain another operation ID.
      const stream = await original(model, context, { ...options, maxTokens: outputLimit, maxRetries: 0 });
      const result = stream.result().then(async (message) => { await finish(message); return message; });
      void result.catch(() => undefined);
      return new Proxy(stream, { get(target, property) {
        if (property === "result") return () => result;
        if (property === Symbol.asyncIterator) return async function* () {
          try {
            for await (const event of target) {
              if (event.type === "done" || event.type === "error") await result;
              yield event;
            }
            await result;
          } catch (error) { await finish(); throw error; }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } catch (error) { await finish(); throw error; }
  };
}
