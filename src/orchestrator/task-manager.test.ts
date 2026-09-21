import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRoleEnum, QueuedTaskStatusEnum, ReleaseStatusEnum, ReviewStatusEnum } from "../types";
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

    await manager.reportProgress({ agentId: "admin", stage: "user_response", message: "Durable answer" });
    assert.equal(recalled.finalResponse?.content, "Durable answer");
    assert.equal(recalled.finalResponse?.state, "complete");
    manager.handleRuntimeEvent("admin", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Final runtime answer" }] },
    }, {
      schemaVersion: 1, kind: "message.completed", taskId: recalled.id, runId: "run-1", turnId: "turn-1", messageId: "message-1", seq: 2,
    });
    assert.equal(recalled.finalResponse?.content, "Final runtime answer");
    assert.equal(recalled.finalResponse?.messageId, "message-1");
    assert.equal(recalled.finalResponse?.revision, 2);
    await manager.flushSchedulerState();
    const persisted = JSON.parse(await readFile(path.join(stateDir, "git-collaboration", "scheduler-state.json"), "utf8")) as { tasks: Array<{ id: string; finalResponse?: { content: string } }> };
    assert.equal(persisted.tasks.find((task) => task.id === recalled.id)?.finalResponse?.content, "Final runtime answer");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("injects private memory and structured shared-knowledge citations into a managed prompt", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oat-task-knowledge-"));
  const prompts: string[] = [];
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const reference = {
    documentId: "knowledge:chunk-1", sourceId: "source-1", chunkId: "chunk-1", path: "knowledge/project/guide.md",
    title: "Release guide", visibility: "project", contentHash: "hash-1", lineStart: 4, lineEnd: 8,
  } as const;
  const manager = new TaskManager(
    {
      project: { name: "knowledge-project", project_name: "Knowledge", repo: stateDir, base_branch: "main" },
      runtime: { persistence: { state_dir: stateDir } }, workspace: { git: {} }, admin: { name: "Admin" }, teams: [],
    } as never,
    {} as never,
    { sendPrompt: async (_agentId: string, text: string) => { prompts.push(text); } } as never,
    {} as never,
    "http://127.0.0.1:1",
    {} as never,
    { emit: (event: { type: string; payload?: Record<string, unknown> }) => { events.push(event); } } as never,
    { buildContext: async () => "<MEMORY_CONTEXT>\n- [decision] private fact\n</MEMORY_CONTEXT>" } as never,
    { buildContext: async () => ({ context: "<KNOWLEDGE_CONTEXT>\n[K1] release guide\n</KNOWLEDGE_CONTEXT>", references: [reference] }) } as never,
  );
  manager.registerAgent({ spec: { id: "admin", role: AgentRoleEnum.Admin, name: "Admin", branch: "main", workspacePath: stateDir, model: "test/model", skills: [] }, sessionId: "admin", workers: [] });
  try {
    const task = await manager.createTask({ targetAgentId: "admin", createdBy: "operator", prompt: "Prepare release" }, { schedule: false });
    task.status = QueuedTaskStatusEnum.Running;
    (manager as unknown as { runningTaskByAgent: Map<string, string> }).runningTaskByAgent.set("admin", task.id);
    await (manager as unknown as { sendManagedPrompt(agentId: string, prompt: string): Promise<void> }).sendManagedPrompt("admin", task.prompt);
    assert.match(prompts[0] ?? "", /<MEMORY_CONTEXT>[\s\S]*<KNOWLEDGE_CONTEXT>[\s\S]*Prepare release/);
    assert.deepEqual(task.knowledgeReferences, [reference]);
    assert.deepEqual(task.memoryReferences, ["[decision] private fact"]);
    assert.ok(events.some(({ type, payload }) => type === "knowledge.context.injected" && Array.isArray(payload?.references)));
  } finally { await rm(stateDir, { recursive: true, force: true }); }
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

    const recordDeliveryReport = (manager as unknown as { recordDeliveryReport(task: typeof original, report: any): void }).recordDeliveryReport.bind(manager);
    recordDeliveryReport(original, { id: "delivery-review-1", taskId: original.id, agentId: "team-worker-0", recipientAgentId: "team-lead", role: AgentRoleEnum.Worker, stage: "review_submitted", summary: "Worker evidence", createdAt: new Date().toISOString(), reviewId: "review-1", reviewStatus: ReviewStatusEnum.Merged, reviewNote: "Approved by Leader" });
    assert.equal(original.deliveryReports?.at(-1)?.agentId, "team-worker-0");
    assert.equal(manager.getTasks("team-lead").find((task) => task.id === delegated.taskId)?.deliveryReports?.at(-1)?.agentId, "team-worker-0");
    assert.equal(root.deliveryReports, undefined, "Worker report must stop at the direct Leader task until Leader approves upward reporting");

    const leaderTask = manager.getTasks("team-lead").find((task) => task.id === delegated.taskId)!;
    const internals = manager as unknown as {
      runningTaskByAgent: Map<string, string>;
      currentWorkflowTaskId(agentId: string): string | undefined;
      parkLeaderWorkflowAfterPrompt(agentId: string): Promise<void>;
      markReviewSubmitted(task: typeof original, review: any): void;
    };
    original.status = QueuedTaskStatusEnum.ReviewPending;
    internals.markReviewSubmitted(original, { id: "review-progress", leaderId: "team-lead" });
    assert.equal(original.lastProgress?.stage, "review_submitted", "submit-review must update the Worker task after ownership is released");

    leaderTask.status = QueuedTaskStatusEnum.Running;
    internals.runningTaskByAgent.set("team-lead", leaderTask.id);
    original.status = QueuedTaskStatusEnum.Completed;
    retry.status = QueuedTaskStatusEnum.Cancelled;
    await internals.parkLeaderWorkflowAfterPrompt("team-lead");
    assert.equal(internals.currentWorkflowTaskId("team-lead"), leaderTask.id, "the last reviewed child must keep Leader context for release submission");
    original.status = QueuedTaskStatusEnum.ReviewPending;
    await internals.parkLeaderWorkflowAfterPrompt("team-lead");
    assert.equal(internals.currentWorkflowTaskId("team-lead"), undefined, "Leader context is parked only after the prompt ends with unfinished children");
    assert.equal(leaderTask.status, QueuedTaskStatusEnum.Waiting);

    (manager as unknown as { promoteReviewedReportsToAdmin(task: typeof leaderTask): void }).promoteReviewedReportsToAdmin(leaderTask);
    recordDeliveryReport(leaderTask, { id: "delivery-release-upstream", taskId: leaderTask.id, agentId: "team-lead", recipientAgentId: "admin", role: AgentRoleEnum.Leader, stage: "release_submitted", summary: "Leader aggregate", createdAt: new Date().toISOString(), releaseProposalId: "release-upstream" });
    const rootAfterLeaderReport = manager.getTasks("admin").find((task) => task.id === root.id);
    assert.equal(rootAfterLeaderReport?.deliveryReports?.[0]?.agentId, "team-worker-0", "Admin must see the reviewed Worker report after Leader reports upward");
    assert.equal(rootAfterLeaderReport?.deliveryReports?.at(-1)?.agentId, "team-lead", "Leader aggregate must reach the Admin root task");

    root.deliveryReports = [{ id: "delivery-release-1", taskId: delegated.taskId, agentId: "team-lead", role: AgentRoleEnum.Leader, stage: "release_submitted", summary: "", createdAt: new Date().toISOString(), releaseProposalId: "release-1" }];
    await (manager as unknown as { settleRootTaskForRelease(admin: typeof adminState, proposal: unknown, note: string): Promise<void> }).settleRootTaskForRelease(adminState, { id: "release-1", leaderId: "team-lead", teamName: "team", integrationBranch: "integration", headSha: "abc", artifactPaths: [], status: ReleaseStatusEnum.Merged, createdAt: new Date().toISOString() }, "");
    assert.equal(root.status, QueuedTaskStatusEnum.Completed);
    assert.ok(root.completedAt);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("model execution errors fail only the current task and keep the Agent schedulable", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "oat-task-runtime-error-"));
  const prompts: Array<{ agentId: string; text: string }> = [];
  const events: Array<{ type: string }> = [];
  let resetCount = 0;
  const manager = new TaskManager(
    {
      project: { name: "runtime-error", project_name: "Runtime error", repo: stateDir, base_branch: "main" },
      runtime: { persistence: { state_dir: stateDir } },
      workspace: { git: {} },
      admin: { name: "Admin" },
      teams: [],
    } as never,
    {} as never,
    {
      sendPrompt: async (agentId: string, text: string) => { prompts.push({ agentId, text }); },
      resetSession: async () => { resetCount += 1; },
    } as never,
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
    const failed = await manager.createTask({ targetAgentId: "admin", createdBy: "operator", prompt: "First task" }, { schedule: false });
    const next = await manager.createTask({ targetAgentId: "admin", createdBy: "operator", prompt: "Second task" }, { schedule: false });
    const orphan = await manager.createTask({ targetAgentId: "admin", createdBy: "admin", parentTaskId: failed.id, prompt: "Unstarted child" }, { schedule: false });
    failed.status = QueuedTaskStatusEnum.Running;
    (manager as unknown as { runningTaskByAgent: Map<string, string> }).runningTaskByAgent.set("admin", failed.id);
    (manager as unknown as { promptActiveAgents: Set<string> }).promptActiveAgents.add("admin");
    manager.startScheduling();

    manager.handleRuntimeEvent("admin", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Partial answer before failure" },
    }, {
      schemaVersion: 1, kind: "content.delta", taskId: failed.id, runId: "run-failed", turnId: "turn-failed", messageId: "message-failed", blockIndex: 0, seq: 1,
    });
    manager.handleRuntimeEvent("admin", {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "402: Insufficient Balance" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(failed.status, QueuedTaskStatusEnum.Failed);
    assert.equal(failed.error, "402: Insufficient Balance");
    assert.equal(failed.finalResponse?.content, "Partial answer before failure");
    assert.equal(failed.finalResponse?.state, "partial");
    assert.equal((manager as unknown as { promptActiveAgents: Set<string> }).promptActiveAgents.has("admin"), true, "the next task owns the prompt lock");
    assert.equal((manager as unknown as { crashedAgents: Set<string> }).crashedAgents.has("admin"), false);
    assert.equal(next.status, QueuedTaskStatusEnum.Running);
    assert.equal(orphan.status, QueuedTaskStatusEnum.Cancelled);
    assert.match(orphan.error ?? "", /Owning task failed/);
    assert.equal(prompts.length, 1);
    assert.equal(resetCount, 0);
    assert.ok(events.some((event) => event.type === "agent.execution_failed"));
    assert.ok(!events.some((event) => event.type === "agent.crash"));
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
      { id: "root", targetAgentId: "admin", createdBy: "operator", prompt: "Root", status: "waiting", createdAt: now, updatedAt: now, lastProgress: { stage: "user_response", message: "Legacy durable answer", at: now } },
      { id: "leader", targetAgentId: "team-lead", createdBy: "admin", parentTaskId: "root", prompt: "Leader", status: "waiting", createdAt: now, updatedAt: now },
      { id: "worker", targetAgentId: "team-worker-0", createdBy: "team-lead", parentTaskId: "leader", prompt: "Worker", status: "review_pending", createdAt: now, updatedAt: now },
      { id: "root-stranded", targetAgentId: "admin", createdBy: "operator", prompt: "Stranded root", status: "waiting", createdAt: now, updatedAt: now },
      { id: "leader-stranded", targetAgentId: "team-lead", createdBy: "admin", parentTaskId: "root-stranded", prompt: "Stranded leader", status: "waiting", createdAt: now, updatedAt: now },
      { id: "worker-reviewed", targetAgentId: "team-worker-0", createdBy: "team-lead", parentTaskId: "leader-stranded", prompt: "Reviewed worker", status: "completed", createdAt: now, updatedAt: now },
    ],
    queues: { admin: ["root", "root-stranded"], "team-lead": ["leader", "leader-stranded"] },
    leaderEvents: [
      { id: "event-1", leaderId: "team-lead", taskId: "worker", reviewId: "review-1", type: "worker_review_ready", status: "leased", createdAt: now, updatedAt: now, deliveryAttempts: 1, leaseExpiresAt: now },
      { id: "event-stranded", leaderId: "team-lead", taskId: "worker-reviewed", reviewId: "review-reviewed", type: "worker_review_ready", status: "acknowledged", createdAt: now, updatedAt: now, deliveryAttempts: 1 },
    ],
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
    assert.equal(manager.getTasks().find((task) => task.id === "root")?.finalResponse?.content, "Legacy durable answer");
    assert.equal(manager.getTasks().find((task) => task.id === "leader")?.status, QueuedTaskStatusEnum.Waiting);
    assert.equal(manager.getTasks().find((task) => task.id === "worker")?.status, QueuedTaskStatusEnum.ReviewPending);
    assert.equal((manager as unknown as { leaderEventsById: Map<string, { status: string; leaseExpiresAt?: string }> }).leaderEventsById.get("event-1")?.status, "pending");
    assert.equal((manager as unknown as { leaderEventsById: Map<string, { status: string; leaseExpiresAt?: string }> }).leaderEventsById.get("event-stranded")?.status, "pending", "a reviewed workflow without a release must resume Leader reporting after restart");
    assert.equal((manager as unknown as { releaseByLeaderTask: Map<string, string> }).releaseByLeaderTask.get("leader"), "release-1");
    await manager.flushSchedulerState();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
