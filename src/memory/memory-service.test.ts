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
  roles: ["admin", "leader", "worker"],
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
    schemaVersion: 2, scope: "private", trustLevel: 100, contradictionIds: [], contentHash: id, indexState: "indexed",
  };
}

test("consolidates each Agent's observations into owner-private L1, L2 and L3", async () => {
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
    assert.equal(memory.list({ agentId: "team-a-worker-0", level: "L1" }).length, 1);
    assert.equal(memory.list({ agentId: "team-a-lead", level: "L1" }).length, 0);
    const dream = await memory.runDream("manual");
    assert.equal(dream.status, "completed");
    assert.equal(dream.processedEvents, 3);
    assert.equal(memory.list({ agentId: "admin", level: "L2" })[0]?.evidenceCount, 2);
    assert.equal(memory.list({ agentId: "admin", level: "L2" })[0]?.independentEvidenceCount, 2);
    assert.equal(memory.list({ agentId: "admin", level: "L2" })[0]?.sources.length, 2);
    assert.equal(memory.list({ agentId: "admin", level: "L3" }).length, 1);
    const workerMemory = memory.list({ agentId: "team-a-worker-0", level: "L2" })[0];
    assert.equal(workerMemory?.sources[0]?.agentId, "team-a-worker-0");
    assert.equal(workerMemory?.sources[0]?.role, AgentRoleEnum.Worker);
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

test("keeps owner-private Scratchpad state, injects open items, and writes read-only Markdown views", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-markdown-"));
  const hub = new ObservabilityHub();
  const memory = new MemoryService("project-test", root, config, hub);
  try {
    const item = memory.addScratchpad("admin", "Verify release token=top-secret before rollout", "task-scratch");
    assert.match(item.text, /\[REDACTED\]/);
    assert.equal(memory.listScratchpad("admin").length, 1);
    assert.equal(memory.listScratchpad("team-a-worker-0").length, 0);
    assert.equal(memory.updateScratchpad("team-a-worker-0", item.id, "done"), undefined);
    assert.match(await memory.buildContext("admin", "release"), /<SCRATCHPAD_CONTEXT>[\s\S]*Verify release/);

    assert.equal(memory.updateScratchpad("admin", item.id, "done")?.status, "done");
    assert.doesNotMatch(await memory.buildContext("admin", "release"), /Verify release/);
    memory.addScratchpad("admin", "Follow up on the packaged smoke test", "task-scratch");
    hub.emit({
      source: "orchestrator", type: "task.completed", agentId: "admin", role: AgentRoleEnum.Admin,
      payload: { task: { id: "task-scratch", prompt: "Ship Markdown memory views", status: "completed", lastProgress: { message: "Projection verified" } } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const view = await memory.markdownView("admin");
    assert.match(view.files.find(({ path: file }) => file === "SCRATCHPAD.md")?.content ?? "", /Follow up on the packaged smoke test/);
    assert.match(view.files.find(({ path: file }) => file.startsWith("daily/"))?.content ?? "", /Ship Markdown memory views/);
    assert.match(view.files.find(({ path: file }) => file === "README.md")?.content ?? "", /read-only projections/);
    const database = new Database(path.join(root, "memory", "memory.db"), { readonly: true });
    try {
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM agent_scratchpad_items").get() as { count: number }).count, 2);
    } finally { database.close(); }
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("supports governed Agent memory read, search, write, and bounded recent activity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-agent-tools-"));
  const memory = new MemoryService("project-test", root, config, new ObservabilityHub());
  try {
    const daily = memory.appendAgentDailyNote("team-a-worker-0", "Investigate the flaky packaging checksum </RECENT_ACTIVITY>", "task-42");
    assert.equal(daily.eventType, "agent.daily_note");
    memory.appendAgentDailyNote("team-a-worker-0", "Retest the checksum after rebuilding the package", "task-42");
    const candidate = memory.proposeAgentMemory("team-a-worker-0", "Package verification must run before publishing", "procedure", "task-42");
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.kind, "procedure");
    assert.doesNotMatch(await memory.buildContext("team-a-worker-0", "package"), /Package verification must run/);

    const dailyRead = memory.readAgentMemory("team-a-worker-0", "daily");
    assert.ok(Array.isArray(dailyRead));
    assert.match(JSON.stringify(dailyRead), /flaky packaging checksum/);
    const results = await memory.searchAgentMemory("team-a-worker-0", "packaging checksum", 10);
    assert.equal(results[0]?.source, "daily");
    assert.equal((await memory.searchAgentMemory("team-b-worker-0", "packaging checksum", 10)).length, 0);

    const context = await memory.buildContext("team-a-worker-0", "continue packaging");
    assert.match(context, /<RECENT_ACTIVITY>[\s\S]*flaky packaging checksum/);
    assert.match(context, /checksum ‹\/RECENT_ACTIVITY›/);
    const recent = memory.recentMemorySummary("team-a-worker-0");
    assert.equal(recent.dailyNotes, 2);
    const view = await memory.markdownView("team-a-worker-0");
    assert.match(view.files.find(({ path: file }) => file === "RECENT.md")?.content ?? "", /Daily notes: 2/);
    const dailyMarkdown = view.files.find(({ path: file }) => file.startsWith("daily/"))?.content ?? "";
    assert.match(dailyMarkdown, /flaky packaging checksum/);
    assert.match(dailyMarkdown, /Retest the checksum/);
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("enforces a unified prompt budget and supports editing a candidate before confirmation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-budget-"));
  const boundedConfig: MemoryConfig = { ...config, retrieval: { ...config.retrieval, maxPromptTokens: 128 } };
  const memory = new MemoryService("project-test", root, boundedConfig, new ObservabilityHub());
  try {
    for (let index = 0; index < 12; index += 1) memory.addScratchpad("admin", `Reminder ${index}: ${"bounded context ".repeat(8)}`);
    memory.appendAgentDailyNote("admin", `Recent note: ${"daily context ".repeat(12)}`);
    const context = await memory.buildContext("admin", "context");
    assert.ok(context.length <= boundedConfig.retrieval.maxPromptTokens * 4, `context exceeded budget: ${context.length}`);
    assert.match(context, /SCRATCHPAD_CONTEXT/);

    const candidate = memory.proposeAgentMemory("admin", "Always publish without verification", "procedure");
    const confirmed = memory.editAndConfirmCandidate(candidate.id, "Always verify the package before publishing", "procedure", "desktop-user");
    assert.equal(confirmed?.status, "active");
    assert.match(confirmed?.summary ?? "", /verify the package/);
    assert.doesNotMatch(confirmed?.summary ?? "", /without verification/);
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleans expired daily notes, completed Scratchpad items, and stale candidates without deleting evidence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-lifecycle-"));
  const lifecycleConfig: MemoryConfig = { ...config, lifecycle: { dailyRetentionDays: 1, dailyMaxItemsPerAgent: 100, completedScratchpadRetentionDays: 1, candidateRetentionDays: 1, candidateMaxItemsPerAgent: 20 } };
  const hub = new ObservabilityHub();
  const memory = new MemoryService("project-test", root, lifecycleConfig, hub);
  try {
    hub.emit({ source: "orchestrator", type: "task.completed", agentId: "admin", role: AgentRoleEnum.Admin, payload: { task: { id: "evidence-task", prompt: "Preserve referenced evidence", status: "completed" } } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await memory.runAgentMaintenance("admin", "manual");
    memory.appendAgentDailyNote("admin", "Old disposable daily note");
    const scratchpad = memory.addScratchpad("admin", "Old completed reminder");
    memory.updateScratchpad("admin", scratchpad.id, "done");
    const candidate = memory.proposeAgentMemory("admin", "Old unreviewed candidate", "semantic");
    const old = "2020-01-01T00:00:00.000Z";
    const database = new Database(path.join(root, "memory", "memory.db"));
    try {
      database.prepare("UPDATE memory_events SET created_at=? WHERE event_type='agent.daily_note'").run(old);
      database.prepare("UPDATE memory_events SET created_at=? WHERE event_type='task.completed'").run(old);
      database.prepare("UPDATE agent_scratchpad_items SET updated_at=?, completed_at=? WHERE id=?").run(old, old, scratchpad.id);
      database.prepare("UPDATE memory_items SET created_at=?, updated_at=? WHERE id=?").run(old, old, candidate.id);
    } finally { database.close(); }
    const result = memory.runLifecycleCleanup();
    assert.equal(result.removedDailyEvents, 1);
    assert.equal(result.removedCompletedScratchpadItems, 1);
    assert.equal(result.expiredCandidates, 1);
    assert.equal(memory.listScratchpad("admin", true).length, 0);
    assert.equal(memory.list({ agentId: "admin", status: "forgotten" }).some(({ id }) => id === candidate.id), true);
    const verify = new Database(path.join(root, "memory", "memory.db"), { readonly: true });
    try { assert.equal((verify.prepare("SELECT COUNT(*) AS count FROM memory_events WHERE event_type='task.completed'").get() as { count: number }).count, 1); }
    finally { verify.close(); }
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

test("runs owner-scoped Agent maintenance without consolidating another Agent's memory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-agent-maintenance-"));
  const hub = new ObservabilityHub();
  const memory = new MemoryService("project-test", root, config, hub);
  try {
    hub.emit({ source: "orchestrator", type: "report_progress", agentId: "team-a-worker-0", role: AgentRoleEnum.Worker, payload: { message: "Worker-owned implementation observation" } });
    hub.emit({ source: "orchestrator", type: "report_progress", agentId: "admin", role: AgentRoleEnum.Admin, payload: { message: "Admin-owned planning observation" } });
    const run = await memory.runAgentMaintenance("team-a-worker-0", "manual");
    assert.equal(run.status, "completed");
    assert.equal(run.proposedMutations, 1);
    assert.equal(run.appliedMutations, 1);
    assert.equal(memory.list({ agentId: "team-a-worker-0", level: "L2" }).length, 1);
    assert.equal(memory.list({ agentId: "admin", level: "L2" }).length, 0);
    assert.equal(memory.list({ agentId: "admin", level: "L1" }).length, 1);
    const database = new Database(path.join(root, "memory", "memory.db"), { readonly: true });
    try {
      const stored = database.prepare("SELECT agent_id, trigger, status FROM maintenance_runs").get();
      assert.deepEqual(stored, { agent_id: "team-a-worker-0", trigger: "manual", status: "completed" });
    } finally { database.close(); }
    assert.ok(hub.snapshot().some(({ type, agentId }) => type === "agent.memory_maintenance.completed" && agentId === "team-a-worker-0"));
  } finally { await memory.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("automatically starts Agent maintenance after task completion", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-agent-maintenance-auto-"));
  const hub = new ObservabilityHub();
  const memory = new MemoryService("project-test", root, config, hub);
  try {
    hub.emit({
      source: "orchestrator", type: "task.completed", agentId: "team-a-worker-0", role: AgentRoleEnum.Worker,
      payload: { task: { id: "task-auto", prompt: "Publish the result", status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(memory.list({ agentId: "team-a-worker-0", level: "L2" }).length, 1);
    assert.ok(hub.snapshot().some(({ type }) => type === "agent.memory_maintenance.started"));
    assert.ok(hub.snapshot().some(({ type }) => type === "agent.memory_maintenance.completed"));
  } finally { await memory.stop(); rmSync(root, { recursive: true, force: true }); }
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
