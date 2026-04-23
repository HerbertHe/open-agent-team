import fs from "node:fs/promises";
import path from "node:path";
import { AgentRoleEnum } from "../types";
import type { ResolvedConfig, AgentInstanceSpec, TeamConfig } from "../types";
import type { WorkspaceProvider } from "../sandbox/interface";
import type { PiSessionProvider } from "../sandbox/local-process";
import { MergeManager } from "../git/merge-manager";
import { SkillResolver } from "../skills/skill-resolver";
import { ChangelogManager } from "../changelog/changelog-manager";
import {
  writeAgentWorkspaceConfig,
  buildAgentSystemPrompt,
  type OatWorkspaceScopeContext,
} from "../pi/workspace-inject";
import { logger } from "../utils/logger";
import { t } from "../i18n/i18n";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type {
  AgentRuntimeState,
  NotifyCompleteBody,
  SpawnWorkersResult,
  ToolDispatchWorkerTasksBody,
  ToolRegisterWorkersBody,
  ToolRequestWorkersBody,
} from "../types";
import type { ObservabilityGraph } from "../types";
import type { ObservabilityHub } from "./observability-hub";

export class TaskManager {
  private readonly agents = new Map<string, AgentRuntimeState>();
  private readonly teamByLeaderId = new Map<string, TeamConfig>();
  private readonly leaderTaskAssignedAt = new Map<string, number>();
  private readonly leaderDispatchStartedAt = new Map<string, number>();
  private readonly workerNotifyCompleteAt = new Map<string, number>();
  /** 已触发过崩溃通知的 agentId 集合，防止重复推送。 */
  private readonly crashedAgents = new Set<string>();
  /**
   * 已成功完成（notify-complete）的 Leader agentId 集合。
   * 作用一：幂等门控，防止 Leader 重复调用 notify-complete 触发重复 merge 和重复 admin prompt。
   * 作用二：防止 Admin 在 cleanup 进行中再次向同一个已完成 Leader 分配任务（竞态保护）。
   * cleanup 完成后不需要清除该记录，因为 Leader 进程已被终止、不会再被复用。
   */
  private readonly completedLeaders = new Set<string>();

  constructor(
    private readonly config: ResolvedConfig,
    private readonly workspaceProvider: WorkspaceProvider,
    private readonly runtimeProvider: PiSessionProvider,
    private readonly mergeManager: MergeManager,
    private readonly orchestratorBaseUrl: string,
    private readonly skillResolver: SkillResolver,
    private readonly observabilityHub: ObservabilityHub,
  ) {}

  getObservabilityHub(): ObservabilityHub {
    return this.observabilityHub;
  }

