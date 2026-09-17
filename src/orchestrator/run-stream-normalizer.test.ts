import assert from "node:assert/strict";
import test from "node:test";
import { ObservabilityHub } from "./observability-hub";
import { RunStreamNormalizer } from "./run-stream-normalizer";

test("normalizes text and reasoning deltas with stable message identity", () => {
  const normalizer = new RunStreamNormalizer();
  const start = normalizer.normalize("admin", undefined, "task-1", {
    type: "message_start",
    message: { role: "assistant", timestamp: 42 },
  });
  const text = normalizer.normalize("admin", undefined, "task-1", {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
  });
  const reasoning = normalizer.normalize("admin", undefined, "task-1", {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "checking" },
  });

  assert.equal(start?.kind, "message.started");
  assert.equal(text?.kind, "content.delta");
  assert.equal(reasoning?.kind, "reasoning.delta");
  assert.equal(text?.messageId, start?.messageId);
  assert.equal(reasoning?.messageId, start?.messageId);
  assert.equal(text?.blockIndex, 0);
  assert.equal(reasoning?.blockIndex, 1);
  assert.deepEqual([start?.seq, text?.seq, reasoning?.seq], [1, 2, 3]);
});

test("keeps task identity after completion tools release the scheduler slot", () => {
  const normalizer = new RunStreamNormalizer();
  const start = normalizer.normalize("admin", undefined, "task-1", { type: "agent_start" });
  const afterRelease = normalizer.normalize("admin", undefined, undefined, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "final" },
  });
  assert.equal(afterRelease?.taskId, "task-1");
  assert.equal(afterRelease?.runId, start?.runId);
});

test("does not expose tool-call argument deltas as activity events", () => {
  const normalizer = new RunStreamNormalizer();
  normalizer.normalize("admin", undefined, "task-1", {
    type: "message_start",
    message: { role: "assistant", timestamp: 42 },
  });
  const argumentDelta = normalizer.normalize("admin", undefined, "task-1", {
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "admin" },
  });
  assert.equal(argumentDelta, undefined);
});

test("observability cursors replay only events after the acknowledged event", () => {
  const hub = new ObservabilityHub(10);
  hub.emit({ source: "orchestrator", type: "first", payload: {} });
  hub.emit({ source: "orchestrator", type: "second", payload: {} });
  hub.emit({ source: "orchestrator", type: "third", payload: {} });
  const snapshot = hub.snapshot();

  assert.ok(snapshot.every((event) => event.eventId));
  assert.deepEqual(snapshot.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(hub.snapshotAfter(snapshot[0].eventId).map((event) => event.type), ["second", "third"]);
  assert.deepEqual(hub.snapshotAfter("expired-cursor").map((event) => event.type), ["first", "second", "third"]);
});
