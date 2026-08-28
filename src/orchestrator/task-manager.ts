import path from "node:path";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import {
  AgentRoleEnum,
  DockerNetworkModeEnum,
  LeaderInboxEventStatusEnum,
  LeaderInboxEventTypeEnum,
  QueuedTaskStatusEnum,
  ReleaseStatusEnum,
  RuntimeModeEnum,
  ReviewStatusEnum,
  ReviewTestStatusEnum,
  WorkerSkillSyncEnum,
} from "../types";
import type { ResolvedConfig, AgentInstanceSpec, TeamConfig, SkillEntry } from "../types";
import type { WorkspaceProvider } from "../sandbox/interface";
import type { PiSessionProvider } from "../sandbox/local-process";
import { DockerSessionProvider } from "../sandbox/docker-process";
import { MergeManager } from "../git/merge-manager";
import { setLocalGitIdentity, setWorktreePushPermission, commitWorkspaceChanges } from "../git/git-identity";
import { SkillResolver } from "../skills/skill-resolver";
import { ChangelogManager } from "../changelog/changelog-manager";
import {
  writeAgentWorkspaceConfig,
  buildAgentSystemPrompt,
  type OatWorkspaceScopeContext,
} from "../pi/workspace-inject";
import { logger } from "../utils/logger";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { rewriteModelProviderByCompatibleType } from "../utils/model-utils";
import { todayRecordsSubPath } from "../utils/records";
import { t } from "../i18n/i18n";
import { Type } from "typebox";
import type {
  AgentRuntimeState,
  AgentGitStatus,
  GitConfigurationUpdate,
  GitManagementStatus,
  GitTaskArtifact,
  NotifyCompleteBody,
  QueuedTask,
  ReleaseProposal,
  ReviewRequest,
  SpawnWorkersResult,
  TaskDeliveryReport,
  ToolCreateTaskBody,
  ToolDispatchWorkerTasksBody,
  ToolRegisterWorkersBody,
  ToolUpdateTaskBody,
} from "../types";
import type { ObservabilityGraph } from "../types";
import type { ObservabilityHub } from "./observability-hub";
import type { MemoryService } from "../memory/memory-service";
import { GitCollaborationStore } from "./git-collaboration-store";

type SchedulerSnapshot = {
  version: 1;
  nextTaskNumber: number;
  taskIdDate: string;
  tasks: QueuedTask[];
  queues: Record<string, string[]>;
  leaderEvents: LeaderInboxEvent[];
  releasesByLeaderTask?: Record<string, string>;
};

type LeaderInboxEvent = {
  id: string;
  leaderId: string;
  taskId: string;
  reviewId: string;
  type: LeaderInboxEventTypeEnum;
  status: LeaderInboxEventStatusEnum;
  createdAt: string;
  updatedAt: string;
  deliveryAttempts: number;
  leaseExpiresAt?: string;
  error?: string;
};

