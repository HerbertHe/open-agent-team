import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRoleEnum } from "../types/enums";
import type { MemoryConfig } from "../types/config";
import { ObservabilityHub } from "../orchestrator/observability-hub";
import { MemoryService, type MemoryServiceDependencies } from "./memory-service";
import type { MemoryIndex } from "./memory-retriever";
import type { MemoryRecord } from "./types";
import { MemoryAccessDeniedError } from "./memory-policy";
import type { MemoryActor } from "./types";

const config: MemoryConfig = {
  enabled: true,
  roles: ["admin", "leader"],
  retrieval: { backend: "lexical", fallback: "lexical", shadow: false, productionEnabled: false, candidateLimit: 30, maxResults: 8, maxPromptTokens: 1800, timeoutMs: 3_000, circuitBreakerFailureThreshold: 3, circuitBreakerCooldownSeconds: 60 },
  zvec: { path: "memory/zvec", index: "flat", metric: "cosine", readOnlyFallback: true, batchSize: 64, maxAttempts: 8, optimizePendingThreshold: 100_000 },
  extraction: { enabled: false, version: "m11-v1", timeoutMs: 15_000, maxInputChars: 4_000, maxOutputTokens: 800, maxFactsPerEvent: 5, maxAttempts: 3 },
  l1: { maxItems: 10, completedTaskTtlHours: 48 },
  l2: { maxResults: 5, retentionDays: 180 },
  l3: { maxPromptItems: 5, minEvidence: 2 },
  dream: { enabled: true, idleAfterSeconds: 30, pollSeconds: 30, maxEventsPerRun: 100, cancelOnNewTask: true },
};

function indexedMemory(id: string, summary: string): MemoryRecord {
  return {
    id, projectId: "project-test", agentId: "admin", level: "L2", kind: "decision", content: summary, summary,
    confidence: 1, salience: 1, evidenceCount: 1, sourceEventIds: [], sources: [], status: "active",
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z", lastConfirmedAt: "2026-09-10T00:00:00.000Z",
    schemaVersion: 2, scope: "project", trustLevel: 100, contradictionIds: [], contentHash: id, indexState: "indexed",
  };
}

