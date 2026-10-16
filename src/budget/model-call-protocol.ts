import { z } from "zod";
import { ExecutionRuntimeContextSchema } from "../program/execution-runtime-context";
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ModelUsageSchema = z.object({ inputTokens: Count, outputTokens: Count,
  cacheReadTokens: Count.optional(), cacheWriteTokens: Count.optional() }).strict();
const Common = { context: ExecutionRuntimeContextSchema, modelRef: z.string().min(1).max(512) };
export const ModelCallRequestSchema = z.discriminatedUnion("stage", [
  z.object({ ...Common, stage: z.literal("begin"), usageUpperBound: ModelUsageSchema,
    callKind: z.enum(["initial", "tool_continuation", "retry", "compaction", "internal"]) }).strict(),
  z.object({ ...Common, stage: z.literal("finish"), outcome: z.enum(["reported", "unknown"]), usage: ModelUsageSchema.optional() }).strict(),
]);
export type ModelCallRequest = z.infer<typeof ModelCallRequestSchema>;
export type ModelCallHandler = (agentId: string, configuredModel: string, request: ModelCallRequest) => Promise<{ mode: "shadow" | "soft" }>;
