import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { installGuardedTools } from "./guarded-tools";
import { ExecutionRuntimeContextSchema } from "../program/execution-runtime-context";
import type { ToolEffectRequest } from "../program/tool-effects-protocol";
type Before = Parameters<NonNullable<AgentSession["agent"]["beforeToolCall"]>>[0];
type After = Parameters<NonNullable<AgentSession["agent"]["afterToolCall"]>>[0];
const context = ExecutionRuntimeContextSchema.parse({ programId: "p", workPackageId: "w", attemptId: "a", executionEpoch: 0, fencingToken: 1, operationId: "task", reservationId: "budget" });
const before = (name = "write") => ({ toolCall: { id: "tool-call", name }, args: { path: "result.txt", content: "private body" } } as unknown as Before);
const after = (name = "write") => ({ toolCall: { id: "tool-call", name }, isError: false, result: { content: [{ type: "text", text: "private output" }] } } as unknown as After);

test("SDK tool hooks honor extension blocks, authorize final arguments and acknowledge receipts before returning", async () => {
  const calls: ToolEffectRequest[] = []; const order: string[] = [];
  const agent = { beforeToolCall: async (input: Before) => { (input.args as Record<string, unknown>).path = "changed.txt"; order.push("extension-before"); },
    afterToolCall: async () => { order.push("extension-after"); } } as unknown as AgentSession["agent"];
  installGuardedTools(agent, () => context, new Set(), async (request) => { calls.push(request); order.push(request.stage); });
  await agent.beforeToolCall!(before()); await agent.afterToolCall!(after());
  assert.deepEqual(order, ["extension-before", "begin", "finish", "extension-after"]);
  assert.equal((calls[0] as Extract<ToolEffectRequest, { stage: "begin" }>).params.path, "changed.txt");
  assert.equal(JSON.stringify(calls[1]).includes("private output"), false);
  assert.equal((calls[1] as Extract<ToolEffectRequest, { stage: "finish" }>).resultDigest.length, 64);
});

test("custom tools stay on parent executor path; ordinary sessions do not issue effect IPC", async () => {
  let ipc = 0;
  let execution: typeof context | undefined = context;
  const agent = {} as AgentSession["agent"];
  installGuardedTools(agent, () => execution, new Set(["notify-complete"]), async () => { ipc++; });
  await agent.beforeToolCall!(before("notify-complete")); await agent.afterToolCall!(after("notify-complete"));
  execution = undefined; await agent.beforeToolCall!(before()); await agent.afterToolCall!(after());
  assert.equal(ipc, 0);
});

test("denied or already-blocked calls cannot obtain an execution permit", async () => {
  let ipc = 0;
  const agent = {} as AgentSession["agent"];
  installGuardedTools(agent, () => context, new Set(), async () => { ipc++; throw new Error("STALE_EXECUTION"); });
  await assert.rejects(agent.beforeToolCall!(before()), /STALE_EXECUTION/);
  assert.equal(ipc, 1);
  const blocked = { beforeToolCall: async () => ({ block: true, reason: "extension denied" }) } as unknown as AgentSession["agent"];
  installGuardedTools(blocked, () => context, new Set(), async () => { throw new Error("should not call"); });
  assert.equal((await blocked.beforeToolCall!(before()))!.block, true);
});
