import type { AgentRoleEnum } from "../types/enums";
import type { RunStreamKind, RunStreamMetadata } from "../types/observability";

type RuntimeEvent = Record<string, unknown> & { type: string };
type StreamState = { taskId?: string; runId: string; turn: number; messageId?: string; seq: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function messageTimestamp(event: RuntimeEvent): number | undefined {
  const timestamp = record(event.message)?.timestamp;
  return typeof timestamp === "number" ? timestamp : undefined;
}

/** Converts provider-specific Pi session events into a small, stable UI stream contract. */
export class RunStreamNormalizer {
  private readonly states = new Map<string, StreamState>();

  normalize(agentId: string, _role: AgentRoleEnum | undefined, taskId: string | undefined, event: RuntimeEvent): RunStreamMetadata | undefined {
    let state = this.states.get(agentId);
    const effectiveTaskId = taskId ?? state?.taskId;
    if (!state || (taskId !== undefined && state.taskId !== taskId)) {
      state = { taskId: effectiveTaskId, runId: `${effectiveTaskId ?? "session"}:${agentId}:${Date.now().toString(36)}`, turn: 0, seq: 0 };
      this.states.set(agentId, state);
    }
    if (event.type === "turn_start") state.turn += 1;
    const assistantEvent = record(event.assistantMessageEvent);
    const contentIndex = assistantEvent?.contentIndex;
    const eventType = typeof assistantEvent?.type === "string" ? assistantEvent.type : undefined;
    const timestamp = messageTimestamp(event);
    if (event.type === "message_start" && record(event.message)?.role === "assistant") {
      state.messageId = `${state.runId}:message:${timestamp ?? state.seq + 1}`;
    } else if (event.type === "message_update" && !state.messageId) {
      state.messageId = `${state.runId}:message:${timestamp ?? state.seq + 1}`;
    }

    let kind: RunStreamKind | undefined;
    if (event.type === "agent_start") kind = "run.started";
    else if (event.type === "agent_end") kind = "run.completed";
    else if (event.type === "message_start" && record(event.message)?.role === "assistant") kind = "message.started";
    else if (event.type === "message_end" && record(event.message)?.role === "assistant") kind = "message.completed";
    else if (event.type === "tool_execution_start") kind = "tool.started";
    else if (event.type === "tool_execution_update") kind = "tool.updated";
    else if (event.type === "tool_execution_end") kind = "tool.completed";
    else if (eventType === "text_start") kind = "content.block.started";
    else if (eventType === "text_delta") kind = "content.delta";
    else if (eventType === "text_end") kind = "content.block.completed";
    else if (eventType === "thinking_start") kind = "reasoning.block.started";
    else if (eventType === "thinking_delta") kind = "reasoning.delta";
    else if (eventType === "thinking_end") kind = "reasoning.completed";
    // toolcall_* is streamed model output (often one JSON character at a time),
    // not an execution activity. The corresponding tool_execution_* events are
    // the stable, user-facing lifecycle and are normalized above.
    if (!kind) return undefined;

    const metadata: RunStreamMetadata = {
      schemaVersion: 1,
      kind,
      taskId: effectiveTaskId,
      runId: state.runId,
      turnId: `${state.runId}:turn:${state.turn}`,
      messageId: state.messageId,
      blockIndex: typeof contentIndex === "number" ? contentIndex : undefined,
      seq: ++state.seq,
    };
    if (kind === "message.completed") state.messageId = undefined;
    if (kind === "run.completed") this.states.delete(agentId);
    return metadata;
  }
}
