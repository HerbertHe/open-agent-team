import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { installBudgetedStream } from "./budgeted-stream";
import { ExecutionRuntimeContextSchema } from "../program/execution-runtime-context";
import type { ModelCallRequest } from "../budget/model-call-protocol";

type StreamFn = AgentSession["agent"]["streamFunction"];
const model = { provider: "provider", id: "model", contextWindow: 100, maxTokens: 20 } as Parameters<StreamFn>[0];
const context = { messages: [], systemPrompt: "test" } as Parameters<StreamFn>[1];
const execution = ExecutionRuntimeContextSchema.parse({ programId: "p", workPackageId: "w", attemptId: "a", executionEpoch: 0, fencingToken: 1, operationId: "task", reservationId: "envelope" });
const message = { stopReason: "stop", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } };
function stream() {
  return { result: async () => message, async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "hello" }; yield { type: "done", message }; } } as unknown as Awaited<ReturnType<StreamFn>>;
}

test("budgeted stream authorizes before dispatch, disables hidden retries and settles before terminal delivery", async () => {
  const order: string[] = []; const calls: ModelCallRequest[] = []; const options: unknown[] = [];
  const agent = { streamFunction: async (_model, _context, value) => { order.push("provider"); options.push(value); return stream(); } } as AgentSession["agent"];
  installBudgetedStream(agent, () => execution, async (request) => { calls.push(request); order.push(request.stage); return { mode: "soft" }; });
  const result = await agent.streamFunction(model, context, { maxTokens: 10, maxRetries: 5 });
  for await (const event of result) if (event.type === "done") order.push("done");
  await result.result();
  assert.deepEqual(order, ["begin", "provider", "finish", "done"]);
  assert.equal((options[0] as { maxRetries: number }).maxRetries, 0);
  assert.equal((options[0] as { maxTokens: number }).maxTokens, 10);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.context.operationId, calls[1]!.context.operationId);
  assert.equal(calls[0]!.context.reservationId, "envelope");
});

test("continuation/internal invocations use separate operation identities; result-only callers also settle", async () => {
  const calls: ModelCallRequest[] = [];
  const agent = { streamFunction: async () => stream() } as unknown as AgentSession["agent"];
  installBudgetedStream(agent, () => execution, async (request) => { calls.push(request); return { mode: "soft" }; });
  await (await agent.streamFunction(model, context)).result();
  await (await agent.streamFunction(model, { ...context, messages: [{ role: "toolResult" }] } as Parameters<StreamFn>[1])).result();
  const starts = calls.filter((call) => call.stage === "begin");
  assert.equal(starts[0]!.callKind, "initial"); assert.equal(starts[1]!.callKind, "tool_continuation");
  assert.notEqual(starts[0]!.context.operationId, starts[1]!.context.operationId);
});

test("budget denial never reaches provider; failures settle unknown and ordinary sessions preserve SDK options", async () => {
  let requests = 0;
  const agent = { streamFunction: async () => { requests++; return stream(); } } as unknown as AgentSession["agent"];
  installBudgetedStream(agent, () => execution, async () => { throw new Error("DENIED"); });
  await assert.rejects(agent.streamFunction(model, context) as Promise<unknown>, /DENIED/); assert.equal(requests, 0);
  const calls: ModelCallRequest[] = [];
  const failing = { streamFunction: async () => { throw new Error("provider disconnected"); } } as unknown as AgentSession["agent"];
  installBudgetedStream(failing, () => execution, async (call) => { calls.push(call); return { mode: "soft" }; });
  await assert.rejects(failing.streamFunction(model, context) as Promise<unknown>, /disconnected/);
  assert.equal((calls[1] as Extract<ModelCallRequest, { stage: "finish" }>).outcome, "unknown");
  let received: unknown;
  const ordinary = { streamFunction: async (_model: unknown, _context: unknown, options: unknown) => { received = options; return stream(); } } as unknown as AgentSession["agent"];
  installBudgetedStream(ordinary, () => undefined, async () => { throw new Error("should not meter"); });
  const options = { maxRetries: 3 };
  await ordinary.streamFunction(model, context, options);
  assert.equal(received, options);
});