test("consolidates Admin/Leader observations through L1, L2 and L3", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-"));
  const hub = new ObservabilityHub();
  const memory = new MemoryService("project-test", root, config, hub);
  memory.setIdleResolver(() => true);
  try {
    for (let index = 0; index < 2; index += 1) {
      hub.emit({
        source: "orchestrator",
        type: "report_progress",
        agentId: "admin",
        role: AgentRoleEnum.Admin,
        payload: { stage: "done", taskId: `decision-${index}`, message: "Project configuration and global configuration stay isolated." },
      });
    }
    hub.emit({
      source: "orchestrator",
      type: "task.completed",
      agentId: "team-a-worker-0",
      role: AgentRoleEnum.Worker,
      payload: { task: { id: "task-1", prompt: "Implement memory", status: "completed" } },
    });

    assert.equal(memory.list({ agentId: "admin", level: "L1" }).length, 1);
    assert.equal(memory.list({ agentId: "team-a-lead", level: "L1" }).length, 1);
    const dream = await memory.runDream("manual");
    assert.equal(dream.status, "completed");
    assert.equal(dream.processedEvents, 3);
    assert.equal(memory.list({ agentId: "admin", level: "L2" })[0]?.evidenceCount, 2);
    assert.equal(memory.list({ agentId: "admin", level: "L2" })[0]?.independentEvidenceCount, 2);
    assert.equal(memory.list({ agentId: "admin", level: "L2" })[0]?.sources.length, 2);
    assert.equal(memory.list({ agentId: "admin", level: "L3" }).length, 1);
    const workerMemory = memory.list({ agentId: "team-a-lead", level: "L2" })[0];
    assert.equal(workerMemory?.sources[0]?.agentId, "team-a-worker-0");
    assert.equal(workerMemory?.sources[0]?.role, AgentRoleEnum.Leader);
    assert.equal(workerMemory?.trustLevel, 80);
    const context = await memory.buildContext("admin", "project configuration");
    assert.match(context, /L3 deep memory/);
    assert.match(context, /Project configuration/);
    const promoted = memory.list({ agentId: "admin", level: "L3" })[0];
    assert.equal(memory.forget(promoted.id), true);
    assert.equal(memory.list({ agentId: "admin", level: "L3" }).length, 0);
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not dream while project work is active", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-busy-"));
  const memory = new MemoryService("project-test", root, config, new ObservabilityHub());
  memory.setIdleResolver(() => false);
  try {
    const dream = await memory.runDream("manual");
    assert.equal(dream.status, "skipped");
    assert.match(dream.error ?? "", /busy|disabled/i);
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("M13 denies external Worker retrieval and canonical mutation while auditing both attempts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-m13-service-"));
  const hub = new ObservabilityHub();
  const memory = new MemoryService("project-test", root, config, hub);
  memory.setIdleResolver(() => true);
  const external: MemoryActor = { id: "vendor-worker", role: "worker", employment: "external", projectId: "project-test", teamId: "team-a", projectIds: ["project-test"] };
  try {
    hub.emit({ source: "orchestrator", type: "report_progress", agentId: "admin", role: AgentRoleEnum.Admin, payload: { taskId: "m13-task", message: "M13 protected canonical fact" } });
    await memory.runDream("manual");
    const canonical = memory.list({ level: "L2" })[0]!;
    assert.equal(await memory.buildContextForActor(external, "protected"), "");
    assert.throws(() => memory.forget(canonical.id, external), MemoryAccessDeniedError);
    assert.equal(memory.list({ level: "L2" }).some(({ id }) => id === canonical.id), true);
    const denied = memory.accessAudits(20).filter((audit) => audit.actorId === external.id && audit.decision === "denied");
    assert.deepEqual(denied.map(({ action }) => action).sort(), ["forget", "inject"]);
  } finally { await memory.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("runs configured Zvec retrieval in shadow without changing lexical output", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-shadow-"));
  const shadowConfig: MemoryConfig = {
    ...config,
    embeddingRef: "memory-default",
    retrieval: { ...config.retrieval, backend: "zvec_hybrid", shadow: true, productionEnabled: true },
  };
  const memory = new MemoryService("project-test", root, shadowConfig, new ObservabilityHub());
  try {
    assert.equal(await memory.buildContext("admin", "api_key=top-secret channel routing"), "");
    const database = new Database(path.join(root, "memory", "memory.db"), { readonly: true });
    try {
      let row: { query: string; fallback_reason: string } | undefined;
      for (let attempt = 0; attempt < 100 && !row; attempt += 1) {
        row = database.prepare("SELECT query, fallback_reason FROM memory_retrieval_runs ORDER BY rowid DESC LIMIT 1").get() as typeof row;
        if (!row) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(row);
      assert.doesNotMatch(row.query, /top-secret/);
      assert.match(row.query, /\[REDACTED\]/);
      assert.match(row.fallback_reason, /No active Zvec collection/);
      assert.equal(memory.overview("admin").retrieval.mode, "shadow");
      assert.equal(memory.overview("admin").retrieval.effectiveBackend, "lexical");
    } finally {
      database.close();
    }
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not call Zvec when the project is not in the global active-retrieval allowlist", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-not-allowlisted-"));
  let calls = 0;
  const index: MemoryIndex = {
    backend: "zvec_active_hybrid",
    search: async () => { calls += 1; return [indexedMemory("unexpected", "must not be used")]; },
    close() {},
  };
  const disabledConfig: MemoryConfig = {
    ...config,
    embeddingRef: "memory-default",
    retrieval: { ...config.retrieval, backend: "zvec_hybrid", shadow: false, productionEnabled: false },
  };
  const memory = new MemoryService("project-test", root, disabledConfig, new ObservabilityHub(), { index });
  try {
    assert.equal(await memory.buildContext("admin", "controlled rollout"), "");
    assert.equal(calls, 0);
    const status = memory.overview("admin").retrieval;
    assert.equal(status.mode, "lexical");
    assert.equal(status.configuredBackend, "zvec_hybrid");
    assert.equal(status.rolloutEnabled, false);
    assert.match(status.lastFallbackReason ?? "", /not enabled by the global memory retrieval rollout/i);
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses Zvec results only when the project is globally enabled for active retrieval", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-active-"));
  const activeConfig: MemoryConfig = {
    ...config,
    embeddingRef: "memory-default",
    retrieval: { ...config.retrieval, backend: "zvec_hybrid", shadow: false, productionEnabled: true },
  };
  const index: MemoryIndex = { backend: "zvec_active_hybrid", search: async () => [indexedMemory("vector-result", "Zvec controlled rollout result")], close() {} };
  const memory = new MemoryService("project-test", root, activeConfig, new ObservabilityHub(), { index });
  try {
    const context = await memory.buildContext("admin", "controlled rollout");
    assert.match(context, /Zvec controlled rollout result/);
    assert.equal(memory.overview("admin").retrieval.mode, "active");
    assert.equal(memory.overview("admin").retrieval.effectiveBackend, "zvec_hybrid");
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to lexical and reports the concrete reason when an active Zvec collection is missing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-active-fallback-"));
  const activeConfig: MemoryConfig = {
    ...config,
    embeddingRef: "memory-default",
    retrieval: { ...config.retrieval, backend: "zvec_hybrid", shadow: false, productionEnabled: true, circuitBreakerFailureThreshold: 1 },
  };
  const hub = new ObservabilityHub();
  const memory = new MemoryService("project-test", root, activeConfig, hub);
  memory.setIdleResolver(() => true);
  try {
    hub.emit({ source: "orchestrator", type: "report_progress", agentId: "admin", role: AgentRoleEnum.Admin, payload: { stage: "done", message: "Lexical fallback keeps the Agent task available." } });
    assert.equal((await memory.runDream("manual")).status, "completed");
    const context = await memory.buildContext("admin", "lexical fallback");
    assert.match(context, /Lexical fallback keeps the Agent task available/);
    const status = memory.overview("admin").retrieval;
    assert.equal(status.effectiveBackend, "lexical");
    assert.equal(status.circuitState, "open");
    assert.match(status.lastFallbackReason ?? "", /No active Zvec collection/);
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps L1 bounded and reports overview for the selected owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-bounds-"));
  const boundedConfig: MemoryConfig = {
    ...config,
    l1: { maxItems: 5, completedTaskTtlHours: 1 },
  };
  const hub = new ObservabilityHub();
  const memory = new MemoryService("project-test", root, boundedConfig, hub);
  try {
    for (let index = 0; index < 8; index += 1) {
      hub.emit({
        source: "orchestrator",
        type: "report_progress",
        agentId: "admin",
        role: AgentRoleEnum.Admin,
        payload: { stage: "progress", message: `Admin observation ${index}` },
      });
    }
    hub.emit({
      source: "orchestrator",
      type: "report_progress",
      agentId: "team-a-lead",
      role: AgentRoleEnum.Leader,
      payload: { stage: "progress", message: "Leader-only observation" },
    });

    assert.equal(memory.list({ agentId: "admin", level: "L1" }).length, 5);
    assert.equal(memory.overview("admin").counts.L1, 5);
    assert.equal(memory.overview("admin").pendingEvents, 8);
    assert.equal(memory.overview("team-a-lead").counts.L1, 1);
    assert.equal(memory.overview("team-a-lead").pendingEvents, 1);
    assert.equal(memory.overview().counts.L1, 6);
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("captures completed assistant messages but ignores streaming snapshots", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-stream-"));
  const hub = new ObservabilityHub();
  const memory = new MemoryService("project-test", root, config, hub);
  const assistantMessage = { role: "assistant", content: [{ type: "text", text: "A complete durable answer" }] };
  try {
    hub.emit({ source: "pi", type: "pi.message_update", agentId: "admin", role: AgentRoleEnum.Admin, payload: { piEvent: { message: assistantMessage } } });
    assert.equal(memory.list({ agentId: "admin", level: "L1" }).length, 0);
    hub.emit({ source: "pi", type: "pi.message_end", agentId: "admin", role: AgentRoleEnum.Admin, payload: { piEvent: { message: assistantMessage } } });
    assert.equal(memory.list({ agentId: "admin", level: "L1" }).length, 1);
    assert.match(memory.list({ agentId: "admin", level: "L1" })[0]?.content ?? "", /complete durable answer/);
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs active-index maintenance continuously, isolates failures and waits for an in-flight batch on stop", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-index-scheduler-"));
  const hub = new ObservabilityHub();
  const schedulerConfig: MemoryConfig = {
    ...config,
    embeddingRef: "memory-v1",
    dream: { ...config.dream, enabled: false },
    retrieval: { ...config.retrieval, backend: "zvec_hybrid", shadow: true, productionEnabled: false },
  };
  let calls = 0;
  let closed = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const operations = {
    syncActiveOnce: async () => {
      calls += 1;
      if (calls === 1) throw new Error("api_key=must-not-leak");
      await gate;
      return undefined;
    },
    close: async () => { closed = true; },
  } as unknown as NonNullable<MemoryServiceDependencies["operations"]>;
  const index: MemoryIndex = { backend: "disabled", search: async () => undefined, close() {} };
  const memory = new MemoryService("project-test", root, schedulerConfig, hub, { operations, index, indexSyncIntervalMs: 10 });
  try {
    memory.start();
    const deadline = Date.now() + 2_000;
    while (calls < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 2);
    const failure = hub.snapshot().find(({ type }) => type === "memory.index_maintenance_failed");
    assert.ok(failure);
    assert.equal(JSON.stringify(failure).includes("must-not-leak"), false);

    const stopping = memory.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    await stopping;
    assert.equal(closed, true);
  } finally {
    release?.();
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