const TASK_STATUSES = new Set<string>(Object.values(QueuedTaskStatusEnum));
const EVENT_STATUSES = new Set<string>(Object.values(LeaderInboxEventStatusEnum));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class TaskManager {
  private readonly agents = new Map<string, AgentRuntimeState>();
  private readonly teamByLeaderId = new Map<string, TeamConfig>();
  private readonly leaderTaskAssignedAt = new Map<string, number>();
  private readonly leaderDispatchStartedAt = new Map<string, number>();
  private readonly workerNotifyCompleteAt = new Map<string, number>();
  /**
   * Worker 忙碌状态：用于避免在同一 Worker 仍在执行时重复下发任务。
   * - set：在 dispatchWorkerTasks 下发任务时写入
   * - delete：在 notify-complete（成功）/ crash / cleanup / resetSession（开始新一轮前）时清除
   */
  private readonly workerBusy = new Map<
    string,
    { leaderId: string; taskIndex: number; startedAt: number }
  >();
  /** 每个 Agent 独立 FIFO 队列；当前运行项也保留在 taskById 中。 */
  private readonly taskById = new Map<string, QueuedTask>();
  private readonly taskQueueByAgent = new Map<string, string[]>();
  private readonly runningTaskByAgent = new Map<string, string>();
  /** Most recently completed workflow, used only to make a retried completion idempotent. */
  private readonly lastCompletedWorkflowByAgent = new Map<string, string>();
  /** Coalesces deferred scheduling until the current runtime tool result is returned. */
  private readonly pendingScheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Prevents a newly freed queue slot from starting inside the prior prompt turn. */
  private readonly promptActiveAgents = new Set<string>();
  /** Startup gate: restored queues may run only after the complete Agent pool exists. */
  private schedulingEnabled = false;
  private schedulerPersistenceTail: Promise<void> = Promise.resolve();
  private readonly leaderEventsById = new Map<string, LeaderInboxEvent>();
  private nextTaskNumber = 1;
  private taskIdDate = "";
  private readonly gitStore: GitCollaborationStore;
  private readonly releaseByLeaderTask = new Map<string, string>();
  private releaseTail: Promise<void> = Promise.resolve();
  /** 已触发过崩溃通知的 agentId 集合，防止重复推送。 */
  private readonly crashedAgents = new Set<string>();
  /** A single controlled restart clears transient runtime crashes without retry loops. */
  private readonly recoveringAgents = new Set<string>();

  constructor(
    private readonly config: ResolvedConfig,
    private readonly workspaceProvider: WorkspaceProvider,
    private readonly runtimeProvider: PiSessionProvider | DockerSessionProvider,
    private readonly mergeManager: MergeManager,
    private readonly orchestratorBaseUrl: string,
    private readonly skillResolver: SkillResolver,
    private readonly observabilityHub: ObservabilityHub,
    private readonly memoryService?: MemoryService,
  ) {
    this.gitStore = new GitCollaborationStore(config.runtime.persistence.state_dir);
  }

  getObservabilityHub(): ObservabilityHub {
    return this.observabilityHub;
  }

  getAllAgents(): AgentRuntimeState[] {
    return Array.from(this.agents.values());
  }

  isSystemIdle(): boolean {
    return this.promptActiveAgents.size === 0 && !this.getTasks().some((task) =>
      task.status === QueuedTaskStatusEnum.Queued ||
      task.status === QueuedTaskStatusEnum.Running ||
      task.status === QueuedTaskStatusEnum.Waiting ||
      task.status === QueuedTaskStatusEnum.ReviewPending
    );
  }

  getDockerRuntimeStatus(): { mode: RuntimeModeEnum; image?: string; network?: DockerNetworkModeEnum; containers: ReturnType<DockerSessionProvider["listRuntimeEntries"]> } {
    if (!(this.runtimeProvider instanceof DockerSessionProvider)) return { mode: RuntimeModeEnum.LocalProcess, containers: [] };
    return { mode: RuntimeModeEnum.Docker, image: this.config.runtime.docker?.image, network: this.config.runtime.docker?.network, containers: this.runtimeProvider.listRuntimeEntries() };
  }

  async restartDockerAgent(agentId: string): Promise<{ ok: true }> {
    if (!(this.runtimeProvider instanceof DockerSessionProvider)) throw new Error(t("docker_runtime_not_enabled"));
    this.getAgent(agentId);
    const active = this.getTasks(agentId).some((task) => task.status === QueuedTaskStatusEnum.Running || task.status === QueuedTaskStatusEnum.Waiting || task.status === QueuedTaskStatusEnum.ReviewPending);
    if (active || this.promptActiveAgents.has(agentId)) throw new Error(t("docker_agent_restart_busy", { agentId }));
    await this.runtimeProvider.resetSession(agentId);
    this.crashedAgents.delete(agentId);
    this.promptActiveAgents.delete(agentId);
    this.observabilityHub.emit({ source: "orchestrator", type: "docker.agent.restarted", agentId, role: this.getAgent(agentId).spec.role, payload: {} });
    this.requestSchedule(agentId);
    return { ok: true };
  }

  handleRuntimeEvent(agentId: string, event: { type?: unknown; willRetry?: unknown; messages?: unknown }): void {
    if (event.type === "agent_start") {
      this.promptActiveAgents.add(agentId);
      return;
    }
    if (event.type !== "agent_end") return;
    const terminalError = event.willRetry === false && Array.isArray(event.messages) && [...event.messages].reverse().some((message) =>
      isRecord(message) && message.role === "assistant" && message.stopReason === "error",
    );
    if (terminalError) return;
    this.promptActiveAgents.delete(agentId);
    if (!this.runningTaskByAgent.has(agentId)) this.requestSchedule(agentId);
  }

  getTasks(agentId?: string): QueuedTask[] {
    const queueOrder = new Map<string, number>();
    for (const queue of this.taskQueueByAgent.values()) queue.forEach((id, index) => queueOrder.set(id, index));
    return Array.from(this.taskById.values())
      .filter((task) => !agentId || task.targetAgentId === agentId)
      .sort((a, b) => a.targetAgentId === b.targetAgentId
        ? (queueOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (queueOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        : a.createdAt.localeCompare(b.createdAt));
  }

  getTaskSchedulingState(task: QueuedTask): { runnable: boolean; reason?: string } {
    if (task.status !== QueuedTaskStatusEnum.Queued) return { runnable: false, reason: task.status };
    if (!this.schedulingEnabled) return { runnable: false, reason: "startup" };
    if (this.crashedAgents.has(task.targetAgentId)) return { runnable: false, reason: "agent_crashed" };
    const agent = this.agents.get(task.targetAgentId);
    if (!agent) return { runnable: false, reason: "agent_missing" };
    if (this.promptActiveAgents.has(task.targetAgentId)) return { runnable: false, reason: "agent_prompt_active" };
    const runningTaskId = this.runningTaskByAgent.get(task.targetAgentId);
    if (runningTaskId) return { runnable: false, reason: `waiting_for:${runningTaskId}` };
    const firstQueued = (this.taskQueueByAgent.get(task.targetAgentId) ?? [])
      .find((id) => this.taskById.get(id)?.status === QueuedTaskStatusEnum.Queued);
    if (firstQueued !== task.id) return { runnable: false, reason: `behind:${firstQueued ?? "unknown"}` };
    if (agent.spec.role === AgentRoleEnum.Leader && agent.leaderTeam) {
      const missing = Array.from({ length: agent.leaderTeam.worker.total }, (_, index) => `${agent.leaderTeam!.name}-worker-${index}`)
        .filter((id) => this.agents.get(id)?.spec.role !== AgentRoleEnum.Worker);
      if (missing.length) return { runnable: false, reason: `workers_missing:${missing.join(",")}` };
    }
    return { runnable: true };
  }

  getTasksWithSchedulingState(agentId?: string): Array<QueuedTask & { scheduling: { runnable: boolean; reason?: string } }> {
    return this.getTasks(agentId).map((task) => ({ ...task, scheduling: this.getTaskSchedulingState(task) }));
  }

  getTaskSnapshots(id: string): NonNullable<QueuedTask["snapshots"]> {
    const task = this.taskById.get(id);
    if (!task) throw new Error(t("scheduler_task_not_found", { taskId: id }));
    return structuredClone(task.snapshots ?? []);
  }

  private checkpointTask(task: QueuedTask, reason: NonNullable<QueuedTask["snapshots"]>[number]["reason"]): void {
    const snapshot = {
      id: `snapshot-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      reason,
      status: task.status,
      prompt: task.prompt,
      progress: task.lastProgress ? structuredClone(task.lastProgress) : undefined,
      error: task.error,
      git: task.git ? structuredClone(task.git) : undefined,
    };
    task.snapshots = [...(task.snapshots ?? []), snapshot].slice(-50);
  }

  private removeTaskFromActiveQueue(task: QueuedTask): void {
    const queue = this.taskQueueByAgent.get(task.targetAgentId) ?? [];
    const next = queue.filter((id) => id !== task.id);
    if (next.length === 0) this.taskQueueByAgent.delete(task.targetAgentId);
    else this.taskQueueByAgent.set(task.targetAgentId, next);
  }

  /** Persist queue state serially so stale snapshots cannot win write races. */
  private persistSchedulerState(): Promise<void> {
    const snapshot: SchedulerSnapshot = {
      version: 1,
      nextTaskNumber: this.nextTaskNumber,
      taskIdDate: this.taskIdDate,
      tasks: Array.from(this.taskById.values(), (task) => structuredClone(task)),
      queues: Object.fromEntries(Array.from(this.taskQueueByAgent.entries(), ([id, queue]) => [id, [...queue]])),
      leaderEvents: Array.from(this.leaderEventsById.values(), (event) => structuredClone(event)),
      releasesByLeaderTask: Object.fromEntries(this.releaseByLeaderTask),
    };
    const write = this.schedulerPersistenceTail.then(() => this.gitStore.saveSchedulerState(snapshot));
    this.schedulerPersistenceTail = write.catch((error: unknown) => {
        logger.warn(t("scheduler_persist_failed", { error: error instanceof Error ? error.message : String(error) }));
      });
    return write;
  }

  private persistSchedulerStateInBackground(): void {
    void this.persistSchedulerState().catch(() => undefined);
  }

  async flushSchedulerState(): Promise<void> {
    await this.persistSchedulerState();
  }

  private isValidSnapshot(snapshot: SchedulerSnapshot): boolean {
    if (!Number.isInteger(snapshot.nextTaskNumber) || snapshot.nextTaskNumber < 1 || typeof snapshot.taskIdDate !== "string") return false;
    if (!Array.isArray(snapshot.tasks) || !isRecord(snapshot.queues) || !Array.isArray(snapshot.leaderEvents)) return false;
    if (snapshot.releasesByLeaderTask !== undefined && (!isRecord(snapshot.releasesByLeaderTask) || Object.values(snapshot.releasesByLeaderTask).some((id) => typeof id !== "string"))) return false;
    const tasks = new Map<string, QueuedTask>();
    for (const raw of snapshot.tasks as unknown[]) {
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.targetAgentId !== "string" ||
          typeof raw.createdBy !== "string" || typeof raw.prompt !== "string" ||
          typeof raw.status !== "string" || !TASK_STATUSES.has(raw.status) ||
          typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string" || tasks.has(raw.id)) return false;
      tasks.set(raw.id, raw as unknown as QueuedTask);
    }
    const queuedRefs = new Set<string>();
    for (const [agentId, rawQueue] of Object.entries(snapshot.queues)) {
      if (!Array.isArray(rawQueue)) return false;
      for (const id of rawQueue) {
        if (typeof id !== "string" || queuedRefs.has(id)) return false;
        const task = tasks.get(id);
        if (!task || task.targetAgentId !== agentId) return false;
        queuedRefs.add(id);
      }
    }
    for (const task of tasks.values()) {
      if ((task.status === QueuedTaskStatusEnum.Queued || task.status === QueuedTaskStatusEnum.Running || task.status === QueuedTaskStatusEnum.Waiting) && !queuedRefs.has(task.id)) return false;
    }
    for (const raw of snapshot.leaderEvents as unknown[]) {
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.leaderId !== "string" ||
          typeof raw.taskId !== "string" || typeof raw.reviewId !== "string" ||
          typeof raw.status !== "string" || !EVENT_STATUSES.has(raw.status)) return false;
    }
    return true;
  }

  /**
   * Scheduler snapshots written before `QueuedTask.createdBy` became durable
   * are still structurally recoverable. Infer a child task's creator from its
   * parent target; root tasks originated from the operator-facing task API.
   */
  private migrateLegacySnapshot(snapshot: unknown): { snapshot: SchedulerSnapshot; migrated: boolean } {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.tasks)) return { snapshot: snapshot as SchedulerSnapshot, migrated: false };
    const tasksById = new Map<string, Record<string, unknown>>();
    for (const task of snapshot.tasks) {
      if (isRecord(task) && typeof task.id === "string") tasksById.set(task.id, task);
    }
    let migrated = false;
    const tasks = snapshot.tasks.map((task) => {
      if (!isRecord(task) || (typeof task.createdBy === "string" && task.createdBy.trim())) return task;
      const parentId = typeof task.parentTaskId === "string" ? task.parentTaskId : undefined;
      const parentTarget = parentId ? tasksById.get(parentId)?.targetAgentId : undefined;
      migrated = true;
      return { ...task, createdBy: typeof parentTarget === "string" && parentTarget.trim() ? parentTarget : "operator" };
    });
    return { snapshot: { ...snapshot, tasks } as SchedulerSnapshot, migrated };
  }

  private configuredAgentIds(): Set<string> {
    const ids = new Set(this.agents.keys());
    for (const team of this.config.teams) {
      for (let index = 0; index < team.worker.total; index += 1) ids.add(`${team.name}-worker-${index}`);
    }
    return ids;
  }

  private async restoreSchedulerState(): Promise<void> {
    const stored = await this.gitStore.loadSchedulerState<unknown>();
    if (!stored) return;
    const { snapshot, migrated } = this.migrateLegacySnapshot(stored);
    if (snapshot.version !== 1 || !this.isValidSnapshot(snapshot)) {
      const quarantine = await this.gitStore.quarantineSchedulerState();
      logger.warn(t("scheduler_snapshot_quarantined", { path: quarantine ?? "N/A" }));
      return;
    }
    if (migrated) await this.gitStore.saveSchedulerState(snapshot);
    this.nextTaskNumber = snapshot.nextTaskNumber;
    this.taskIdDate = snapshot.taskIdDate;
    const configuredAgentIds = this.configuredAgentIds();
    for (const task of snapshot.tasks) {
      // A process restart has no live prompt. Preserve interrupted work as a
      // paused, recallable checkpoint rather than silently failing or replaying
      // side effects. The operator can inspect the snapshot before recall.
      if (task.status === QueuedTaskStatusEnum.Running) {
        task.status = QueuedTaskStatusEnum.Paused;
        task.pauseReason = "startup_recovery";
        task.pausedAt = task.updatedAt = new Date().toISOString();
        task.completedAt = undefined;
        this.checkpointTask(task, "startup_recovery");
      }
      if (task.status === QueuedTaskStatusEnum.Queued && !configuredAgentIds.has(task.targetAgentId)) {
        task.status = QueuedTaskStatusEnum.Failed;
        task.error = t("scheduler_target_missing", { agentId: task.targetAgentId });
        task.completedAt = task.updatedAt = new Date().toISOString();
      }
      this.taskById.set(task.id, task);
    }
    for (const [agentId, queue] of Object.entries(snapshot.queues)) {
      const active = queue.filter((taskId) => {
        const status = this.taskById.get(taskId)?.status;
        return status === QueuedTaskStatusEnum.Queued || status === QueuedTaskStatusEnum.Waiting;
      });
      if (active.length > 0) this.taskQueueByAgent.set(agentId, active);
    }
    for (const [taskId, proposalId] of Object.entries(snapshot.releasesByLeaderTask ?? {})) {
      if (this.taskById.has(taskId)) this.releaseByLeaderTask.set(taskId, proposalId);
    }
    for (const event of snapshot.leaderEvents ?? []) {
      // Review handoffs are durable. Reset an interrupted lease so the Leader
      // can receive the same event after its runtime and Worker pool recover.
      if (event.status === LeaderInboxEventStatusEnum.Pending || event.status === LeaderInboxEventStatusEnum.Leased || event.status === LeaderInboxEventStatusEnum.LegacyDelivered) {
        event.status = LeaderInboxEventStatusEnum.Pending;
        event.leaseExpiresAt = undefined;
        event.error = undefined;
        event.updatedAt = new Date().toISOString();
      }
      this.leaderEventsById.set(event.id, event);
    }
    await this.persistSchedulerState();
  }

  private async enqueueLeaderReviewEvent(leaderId: string, taskId: string, reviewId: string): Promise<void> {
    const now = new Date().toISOString();
    const event: LeaderInboxEvent = {
      id: `leader-event-${randomUUID()}`,
      leaderId,
      taskId,
      reviewId,
      type: LeaderInboxEventTypeEnum.WorkerReviewReady,
      status: LeaderInboxEventStatusEnum.Pending,
      createdAt: now,
      updatedAt: now,
      deliveryAttempts: 0,
    };
    this.leaderEventsById.set(event.id, event);
    try {
      await this.persistSchedulerState();
    } catch (error) {
      this.leaderEventsById.delete(event.id);
      throw error;
    }
    void this.deliverLeaderReviewEvent(event.id).catch((error: unknown) => {
      logger.warn(t("scheduler_event_delivery_failed", {
        operation: "persisted_delivery", error: error instanceof Error ? error.message : String(error),
      }), { eventId: event.id });
    });
  }

  private async deliverLeaderReviewEvent(eventId: string): Promise<void> {
    const event = this.leaderEventsById.get(eventId);
    if (!event || event.status === LeaderInboxEventStatusEnum.Acknowledged || event.status === LeaderInboxEventStatusEnum.Failed || this.crashedAgents.has(event.leaderId)) return;
    if (event.status === LeaderInboxEventStatusEnum.Leased && event.leaseExpiresAt && Date.parse(event.leaseExpiresAt) > Date.now()) return;
    const workerTask = this.taskById.get(event.taskId);
    const workflow = workerTask?.parentTaskId ? this.taskById.get(workerTask.parentTaskId) : undefined;
    if (!workflow || workflow.targetAgentId !== event.leaderId || [QueuedTaskStatusEnum.Completed, QueuedTaskStatusEnum.Cancelled, QueuedTaskStatusEnum.Failed].includes(workflow.status)) {
      event.status = LeaderInboxEventStatusEnum.Failed;
      event.error = t("scheduler_owner_unavailable");
      event.updatedAt = new Date().toISOString();
      await this.persistSchedulerState();
      return;
    }
    if (this.promptActiveAgents.has(event.leaderId)) {
      const retry = setTimeout(() => void this.deliverLeaderReviewEvent(eventId).catch(() => undefined), 250);
      retry.unref?.();
      return;
    }
    const activeTaskId = this.runningTaskByAgent.get(event.leaderId);
    if (activeTaskId && activeTaskId !== workflow.id) {
      const retry = setTimeout(() => void this.deliverLeaderReviewEvent(eventId).catch((retryError: unknown) => {
        logger.warn(t("scheduler_event_delivery_failed", {
          operation: "queued_delivery", error: retryError instanceof Error ? retryError.message : String(retryError),
        }), { eventId });
      }), 1_000);
      retry.unref?.();
      return;
    }
    if (!activeTaskId) {
      if (workflow.status !== QueuedTaskStatusEnum.Waiting) {
        const retry = setTimeout(() => void this.deliverLeaderReviewEvent(eventId).catch(() => undefined), 1_000);
        retry.unref?.();
        return;
      }
      const leader = this.getAgent(event.leaderId);
      workflow.status = QueuedTaskStatusEnum.Running;
      workflow.updatedAt = new Date().toISOString();
      this.runningTaskByAgent.set(event.leaderId, workflow.id);
      try {
        await this.persistSchedulerState();
        await this.prepareLeaderWorkspace(leader, workflow);
      } catch (error) {
        this.runningTaskByAgent.delete(event.leaderId);
        workflow.status = QueuedTaskStatusEnum.Waiting;
        workflow.updatedAt = new Date().toISOString();
        await this.persistSchedulerState().catch(() => undefined);
        const retry = setTimeout(() => void this.deliverLeaderReviewEvent(eventId).catch(() => undefined), 1_000);
        retry.unref?.();
        throw error;
      }
    }
    const leaseMs = 30_000;
    event.status = LeaderInboxEventStatusEnum.Leased;
    event.deliveryAttempts += 1;
    event.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    event.updatedAt = new Date().toISOString();
    await this.persistSchedulerState();
    try {
      await this.sendManagedPrompt(event.leaderId, [
        `WORKER_REVIEW_READY: ${event.reviewId}`,
        `Worker review for task ${event.taskId} is ready.`,
        `Inspect it and call review-worker-branch with reviewId="${event.reviewId}".`,
        `If other child tasks remain, finish this turn and wait for their durable review events.`,
        `If this is the last child, run integration checks, call submit-release-proposal, then notify-complete as Leader.`,
        `This event is durable; completing the review acknowledges it.`,
      ].join("\n"));
      const retry = setTimeout(() => void this.deliverLeaderReviewEvent(eventId).catch((retryError: unknown) => {
        logger.warn(t("scheduler_event_delivery_failed", {
          operation: "redelivery", error: retryError instanceof Error ? retryError.message : String(retryError),
        }), { eventId });
      }), leaseMs);
      retry.unref?.();
    } catch (error: unknown) {
      event.status = LeaderInboxEventStatusEnum.Pending;
      event.leaseExpiresAt = undefined;
      event.error = error instanceof Error ? error.message : String(error);
      event.updatedAt = new Date().toISOString();
      const retry = setTimeout(() => void this.deliverLeaderReviewEvent(eventId).catch((retryError: unknown) => {
        logger.warn(t("scheduler_event_delivery_failed", {
          operation: "retry", error: retryError instanceof Error ? retryError.message : String(retryError),
        }), { eventId });
      }), 1_000);
      retry.unref?.();
    }
    await this.persistSchedulerState();
    if (this.runningTaskByAgent.get(event.leaderId) === workflow.id) {
      const unfinishedChildren = Array.from(this.taskById.values()).some((task) =>
        task.parentTaskId === workflow.id &&
        (task.status === QueuedTaskStatusEnum.Queued || task.status === QueuedTaskStatusEnum.Running || task.status === QueuedTaskStatusEnum.ReviewPending),
      );
      if (unfinishedChildren) {
        this.runningTaskByAgent.delete(event.leaderId);
        workflow.status = QueuedTaskStatusEnum.Waiting;
        workflow.updatedAt = new Date().toISOString();
        this.emitTaskEvent("task.waiting_for_workers", workflow);
        await this.persistSchedulerState();
        this.requestSchedule(event.leaderId);
      }
    }
  }

  private async acknowledgeLeaderReviewEvent(leaderId: string, reviewId: string): Promise<void> {
    let changed = false;
    for (const event of this.leaderEventsById.values()) {
      if (event.leaderId !== leaderId || event.reviewId !== reviewId || event.status === LeaderInboxEventStatusEnum.Acknowledged) continue;
      event.status = LeaderInboxEventStatusEnum.Acknowledged;
      event.leaseExpiresAt = undefined;
      event.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) await this.persistSchedulerState();
  }

  private async deliverWorkerCrashNotice(leaderId: string, workerTaskId: string, error: string): Promise<void> {
    const workerTask = this.taskById.get(workerTaskId);
    const workflow = workerTask?.parentTaskId ? this.taskById.get(workerTask.parentTaskId) : undefined;
    if (!workflow || workflow.status !== QueuedTaskStatusEnum.Waiting || this.crashedAgents.has(leaderId)) return;
    if (this.promptActiveAgents.has(leaderId) || this.runningTaskByAgent.has(leaderId)) {
      const retry = setTimeout(() => void this.deliverWorkerCrashNotice(leaderId, workerTaskId, error).catch(() => undefined), 500);
      retry.unref?.();
      return;
    }
    const leader = this.getAgent(leaderId);
    workflow.status = QueuedTaskStatusEnum.Running;
    workflow.updatedAt = new Date().toISOString();
    this.runningTaskByAgent.set(leaderId, workflow.id);
    try {
      await this.persistSchedulerState();
      await this.prepareLeaderWorkspace(leader, workflow);
      await this.sendManagedPrompt(leaderId, [
        `WORKER_CRASH: Worker task ${workerTaskId} failed and cannot produce a review.`,
        `Error: ${error}`,
        `Decide within this workflow whether to dispatch a replacement Worker task or continue without this contribution.`,
      ].join("\n"));
    } catch (noticeError) {
      logger.warn(t("scheduler_event_delivery_failed", {
        operation: "worker_crash_notice",
        error: noticeError instanceof Error ? noticeError.message : String(noticeError),
      }), {
        leaderId, workerTaskId,
      });
    }
    if (this.runningTaskByAgent.get(leaderId) === workflow.id) {
      this.runningTaskByAgent.delete(leaderId);
      workflow.status = QueuedTaskStatusEnum.Waiting;
      workflow.updatedAt = new Date().toISOString();
      await this.persistSchedulerState();
      this.requestSchedule(leaderId);
    }
  }

  private activeTasks(): QueuedTask[] {
    // A review handoff is still active: allowing a conflict here could create
    // two branches changing the same resource before integration.
    return this.getTasks().filter((task) =>
      task.status === QueuedTaskStatusEnum.Queued || task.status === QueuedTaskStatusEnum.Running ||
      task.status === QueuedTaskStatusEnum.Waiting || task.status === QueuedTaskStatusEnum.ReviewPending,
    );
  }

  /** Task IDs are traceable by their local creation date and daily sequence. */
  private nextTaskId(createdAt: Date): string {
    const date = [
      createdAt.getFullYear(),
      String(createdAt.getMonth() + 1).padStart(2, "0"),
      String(createdAt.getDate()).padStart(2, "0"),
    ].join("");
    if (date !== this.taskIdDate) {
      this.taskIdDate = date;
      this.nextTaskNumber = 1;
    }
    if (this.nextTaskNumber > 1_000_000) throw new Error(t("scheduler_daily_capacity", { date }));
    // Project names are user-controlled and task IDs are also used in workspace
    // paths, so retain a readable but path-safe project-group identifier.
    const projectId = this.config.project.name.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
    return `task-${projectId}-${date}-${String(this.nextTaskNumber++).padStart(7, "0")}`;
  }

  async createTask(body: ToolCreateTaskBody, options: { schedule?: boolean; ignoreConflictTaskId?: string } = {}): Promise<QueuedTask> {
    const target = this.getAgent(body.targetAgentId);
    if (body.parentTaskId && !this.taskById.has(body.parentTaskId)) {
      throw new Error(t("scheduler_parent_not_found", { taskId: body.parentTaskId }));
    }
    const prompt = body.prompt?.trim();
    if (!prompt) throw new Error(t("scheduler_prompt_required", { operation: "create_task" }));
    const conflictKey = body.conflictKey?.trim() || undefined;
    const duplicate = this.activeTasks().find((task) => task.id !== options.ignoreConflictTaskId && (
      (conflictKey && task.conflictKey === conflictKey) ||
      (task.targetAgentId === body.targetAgentId && task.prompt === prompt)
    ));
    if (duplicate) {
      throw new Error(t("scheduler_task_conflict", { taskId: duplicate.id, status: duplicate.status }));
    }
    const createdAt = new Date();
    const now = createdAt.toISOString();
    const task: QueuedTask = {
      id: this.nextTaskId(createdAt),
      targetAgentId: target.spec.id,
      createdBy: body.createdBy,
      parentTaskId: body.parentTaskId,
      prompt,
      conflictKey,
      status: QueuedTaskStatusEnum.Queued,
      createdAt: now,
      updatedAt: now,
    };
    this.checkpointTask(task, "created");
    this.taskById.set(task.id, task);
    const queue = this.taskQueueByAgent.get(task.targetAgentId) ?? [];
    queue.push(task.id);
    this.taskQueueByAgent.set(task.targetAgentId, queue);
    this.emitTaskEvent("task.created", task);
    try {
      // Creation is not accepted until the ID and queue position are durable.
      // Otherwise a restart can reuse the daily sequence or lose accepted work.
      await this.persistSchedulerState();
    } catch (error) {
      this.taskById.delete(task.id);
      this.removeTaskFromActiveQueue(task);
      throw error;
    }
    if (options.schedule !== false) this.requestSchedule(task.targetAgentId);
    return task;
  }

  private requestSchedule(agentId: string): void {
    if (!this.schedulingEnabled) return;
    if (this.pendingScheduleTimers.has(agentId)) return;
    const timer = setTimeout(() => {
      this.pendingScheduleTimers.delete(agentId);
      void this.scheduleAgent(agentId).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.completeRunningTask(agentId, message);
      });
    }, 0);
    timer.unref?.();
    this.pendingScheduleTimers.set(agentId, timer);
  }

  private async sendManagedPrompt(agentId: string, prompt: string): Promise<void> {
    this.promptActiveAgents.add(agentId);
    try {
      const memory = await this.memoryService?.buildContext(agentId, prompt);
      await this.runtimeProvider.sendPrompt(agentId, memory ? `${memory}\n\n${prompt}` : prompt);
      // IPC delivery is not prompt completion. Keep the Agent occupied until
      // the runtime emits agent_end (or the crash path clears the slot).
    } catch (error) {
      this.promptActiveAgents.delete(agentId);
      if (!this.runningTaskByAgent.has(agentId)) this.requestSchedule(agentId);
      throw error;
    }
  }

  async updateTask(body: ToolUpdateTaskBody): Promise<QueuedTask> {
    const task = this.taskById.get(body.id);
    if (!task) throw new Error(t("scheduler_task_not_found", { taskId: body.id }));
    if (task.status !== QueuedTaskStatusEnum.Queued) throw new Error(t("scheduler_only_queued_modifiable", { taskId: body.id }));
    const prompt = body.prompt?.trim();
    if (body.prompt !== undefined && !prompt) throw new Error(t("scheduler_prompt_required", { operation: "update_task" }));
    const conflictKey = body.conflictKey?.trim() || undefined;
    const conflict = this.activeTasks().find((other) => other.id !== task.id && (
      (conflictKey && other.conflictKey === conflictKey) ||
      (prompt && other.targetAgentId === task.targetAgentId && other.prompt === prompt)
    ));
    if (conflict) throw new Error(t("scheduler_task_conflict", { taskId: conflict.id, status: conflict.status }));
    if (prompt) task.prompt = prompt;
    if (body.conflictKey !== undefined) task.conflictKey = conflictKey;
    if (body.status === QueuedTaskStatusEnum.Cancelled) {
      task.status = QueuedTaskStatusEnum.Cancelled;
      this.removeTaskFromActiveQueue(task);
    }
    task.updatedAt = new Date().toISOString();
    this.emitTaskEvent("task.updated", task);
    await this.persistSchedulerState();
    return task;
  }

  async pauseTask(id: string): Promise<QueuedTask> {
    const task = this.taskById.get(id);
    if (!task) throw new Error(t("scheduler_task_not_found", { taskId: id }));
    if (task.status !== QueuedTaskStatusEnum.Queued) {
      throw new Error(`Task ${id} cannot be paused while it is ${task.status}. Wait for the current Agent turn to reach a checkpoint.`);
    }
    task.status = QueuedTaskStatusEnum.Paused;
    task.pausedAt = task.updatedAt = new Date().toISOString();
    task.pauseReason = "operator";
    this.removeTaskFromActiveQueue(task);
    this.checkpointTask(task, "paused");
    this.emitTaskEvent("task.paused", task);
    await this.persistSchedulerState();
    return task;
  }

  async resumeTask(id: string): Promise<QueuedTask> {
    const task = this.taskById.get(id);
    if (!task) throw new Error(t("scheduler_task_not_found", { taskId: id }));
    if (task.status !== QueuedTaskStatusEnum.Paused) throw new Error(`Only paused tasks can be resumed: ${id}`);
    task.status = QueuedTaskStatusEnum.Queued;
    task.pausedAt = undefined;
    task.pauseReason = undefined;
    task.error = undefined;
    task.updatedAt = new Date().toISOString();
    const queue = this.taskQueueByAgent.get(task.targetAgentId) ?? [];
    if (!queue.includes(task.id)) queue.push(task.id);
    this.taskQueueByAgent.set(task.targetAgentId, queue);
    this.emitTaskEvent("task.resumed", task);
    await this.persistSchedulerState();
    this.requestSchedule(task.targetAgentId);
    return task;
  }

  async recallTask(id: string): Promise<QueuedTask> {
    const source = this.taskById.get(id);
    if (!source) throw new Error(t("scheduler_task_not_found", { taskId: id }));
    if ([QueuedTaskStatusEnum.Queued, QueuedTaskStatusEnum.Running, QueuedTaskStatusEnum.Waiting, QueuedTaskStatusEnum.ReviewPending].includes(source.status)) {
      throw new Error(`Active task ${id} cannot be recalled.`);
    }
    const recalled = await this.createTask({
      targetAgentId: source.targetAgentId,
      createdBy: "operator",
      prompt: source.prompt,
      conflictKey: source.conflictKey,
    }, { schedule: false });
    recalled.recalledFromTaskId = source.id;
    this.checkpointTask(recalled, "recalled");
    await this.persistSchedulerState();
    this.emitTaskEvent("task.recalled", recalled);
    this.requestSchedule(recalled.targetAgentId);
    return recalled;
  }

  /** Reorder only pending work. A currently running task always keeps its slot. */
  async reorderQueuedTasks(targetAgentId: string, taskIds: string[]): Promise<QueuedTask[]> {
    const queue = this.taskQueueByAgent.get(targetAgentId) ?? [];
    const queuedIds = queue.filter((id) => this.taskById.get(id)?.status === QueuedTaskStatusEnum.Queued);
    if (taskIds.length !== queuedIds.length || new Set(taskIds).size !== taskIds.length || taskIds.some((id) => !queuedIds.includes(id))) {
      throw new Error(t("scheduler_reorder_invalid"));
    }
    this.taskQueueByAgent.set(targetAgentId, [...queue.filter((id) => this.taskById.get(id)?.status !== QueuedTaskStatusEnum.Queued), ...taskIds]);
    const updatedAt = new Date().toISOString();
    for (const id of taskIds) {
      const task = this.taskById.get(id);
      if (!task) continue;
      task.updatedAt = updatedAt;
      this.emitTaskEvent("task.reordered", task);
    }
    await this.persistSchedulerState();
    return this.getTasks(targetAgentId);
  }

  async deleteTask(id: string): Promise<{ ok: true }> {
    const task = this.taskById.get(id);
    if (!task) throw new Error(t("scheduler_task_not_found", { taskId: id }));
    if (task.status === QueuedTaskStatusEnum.Running || task.status === QueuedTaskStatusEnum.Waiting || task.status === QueuedTaskStatusEnum.ReviewPending) {
      throw new Error(t("scheduler_delete_active", { taskId: id }));
    }
    const children = Array.from(this.taskById.values()).filter((child) => child.parentTaskId === id);
    if (children.length > 0) {
      throw new Error(t("scheduler_delete_has_children", { taskId: id, count: children.length }));
    }
    this.taskById.delete(id);
    this.removeTaskFromActiveQueue(task);
    this.emitTaskEvent("task.deleted", task);
    await this.persistSchedulerState();
    return { ok: true };
  }

  private emitTaskEvent(type: string, task: QueuedTask): void {
    const agent = this.agents.get(task.targetAgentId);
    this.observabilityHub.emit({
      source: "orchestrator", type, agentId: task.targetAgentId,
      role: agent?.spec.role, sessionId: agent?.sessionId,
      payload: { task: { ...task } },
    });
    this.persistSchedulerStateInBackground();
  }

  private rootTaskFor(task: QueuedTask): QueuedTask {
    let current = task;
    const visited = new Set<string>();
    while (current.parentTaskId && !visited.has(current.id)) {
      visited.add(current.id);
      const parent = this.taskById.get(current.parentTaskId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  private recordDeliveryReport(task: QueuedTask, report: TaskDeliveryReport): void {
    const root = this.rootTaskFor(task);
    const targets = root.id === task.id ? [task] : [task, root];
    for (const target of targets) {
      const reports = target.deliveryReports ?? [];
      if (reports.some((item) => item.id === report.id)) continue;
      target.deliveryReports = [...reports, report];
      target.updatedAt = report.createdAt;
      this.emitTaskEvent("task.delivery_report", target);
    }
  }

  private async scheduleAgent(agentId: string): Promise<void> {
    if (!this.schedulingEnabled) return;
    if (this.crashedAgents.has(agentId)) return;
    if (this.promptActiveAgents.has(agentId)) return;
    if (this.runningTaskByAgent.has(agentId)) return;
    const agent = this.getAgent(agentId);
    if (agent.spec.role === AgentRoleEnum.Leader) {
      const readyEvent = Array.from(this.leaderEventsById.values())
        .filter((event) => event.leaderId === agentId && (
          event.status === LeaderInboxEventStatusEnum.Pending ||
          (event.status === LeaderInboxEventStatusEnum.Leased && (!event.leaseExpiresAt || Date.parse(event.leaseExpiresAt) <= Date.now()))
        ))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (readyEvent) {
        await this.deliverLeaderReviewEvent(readyEvent.id);
        return;
      }
    }
    const queue = this.taskQueueByAgent.get(agentId) ?? [];
    const task = queue.map((id) => this.taskById.get(id)).find((item): item is QueuedTask => item?.status === QueuedTaskStatusEnum.Queued);
    if (!task) return;
    if (agent.spec.role === AgentRoleEnum.Leader && agent.leaderTeam) {
      const workersReady = Array.from({ length: agent.leaderTeam.worker.total }, (_, index) =>
        this.agents.get(`${agent.leaderTeam!.name}-worker-${index}`)?.spec.role === AgentRoleEnum.Worker,
      ).every(Boolean);
      // Restored Leader work must not begin before its configured Worker pool
      // has been registered. registerAgent will retry the Leader queue.
      if (!workersReady) return;
    }
    task.status = QueuedTaskStatusEnum.Running;
    task.startedAt = task.updatedAt = new Date().toISOString();
    this.runningTaskByAgent.set(agentId, task.id);
    this.lastCompletedWorkflowByAgent.delete(agentId);
    this.checkpointTask(task, "started");
    // Commit the ownership transition before rebinding a workspace or sending
    // a prompt. A crash after the external side effect must never replay the
    // same queue item as if it were still pending.
    await this.persistSchedulerState();
    if (agent.spec.role === AgentRoleEnum.Worker) {
      this.workerBusy.set(agentId, { leaderId: task.createdBy, taskIndex: 0, startedAt: Date.now() });
      await this.prepareWorkerWorkspace(agent, task);
      await this.persistSchedulerState();
      this.emitTaskEvent("task.started", task);
      await this.sendManagedPrompt(agentId, this.buildWorkerDispatchPrompt(agentId, task.prompt));
    } else if (agent.spec.role === AgentRoleEnum.Leader) {
      await this.prepareLeaderWorkspace(agent, task);
      this.leaderTaskAssignedAt.set(agentId, Date.now());
      this.emitTaskEvent("task.started", task);
      await this.sendManagedPrompt(agentId, [
        `ADMIN_TASK:`, task.prompt, ``,
        `Dispatch requirement: immediately call dispatch-worker-tasks for this task.`,
        `If the task cannot be safely split into independent parts, dispatch exactly one complete implementation task to one Worker; do not leave the task at Leader level.`,
        `Only skip dispatch when the request requires no implementation work, and report the reason with report-progress.`,
      ].join("\n"));
    } else if (agent.spec.role === AgentRoleEnum.Admin) {
      this.emitTaskEvent("task.started", task);
      if (task.prompt.startsWith("RELEASE_PROPOSAL:\n")) {
        // A release proposal is an internal control event. It must retain its
        // own semantics instead of being reinterpreted as a new operator goal.
        await this.sendManagedPrompt(agentId, task.prompt);
      } else {
        await this.sendManagedPrompt(agentId, [
          `OPERATOR_INSTRUCTION:`,
          task.prompt,
          ``,
          `Operator delivery requirement: write a concise answer directly for the operator by calling report-progress with stage="user_response" and the exact reply in message.`,
          `For greetings or questions, answer directly without delegating. For concrete work, acknowledge the request and state the next step after assigning the appropriate leader.`,
          `Then call notify-complete with agentRole="admin" to finish this operator task.`,
        ].join("\n"));
      }
    } else {
      throw new Error(t("scheduler_unsupported_role", { role: agent.spec.role }));
    }
  }

  private async completeRunningTask(agentId: string, failedError?: string): Promise<void> {
    const taskId = this.runningTaskByAgent.get(agentId);
    if (!taskId) return;
    const task = this.taskById.get(taskId);
    this.runningTaskByAgent.delete(agentId);
    if (task) {
      task.status = failedError ? QueuedTaskStatusEnum.Failed : QueuedTaskStatusEnum.Completed;
      task.error = failedError;
      task.completedAt = task.updatedAt = new Date().toISOString();
      this.checkpointTask(task, failedError ? "failed" : "completed");
      this.removeTaskFromActiveQueue(task);
      this.emitTaskEvent(failedError ? "task.failed" : "task.completed", task);
    }
    if (!failedError) this.lastCompletedWorkflowByAgent.set(agentId, taskId);
    await this.persistSchedulerState();
    this.requestSchedule(agentId);
  }

  private async completeWorkflowTask(agentId: string, failedError?: string): Promise<void> {
    const taskId = this.runningTaskByAgent.get(agentId);
    if (!taskId) return;
    this.runningTaskByAgent.delete(agentId);
    const task = this.taskById.get(taskId);
    if (task) {
      task.status = failedError ? QueuedTaskStatusEnum.Failed : QueuedTaskStatusEnum.Completed;
      task.error = failedError;
      task.completedAt = task.updatedAt = new Date().toISOString();
      this.checkpointTask(task, failedError ? "failed" : "completed");
      this.removeTaskFromActiveQueue(task);
      this.emitTaskEvent(failedError ? "task.failed" : "task.completed", task);
    }
    if (!failedError) this.lastCompletedWorkflowByAgent.set(agentId, taskId);
    this.releaseByLeaderTask.delete(taskId);
    await this.persistSchedulerState();
    this.requestSchedule(agentId);
  }

  private async waitForDelegatedWorkflow(agentId: string): Promise<void> {
    const taskId = this.runningTaskByAgent.get(agentId);
    if (!taskId) return;
    const task = this.taskById.get(taskId);
    this.runningTaskByAgent.delete(agentId);
    if (task) {
      task.status = QueuedTaskStatusEnum.Waiting;
      task.updatedAt = new Date().toISOString();
      this.emitTaskEvent("task.waiting_for_delivery", task);
    }
    await this.persistSchedulerState();
    this.requestSchedule(agentId);
  }

  private currentWorkflowTaskId(agentId: string): string | undefined {
    return this.runningTaskByAgent.get(agentId);
  }

  /** Move an interrupted workflow to a terminal state without scheduling a crashed Agent. */
  private async failActiveWorkflow(agentId: string, error: string): Promise<void> {
    const taskIds = new Set<string>();
    const runningTaskId = this.currentWorkflowTaskId(agentId);
    if (runningTaskId) taskIds.add(runningTaskId);
    for (const candidate of this.taskById.values()) {
      if (candidate.targetAgentId === agentId && candidate.status === QueuedTaskStatusEnum.Waiting) taskIds.add(candidate.id);
    }
    this.runningTaskByAgent.delete(agentId);
    if (taskIds.size === 0) return;

    for (const taskId of taskIds) {
      const task = this.taskById.get(taskId);
      if (task && ![QueuedTaskStatusEnum.Completed, QueuedTaskStatusEnum.Cancelled, QueuedTaskStatusEnum.Failed].includes(task.status)) {
        task.status = QueuedTaskStatusEnum.Failed;
        task.error = error;
        task.completedAt = task.updatedAt = new Date().toISOString();
        this.removeTaskFromActiveQueue(task);
        this.emitTaskEvent("task.failed", task);
      }

      // Work not yet sent to a Worker cannot produce a handoff after its owning
      // Leader crashes. Keep running children visible for recovery decisions.
      for (const child of this.taskById.values()) {
        if (child.parentTaskId !== taskId || child.status !== QueuedTaskStatusEnum.Queued) continue;
        child.status = QueuedTaskStatusEnum.Cancelled;
        child.completedAt = child.updatedAt = new Date().toISOString();
        this.removeTaskFromActiveQueue(child);
        this.emitTaskEvent("task.cancelled_due_to_owner_crash", child);
      }
    }
    for (const event of this.leaderEventsById.values()) {
      const ownerTaskId = this.taskById.get(event.taskId)?.parentTaskId;
      if (!ownerTaskId || !taskIds.has(ownerTaskId) || event.status === LeaderInboxEventStatusEnum.Acknowledged || event.status === LeaderInboxEventStatusEnum.Failed) continue;
      event.status = LeaderInboxEventStatusEnum.Failed;
      event.leaseExpiresAt = undefined;
      event.error = error;
      event.updatedAt = new Date().toISOString();
    }
    await this.persistSchedulerState();
  }

  private async resolveBaseSha(): Promise<string> {
    return simpleGit(path.resolve(this.config.project.repo))
      .raw(["rev-parse", this.config.project.base_branch])
      .then((sha) => sha.trim());
  }

  private async prepareWorkerWorkspace(agent: AgentRuntimeState, task: QueuedTask): Promise<void> {
    const teamName = agent.spec.teamName;
    if (!teamName) throw new Error(t("scheduler_worker_no_team", { agentId: agent.spec.id }));
    const team = this.resolveTeam(teamName);
    let artifact = task.git;
    if (!artifact?.workspacePath || !artifact.branch) {
      const attempt = 1;
      const baseSha = await this.resolveBaseSha();
      const branch = `oat/${teamName}/${task.id}/attempt-${attempt}`;
      const workspacePath = this.gitStore.workerWorkspace(task.id, attempt);
      artifact = {
        taskId: task.id, attempt, baseSha, branch, workspacePath,
        artifactPath: this.gitStore.taskArtifactPath(task.id),
      };
      task.git = artifact;
      await this.gitStore.saveArtifact(artifact);
    }
    const { branch, baseSha, workspacePath } = artifact;
    const spec: AgentInstanceSpec = { ...agent.spec, branch, baseRef: baseSha, workspacePath };
    await this.workspaceProvider.ensureWorkspace(spec, team.leader.repos ?? []);
    await setLocalGitIdentity(spec.workspacePath, `${agent.spec.id}-${task.id}`, `${agent.spec.id}@${this.config.project.name}.oat`);
    await writeAgentWorkspaceConfig({
      workspacePath: spec.workspacePath, agentName: spec.name, role: AgentRoleEnum.Worker,
      scopeCtx: { workspaceRoot: this.gitStore.root, workspacePath: spec.workspacePath, role: AgentRoleEnum.Worker, teamName, teams: [] },
      orchestratorBaseUrl: this.orchestratorBaseUrl,
      runtimeMetaPath: path.join(this.gitStore.root, "agent-meta", agent.spec.id, task.id),
    });
    await this.runtimeProvider.rebindSession(agent.spec.id, spec);
    agent.spec = spec;
  }

  private async prepareLeaderWorkspace(agent: AgentRuntimeState, task: QueuedTask): Promise<void> {
    const team = agent.leaderTeam;
    if (!team) throw new Error(t("leader_has_no_team", { leaderId: agent.spec.id }));
    const baseSha = await this.resolveBaseSha();
    const branch = `oat/${team.name}/${task.id}/integration`;
    const workspacePath = this.gitStore.leaderWorkspace(team.name, task.id);
    const spec: AgentInstanceSpec = { ...agent.spec, branch, baseRef: baseSha, workspacePath };
    await this.workspaceProvider.ensureWorkspace(spec, team.leader.repos ?? []);
    await setLocalGitIdentity(spec.workspacePath, `${team.name}-leader-${task.id}`, `leader-${team.name}@${this.config.project.name}.oat`);
    await writeAgentWorkspaceConfig({
      workspacePath: spec.workspacePath, agentName: spec.name, role: AgentRoleEnum.Leader,
      scopeCtx: { workspaceRoot: this.gitStore.root, workspacePath: spec.workspacePath, role: AgentRoleEnum.Leader, teamName: team.name, teams: [{ name: team.name, worker: { total: team.worker.total } }] },
      orchestratorBaseUrl: this.orchestratorBaseUrl,
      runtimeMetaPath: path.join(this.gitStore.root, "agent-meta", agent.spec.id, task.id),
    });
    await this.runtimeProvider.rebindSession(agent.spec.id, spec);
    agent.spec = spec;
  }

  private async handoffWorkerReview(
    workerId: string,
    task: QueuedTask,
    leaderId: string,
    review: ReviewRequest,
  ): Promise<void> {
    if (this.crashedAgents.has(leaderId)) {
      throw new Error(t("scheduler_leader_unavailable_review", { leaderId, reviewId: review.id }));
    }
    task.status = QueuedTaskStatusEnum.ReviewPending;
    task.updatedAt = new Date().toISOString();
    this.removeTaskFromActiveQueue(task);
    this.runningTaskByAgent.delete(workerId);
    this.workerBusy.delete(workerId);
    this.emitTaskEvent("review.requested", task);
    try {
      // The durable inbox snapshot also commits review_pending and ownership
      // release, so the Worker is not reused before the handoff is recoverable.
      await this.enqueueLeaderReviewEvent(leaderId, task.id, review.id);
    } catch (error) {
      task.status = QueuedTaskStatusEnum.Running;
      task.updatedAt = new Date().toISOString();
      const queue = this.taskQueueByAgent.get(workerId) ?? [];
      if (!queue.includes(task.id)) queue.unshift(task.id);
      this.taskQueueByAgent.set(workerId, queue);
      this.runningTaskByAgent.set(workerId, task.id);
      this.workerBusy.set(workerId, { leaderId, taskIndex: 0, startedAt: Date.now() });
      this.emitTaskEvent("review.handoff_failed", task);
      await this.persistSchedulerState().catch(() => undefined);
      throw error;
    }
    this.requestSchedule(workerId);
  }

  async submitReview(workerId: string, tests: GitTaskArtifact["tests"] = []): Promise<ReviewRequest> {
    const worker = this.getAgent(workerId);
    if (worker.spec.role !== AgentRoleEnum.Worker) throw new Error(t("scheduler_role_expected", { agentId: workerId, role: AgentRoleEnum.Worker }));
    const taskId = this.runningTaskByAgent.get(workerId);
    const task = taskId ? this.taskById.get(taskId) : undefined;
    if (!task?.git) throw new Error(t("scheduler_worker_no_active_git_task", { agentId: workerId }));
    const leader = this.getAgent(task.createdBy);
    if (leader.spec.role !== AgentRoleEnum.Leader) throw new Error(t("scheduler_task_no_leader_owner", { taskId: task.id }));
    const leaderWorkflow = task.parentTaskId ? this.taskById.get(task.parentTaskId) : undefined;
    if (!leaderWorkflow || !leader.leaderTeam) throw new Error(t("scheduler_task_no_leader_workflow", { taskId: task.id }));
    const integrationBranch = `oat/${leader.leaderTeam.name}/${leaderWorkflow.id}/integration`;
    const existing = (await this.gitStore.listReviews(leader.spec.id)).find((review) =>
      review.taskId === task.id && review.status === ReviewStatusEnum.Pending,
    );
    if (existing) {
      await this.handoffWorkerReview(workerId, task, leader.spec.id, existing);
      this.recordDeliveryReport(task, {
        id: `delivery-${existing.id}`,
        taskId: task.id,
        agentId: workerId,
        role: AgentRoleEnum.Worker,
        stage: "review_submitted",
        summary: task.lastProgress?.message?.trim() || "",
        createdAt: existing.createdAt,
        reviewId: existing.id,
        branch: existing.branch,
        changedFiles: existing.changedFiles,
        tests: existing.tests,
        artifactPaths: [existing.artifactPath],
      });
      return existing;
    }
    const committed = await commitWorkspaceChanges(worker.spec.workspacePath, `feat(${worker.spec.teamName}): ${task.id}`);
    if (!committed) throw new Error(t("scheduler_review_commit_required", { taskId: task.id }));
    const git = simpleGit(worker.spec.workspacePath);
    const headSha = (await git.raw(["rev-parse", "HEAD"])).trim();
    const changedFiles = (await git.raw(["diff", "--name-only", task.git.baseSha, headSha]))
      .split("\n").map((file) => file.trim()).filter(Boolean);
    task.git.headSha = headSha;
    task.git.changedFiles = changedFiles;
    task.git.tests = tests;
    await this.gitStore.saveArtifact(task.git);
    const review: ReviewRequest = {
      id: `review-${randomUUID()}`,
      taskId: task.id,
      workerId,
      leaderId: leader.spec.id,
      teamName: worker.spec.teamName ?? "",
      branch: task.git.branch,
      baseSha: task.git.baseSha,
      headSha,
      artifactPath: task.git.artifactPath,
      changedFiles,
      tests,
      status: ReviewStatusEnum.Pending,
      createdAt: new Date().toISOString(),
      // A reusable Leader may already be dispatching another workflow when
      // this Worker finishes. Bind the review to its persisted parent, not to
      // whatever workspace the Leader happens to have open at submission time.
      integrationBranch,
    };
    await this.gitStore.saveReview(review);
    await this.handoffWorkerReview(workerId, task, leader.spec.id, review);
    this.recordDeliveryReport(task, {
      id: `delivery-${review.id}`,
      taskId: task.id,
      agentId: workerId,
      role: AgentRoleEnum.Worker,
      stage: "review_submitted",
      summary: task.lastProgress?.message?.trim() || "",
      createdAt: review.createdAt,
      reviewId: review.id,
      branch: review.branch,
      changedFiles: review.changedFiles,
      tests: review.tests,
      artifactPaths: [review.artifactPath],
    });
    this.observabilityHub.emit({
      source: "orchestrator", type: "leader.review_ready", agentId: leader.spec.id,
      role: AgentRoleEnum.Leader, sessionId: leader.sessionId,
      payload: { reviewId: review.id, workerId, taskId: task.id },
    });
    return review;
  }

  async listReviewRequests(leaderId?: string): Promise<ReviewRequest[]> {
    return this.gitStore.listReviews(leaderId);
  }

  async reviewWorkerBranch(leaderId: string, reviewId: string, approve: boolean, note: string): Promise<ReviewRequest> {
    const leader = this.getAgent(leaderId);
    if (leader.spec.role !== AgentRoleEnum.Leader) throw new Error(t("scheduler_role_expected", { agentId: leaderId, role: AgentRoleEnum.Leader }));
    const review = await this.gitStore.loadReview(reviewId);
    if (review.leaderId !== leaderId) throw new Error(t("scheduler_review_not_owned", { reviewId, leaderId }));
    if (review.status !== ReviewStatusEnum.Pending) {
      await this.acknowledgeLeaderReviewEvent(leaderId, reviewId);
      return review;
    }
    review.reviewer = leaderId;
    review.reviewedAt = new Date().toISOString();
    review.reviewNote = note;
    if (!approve) {
      const original = this.taskById.get(review.taskId);
      if (!original) throw new Error(t("scheduler_review_original_missing", { taskId: review.taskId }));
      review.status = ReviewStatusEnum.ChangesRequested;
      const retryTask = await this.createTask({
        targetAgentId: review.workerId,
        createdBy: leaderId,
        parentTaskId: original.parentTaskId,
        prompt: `Address review ${review.id}: ${note}\nOriginal task: ${original.prompt}`,
        conflictKey: original.conflictKey,
      }, { schedule: false, ignoreConflictTaskId: original.id });
      try {
        await this.gitStore.saveReview(review);
        original.status = QueuedTaskStatusEnum.Failed;
        original.error = t("scheduler_review_changes_requested", { reviewId: review.id, note });
        original.completedAt = original.updatedAt = new Date().toISOString();
        this.emitTaskEvent("review.changes_requested", original);
        await this.persistSchedulerState();
      } catch (error) {
        this.taskById.delete(retryTask.id);
        this.removeTaskFromActiveQueue(retryTask);
        await this.persistSchedulerState().catch(() => undefined);
        throw error;
      }
      this.requestSchedule(review.workerId);
      await this.acknowledgeLeaderReviewEvent(leaderId, reviewId);
      return review;
    }
    if (leader.spec.branch !== review.integrationBranch) {
      throw new Error(t("scheduler_review_wrong_branch", { expected: review.integrationBranch ?? "N/A", actual: leader.spec.branch }));
    }
    await this.mergeManager.mergeBranch(leader.spec.workspacePath, review.branch, leader.spec.branch);
    review.status = ReviewStatusEnum.Merged;
    review.mergeCommit = (await simpleGit(leader.spec.workspacePath).raw(["rev-parse", "HEAD"])).trim();
    await this.gitStore.saveReview(review);
    const task = this.taskById.get(review.taskId);
    if (task) {
      task.status = QueuedTaskStatusEnum.Completed;
      task.completedAt = task.updatedAt = new Date().toISOString();
      this.emitTaskEvent("review.merged", task);
    }
    await this.acknowledgeLeaderReviewEvent(leaderId, reviewId);
    return review;
  }

  async submitReleaseProposal(leaderId: string, note = ""): Promise<ReleaseProposal> {
    const leader = this.getAgent(leaderId);
    if (leader.spec.role !== AgentRoleEnum.Leader || !leader.leaderTeam) throw new Error(t("scheduler_role_expected", { agentId: leaderId, role: AgentRoleEnum.Leader }));
    const taskId = this.runningTaskByAgent.get(leaderId);
    if (!taskId) throw new Error(t("scheduler_leader_no_active_work", { leaderId }));
    const unfinishedChildren = Array.from(this.taskById.values()).filter((task) =>
      task.parentTaskId === taskId &&
      (task.status === QueuedTaskStatusEnum.Queued || task.status === QueuedTaskStatusEnum.Running || task.status === QueuedTaskStatusEnum.ReviewPending),
    );
    if (unfinishedChildren.length > 0) {
      throw new Error(t("scheduler_release_unfinished_children", { count: unfinishedChildren.length }));
    }
    const reviews = (await this.gitStore.listReviews(leaderId)).filter((review) => review.integrationBranch === leader.spec.branch && review.status === ReviewStatusEnum.Merged);
    if (reviews.length === 0) throw new Error(t("scheduler_release_requires_review"));
    const existing = (await this.gitStore.listReleases()).find((proposal) =>
      proposal.leaderId === leaderId && proposal.integrationBranch === leader.spec.branch && proposal.status !== ReleaseStatusEnum.Rejected,
    );
    if (existing) {
      this.releaseByLeaderTask.set(taskId, existing.id);
      return existing;
    }
    const proposal: ReleaseProposal = {
      id: `release-${randomUUID()}`,
      leaderId,
      teamName: leader.leaderTeam.name,
      integrationBranch: leader.spec.branch,
      headSha: (await simpleGit(leader.spec.workspacePath).raw(["rev-parse", "HEAD"])).trim(),
      artifactPaths: reviews.map((review) => review.artifactPath),
      status: ReleaseStatusEnum.Pending,
      createdAt: new Date().toISOString(),
      note,
    };
    await this.gitStore.saveRelease(proposal);
    this.releaseByLeaderTask.set(taskId, proposal.id);
    this.observabilityHub.emit({ source: "orchestrator", type: "release.proposed", agentId: leaderId, role: AgentRoleEnum.Leader, sessionId: leader.sessionId, payload: { proposal } });
    return proposal;
  }

  async listReleaseProposals(): Promise<ReleaseProposal[]> {
    return this.gitStore.listReleases();
  }

  private isValidGitIdentity(name?: string, email?: string): boolean {
    return Boolean(name?.trim() && email && /^[^\s@]+@[^\s@]+$/.test(email));
  }

  async updateGitConfiguration(update: GitConfigurationUpdate): Promise<GitManagementStatus> {
    const remote = update.remote?.trim() || undefined;
    const remoteUrl = update.remoteUrl?.trim() || undefined;
    const userName = update.userName?.trim() || undefined;
    const userEmail = update.userEmail?.trim() || undefined;
    if (remote && !/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error(t("git_remote_name_invalid"));
    if (remoteUrl && !remote) throw new Error(t("git_remote_url_requires_name"));
    if (update.pushEnabled && !remote) throw new Error(t("git_push_requires_remote"));
    if (update.pushEnabled && !this.isValidGitIdentity(userName, userEmail)) throw new Error(t("git_push_requires_identity"));

    const git = simpleGit(path.resolve(this.config.project.repo));
    if (userName) await git.addConfig("user.name", userName, false, "local");
    else await git.raw(["config", "--local", "--unset-all", "user.name"]).catch(() => undefined);
    if (userEmail) await git.addConfig("user.email", userEmail, false, "local");
    else await git.raw(["config", "--local", "--unset-all", "user.email"]).catch(() => undefined);

    if (remote && remoteUrl) {
      const exists = (await git.getRemotes()).some((entry) => entry.name === remote);
      if (exists) {
        await git.raw(["remote", "set-url", remote, remoteUrl]);
        await git.raw(["config", "--local", "--unset-all", `remote.${remote}.pushurl`]).catch(() => undefined);
      }
      else await git.addRemote(remote, remoteUrl);
    }
    if (update.pushEnabled && remote) {
      const configured = (await git.getRemotes(true)).some((entry) => entry.name === remote && Boolean(entry.refs.push || entry.refs.fetch));
      if (!configured) throw new Error(t("git_push_remote_not_configured", { remote }));
    }

    this.config.workspace.git.remote = remote;
    this.config.workspace.git.remote_url = remoteUrl;
    this.config.workspace.git.user_name = userName;
    this.config.workspace.git.user_email = userEmail;
    this.config.workspace.git.push_enabled = update.pushEnabled;
    await Promise.all(this.getAllAgents().map((agent) => setWorktreePushPermission(
      agent.spec.workspacePath,
      remote,
      false,
      remoteUrl,
    ).catch((error: unknown) => logger.warn(t("operation_failed", { operation: "update_git_push_permission", error: error instanceof Error ? error.message : String(error) }), { agentId: agent.spec.id }))));
    return this.getGitManagementStatus();
  }

  async getGitManagementStatus(): Promise<GitManagementStatus> {
    const repoPath = path.resolve(this.config.project.repo);
    const repo = simpleGit(repoPath);
    const localValue = async (key: string) => (await repo.raw(["config", "--local", "--get", key]).catch(() => "")).trim() || undefined;
    const headCommit = (await repo.raw(["rev-parse", `refs/heads/${this.config.project.base_branch}`]).catch(() => "")).trim() || undefined;
    const remote = this.config.workspace.git.remote;
    const remotes = await repo.getRemotes(true).catch(() => []);
    const configuredRemoteUrl = remote ? remotes.find((entry) => entry.name === remote)?.refs.push || remotes.find((entry) => entry.name === remote)?.refs.fetch : undefined;
    const userName = await localValue("user.name") ?? this.config.workspace.git.user_name;
    const userEmail = await localValue("user.email") ?? this.config.workspace.git.user_email;

    const agents = await Promise.all(this.getAllAgents().map(async (agent): Promise<AgentGitStatus> => {
      const result: AgentGitStatus = {
        agentId: agent.spec.id,
        role: agent.spec.role,
        workspacePath: agent.spec.workspacePath,
        dirty: false,
        ahead: 0,
        behind: 0,
        mergedIntoBase: false,
      };
      try {
        const git = simpleGit(agent.spec.workspacePath);
        const status = await git.status();
        result.branch = status.current || (await git.raw(["branch", "--show-current"])).trim() || agent.spec.branch;
        result.headCommit = (await git.raw(["rev-parse", "HEAD"])).trim();
        result.headSubject = (await git.raw(["log", "-1", "--pretty=%s"])).trim();
        result.dirty = !status.isClean();
        const counts = (await git.raw(["rev-list", "--left-right", "--count", `${this.config.project.base_branch}...HEAD`])).trim().split(/\s+/).map(Number);
        result.behind = Number.isFinite(counts[0]) ? counts[0] : 0;
        result.ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
        result.mergedIntoBase = await repo.raw(["merge-base", "--is-ancestor", result.headCommit, `refs/heads/${this.config.project.base_branch}`]).then(() => true).catch(() => false);
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      return result;
    }));

    return {
      repository: {
        path: repoPath,
        baseBranch: this.config.project.base_branch,
        headCommit,
        remote,
        remoteUrl: configuredRemoteUrl ?? this.config.workspace.git.remote_url,
        pushEnabled: this.config.workspace.git.push_enabled,
        userName,
        userEmail,
        identityValid: this.isValidGitIdentity(userName, userEmail),
      },
      agents,
      reviews: await this.gitStore.listReviews(),
      releases: await this.gitStore.listReleases(),
    };
  }

  async pushRelease(adminId: string, proposalId: string): Promise<ReleaseProposal> {
    const admin = this.getAgent(adminId);
    if (admin.spec.role !== AgentRoleEnum.Admin) throw new Error(t("scheduler_role_expected", { agentId: adminId, role: AgentRoleEnum.Admin }));
    return this.withReleaseLock(async () => {
      const proposal = await this.gitStore.loadRelease(proposalId);
      if (proposal.status !== ReleaseStatusEnum.Merged || !proposal.mergeCommit) throw new Error(t("git_push_requires_merged_release", { proposalId }));
      if (proposal.pushedCommit === proposal.mergeCommit) return proposal;
      const { remote, push_enabled: pushEnabled, user_name: userName, user_email: userEmail } = this.config.workspace.git;
      if (!pushEnabled || !remote) throw new Error(t("git_push_disabled"));
      if (!this.isValidGitIdentity(userName, userEmail)) throw new Error(t("git_push_requires_identity"));
      const git = simpleGit(path.resolve(this.config.project.repo));
      const localHead = (await git.raw(["rev-parse", `refs/heads/${this.config.project.base_branch}`])).trim();
      if (localHead !== proposal.mergeCommit) throw new Error(t("git_push_release_not_head", { proposalId }));
      const [authorName = "", authorEmail = ""] = (await git.raw(["show", "-s", "--format=%an%n%ae", proposal.mergeCommit])).trim().split("\n");
      if (authorName !== userName || authorEmail !== userEmail) throw new Error(t("git_push_commit_identity_mismatch", { proposalId }));
      const configured = (await git.getRemotes(true)).some((entry) => entry.name === remote && Boolean(entry.refs.push || entry.refs.fetch));
      if (!configured) throw new Error(t("git_push_remote_not_configured", { remote }));

      this.observabilityHub.emit({ source: "orchestrator", type: "git.push.start", agentId: adminId, role: AgentRoleEnum.Admin, sessionId: admin.sessionId, payload: { remote, proposalId, commit: proposal.mergeCommit } });
      try {
        // ls-remote verifies that the configured credential path can reach the
        // remote. The actual non-force push remains the write-authority check.
        await git.raw(["ls-remote", "--heads", remote]);
        await git.raw(["push", remote, `${proposal.mergeCommit}:refs/heads/${this.config.project.base_branch}`]);
      } catch (error) {
        this.observabilityHub.emit({ source: "orchestrator", type: "git.push.error", agentId: adminId, role: AgentRoleEnum.Admin, sessionId: admin.sessionId, payload: { remote, proposalId, error: error instanceof Error ? error.message : String(error) } });
        throw error;
      }
      proposal.pushedAt = new Date().toISOString();
      proposal.pushedBy = adminId;
      proposal.pushedRemote = remote;
      proposal.pushedCommit = proposal.mergeCommit;
      await this.gitStore.saveRelease(proposal);
      this.observabilityHub.emit({ source: "orchestrator", type: "git.push.done", agentId: adminId, role: AgentRoleEnum.Admin, sessionId: admin.sessionId, payload: { remote, proposalId, commit: proposal.mergeCommit } });
      void this.pushNotification(t("notification_delivery_success", { remote, branch: this.config.project.base_branch }));
      return proposal;
    });
  }

  async approveRelease(adminId: string, proposalId: string, approve: boolean, note = ""): Promise<ReleaseProposal> {
    const admin = this.getAgent(adminId);
    if (admin.spec.role !== AgentRoleEnum.Admin) throw new Error(t("scheduler_role_expected", { agentId: adminId, role: AgentRoleEnum.Admin }));
    const proposal = await this.withReleaseLock(async () => {
      // Reload under the decision lock so concurrent or retried tool calls
      // cannot overwrite one another with a stale status.
      const current = await this.gitStore.loadRelease(proposalId);
      if (current.status === ReleaseStatusEnum.Merged) {
        if (!approve) throw new Error(t("scheduler_release_transition_invalid", { proposalId, status: current.status, action: ReleaseStatusEnum.Rejected }));
        return current;
      }
      if (current.status === ReleaseStatusEnum.Rejected) {
        if (approve) throw new Error(t("scheduler_release_transition_invalid", { proposalId, status: current.status, action: ReleaseStatusEnum.Approved }));
        return current;
      }
      if (current.status === ReleaseStatusEnum.Approved && !approve) {
        throw new Error(t("scheduler_release_transition_invalid", { proposalId, status: current.status, action: ReleaseStatusEnum.Rejected }));
      }
      current.note = note || current.note;
      if (!approve) {
        current.status = ReleaseStatusEnum.Rejected;
        await this.gitStore.saveRelease(current);
        return current;
      }
      if (current.status === ReleaseStatusEnum.Pending) {
        current.status = ReleaseStatusEnum.Approved;
        current.approvedAt = new Date().toISOString();
        current.approvedBy = adminId;
        await this.gitStore.saveRelease(current);
      }
      const repo = simpleGit(path.resolve(this.config.project.repo));
      const baseSha = await this.resolveBaseSha();
      const worktreeRecords = (await repo.raw(["worktree", "list", "--porcelain"]))
        .trim().split(/\n\n+/).map((record) => Object.fromEntries(record.split("\n").map((line) => {
          const separator = line.indexOf(" ");
          return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
        })));
      const baseWorktreePath = worktreeRecords.find((record) => record.branch === `refs/heads/${this.config.project.base_branch}`)?.worktree;
      const assertBaseWorktreeClean = async () => {
        if (!baseWorktreePath) return;
        const baseWorktree = simpleGit(baseWorktreePath);
        const status = await baseWorktree.status();
        const currentHead = (await baseWorktree.raw(["rev-parse", "HEAD"])).trim();
        if (!status.isClean() || currentHead !== baseSha) throw new Error(t("git_base_worktree_dirty", { branch: this.config.project.base_branch }));
      };
      await assertBaseWorktreeClean();
      const releaseBranch = `oat/release/${current.id}`;
      const workspacePath = this.gitStore.releaseWorkspace(current.id);
      const spec: AgentInstanceSpec = { ...admin.spec, branch: releaseBranch, baseRef: baseSha, workspacePath };
      await this.workspaceProvider.ensureWorkspace(spec, []);
      try {
        if (this.config.workspace.git.user_name && this.config.workspace.git.user_email) {
          await setLocalGitIdentity(workspacePath, this.config.workspace.git.user_name, this.config.workspace.git.user_email);
        }
        await this.mergeManager.mergeBranch(workspacePath, current.integrationBranch, releaseBranch);
        const headSha = (await simpleGit(workspacePath).raw(["rev-parse", "HEAD"])).trim();
        await assertBaseWorktreeClean();
        await repo.raw(["update-ref", `refs/heads/${this.config.project.base_branch}`, headSha, baseSha]);
        if (baseWorktreePath) {
          try {
            await simpleGit(baseWorktreePath).raw(["reset", "--hard", headSha]);
          } catch (error) {
            await repo.raw(["update-ref", `refs/heads/${this.config.project.base_branch}`, baseSha, headSha]).catch(() => undefined);
            throw error;
          }
        }
        current.status = ReleaseStatusEnum.Merged;
        current.mergedAt = new Date().toISOString();
        current.mergeCommit = headSha;
        await this.gitStore.saveRelease(current);
      } finally {
        await repo.raw(["worktree", "remove", "--force", workspacePath]).catch(() => undefined);
        await repo.raw(["branch", "-D", releaseBranch]).catch(() => undefined);
      }
      return current;
    });
    this.observabilityHub.emit({
      source: "orchestrator", type: proposal.status === ReleaseStatusEnum.Merged ? "release.merged" : "release.rejected",
      agentId: adminId, role: AgentRoleEnum.Admin, sessionId: admin.sessionId, payload: { proposal },
    });
    await this.settleRootTaskForRelease(admin, proposal, note);
    return proposal;
  }

  private async settleRootTaskForRelease(admin: AgentRuntimeState, proposal: ReleaseProposal, note: string): Promise<void> {
    const root = Array.from(this.taskById.values()).find((task) =>
      !task.parentTaskId && task.deliveryReports?.some((report) => report.releaseProposalId === proposal.id),
    );
    if (!root || (root.status !== QueuedTaskStatusEnum.Waiting && root.status !== QueuedTaskStatusEnum.Running)) return;
    const succeeded = proposal.status === ReleaseStatusEnum.Merged;
    const message = succeeded
      ? t("scheduler_root_delivery_completed", { proposalId: proposal.id })
      : t("scheduler_root_delivery_rejected", { proposalId: proposal.id, note: note || proposal.note || "N/A" });
    const at = new Date().toISOString();
    root.status = succeeded ? QueuedTaskStatusEnum.Completed : QueuedTaskStatusEnum.Failed;
    root.error = succeeded ? undefined : message;
    root.lastProgress = { stage: succeeded ? "done" : "failed", message, at };
    root.completedAt = root.updatedAt = at;
    this.checkpointTask(root, succeeded ? "completed" : "failed");
    this.removeTaskFromActiveQueue(root);
    this.emitTaskEvent(succeeded ? "task.completed" : "task.failed", root);
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "report_progress",
      agentId: admin.spec.id,
      role: AgentRoleEnum.Admin,
      sessionId: admin.sessionId,
      payload: { taskId: root.id, stage: succeeded ? "done" : "failed", message },
    });
    await this.persistSchedulerState();
  }

  private async withReleaseLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.releaseTail;
    let release!: () => void;
    this.releaseTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  getObservabilityGraph(): ObservabilityGraph {
    const nodes: ObservabilityGraph["nodes"] = [];
    const edges: ObservabilityGraph["edges"] = [];
    const edgeKey = (s: string, t: string) => `${s}\0${t}`;
    const edgeSeen = new Set<string>();
    const pushEdge = (source: string, target: string, kind: ObservabilityGraph["edges"][0]["kind"]) => {
      const k = edgeKey(source, target);
      if (edgeSeen.has(k)) return;
      edgeSeen.add(k);
      edges.push({ source, target, kind });
    };

    const admin = Array.from(this.agents.values()).find((a) => a.spec.role === AgentRoleEnum.Admin);
    const statusFor = (agentId: string): NonNullable<ObservabilityGraph["nodes"][number]["status"]> => {
      if (this.crashedAgents.has(agentId)) return "failed";
      const activeTaskId = this.runningTaskByAgent.get(agentId);
      const activeTask = activeTaskId ? this.taskById.get(activeTaskId) : undefined;
      if (this.promptActiveAgents.has(agentId) || activeTask?.status === QueuedTaskStatusEnum.Running) return "running";
      if (this.getTasks(agentId).some((task) => [QueuedTaskStatusEnum.Queued, QueuedTaskStatusEnum.Waiting, QueuedTaskStatusEnum.ReviewPending, QueuedTaskStatusEnum.Paused].includes(task.status))) return "waiting";
      return "idle";
    };

    for (const a of this.agents.values()) {
      nodes.push({
        id: a.spec.id,
        role: a.spec.role,
        label: a.spec.name,
        teamName: a.spec.teamName,
        sessionId: a.sessionId,
        status: statusFor(a.spec.id),
      });
      if (a.spec.role === AgentRoleEnum.Leader && admin) {
        pushEdge(admin.spec.id, a.spec.id, "admin_leader");
      }
    }

    for (const leader of this.agents.values()) {
      if (leader.spec.role !== AgentRoleEnum.Leader) continue;
      const teamName = leader.spec.teamName;
      if (!teamName) continue;

      const workerIds = new Set<string>();
      for (const wId of leader.workers) {
        workerIds.add(wId);
      }
      for (const a of this.agents.values()) {
        if (a.spec.role === AgentRoleEnum.Worker && a.spec.teamName === teamName) {
          workerIds.add(a.spec.id);
        }
      }
      for (const wId of workerIds) {
        pushEdge(leader.spec.id, wId, "leader_worker");
      }
    }

    return { nodes, edges };
  }

  registerAgent(state: AgentRuntimeState): void {
    this.agents.set(state.spec.id, state);
    this.crashedAgents.delete(state.spec.id);
    this.promptActiveAgents.delete(state.spec.id);
    if (this.taskQueueByAgent.has(state.spec.id)) this.requestSchedule(state.spec.id);
    if (state.spec.role === AgentRoleEnum.Worker && state.spec.teamName) {
      for (const leader of this.agents.values()) {
        if (leader.spec.role === AgentRoleEnum.Leader && leader.spec.teamName === state.spec.teamName && this.taskQueueByAgent.has(leader.spec.id)) {
          this.requestSchedule(leader.spec.id);
        }
      }
    }
  }

  getAgent(agentId: string): AgentRuntimeState {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(t("agent_not_found", { agentId }));
    return a;
  }

  private resolveTeam(teamName: string): TeamConfig {
    const team = this.config.teams.find((x) => x.name === teamName);
    if (!team) throw new Error(t("team_not_found", { teamName }));
    return team;
  }

  async startAdminAndLeaders(adm: { sessionId: string; spec: AgentInstanceSpec }, leaders: Array<{ sessionId: string; spec: AgentInstanceSpec; team: TeamConfig }>) {
    await this.gitStore.init();
    const rootGit = simpleGit(path.resolve(this.config.project.repo));
    const configuredGit = this.config.workspace.git;
    if (configuredGit.user_name) await rootGit.addConfig("user.name", configuredGit.user_name, false, "local");
    if (configuredGit.user_email) await rootGit.addConfig("user.email", configuredGit.user_email, false, "local");
    if (configuredGit.remote && configuredGit.remote_url) {
      const exists = (await rootGit.getRemotes()).some((entry) => entry.name === configuredGit.remote);
      if (exists) {
        await rootGit.raw(["remote", "set-url", configuredGit.remote, configuredGit.remote_url]);
        await rootGit.raw(["config", "--local", "--unset-all", `remote.${configuredGit.remote}.pushurl`]).catch(() => undefined);
      } else await rootGit.addRemote(configuredGit.remote, configuredGit.remote_url);
    }
    this.registerAgent({ spec: adm.spec, sessionId: adm.sessionId, workers: [] });
    for (const l of leaders) {
      this.registerAgent({ spec: l.spec, sessionId: l.sessionId, workers: [], leaderTeam: l.team });
      this.teamByLeaderId.set(l.spec.id, l.team);
    }
    await this.restoreSchedulerState();
    for (const agentId of this.taskQueueByAgent.keys()) {
      if (this.agents.has(agentId)) this.requestSchedule(agentId);
    }
  }

  /** Open the startup gate only after Admin, Leaders, and every Worker exist. */
  startScheduling(): void {
    if (this.schedulingEnabled) return;
    this.schedulingEnabled = true;
    this.observabilityHub.emit({ source: "orchestrator", type: "scheduler.ready", payload: { restoredTasks: this.taskById.size } });
    for (const agentId of this.taskQueueByAgent.keys()) {
      if (this.agents.has(agentId)) this.requestSchedule(agentId);
    }
  }

  private getSkillsForLeader(team: TeamConfig): SkillEntry[] {
    return team.leader.skills ?? [];
  }

  private computeWorkerSkills(team: TeamConfig): SkillEntry[] {
    return [...(team.leader.skills ?? [])];
  }

  /** 构建 worker 专用编排工具（仅包含 worker 需要的工具子集）。 */
  private buildWorkerTools(spec: AgentInstanceSpec): ReturnType<typeof defineTool>[] {
    const tm = this;

    const createTaskTool = defineTool({
      name: "create-task", label: "Create Task", description: "Queue a task and check active conflicts before creation.",
      parameters: Type.Object({ targetAgentId: Type.String(), prompt: Type.String(), conflictKey: Type.Optional(Type.String()) }),
      execute: async (_id, params) => ({ content: [{ type: "text" as const, text: JSON.stringify(await tm.createTask({ ...params, createdBy: spec.id })) }], details: {} }),
    });
    const updateTaskTool = defineTool({
      name: "update-task", label: "Update Task", description: "Modify or cancel a queued task.",
      parameters: Type.Object({ id: Type.String(), prompt: Type.Optional(Type.String()), conflictKey: Type.Optional(Type.String()), status: Type.Optional(Type.Union([Type.Literal(QueuedTaskStatusEnum.Queued), Type.Literal(QueuedTaskStatusEnum.Cancelled)])) }),
      execute: async (_id, params) => ({ content: [{ type: "text" as const, text: JSON.stringify(await tm.updateTask(params)) }], details: {} }),
    });
    const deleteTaskTool = defineTool({
      name: "delete-task", label: "Delete Task", description: "Delete a non-running task.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => ({ content: [{ type: "text" as const, text: JSON.stringify(await tm.deleteTask(params.id)) }], details: {} }),
    });
    const queryTasksTool = defineTool({
      name: "query-tasks", label: "Query Tasks", description: "List queue task states.",
      parameters: Type.Object({ agentId: Type.Optional(Type.String()) }),
      execute: async (_id, params) => ({ content: [{ type: "text" as const, text: JSON.stringify(tm.getTasks(params.agentId)) }], details: {} }),
    });

    const notifyCompleteTool = defineTool({
      name: "notify-complete",
      label: "Notify Complete",
      description: "Notify orchestrator that a worker has completed its work.",
      parameters: Type.Object({
        agentRole: Type.Union(
          [
            Type.Literal(AgentRoleEnum.Worker),
            Type.Literal(AgentRoleEnum.Leader),
            Type.Literal(AgentRoleEnum.Admin),
          ],
          { description: "Which role is completing" }
        ),
        agentId: Type.Optional(Type.String({ description: "Agent id (optional; defaults to current agent)" })),
        changelog: Type.Optional(Type.String({ description: "Optional CHANGELOG content" })),
      }),
      execute: async (_toolCallId, params) => {
        const result = await tm.notifyComplete({ ...params, agentId: spec.id, agentRole: spec.role });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      },
    });

    const submitReviewTool = defineTool({
      name: "submit-review",
      label: "Submit Review",
      description: "Commit the current task branch and create a Leader review request. This never merges code.",
      parameters: Type.Object({
        tests: Type.Optional(Type.Array(Type.Object({
          command: Type.String(),
          status: Type.Union([Type.Literal(ReviewTestStatusEnum.Passed), Type.Literal(ReviewTestStatusEnum.Failed), Type.Literal(ReviewTestStatusEnum.Unknown)]),
          evidencePath: Type.Optional(Type.String()),
        }))),
      }),
      execute: async (_toolCallId, params) => {
        const review = await tm.submitReview(spec.id, params.tests ?? []);
        return { content: [{ type: "text" as const, text: JSON.stringify(review) }], details: {} };
      },
    });

    const reportProgressTool = defineTool({
      name: "report-progress",
      label: "Report Progress",
      description: "Report progress for long running tasks.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent id" }),
        stage: Type.Optional(Type.String({ description: "Execution stage" })),
        message: Type.String({ description: "Progress message" }),
      }),
      execute: async (_toolCallId, params) => {
        const result = await tm.reportProgress({ ...params, agentId: spec.id });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      },
    });

    const generateChangelogTool = defineTool({
      name: "generate-changelog",
      label: "Generate Changelog",
      description: "Generate or read CHANGELOG.md for an agent workspace.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent id whose workspace changelog to read" }),
      }),
      execute: async () => {
        const result = await tm.generateChangelog(spec.id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      },
    });

    // Workers implement and self-test exactly one owned queue item. Queue
    // mutation and completion tools would let them alter another Agent's
    // workflow or bypass the persisted review handoff.
    return [queryTasksTool, submitReviewTool, reportProgressTool, generateChangelogTool];
  }

  /**
   * 拉起单个 Worker：workspace → pi 会话 → 注册拓扑与事件桥（不下发任务 prompt）。
   */
  private async spawnSingleWorker(leader: AgentRuntimeState, team: TeamConfig, workerIndex: number): Promise<void> {
    const leaderId = leader.spec.id;
    const workerId = `${team.name}-worker-${workerIndex}`;
    const workerModel = team.worker.model ?? team.leader.model ?? this.config.admin.model ?? this.config.model;
    if (!workerModel) {
      throw new Error(t("worker_model_missing", { teamName: team.name }));
    }

    const leaderSkills = this.getSkillsForLeader(team);
    const sparsePaths = team.leader.repos ?? [];

    const branch = `${team.branch_prefix}/worker-${workerIndex}`;
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "worker.bootstrap.start",
      agentId: workerId,
      role: AgentRoleEnum.Worker,
      sessionId: "",
      payload: { leaderId, teamName: team.name, taskIndex: workerIndex },
    });
    const spec: AgentInstanceSpec = {
      id: workerId,
      role: AgentRoleEnum.Worker,
      teamName: team.name,
      name: workerId,
      branch,
      workspacePath: path.join(this.config.workspace.root_dir, workerId),
      model: rewriteModelProviderByCompatibleType(workerModel, this.config.providers),
      skills: this.computeWorkerSkills(team),
    };

    await this.workspaceProvider.ensureWorkspace(spec, sparsePaths);

    // 设置 worker 工作目录的 git 身份
    const projectName = this.config.project.name;
    await setLocalGitIdentity(
      spec.workspacePath,
      `${team.name}-worker-${workerIndex}`,
      `worker-${workerIndex}-${team.name}@project-${projectName}.oat`,
    );

    const workerSkills: SkillEntry[] = [...leaderSkills, ...(team.worker.extra_skills ?? [])];
    spec.skills = workerSkills;
    
    if (team.worker.skill_sync !== WorkerSkillSyncEnum.Manual) {
      await this.skillResolver.installSkillsToWorkspace(workerSkills, spec.workspacePath);
    }

    const workerScopeCtx: OatWorkspaceScopeContext = {
      workspaceRoot: this.config.workspace.root_dir,
      workspacePath: spec.workspacePath,
      role: AgentRoleEnum.Worker,
      teamName: team.name,
      teams: this.config.teams.map((t) => ({ name: t.name, worker: { total: t.worker.total } })),
    };
    await writeAgentWorkspaceConfig({
      workspacePath: spec.workspacePath,
      agentName: spec.name,
      role: AgentRoleEnum.Worker,
      scopeCtx: workerScopeCtx,
      orchestratorBaseUrl: this.orchestratorBaseUrl,
      runtimeMetaPath: path.join(this.gitStore.root, "agent-meta", workerId, "pool"),
    });

    const workerSystemPrompt = buildAgentSystemPrompt({
      agentName: spec.name,
      description: `Worker agent for ${team.name} (index ${workerIndex})`,
      role: AgentRoleEnum.Worker,
      promptText: team.worker.prompt,
    });

    const workerTools = this.buildWorkerTools(spec);
    await this.runtimeProvider.start(spec, {
      systemPrompt: workerSystemPrompt,
      customTools: workerTools,
    });

    const sessionId = spec.id;
    this.registerAgent({ spec, sessionId, workers: [] });
    leader.workers.push(workerId);
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "worker.spawned",
      agentId: workerId,
      role: AgentRoleEnum.Worker,
      sessionId,
      payload: { leaderId, teamName: team.name, taskIndex: workerIndex },
    });
    this.observabilityHub.enableDiskLogger(spec.workspacePath, workerId);

    logger.info(t("worker_registered"), { workerId });
  }

  private buildWorkerDispatchPrompt(workerId: string, taskPrompt: string): string {
    const todayPath = todayRecordsSubPath();
    return [
      taskPrompt,
      ``,
      `Rules (MUST follow):`,
      `- You own the full delivery for this task: implement it, run the relevant tests yourself, inspect the results, and fix failures before reporting completion. Do NOT delegate testing to another Worker.`,
      `- Your completion is a Git review handoff, not a request for a separate test task. Include the tests run and their result in CHANGELOG.md.`,
      `- Append your new entries to the END of the workspace root CHANGELOG.md according to the system constraints. Do NOT overwrite existing content (if there are no code changes, still record the reason).`,
      `- All other work-process files (analysis notes, drafts, logs, intermediate outputs) MUST be placed under \`${todayPath}/\`. Create it (mkdir -p) if it does not exist.`,
      `- Report execution progress using tool report-progress:`,
      `  { "agentId": "${workerId}", "stage": "<stage>", "message": "<short message>" }`,
      `- You MUST call report-progress at least 3 times:`,
      `  1) stage="start" (when you begin working),`,
      `  2) stage="changelog_update" (immediately after finishing CHANGELOG.md update),`,
      `  3) stage="before_submit_review" (right before calling submit-review).`,
      `- Optionally call stage="done" after submit-review returns.`,
      `- After updating CHANGELOG.md and completing self-tests, MUST call tool submit-review exactly once with the test evidence. This creates a review request; it does NOT merge your branch.`,
      `- You MUST NOT rely on filling the changelog argument; it can be omitted.`,
    ].join("\n");
  }

  async registerWorkers(leaderId: string, body: ToolRegisterWorkersBody): Promise<SpawnWorkersResult> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) throw new Error(t("leader_has_no_team", { leaderId }));

    const count = body.count;
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(t("scheduler_worker_count_invalid"));
    }
    const plannedWorkerIds = Array.from({ length: count }, (_, i) => `${team.name}-worker-${i}`);
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "register_workers.start",
      agentId: leaderId,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: { teamName: team.name, count, plannedWorkerIds },
    });

    try {
      if (count > team.worker.total) {
        throw new Error(
          t("requested_workers_exceed_max", {
            workerCount: count,
            teamName: team.name,
            max: team.worker.total,
          })
        );
      }
      const workerIds: string[] = [];
      const workerIdsToSpawn: number[] = [];
      for (let i = 0; i < count; i++) {
        const wid = `${team.name}-worker-${i}`;
        workerIds.push(wid);
        if (this.agents.has(wid)) {
          if (!leader.workers.includes(wid)) leader.workers.push(wid);
        } else {
          workerIdsToSpawn.push(i);
        }
      }

      for (const i of workerIdsToSpawn) {
        await this.spawnSingleWorker(leader, team, i);
      }

      this.observabilityHub.emit({
        source: "orchestrator",
        type: "register_workers.done",
        agentId: leaderId,
        role: AgentRoleEnum.Leader,
        sessionId: leader.sessionId,
        payload: { workerIds },
      });
      return { workerIds };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "register_workers.error",
        agentId: leaderId,
        role: AgentRoleEnum.Leader,
        sessionId: leader.sessionId,
        payload: { error: err },
      });
      throw e;
    }
  }

  async dispatchWorkerTasks(leaderId: string, body: ToolDispatchWorkerTasksBody): Promise<{ ok: true; taskIds?: string[] }> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) throw new Error(t("leader_has_no_team", { leaderId }));
    const leaderTaskId = this.currentWorkflowTaskId(leaderId);
    const leaderTask = leaderTaskId ? this.taskById.get(leaderTaskId) : undefined;
    if (!leaderTask || leaderTask.status !== QueuedTaskStatusEnum.Running) {
      throw new Error(t("scheduler_dispatch_no_active_workflow", { leaderId }));
    }

    const tasks = body.tasks ?? [];
    if (tasks.length === 0) {
      throw new Error(t("scheduler_dispatch_requires_tasks"));
    }
    if (tasks.length > 1 && tasks.some((task) => task.independent !== true)) {
      throw new Error(t("scheduler_dispatch_requires_independence"));
    }
    // 下发即入队：忙碌 Worker 的任务保留在其队列中，绝不让 Leader 因此接管具体工作。
    const workerIds = Array.from({ length: team.worker.total }, (_, i) => `${team.name}-worker-${i}`)
      .filter((workerId) => this.agents.get(workerId)?.spec.role === AgentRoleEnum.Worker);
    if (workerIds.length === 0) throw new Error(t("scheduler_no_registered_workers", { teamName: team.name }));
    const projectedLoads = new Map(workerIds.map((workerId) => [workerId, (this.taskQueueByAgent.get(workerId) ?? []).filter((taskId) => {
      const status = this.taskById.get(taskId)?.status;
      return status === QueuedTaskStatusEnum.Queued || status === QueuedTaskStatusEnum.Running;
    }).length]));
    const assignments = tasks.map((request) => {
      const prompt = request.prompt?.trim();
      if (!prompt) throw new Error(t("scheduler_dispatch_prompt_required"));
      const workerId = request.index === undefined
        ? workerIds.reduce((best, candidate) =>
            (projectedLoads.get(candidate) ?? 0) < (projectedLoads.get(best) ?? 0) ? candidate : best)
        : `${team.name}-worker-${request.index}`;
      if (this.agents.get(workerId)?.spec.role !== AgentRoleEnum.Worker) {
        throw new Error(t("worker_not_registered", { workerId }));
      }
      projectedLoads.set(workerId, (projectedLoads.get(workerId) ?? 0) + 1);
      return { workerId, request: { ...request, prompt } };
    });
    const batchConflictKeys = new Set<string>();
    for (const { request } of assignments) {
      const key = request.conflictKey?.trim();
      if (key && batchConflictKeys.has(key)) throw new Error(t("scheduler_duplicate_conflict_key", { key }));
      if (key) batchConflictKeys.add(key);
    }
    const taskIds: string[] = [];
    const createdTasks: QueuedTask[] = [];
    try {
      for (const { workerId, request } of assignments) {
        const task = await this.createTask({
          targetAgentId: workerId,
          createdBy: leaderId,
          parentTaskId: leaderTaskId,
          prompt: request.prompt,
          conflictKey: request.conflictKey,
        }, { schedule: false });
        createdTasks.push(task);
        taskIds.push(task.id);
      }
    } catch (error) {
      // No Worker has been scheduled yet, so a failed batch can be rolled back
      // without leaving a partially accepted dispatch behind.
      for (const task of createdTasks) {
        this.taskById.delete(task.id);
        this.removeTaskFromActiveQueue(task);
        this.emitTaskEvent("task.dispatch_rolled_back", task);
      }
      await this.persistSchedulerState();
      throw error;
    }
    this.leaderDispatchStartedAt.set(leaderId, Date.now());
    // Children now own the execution. Preserve the Leader's integration
    // workflow, while accurately exposing it as a non-blocking wait.
    leaderTask.status = QueuedTaskStatusEnum.Waiting;
    leaderTask.updatedAt = new Date().toISOString();
    this.runningTaskByAgent.delete(leaderId);
    this.emitTaskEvent("task.waiting_for_workers", leaderTask);
    await this.persistSchedulerState();
    for (const workerId of new Set(assignments.map((assignment) => assignment.workerId))) this.requestSchedule(workerId);
    // Dispatch is a short control-plane turn. Once children own execution,
    // the Leader can immediately dispatch its next queued workflow.
    this.requestSchedule(leaderId);
    this.observabilityHub.emit({
      source: "orchestrator", type: "dispatch_worker_tasks.queued", agentId: leaderId,
      role: AgentRoleEnum.Leader, sessionId: leader.sessionId,
      payload: { teamName: team.name, taskCount: tasks.length, taskIds },
    });
    return { ok: true, taskIds };

    /* Legacy direct-dispatch implementation retained below temporarily for reference.
    const legacyTeam = team!;
    this.leaderDispatchStartedAt.set(leaderId, Date.now());
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "dispatch_worker_tasks.start",
      agentId: leaderId,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: { teamName: legacyTeam.name, taskCount: tasks.length },
    });

    try {
      const teamWorkerIds = Array.from({ length: legacyTeam.worker.total }, (_, i) => `${legacyTeam.name}-worker-${i}`);
      const claimedThisDispatch = new Set<string>();
      const pickIdleWorker = (): string | undefined => {
        for (const wid of teamWorkerIds) {
          if (claimedThisDispatch.has(wid)) continue;
          if (!this.workerBusy.has(wid)) return wid;
        }
        return undefined;
      };

      for (let i = 0; i < tasks.length; i++) {
        const idx = tasks[i].index ?? i;
        const workerId =
          tasks[i].index === undefined ? (pickIdleWorker() ?? "") : `${legacyTeam.name}-worker-${idx}`;
        if (!workerId) {
          throw new Error(
            `No idle workers available for team=${legacyTeam.name}. ` +
              `Wait for workers to call notify-complete, or explicitly set tasks[].index.`,
          );
        }
        let agent: AgentRuntimeState;
        try {
          agent = this.getAgent(workerId);
        } catch {
          throw new Error(t("worker_not_registered", { workerId }));
        }
        if (agent.spec.role !== AgentRoleEnum.Worker) {
          throw new Error(t("worker_not_registered", { workerId }));
        }

        // 显式指定 index 时：如果 worker 正忙，拒绝本次下发，避免把多轮任务叠到同一个 worker。
        if (tasks[i].index !== undefined) {
          const busy = this.workerBusy.get(workerId);
          if (busy) {
            const busyInfo = busy as { leaderId: string; taskIndex: number; startedAt: number };
            throw new Error(
              `Worker is busy: workerId=${workerId} (leaderId=${busyInfo.leaderId}, taskIndex=${busyInfo.taskIndex}). ` +
                `Wait for notify-complete or choose another worker index.`,
            );
          }
        } else {
          // 自动分配模式：同一批次内不重复选中同一个 worker
          claimedThisDispatch.add(workerId);
        }

        // 若该 Worker 已完成过上一轮任务，则先重置 session（清空历史），再下发新任务
        // 同时清除上一轮的完成/崩溃记录，以确保本轮超时监控与崩溃通知正常触发
        if (this.workerNotifyCompleteAt.has(workerId)) {
          this.workerNotifyCompleteAt.delete(workerId);
          this.crashedAgents.delete(workerId);
          this.workerBusy.delete(workerId);
          try {
            await this.runtimeProvider.resetSession(workerId);
          } catch (resetErr) {
            // resetSession 内部 stop + start：若 start 失败，子进程已消失。
            // 将该 worker 视为崩溃：从 agents 移除并通知 leader，然后跳过本 worker。
            const error = new Error(String(resetErr));
            logger.error("Failed to reset worker session, treating as crash", {
              workerId,
              error: error.message,
            });
            void this.handleAgentCrash(workerId, error);
            continue;
          }
        }

        const prompt = this.buildWorkerDispatchPrompt(workerId, tasks[i].prompt);
        const promptPreview = tasks[i].prompt.length > 200 ? `${tasks[i].prompt.slice(0, 197)}...` : tasks[i].prompt;
        this.observabilityHub.emit({
          source: "orchestrator",
          type: "worker.task.dispatched",
          agentId: workerId,
          role: AgentRoleEnum.Worker,
          sessionId: agent.sessionId,
          payload: { leaderId, taskIndex: idx, promptPreview },
        });

        // fire-and-forget：Worker 并行执行，通过 notify-complete 工具回报完成
        this.workerBusy.set(workerId, { leaderId, taskIndex: idx, startedAt: Date.now() });
        void this.runtimeProvider.sendPrompt(workerId, prompt).catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          this.workerBusy.delete(workerId);
          this.observabilityHub.emit({
            source: "orchestrator",
            type: "worker.dispatch_failed",
            agentId: workerId,
            role: AgentRoleEnum.Worker,
            sessionId: agent.sessionId,
            payload: { leaderId, taskIndex: idx, error: error.message },
          });
          // 通知 Leader 该 Worker 无法执行任务（发送失败视为崩溃）
          void this.handleAgentCrash(workerId, error);
        });

        const NOTIFY_COMPLETE_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
        setTimeout(() => {
          if (!this.workerNotifyCompleteAt.has(workerId)) {
            this.observabilityHub.emit({
              source: "orchestrator",
              type: "worker.notify_complete_timeout",
              agentId: workerId,
              role: AgentRoleEnum.Worker,
              sessionId: agent.sessionId,
              payload: { leaderId, taskIndex: idx, timeoutMs: NOTIFY_COMPLETE_TIMEOUT_MS },
            });
          }
        }, NOTIFY_COMPLETE_TIMEOUT_MS).unref();

        logger.info(t("worker_task_dispatched"), { workerId, taskIndex: idx });
      }

      this.observabilityHub.emit({
        source: "orchestrator",
        type: "dispatch_worker_tasks.done",
        agentId: leaderId,
        role: AgentRoleEnum.Leader,
        sessionId: leader.sessionId,
        payload: { taskCount: tasks.length },
      });
      return { ok: true };
    } catch (e) {
      const err = String(e);
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "dispatch_worker_tasks.error",
        agentId: leaderId,
        role: AgentRoleEnum.Leader,
        sessionId: leader.sessionId,
        payload: { error: err },
      });
      throw e;
    } */
  }

  async assignLeaderTask(leaderId: string, prompt: string): Promise<{ ok: true; taskId: string }> {
    const leader = this.getAgent(leaderId);
    if (leader.spec.role !== AgentRoleEnum.Leader) {
      throw new Error(t("scheduler_role_expected", { agentId: leaderId, role: AgentRoleEnum.Leader }));
    }
    if (this.crashedAgents.has(leaderId)) {
      throw new Error(t("scheduler_leader_crashed", { leaderId }));
    }
    const admin = Array.from(this.agents.values()).find((agent) => agent.spec.role === AgentRoleEnum.Admin);
    const adminTaskId = admin ? this.runningTaskByAgent.get(admin.spec.id) : undefined;
    if (admin && !adminTaskId) {
      const previousAdminTaskId = this.lastCompletedWorkflowByAgent.get(admin.spec.id);
      const existing = Array.from(this.taskById.values()).find((task) =>
        task.targetAgentId === leaderId && task.prompt === prompt.trim() && (
          task.parentTaskId === previousAdminTaskId ||
          (Boolean(task.parentTaskId) && this.taskById.get(task.parentTaskId!)?.status === QueuedTaskStatusEnum.Waiting)
        ),
      );
      if (existing) return { ok: true, taskId: existing.id };
      throw new Error(t("scheduler_admin_no_active_task", { adminId: admin.spec.id }));
    }
    const task = await this.createTask({ targetAgentId: leaderId, createdBy: admin?.spec.id ?? "admin", parentTaskId: adminTaskId, prompt });
    if (admin && adminTaskId) {
      await this.reportProgress({
        agentId: admin.spec.id,
        stage: "delegated",
        message: t("scheduler_delegated", { leaderName: leader.spec.name, taskId: task.id }),
      });
      await this.waitForDelegatedWorkflow(admin.spec.id);
    }
    logger.info(t("scheduler_leader_task_queued", { taskId: task.id }), { leaderId });
    return { ok: true, taskId: task.id };
  }

  async sendAdminOperatorInstruction(prompt: string): Promise<{ ok: true; taskId: string }> {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error(t("scheduler_prompt_required", { operation: "admin_instruction" }));

    const admin = Array.from(this.agents.values()).find((a) => a.spec.role === AgentRoleEnum.Admin);
    if (!admin) throw new Error(t("admin_not_found"));

    const preview = trimmed.length > 250 ? `${trimmed.slice(0, 247)}...` : trimmed;
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "admin.operator_instruction",
      agentId: admin.spec.id,
      role: AgentRoleEnum.Admin,
      sessionId: admin.sessionId,
      payload: { preview },
    });

    // Operator input must use the same observable FIFO as every other Admin
    // task. Direct runtime sends otherwise silently bypass TaskManager.
    const task = await this.createTask({
      targetAgentId: admin.spec.id,
      createdBy: "operator",
      prompt: trimmed,
    });
    return { ok: true, taskId: task.id };
  }

  hasLeaderTaskAssigned(leaderId: string): boolean {
    return this.leaderTaskAssignedAt.has(leaderId);
  }

  hasLeaderDispatchStarted(leaderId: string): boolean {
    return this.leaderDispatchStartedAt.has(leaderId);
  }



  async notifyComplete(body: NotifyCompleteBody): Promise<any> {
    const { agentRole, agentId } = body;

    // 先验证 agent 是否存在：Worker 路径依赖 agent 状态，未知 agentId 必须提前拒绝
    const agent = this.agents.get(agentId);
    if (!agent) {
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "notify_complete.unknown_agent",
        agentId,
        role: agentRole,
        payload: { hasChangelog: Boolean(body.changelog) },
      });
      // Worker 未知则直接报错（不能假定 merge 成功）；其他角色静默忽略
      if (agentRole === AgentRoleEnum.Worker) {
        throw new Error(t("agent_not_found", { agentId }));
      }
      return { ok: true };
    }
    if (agent.spec.role !== agentRole) {
      throw new Error(t("scheduler_notify_role_mismatch", { agentId, actual: agent.spec.role, expected: agentRole }));
    }

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "notify_complete",
      agentId,
      role: agentRole,
      sessionId: agent.sessionId,
      payload: { hasChangelog: Boolean(body.changelog) },
    });

    if (agentRole === AgentRoleEnum.Worker) {
      throw new Error(t("scheduler_worker_must_submit_review"));
      /* legacy completion path retained below for source history.
      // 幂等保护：Worker 已成功完成（时间戳已写入）时直接返回，
      // 防止 LLM 重复调用 notify-complete 触发重复 merge + 重复 leader prompt。
      if (this.workerNotifyCompleteAt.has(agentId)) {
        return { ok: true, alreadyCompleted: true };
      }
      try {
        // 时间戳必须在 merge 成功后写入：若 merge 失败时间戳已写，
        // 下一轮 dispatchWorkerTasks 会误判为"上轮已完成"，跳过 resetSession 直接发任务。
        const result = await this.handleWorkerComplete(agentId, body.changelog);
        this.workerNotifyCompleteAt.set(agentId, Date.now());
        this.workerBusy.delete(agentId);
        await this.completeRunningTask(agentId);
        return result;
      } catch (e) {
        this.observabilityHub.emit({
          source: "orchestrator",
          type: "notify_complete.error",
          agentId,
          role: agentRole,
          payload: { error: e instanceof Error ? e.message : String(e) },
        });
        throw e;
      }
    } */
    }
    if (agentRole === AgentRoleEnum.Leader) {
      const team = agent.leaderTeam;
      const leaderTaskId = this.currentWorkflowTaskId(agentId);
      const activeWorkerTasks = team
        ? Array.from({ length: team.worker.total }, (_, index) => `${team.name}-worker-${index}`)
          .flatMap((workerId) => this.getTasks(workerId))
          .filter((task) => task.parentTaskId === leaderTaskId)
          .filter((task) => task.status === QueuedTaskStatusEnum.Queued || task.status === QueuedTaskStatusEnum.Running || task.status === QueuedTaskStatusEnum.ReviewPending)
        : [];
      if (activeWorkerTasks.length > 0) {
        throw new Error(t("scheduler_leader_completion_blocked", { leaderId: agentId, count: activeWorkerTasks.length }));
      }
      // Tool calls can be retried after their response is generated. Once a
      // workflow has left both active maps, only an immediately preceding
      // successful completion is idempotent; an idle Leader is otherwise an
      // invalid caller.
      if (!this.currentWorkflowTaskId(agentId)) {
        if (this.lastCompletedWorkflowByAgent.has(agentId)) return { ok: true, alreadyCompleted: true };
        throw new Error(t("scheduler_leader_no_active_work", { leaderId: agentId }));
      }
      try {
        const pending = (this.taskQueueByAgent.get(agentId) ?? []).some((taskId) => this.taskById.get(taskId)?.status === QueuedTaskStatusEnum.Queued);
        const result = await this.handleLeaderComplete(agentId, body.changelog, !pending);
        await this.completeWorkflowTask(agentId);
        // Leader is a reusable control-plane agent; releases are handled by the
        // MergeController, so completing one work item never tears it down.
        return result;
      } catch (e) {
        this.observabilityHub.emit({
          source: "orchestrator",
          type: "notify_complete.error",
          agentId,
          role: agentRole,
          payload: { error: e instanceof Error ? e.message : String(e) },
        });
        throw e;
      }
    }
    
    if (agentRole === AgentRoleEnum.Admin) {
      // An LLM can retry a tool call after receiving its result. Only the
      // first call that owns an active Admin task may run completion side
      // effects (including the optional Git push).
      if (!this.runningTaskByAgent.has(agentId)) {
        return { ok: true, alreadyCompleted: true };
      }
      await this.completeRunningTask(agentId);
      return { ok: true };
    }

    return { ok: true };
  }

  private async pushNotification(text: string, media?: any): Promise<void> {
    const push = this.config.admin.push_channel;
    if (!push) return;
    try {
      const { Notifier } = await import("../plugins/notifier");
      await Notifier.sendNotification({
        channel: push.channel,
        account: push.account,
        text,
        media
      });
    } catch (err: any) {
      logger.warn(t("scheduler_event_delivery_failed", { operation: "notification", error: err.message }));
    }
  }

  async reportProgress(body: any): Promise<any> {
    const agentId = body?.agentId as string | undefined;
    const stage = typeof body?.stage === "string" ? body.stage : undefined;
    const message = typeof body?.message === "string" ? body.message : "";
    if (agentId) {
      try {
        const agent = this.getAgent(agentId);
        const taskId = this.currentWorkflowTaskId(agentId);
        const task = taskId ? this.taskById.get(taskId) : undefined;
        if (task) {
          task.lastProgress = { stage, message, at: new Date().toISOString() };
          this.checkpointTask(task, "progress");
          this.emitTaskEvent("task.progress", task);
        }
        this.observabilityHub.emit({
          source: "orchestrator",
          type: "report_progress",
          agentId,
          role: agent.spec.role,
          sessionId: agent.sessionId,
          // Associate progress with the Agent's currently running queue item so
          // clients can keep independent task conversations separate.
          payload: { stage, message, taskId },
        });

        // 异步向绑定渠道通知进度，防止阻碍编排逻辑
        void this.pushNotification(
          t("notification_progress", { agentId, stage: stage || "N/A", message })
        );
      } catch {
        this.observabilityHub.emit({
          source: "orchestrator",
          type: "report_progress.unknown_agent",
          agentId,
          payload: { stage, message },
        });
      }
    }
    return { ok: true };
  }

  /**
   * 处理 Agent 崩溃：记录可观测事件，并向上一层 Agent 推送崩溃通知。
   * - Worker 崩溃 → 通知所属 Leader，Leader 可选择跳过或重新分配任务
   * - Leader 崩溃 → 通知 Admin，Admin 可选择重新分配给其他 Leader 或终止
   *
   * 同一 agentId 的崩溃通知只发送一次（`crashedAgents` 去重）。
   * 在 `resetSession` 重新派发前或 `cleanupLeaderAndWorkers` 清理时会清除对应记录。
   */
  async handleAgentCrash(agentId: string, error: Error): Promise<void> {
    if (this.crashedAgents.has(agentId)) return;

    // 必须先确认 agent 存在再写入去重集合：若 agentId 未知则不占用去重槽，
    // 避免误报导致后续真实崩溃被压制。
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const interruptedTaskId = this.currentWorkflowTaskId(agentId);
    this.crashedAgents.add(agentId);
    this.promptActiveAgents.delete(agentId);
    this.workerBusy.delete(agentId);
    await this.failActiveWorkflow(agentId, t("scheduler_agent_crashed", { error: error.message }));

    const role = agent.spec.role;
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "agent.crash",
      agentId,
      role,
      sessionId: agent.sessionId,
      payload: { error: error.message },
    });
    logger.warn(t("scheduler_event_delivery_failed", { operation: "agent_runtime", error: error.message }), { agentId, role });

    // 推送崩溃通知至关联通知渠道
    void this.pushNotification(
      t("notification_agent_crashed", { agentId, role, error: error.message })
    );

    // The process may have exited because of a transient transport or model
    // compatibility failure. Restart its empty session once, then re-open its
    // still-queued work. Active workflows remain failed rather than replaying
    // side effects; queued tasks are safe to schedule again.
    this.scheduleAgentRecovery(agentId);

    if (role === AgentRoleEnum.Worker) {
      const teamName = agent.spec.teamName ?? "";
      let team: TeamConfig | undefined;
      try { team = this.resolveTeam(teamName); } catch { return; }

      const leader = Array.from(this.agents.values()).find(
        (a) => a.spec.role === AgentRoleEnum.Leader && a.spec.teamName === team!.name,
      );
      if (!leader) return;

      this.observabilityHub.emit({
        source: "orchestrator",
        type: "agent.crash.notify_leader",
        agentId: leader.spec.id,
        role: AgentRoleEnum.Leader,
        sessionId: leader.sessionId,
        payload: { crashedWorkerId: agentId, error: error.message },
      });

      if (interruptedTaskId) {
        void this.deliverWorkerCrashNotice(leader.spec.id, interruptedTaskId, error.message);
      }

    } else if (role === AgentRoleEnum.Leader) {
      const admin = Array.from(this.agents.values()).find(
        (a) => a.spec.role === AgentRoleEnum.Admin,
      );
      if (!admin) return;

      this.observabilityHub.emit({
        source: "orchestrator",
        type: "agent.crash.notify_admin",
        agentId: admin.spec.id,
        role: AgentRoleEnum.Admin,
        sessionId: admin.sessionId,
        payload: { crashedLeaderId: agentId, error: error.message },
      });

      await this.createTask({
        targetAgentId: admin.spec.id,
        createdBy: "orchestrator",
        prompt: [
          `LEADER_CRASH: Leader ${agentId} encountered a fatal error and cannot complete its task.`,
          `Error: ${error.message}`,
          ``,
          `You can:`,
          `1. Reassign the task to another suitable leader via assign-leader-task.`,
          `2. Report the failure as the final delivery result.`,
        ].join("\n"),
      });
    }
  }

  private scheduleAgentRecovery(agentId: string): void {
    if (this.recoveringAgents.has(agentId)) return;
    this.recoveringAgents.add(agentId);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await this.runtimeProvider.resetSession(agentId);
          this.crashedAgents.delete(agentId);
          this.promptActiveAgents.delete(agentId);
          this.observabilityHub.emit({
            source: "orchestrator",
            type: "agent.recovered",
            agentId,
            role: this.getAgent(agentId).spec.role,
            payload: {},
          });
          this.requestSchedule(agentId);
        } catch (recoveryError) {
          logger.warn(t("scheduler_event_delivery_failed", {
            operation: "agent_runtime_recovery",
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          }), { agentId });
        } finally {
          this.recoveringAgents.delete(agentId);
        }
      })();
    }, 400);
    timer.unref();
  }

  async generateChangelog(agentId: string): Promise<any> {
    const agent = this.getAgent(agentId);
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "tool.generate_changelog",
      agentId,
      role: agent.spec.role,
      sessionId: agent.sessionId,
      payload: {},
    });
    const mgr = new ChangelogManager();
    const changelog = await mgr.readChangelog(agent.spec.workspacePath);
    return { ok: true, changelog };
  }

  private async handleLeaderComplete(leaderId: string, changelog?: string, cleanup = true): Promise<any> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) throw new Error(t("leader_team_missing"));
    const taskId = this.currentWorkflowTaskId(leaderId);
    const proposalId = taskId ? this.releaseByLeaderTask.get(taskId) : undefined;
    if (!proposalId) {
      throw new Error(t("scheduler_release_proposal_required"));
    }
    const proposal = await this.gitStore.loadRelease(proposalId);
    const leaderTask = taskId ? this.taskById.get(taskId) : undefined;
    if (leaderTask) {
      this.recordDeliveryReport(leaderTask, {
        id: `delivery-${proposal.id}`,
        taskId: leaderTask.id,
        agentId: leaderId,
        role: AgentRoleEnum.Leader,
        stage: "release_submitted",
        summary: changelog?.trim() || proposal.note?.trim() || "",
        createdAt: proposal.createdAt,
        releaseProposalId: proposal.id,
        branch: proposal.integrationBranch,
        artifactPaths: proposal.artifactPaths,
      });
    }
    const admin = Array.from(this.agents.values()).find((a) => a.spec.role === AgentRoleEnum.Admin);
    if (!admin) throw new Error(t("admin_not_found"));
    // The Admin root task is completed after it acknowledges delegation. Link
    // the downstream delivery back to that original task so the operator gets
    // a final answer in the same conversation instead of an unbound internal
    // RELEASE_PROPOSAL prompt.
    const rootTask = leaderTask?.parentTaskId ? this.taskById.get(leaderTask.parentTaskId) : undefined;
    if (rootTask) {
      const message = t("scheduler_release_waiting_approval", { teamName: team.name, proposalId: proposal.id });
      const at = new Date().toISOString();
      rootTask.lastProgress = { stage: "awaiting_approval", message, at };
      rootTask.updatedAt = at;
      this.emitTaskEvent("task.progress", rootTask);
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "report_progress",
        agentId: admin.spec.id,
        role: AgentRoleEnum.Admin,
        sessionId: admin.sessionId,
        payload: { taskId: rootTask.id, stage: "awaiting_approval", message },
      });
    }
    this.observabilityHub.emit({
      source: "orchestrator", type: "prompt.admin.release_proposal", agentId: admin.spec.id,
      role: AgentRoleEnum.Admin, sessionId: admin.sessionId,
      payload: { proposalId, artifactPaths: proposal.artifactPaths, integrationBranch: proposal.integrationBranch },
    });
    await this.createTask({
      targetAgentId: admin.spec.id,
      createdBy: leaderId,
      parentTaskId: rootTask?.id,
      prompt: `RELEASE_PROPOSAL:\n${JSON.stringify({ id: proposal.id, team: proposal.teamName, branch: proposal.integrationBranch, headSha: proposal.headSha, artifactPaths: proposal.artifactPaths, note: proposal.note }, null, 2)}\n\nAnalyze the status and use approve-release to approve or reject this delivery.`,
    });
    return { ok: true, releaseProposalId: proposalId, changelog };

    /* Legacy automatic leader-to-main merge path retained for migration history.

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "merge.leader_to_main.start",
      agentId: leaderId,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: { baseBranch: this.config.project.base_branch, leaderBranch: leader.spec.branch },
    });

    // 在 merge 前先 commit leader 的所有变更
    await commitWorkspaceChanges(
      leader.spec.workspacePath,
      `feat(${team.name}): leader task complete`,
    );

    await this.mergeManager.mergeToMain(
      leader.spec.workspacePath,
      leader.spec.branch,
      this.config.project.base_branch
    );

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "merge.leader_to_main.done",
      agentId: leaderId,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: {},
    });

    const mgr = new ChangelogManager();
    const cl = changelog ?? (await mgr.readChangelog(leader.spec.workspacePath));

    // 推送 Leader 团队目标达成通知
    void this.pushNotification(
      `[Leader Merged 🎉] Leader '${leaderId}' completed the team goal and successfully merged into main branch!\nChangelog:\n${cl}`
    );

    const admin = Array.from(this.agents.values()).find((a) => a.spec.role === AgentRoleEnum.Admin);
    if (!admin) throw new Error(t("admin_not_found"));

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "prompt.admin.after_leader",
      agentId: admin.spec.id,
      role: AgentRoleEnum.Admin,
      sessionId: admin.sessionId,
      payload: { leaderId },
    });
    await this.runtimeProvider.sendPrompt(
      admin.spec.id,
      `Leader ${leaderId} has completed and has been merged into main.\n\nYour delivery summary should include this team's CHANGELOG:\n${cl}`,
    );

    if (cleanup) {
      // Admin 已收到通知，异步清理 Leader 和 Worker 会话（释放内存，移除拓扑）
      this.cleanupLeaderAndWorkers(leaderId).catch((err: unknown) => {
        logger.warn(t("scheduler_event_delivery_failed", {
          operation: "agent_cleanup",
          error: err instanceof Error ? err.message : String(err),
        }), {
          leaderId,
        });
      });
    }

    return { ok: true, mergedToMain: true }; */
  }

  private async cleanupLeaderAndWorkers(leaderId: string): Promise<void> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) return;

    for (const wId of leader.workers) {
      const w = this.agents.get(wId);
      if (!w) continue;
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "agent.cleanup.worker",
        agentId: w.spec.id,
        role: AgentRoleEnum.Worker,
        sessionId: w.sessionId,
        payload: { leaderId },
      });
      try {
        await this.runtimeProvider.stop(w.spec.id);
      } catch {}
      // 清理 worker 相关的所有状态 Map，防止内存泄漏与下次使用时状态污染
      this.agents.delete(w.spec.id);
      this.crashedAgents.delete(w.spec.id);
      this.workerNotifyCompleteAt.delete(w.spec.id);
      this.workerBusy.delete(w.spec.id);
    }

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "agent.cleanup.leader",
      agentId: leader.spec.id,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: {},
    });
    try {
      await this.runtimeProvider.stop(leader.spec.id);
    } catch {}
    // 清理 leader 相关的所有状态 Map
    this.agents.delete(leader.spec.id);
    this.crashedAgents.delete(leader.spec.id);
    this.teamByLeaderId.delete(leader.spec.id);
    this.leaderTaskAssignedAt.delete(leader.spec.id);
    this.leaderDispatchStartedAt.delete(leader.spec.id);
  }
}
