import { z } from "zod";
import { ExecutionRuntimeContextSchema } from "./execution-runtime-context";
import type { ToolResultPayload } from "../sandbox/agent-runner-ipc";
export const ToolEffectRequestSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("begin"), context: ExecutionRuntimeContextSchema, toolName: z.string().min(1).max(128),
    toolCallId: z.string().min(1).max(512), params: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ stage: z.literal("finish"), context: ExecutionRuntimeContextSchema, toolName: z.string().min(1).max(128),
    toolCallId: z.string().min(1).max(512), isError: z.boolean(), resultDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type ToolEffectRequest = z.infer<typeof ToolEffectRequestSchema>;
export type ToolEffectHandler = (agentId: string, workspacePath: string, request: ToolEffectRequest, virtualWorkspace?: string) => Promise<void>;
export type RuntimeToolCall = { agentId: string; workspacePath: string; context: z.infer<typeof ExecutionRuntimeContextSchema>;
  toolName: string; toolCallId: string; params: unknown; permittedTools: ReadonlySet<string>; execute: () => Promise<ToolResultPayload> };
export type RuntimeToolExecutor = (input: RuntimeToolCall) => Promise<ToolResultPayload>;
