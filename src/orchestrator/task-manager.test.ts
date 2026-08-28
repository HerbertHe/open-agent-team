import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRoleEnum, QueuedTaskStatusEnum, ReleaseStatusEnum } from "../types";
import { TaskManager } from "./task-manager";

test("startup gate, pause, snapshots, and recall keep queue work durable", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oat-task-manager-"));
  const prompts: Array<{ agentId: string; text: string }> = [];
  const events: Array<{ type: string }> = [];
  const manager = new TaskManager(
    {
      project: { name: "test", project_name: "Test", repo: stateDir, base_branch: "main" },
      runtime: { persistence: { state_dir: stateDir } },
      workspace: { git: {} },
      admin: { name: "Admin" },
      teams: [],
    } as never,
    {} as never,
    { sendPrompt: async (agentId: string, text: string) => { prompts.push({ agentId, text }); } } as never,
    {} as never,
    "http://127.0.0.1:1",
    {} as never,
    { emit: (event: { type: string }) => { events.push(event); } } as never,
  );

  manager.registerAgent({
    spec: { id: "admin", role: AgentRoleEnum.Admin, name: "Admin", branch: "main", workspacePath: stateDir, model: "test/model", skills: [] },
    sessionId: "admin",
    workers: [],
  });

  try {
    const original = await manager.createTask({ targetAgentId: "admin", createdBy: "operator", prompt: "Ship it" });
    assert.equal(original.status, QueuedTaskStatusEnum.Queued);
    assert.equal(manager.getTaskSchedulingState(original).reason, "startup");
    assert.equal(prompts.length, 0);

    await manager.pauseTask(original.id);
    assert.equal(original.status, QueuedTaskStatusEnum.Paused);
    assert.ok(original.snapshots?.some((snapshot) => snapshot.reason === "paused"));

    const recalled = await manager.recallTask(original.id);
    assert.equal(recalled.status, QueuedTaskStatusEnum.Queued);
    assert.equal(recalled.recalledFromTaskId, original.id);

    manager.startScheduling();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(recalled.status, QueuedTaskStatusEnum.Running);
    assert.equal(prompts.length, 1);
    assert.ok(events.some((event) => event.type === "scheduler.ready"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("delegated roots wait for delivery, prompt locks follow runtime end, and retries ignore their predecessor", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oat-task-audit-"));
  const prompts: Array<{ agentId: string; text: string }> = [];
  const manager = new TaskManager(
    {
      project: { name: "audit", project_name: "Audit", repo: stateDir, base_branch: "main" },
      runtime: { persistence: { state_dir: stateDir } },
      workspace: { git: {} },
      admin: { name: "Admin" },
      teams: [],
    } as never,
    {} as never,
    { sendPrompt: async (agentId: string, text: string) => { prompts.push({ agentId, text }); } } as never,
    {} as never,
    "http://127.0.0.1:1",
    {} as never,
    { emit: () => undefined } as never,
  );
  const adminState = {
    spec: { id: "admin", role: AgentRoleEnum.Admin, name: "Admin", branch: "main", workspacePath: stateDir, model: "test/model", skills: [] },
    sessionId: "admin", workers: [],
  } as never;
  manager.registerAgent(adminState);
  manager.registerAgent({
    spec: { id: "team-lead", role: AgentRoleEnum.Leader, name: "Leader", branch: "main", workspacePath: stateDir, model: "test/model", skills: [], teamName: "team" },
    sessionId: "team-lead", workers: [], leaderTeam: { name: "team", leader: { name: "Leader" }, worker: { total: 0 } },
  } as never);
  manager.registerAgent({
    spec: { id: "team-worker-0", role: AgentRoleEnum.Worker, name: "Worker", branch: "main", workspacePath: stateDir, model: "test/model", skills: [], teamName: "team" },
    sessionId: "team-worker-0", workers: [],
  } as never);

  try {
    const root = await manager.createTask({ targetAgentId: "admin", createdBy: "operator", prompt: "Deliver feature" }, { schedule: false });
    root.status = QueuedTaskStatusEnum.Running;
    (manager as unknown as { runningTaskByAgent: Map<string, string> }).runningTaskByAgent.set("admin", root.id);
    const delegated = await manager.assignLeaderTask("team-lead", "Implement feature");
    assert.equal(root.status, QueuedTaskStatusEnum.Waiting);
    assert.equal(root.completedAt, undefined);
    assert.equal(manager.getTasks("team-lead").find((task) => task.id === delegated.taskId)?.parentTaskId, root.id);
    assert.equal(manager.getObservabilityGraph().nodes.find((node) => node.id === "admin")?.status, "waiting");

    await (manager as unknown as { sendManagedPrompt(agentId: string, prompt: string): Promise<void> }).sendManagedPrompt("admin", "status");
    assert.equal((manager as unknown as { promptActiveAgents: Set<string> }).promptActiveAgents.has("admin"), true);
    assert.equal(manager.getObservabilityGraph().nodes.find((node) => node.id === "admin")?.status, "running");
    manager.handleRuntimeEvent("admin", { type: "agent_end", willRetry: false, messages: [] });
    assert.equal((manager as unknown as { promptActiveAgents: Set<string> }).promptActiveAgents.has("admin"), false);
    assert.equal(prompts.length, 1);

    const original = await manager.createTask({ targetAgentId: "team-worker-0", createdBy: "team-lead", parentTaskId: delegated.taskId, prompt: "First attempt", conflictKey: "src/shared.ts" }, { schedule: false });
    const retry = await manager.createTask({ targetAgentId: "team-worker-0", createdBy: "team-lead", parentTaskId: delegated.taskId, prompt: "Address review", conflictKey: "src/shared.ts" }, { schedule: false, ignoreConflictTaskId: original.id });
    assert.equal(retry.conflictKey, original.conflictKey);

    root.deliveryReports = [{ id: "delivery-release-1", taskId: delegated.taskId, agentId: "team-lead", role: AgentRoleEnum.Leader, stage: "release_submitted", summary: "", createdAt: new Date().toISOString(), releaseProposalId: "release-1" }];
    await (manager as unknown as { settleRootTaskForRelease(admin: typeof adminState, proposal: unknown, note: string): Promise<void> }).settleRootTaskForRelease(adminState, { id: "release-1", leaderId: "team-lead", teamName: "team", integrationBranch: "integration", headSha: "abc", artifactPaths: [], status: ReleaseStatusEnum.Merged, createdAt: new Date().toISOString() }, "");
    assert.equal(root.status, QueuedTaskStatusEnum.Completed);
    assert.ok(root.completedAt);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("restart preserves durable waiting workflows, review handoffs, and release linkage", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oat-task-restore-"));
  const now = new Date().toISOString();
  const schedulerDir = path.join(stateDir, "git-collaboration");
  await mkdir(schedulerDir, { recursive: true });
  await writeFile(path.join(schedulerDir, "scheduler-state.json"), JSON.stringify({
    version: 1,
    nextTaskNumber: 4,
    taskIdDate: "20260827",
    tasks: [
      { id: "root", targetAgentId: "admin", createdBy: "operator", prompt: "Root", status: "waiting", createdAt: now, updatedAt: now },
      { id: "leader", targetAgentId: "team-lead", createdBy: "admin", parentTaskId: "root", prompt: "Leader", status: "waiting", createdAt: now, updatedAt: now },
      { id: "worker", targetAgentId: "team-worker-0", createdBy: "team-lead", parentTaskId: "leader", prompt: "Worker", status: "review_pending", createdAt: now, updatedAt: now },
    ],
    queues: { admin: ["root"], "team-lead": ["leader"] },
    leaderEvents: [{ id: "event-1", leaderId: "team-lead", taskId: "worker", reviewId: "review-1", type: "worker_review_ready", status: "leased", createdAt: now, updatedAt: now, deliveryAttempts: 1, leaseExpiresAt: now }],
    releasesByLeaderTask: { leader: "release-1" },
  }), "utf8");
  const manager = new TaskManager(
    { project: { name: "restore", project_name: "Restore", repo: stateDir, base_branch: "main" }, runtime: { persistence: { state_dir: stateDir } }, workspace: { git: {} }, admin: { name: "Admin" }, teams: [{ name: "team", leader: { name: "Leader" }, worker: { total: 1 } }] } as never,
    {} as never, { sendPrompt: async () => undefined } as never, {} as never,
    "http://127.0.0.1:1", {} as never, { emit: () => undefined } as never,
  );
  manager.registerAgent({ spec: { id: "admin", role: AgentRoleEnum.Admin }, sessionId: "admin", workers: [] } as never);
  manager.registerAgent({ spec: { id: "team-lead", role: AgentRoleEnum.Leader, teamName: "team" }, sessionId: "team-lead", workers: [], leaderTeam: { name: "team", leader: { name: "Leader" }, worker: { total: 1 } } } as never);
  try {
    await (manager as unknown as { restoreSchedulerState(): Promise<void> }).restoreSchedulerState();
    assert.equal(manager.getTasks().find((task) => task.id === "root")?.status, QueuedTaskStatusEnum.Waiting);
    assert.equal(manager.getTasks().find((task) => task.id === "leader")?.status, QueuedTaskStatusEnum.Waiting);
    assert.equal(manager.getTasks().find((task) => task.id === "worker")?.status, QueuedTaskStatusEnum.ReviewPending);
    assert.equal((manager as unknown as { leaderEventsById: Map<string, { status: string; leaseExpiresAt?: string }> }).leaderEventsById.get("event-1")?.status, "pending");
    assert.equal((manager as unknown as { releaseByLeaderTask: Map<string, string> }).releaseByLeaderTask.get("leader"), "release-1");
    await manager.flushSchedulerState();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