  getAllAgents(): AgentRuntimeState[] {
    return Array.from(this.agents.values());
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

    for (const a of this.agents.values()) {
      nodes.push({
        id: a.spec.id,
        role: a.spec.role,
        label: a.spec.name,
        teamName: a.spec.teamName,
        sessionId: a.sessionId,
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
    this.registerAgent({ spec: adm.spec, sessionId: adm.sessionId, workers: [] });
    for (const l of leaders) {
      this.registerAgent({ spec: l.spec, sessionId: l.sessionId, workers: [], leaderTeam: l.team });
      this.teamByLeaderId.set(l.spec.id, l.team);
    }
  }

  private getSkillsForLeader(team: TeamConfig): string[] {
    return team.leader.skills ?? [];
  }

  private computeWorkerSkills(team: TeamConfig): string[] {
    return [...(team.leader.skills ?? [])];
  }

  /** 构建 worker 专用编排工具（仅包含 worker 需要的工具子集）。 */
  private buildWorkerTools(spec: AgentInstanceSpec): ReturnType<typeof defineTool>[] {
    const tm = this;

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
        const agentId = params.agentId ?? spec.id;
        const result = await tm.notifyComplete({ ...params, agentId });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
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
        const result = await tm.reportProgress(params);
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
      execute: async (_toolCallId, params) => {
        const result = await tm.generateChangelog(params.agentId);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      },
    });

    return [notifyCompleteTool, reportProgressTool, generateChangelogTool];
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
      model: workerModel,
      skills: this.computeWorkerSkills(team),
    };

    await this.workspaceProvider.ensureWorkspace(spec, sparsePaths);

    const workerSkills = [...leaderSkills, ...(team.worker.extra_skills ?? [])];
    spec.skills = workerSkills;
    await this.skillResolver.syncSkillsToWorkspace(workerSkills, spec.workspacePath);

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
    });

    const workerSystemPrompt = buildAgentSystemPrompt({
      agentName: spec.name,
      description: `Worker agent for ${team.name} (index ${workerIndex})`,
      role: AgentRoleEnum.Worker,
      promptText: team.worker.prompt,
      skills: workerSkills,
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

    logger.info(t("worker_registered"), { workerId });
  }

  private buildWorkerDispatchPrompt(workerId: string, taskPrompt: string): string {
    return [
      taskPrompt,
      ``,
      `Rules (MUST follow):`,
      `- Update the workspace root CHANGELOG.md according to the system constraints (if there are no code changes, still record the reason).`,
      `- Report execution progress using tool report-progress:`,
      `  { "agentId": "${workerId}", "stage": "<stage>", "message": "<short message>" }`,
      `- You MUST call report-progress at least 3 times:`,
      `  1) stage="start" (when you begin working),`,
      `  2) stage="changelog_update" (immediately after finishing CHANGELOG.md update),`,
      `  3) stage="before_notify_complete" (right before calling notify-complete).`,
      `- Optionally call stage="done" after notify-complete returns.`,
      `- After updating CHANGELOG.md, MUST call tool notify-complete exactly once with:`,
      `  { "agentRole": "${AgentRoleEnum.Worker}", "agentId": "${workerId}" }`,
      `- You MUST NOT omit agentId; the orchestrator relies on it to find the correct Worker runtime.`,
      `- You MUST NOT rely on filling the changelog argument; it can be omitted.`,
    ].join("\n");
  }

  async registerWorkers(leaderId: string, body: ToolRegisterWorkersBody): Promise<SpawnWorkersResult> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) throw new Error(t("leader_has_no_team", { leaderId }));

    const count = body.count;
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error("register_workers: count must be an integer > 0");
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

  async dispatchWorkerTasks(leaderId: string, body: ToolDispatchWorkerTasksBody): Promise<{ ok: true }> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) throw new Error(t("leader_has_no_team", { leaderId }));

    const tasks = body.tasks ?? [];
    this.leaderDispatchStartedAt.set(leaderId, Date.now());
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "dispatch_worker_tasks.start",
      agentId: leaderId,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: { teamName: team.name, taskCount: tasks.length },
    });

    try {
      for (let i = 0; i < tasks.length; i++) {
        const idx = tasks[i].index ?? i;
        const workerId = `${team.name}-worker-${idx}`;
        let agent: AgentRuntimeState;
        try {
          agent = this.getAgent(workerId);
        } catch {
          throw new Error(t("worker_not_registered", { workerId }));
        }
        if (agent.spec.role !== AgentRoleEnum.Worker) {
          throw new Error(t("worker_not_registered", { workerId }));
        }

        // 若该 Worker 已完成过上一轮任务，则先重置 session（清空历史），再下发新任务
        // 同时清除上一轮的完成/崩溃记录，以确保本轮超时监控与崩溃通知正常触发
        if (this.workerNotifyCompleteAt.has(workerId)) {
          this.workerNotifyCompleteAt.delete(workerId);
          this.crashedAgents.delete(workerId);
          try {
            await this.runtimeProvider.resetSession(workerId);
          } catch (resetErr) {
            // resetSession 内部 stop + start：若 start 失败，子进程已消失。
            // 将该 worker 视为崩溃：从 agents 移除并通知 leader，然后跳过本 worker。
            const error = resetErr instanceof Error ? resetErr : new Error(String(resetErr));
            logger.error("Failed to reset worker session, treating as crash", {
              workerId,
              error: error.message,
            });
            this.agents.delete(workerId);
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
        void this.runtimeProvider.sendPrompt(workerId, prompt).catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
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
      const err = e instanceof Error ? e.message : String(e);
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "dispatch_worker_tasks.error",
        agentId: leaderId,
        role: AgentRoleEnum.Leader,
        sessionId: leader.sessionId,
        payload: { error: err },
      });
      throw e;
    }
  }

  async assignLeaderTask(leaderId: string, prompt: string): Promise<{ ok: true }> {
    const leader = this.getAgent(leaderId);
    if (leader.spec.role !== AgentRoleEnum.Leader) {
      throw new Error(`assignLeaderTask: agentId=${leaderId} is not a leader`);
    }
    // 已完成的 Leader 正在 cleanup 或已被清理，不再接受新任务，
    // 防止 cleanup 竞态导致 sendPrompt 向已退出的子进程发送消息。
    if (this.completedLeaders.has(leaderId)) {
      throw new Error(`assignLeaderTask: leader ${leaderId} has already completed and is being cleaned up`);
    }
    this.leaderTaskAssignedAt.set(leaderId, Date.now());

    const promptPreview = prompt.length > 250 ? `${prompt.slice(0, 247)}...` : prompt;
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "leader.task.assigned",
      agentId: leaderId,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: { promptPreview },
    });

    logger.info("leader task assigned", { leaderId });
    await this.runtimeProvider.sendPrompt(leaderId, `ADMIN_TASK:\n${prompt}`);
    return { ok: true };
  }

  async sendAdminDashboardInstruction(prompt: string): Promise<{ ok: true }> {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error("admin_instruction: prompt must be non-empty");

    const admin = Array.from(this.agents.values()).find((a) => a.spec.role === AgentRoleEnum.Admin);
    if (!admin) throw new Error(t("admin_not_found"));

    const preview = trimmed.length > 250 ? `${trimmed.slice(0, 247)}...` : trimmed;
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "admin.dashboard_instruction",
      agentId: admin.spec.id,
      role: AgentRoleEnum.Admin,
      sessionId: admin.sessionId,
      payload: { preview },
    });

    await this.runtimeProvider.sendPrompt(admin.spec.id, `DASHBOARD_INSTRUCTION:\n${trimmed}`);
    return { ok: true };
  }

  hasLeaderTaskAssigned(leaderId: string): boolean {
    return this.leaderTaskAssignedAt.has(leaderId);
  }

  hasLeaderDispatchStarted(leaderId: string): boolean {
    return this.leaderDispatchStartedAt.has(leaderId);
  }

  async requestWorkers(leaderId: string, body: ToolRequestWorkersBody): Promise<SpawnWorkersResult> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) throw new Error(t("leader_has_no_team", { leaderId }));

    const tasks = body.tasks ?? [];
    const workerCount = tasks.length;
    const plannedWorkerIds = Array.from({ length: workerCount }, (_, i) => `${team.name}-worker-${i}`);
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "request_workers.start",
      agentId: leaderId,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: { teamName: team.name, taskCount: workerCount, plannedWorkerIds },
    });

    try {
      let r: SpawnWorkersResult = { workerIds: [] };
      if (workerCount > 0) {
        r = await this.registerWorkers(leaderId, { leaderId, count: workerCount });
      }
      if (tasks.length > 0) {
        await this.dispatchWorkerTasks(leaderId, { leaderId, tasks });
      }

      this.observabilityHub.emit({
        source: "orchestrator",
        type: "request_workers.done",
        agentId: leaderId,
        role: AgentRoleEnum.Leader,
        sessionId: leader.sessionId,
        payload: { workerIds: r.workerIds },
      });
      return r;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "request_workers.error",
        agentId: leaderId,
        role: AgentRoleEnum.Leader,
        sessionId: leader.sessionId,
        payload: { error: err },
      });
      throw e;
    }
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

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "notify_complete",
      agentId,
      role: agentRole,
      sessionId: agent.sessionId,
      payload: { hasChangelog: Boolean(body.changelog) },
    });

    if (agentRole === AgentRoleEnum.Worker) {
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
    if (agentRole === AgentRoleEnum.Leader) {
      // 幂等保护：防止 Leader 重复调用 notify-complete 触发重复 merge + 重复 admin prompt
      if (this.completedLeaders.has(agentId)) {
        return { ok: true, alreadyCompleted: true };
      }
      try {
        const result = await this.handleLeaderComplete(agentId, body.changelog);
        // 标记放在 handleLeaderComplete 成功后，防止 merge 失败时 leader 被锁死
        this.completedLeaders.add(agentId);
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
    return { ok: true };
  }

  async reportProgress(body: any): Promise<any> {
    const agentId = body?.agentId as string | undefined;
    const stage = typeof body?.stage === "string" ? body.stage : undefined;
    const message = typeof body?.message === "string" ? body.message : "";
    if (agentId) {
      try {
        const agent = this.getAgent(agentId);
        this.observabilityHub.emit({
          source: "orchestrator",
          type: "report_progress",
          agentId,
          role: agent.spec.role,
          sessionId: agent.sessionId,
          payload: { stage, message },
        });
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

    this.crashedAgents.add(agentId);

    const role = agent.spec.role;
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "agent.crash",
      agentId,
      role,
      sessionId: agent.sessionId,
      payload: { error: error.message },
    });
    logger.warn("agent crashed", { agentId, role, error: error.message });

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

      void this.runtimeProvider.sendPrompt(
        leader.spec.id,
        [
          `WORKER_CRASH: Worker ${agentId} encountered a fatal error and cannot complete its task.`,
          `Error: ${error.message}`,
          ``,
          `You can:`,
          `1. Skip this worker's contribution and call notify-complete once all other workers finish.`,
          `2. Reassign the task by calling dispatch-worker-tasks with another available worker index.`,
        ].join("\n"),
      ).catch((e: unknown) => {
        logger.warn("failed to notify leader of worker crash", {
          leaderId: leader.spec.id,
          error: e instanceof Error ? e.message : String(e),
        });
      });

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

      void this.runtimeProvider.sendPrompt(
        admin.spec.id,
        [
          `LEADER_CRASH: Leader ${agentId} encountered a fatal error and cannot complete its task.`,
          `Error: ${error.message}`,
          ``,
          `You can:`,
          `1. Reassign the task to another suitable leader via assign-leader-task.`,
          `2. Report the failure as the final delivery result.`,
        ].join("\n"),
      ).catch((e: unknown) => {
        logger.warn("failed to notify admin of leader crash", {
          adminId: admin.spec.id,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }
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

  private async handleWorkerComplete(workerId: string, changelog?: string): Promise<any> {
    const worker = this.getAgent(workerId);
    const team = this.resolveTeam(worker.spec.teamName ?? "");

    const leader = Array.from(this.agents.values()).find(
      (a) => a.spec.role === AgentRoleEnum.Leader && a.spec.teamName === team.name
    );
    if (!leader) throw new Error(t("leader_not_found_for_team", { teamName: team.name }));

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "merge.worker_to_leader.start",
      agentId: workerId,
      role: AgentRoleEnum.Worker,
      sessionId: worker.sessionId,
      payload: { leaderId: leader.spec.id, workerBranch: worker.spec.branch, leaderBranch: leader.spec.branch },
    });

    await this.mergeManager.mergeBranch(leader.spec.workspacePath, worker.spec.branch, leader.spec.branch);

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "merge.worker_to_leader.done",
      agentId: workerId,
      role: AgentRoleEnum.Worker,
      sessionId: worker.sessionId,
      payload: { leaderId: leader.spec.id },
    });

    const mgr = new ChangelogManager();
    const cl = changelog ?? (await mgr.readChangelog(worker.spec.workspacePath));

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "prompt.leader.after_worker",
      agentId: leader.spec.id,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: { workerId },
    });
    await this.runtimeProvider.sendPrompt(
      leader.spec.id,
      `Worker ${workerId} has completed and its changes have been merged into your branch.\n\nSummarize the following worker CHANGELOG into your CHANGELOG:\n${cl}`,
    );

    logger.success(t("worker_merged_into_leader"), { workerId, leaderId: leader.spec.id });
    return { ok: true, mergedToLeader: true };
  }

  private async handleLeaderComplete(leaderId: string, changelog?: string): Promise<any> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) throw new Error(t("leader_team_missing"));

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "merge.leader_to_main.start",
      agentId: leaderId,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: { baseBranch: this.config.project.base_branch, leaderBranch: leader.spec.branch },
    });

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

    // Admin 已收到通知，异步清理 Leader 和 Worker 会话（释放内存，移除拓扑）
    this.cleanupLeaderAndWorkers(leaderId).catch((err: unknown) => {
      logger.warn("cleanupLeaderAndWorkers failed", {
        leaderId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { ok: true, mergedToMain: true };
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
      try {
        await this.workspaceProvider.removeWorkspace(w.spec);
      } catch {}
      // 清理 worker 相关的所有状态 Map，防止内存泄漏与下次使用时状态污染
      this.agents.delete(w.spec.id);
      this.crashedAgents.delete(w.spec.id);
      this.workerNotifyCompleteAt.delete(w.spec.id);
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
    try {
      await this.workspaceProvider.removeWorkspace(leader.spec);
    } catch {}
    // 清理 leader 相关的所有状态 Map
    this.agents.delete(leader.spec.id);
    this.crashedAgents.delete(leader.spec.id);
    this.teamByLeaderId.delete(leader.spec.id);
    this.leaderTaskAssignedAt.delete(leader.spec.id);
    this.leaderDispatchStartedAt.delete(leader.spec.id);
  }
}
