import assert from "node:assert/strict";
import test from "node:test";
import { ActiveMemoryRetriever, applyMemoryPromptBudget, type MemoryIndex, type MemoryRetrievalResult, type MemoryRetriever } from "./memory-retriever";
import type { MemoryRecord } from "./types";

function memory(id: string, level: "L1" | "L2" | "L3", summary = id): MemoryRecord {
  return {
    id, projectId: "project", agentId: "admin", level, kind: level === "L1" ? "working" : "decision",
    content: summary, summary, confidence: 1, salience: 1, evidenceCount: 1, sourceEventIds: [], sources: [], status: "active",
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z", lastConfirmedAt: "2026-09-10T00:00:00.000Z",
    schemaVersion: 2, scope: "project", trustLevel: 100, contradictionIds: [], contentHash: id, indexState: "indexed",
  };
}

function primary(result: MemoryRetrievalResult): MemoryRetriever {
  return { retrieve: async () => result };
}

function options(index: MemoryIndex, lexical: MemoryRetrievalResult, now: () => Date) {
  return {
    primary: primary(lexical), index, configuredBackend: "zvec_hybrid" as const, candidateLimit: 30,
    maxPromptTokens: 1800, timeoutMs: 50, failureThreshold: 2, cooldownMs: 1_000, now,
  };
}

test("M10 active retrieval keeps chronological L1 while replacing L2/L3 with governed Zvec results", async () => {
  const lexical = { l1: [memory("working", "L1")], l2: [memory("lexical", "L2")], l3: [] };
  const index: MemoryIndex = { backend: "zvec_active_hybrid", search: async () => [memory("vector-l2", "L2"), memory("vector-l3", "L3")], close() {} };
  const retriever = new ActiveMemoryRetriever(options(index, lexical, () => new Date("2026-09-10T01:00:00.000Z")));
  const result = await retriever.retrieve({ agentId: "admin", query: "semantic query", globalScope: true, l2MaxResults: 5, l3MaxPromptItems: 5 });
  assert.deepEqual(result.l1.map(({ id }) => id), ["working"]);
  assert.deepEqual(result.l2.map(({ id }) => id), ["vector-l2"]);
  assert.deepEqual(result.l3.map(({ id }) => id), ["vector-l3"]);
  assert.equal(retriever.getStatus().effectiveBackend, "zvec_hybrid");
  assert.equal(retriever.getStatus().lastSuccessAt, "2026-09-10T01:00:00.000Z");
});

test("M10 keeps usable Zvec results while exposing a partial-route degradation", async () => {
  const lexical = { l1: [memory("working", "L1")], l2: [memory("lexical", "L2")], l3: [] };
  const index: MemoryIndex = {
    backend: "zvec_active_hybrid",
    search: async () => [memory("fts-result", "L2")],
    lastFailureReason: () => "dense: embedding request timed out",
    close() {},
  };
  const retriever = new ActiveMemoryRetriever(options(index, lexical, () => new Date("2026-09-10T01:00:00.000Z")));

  const result = await retriever.retrieve({ agentId: "admin", query: "semantic query", globalScope: true, l2MaxResults: 5, l3MaxPromptItems: 5 });

  assert.deepEqual(result.l2.map(({ id }) => id), ["fts-result"]);
  assert.equal(retriever.getStatus().effectiveBackend, "zvec_hybrid");
  assert.equal(retriever.getStatus().fallbackCount, 1);
  assert.match(retriever.getStatus().lastFallbackReason ?? "", /dense: embedding request timed out/);
});

test("M10 circuit breaker falls back to lexical, opens at the threshold, and recovers through one half-open probe", async () => {
  let now = new Date("2026-09-10T01:00:00.000Z");
  let calls = 0;
  let healthy = false;
  const index: MemoryIndex = {
    backend: "zvec_active_hybrid",
    search: async () => { calls += 1; return healthy ? [memory("recovered", "L2")] : undefined; },
    close() {},
  };
  const lexical = { l1: [], l2: [memory("fallback", "L2")], l3: [] };
  const retriever = new ActiveMemoryRetriever(options(index, lexical, () => now));
  const input = { agentId: "admin", query: "query", globalScope: true, l2MaxResults: 5, l3MaxPromptItems: 5 };
  assert.deepEqual((await retriever.retrieve(input)).l2.map(({ id }) => id), ["fallback"]);
  assert.deepEqual((await retriever.retrieve(input)).l2.map(({ id }) => id), ["fallback"]);
  assert.equal(retriever.getStatus().circuitState, "open");
  await retriever.retrieve(input);
  assert.equal(calls, 2);
  assert.equal(retriever.getStatus().fallbackCount, 3);
  now = new Date(now.getTime() + 1_001);
  healthy = true;
  assert.deepEqual((await retriever.retrieve(input)).l2.map(({ id }) => id), ["recovered"]);
  assert.equal(calls, 3);
  assert.equal(retriever.getStatus().circuitState, "closed");
  assert.equal(retriever.getStatus().consecutiveFailures, 0);
});

test("M10 timeout is bounded and prompt budgeting applies to both active and fallback results", async () => {
  const lexical = { l1: [memory("working", "L1", "当前任务状态")], l2: [memory("fallback", "L2", "回退记忆".repeat(100))], l3: [] };
  const index: MemoryIndex = { backend: "zvec_active_hybrid", search: async () => new Promise(() => undefined), close() {} };
  const retriever = new ActiveMemoryRetriever({ ...options(index, lexical, () => new Date()), timeoutMs: 10, maxPromptTokens: 128 });
  const started = performance.now();
  const result = await retriever.retrieve({ agentId: "admin", query: "query", globalScope: true, l2MaxResults: 5, l3MaxPromptItems: 5 });
  assert.ok(performance.now() - started < 500);
  assert.deepEqual(result.l1.map(({ id }) => id), ["working"]);
  assert.deepEqual(result.l2, []);
  assert.match(retriever.getStatus().lastFallbackReason ?? "", /timeout/);
  assert.deepEqual(applyMemoryPromptBudget(lexical, 128), result);
});
