import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRoleEnum } from "../types/enums";
import type { MemoryConfig } from "../types/config";
import { ObservabilityHub } from "../orchestrator/observability-hub";
import { MemoryService } from "./memory-service";

const config: MemoryConfig = {
  enabled: true,
  roles: ["admin", "leader"],
  l1: { maxItems: 10, completedTaskTtlHours: 48 },
  l2: { maxResults: 5, retentionDays: 180 },
  l3: { maxPromptItems: 5, minEvidence: 2 },
  dream: { enabled: true, idleAfterSeconds: 30, pollSeconds: 30, maxEventsPerRun: 100, cancelOnNewTask: true },
};

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
        payload: { stage: "done", message: "Project configuration and global configuration stay isolated." },
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
    assert.equal(memory.list({ agentId: "admin", level: "L2" })[0]?.sources.length, 2);
    assert.equal(memory.list({ agentId: "admin", level: "L3" }).length, 1);
    assert.equal(memory.list({ agentId: "team-a-lead", level: "L2" })[0]?.sources[0]?.agentId, "team-a-worker-0");
    const context = await memory.buildContext("admin", "project configuration");
    assert.match(context, /L3 deep memory/);
    assert.match(context, /Project configuration/);
    const promoted = memory.list({ agentId: "admin", level: "L3" })[0];
    assert.equal(memory.forget(promoted.id), true);
    assert.equal(memory.list({ agentId: "admin", level: "L3" }).length, 0);
  } finally {
    memory.stop();
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
    memory.stop();
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
    memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("captures completed assistant messages but ignores streaming snapshots", () => {
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
    memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
