import fs from "node:fs/promises";
import path from "node:path";
import { AgentRoleEnum } from "../types";
import type { ResolvedConfig, AgentInstanceSpec, TeamConfig } from "../types";
import type { WorkspaceProvider } from "../sandbox/interface";
import type { RuntimeProvider } from "../sandbox/interface";
import { MergeManager } from "../git/merge-manager";
import { SkillResolver } from "../skills/skill-resolver";
import { ChangelogManager } from "../changelog/changelog-manager";
import { AgentSession } from "./agent-session";
import {
  writeAgentMarkdown,
  writeCustomPlugins,
  writeCustomTools,
  writeOatAgentMeta,
  writeOatOrchestratorMeta,
} from "../opencode/workspace-inject";
import { logger } from "../utils/logger";
import { waitForRuntimeReady } from "../sandbox/runtime-ready";
import { isPortAvailable } from "../utils/available-port";
import { t } from "../i18n/i18n";
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
  private nextPort: number;
  /** 记录某 leader 是否已经收到 ADMIN_TASK（用于 admin 回退/超时逻辑） */
  private readonly leaderTaskAssignedAt = new Map<string, number>();
  /** 记录某 leader 是否已经开始过 worker dispatch（用于 worker 分配兜底） */
  private readonly leaderDispatchStartedAt = new Map<string, number>();
  /** 记录某 worker 是否已经调用 notify-complete */
  private readonly workerNotifyCompleteAt = new Map<string, number>();
  constructor(
    private readonly config: ResolvedConfig,
    private readonly workspaceProvider: WorkspaceProvider,
    private readonly runtimeProvider: RuntimeProvider,
    private readonly mergeManager: MergeManager,
    private readonly orchestratorBaseUrl: string,
    private readonly skillResolver: SkillResolver,
    private readonly observabilityHub: ObservabilityHub,
    private readonly onAgentRegistered?: (state: AgentRuntimeState) => void,
    private readonly onAgentRemoved?: (agentId: string) => void
  ) {
    this.nextPort = config.runtime.ports.base;
  }

  getObservabilityHub(): ObservabilityHub {
    return this.observabilityHub;
  }

  getAllAgents(): AgentRuntimeState[] {
    return Array.from(this.agents.values());
  }

  /** 供 ~/.local/share/opencode/log 解析时按端口关联到 Agent */
  getAgentPortList(): Array<{ agentId: string; port: number }> {
    return Array.from(this.agents.values()).map((a) => ({
      agentId: a.spec.id,
      port: a.spec.port,
    }));
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
        port: a.spec.port,
        teamName: a.spec.teamName,
        sessionId: a.sessionId,
      });
      if (a.spec.role === AgentRoleEnum.Leader && admin) {
        pushEdge(admin.spec.id, a.spec.id, "admin_leader");
      }
    }

    // Leader → Worker：合并 leader.workers 与同 team 下已注册的 Worker（仅展示真实 Agent，不再生成「待创建」占位节点）
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

  setNextPort(p: number): void {
    this.nextPort = p;
  }

  registerAgent(state: AgentRuntimeState): void {
    this.agents.set(state.spec.id, state);
    this.onAgentRegistered?.(state);
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

  /**
   * 自 nextPort 起向后寻找第一个可绑定的端口（避免与已占用端口冲突）。
   */
  private async allocateNextAvailablePort(): Promise<number> {
    const maxAttempts = Math.max(200, this.config.runtime.ports.max_agents * 20);
    let p = this.nextPort;
    for (let k = 0; k < maxAttempts; k++) {
      if (await isPortAvailable(p)) {
        this.nextPort = p + 1;
        return p;
      }
      p += 1;
    }
    throw new Error(t("no_free_worker_port", { maxAttempts }));
  }

  private getSparsePathsForLeader(team: TeamConfig): string[] {
    return team.leader.repos ?? [];
  }

  private getSkillsForLeader(team: TeamConfig): string[] {
    return team.leader.skills ?? [];
  }

  private computeWorkerSkills(team: TeamConfig): string[] {
    // Worker skills 继承 leader skills；extra_skills 将在请求时追加（如果你扩展请求参数）
    return [...(team.leader.skills ?? [])];
  }

  /**
   * 拉起单个 Worker：workspace → opencode → 注册拓扑与事件桥（不下发任务 prompt）。
   */
  private async spawnSingleWorker(leader: AgentRuntimeState, team: TeamConfig, workerIndex: number): Promise<void> {
    const leaderId = leader.spec.id;
    const workerId = `${team.name}-worker-${workerIndex}`;
    const workerModel = team.worker.model ?? team.leader.model ?? this.config.admin.model ?? this.config.model;
    if (!workerModel) {
      throw new Error(t("worker_model_missing", { teamName: team.name }));
    }

    const leaderSkills = this.getSkillsForLeader(team);
    const sparsePaths = this.getSparsePathsForLeader(team);

    const branch = `${team.branch_prefix}/worker-${workerIndex}`;
    const port = await this.allocateNextAvailablePort();
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "worker.bootstrap.start",
      agentId: workerId,
      role: AgentRoleEnum.Worker,
      sessionId: "",
      payload: { leaderId, port, teamName: team.name, taskIndex: workerIndex },
    });
    const spec: AgentInstanceSpec = {
      id: workerId,
      role: AgentRoleEnum.Worker,
      teamName: team.name,
      name: workerId,
      branch,
      workspacePath: path.join(this.config.workspace.root_dir, workerId),
      port,
      model: workerModel,
      skills: this.computeWorkerSkills(team),
    };

    await this.workspaceProvider.ensureWorkspace(spec, sparsePaths);

    const workerSkills = [...leaderSkills, ...(team.worker.extra_skills ?? [])];
    spec.skills = workerSkills;
    await this.skillResolver.syncSkillsToWorkspace(workerSkills, spec.workspacePath);

    await writeOatOrchestratorMeta(spec.workspacePath, { baseUrl: this.orchestratorBaseUrl });
    await writeOatAgentMeta(spec.workspacePath, {
      role: AgentRoleEnum.Worker,
      allowedPushPattern: ".*\\/worker-\\d+",
    });

    await writeAgentMarkdown({
      workspacePath: spec.workspacePath,
      agentName: spec.name,
      description: `Worker agent for ${team.name} (index ${workerIndex})`,
      role: AgentRoleEnum.Worker,
      model: spec.model,
      promptText: team.worker.prompt,
      skills: workerSkills,
      toolsAllowed: { write: true, edit: true, bash: true },
    });

    await writeCustomTools(spec.workspacePath, this.orchestratorBaseUrl, {
      workspaceRoot: this.config.workspace.root_dir,
      workspacePath: spec.workspacePath,
      role: AgentRoleEnum.Worker,
      teamName: team.name,
      teams: this.config.teams.map((t) => ({
        name: t.name,
        worker: { total: t.worker.total },
      })),
    });
    await writeCustomPlugins(spec.workspacePath, { role: AgentRoleEnum.Worker });

    await this.runtimeProvider.start(spec);
    await waitForRuntimeReady(this.runtimeProvider, port);

    const session = new AgentSession(`http://127.0.0.1:${port}`);
    await session.connect();
    const s = await session.createSession(`worker-${workerIndex}`);

    this.registerAgent({ spec, sessionId: s.sessionId, workers: [] });
    leader.workers.push(workerId);
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "worker.spawned",
      agentId: workerId,
      role: AgentRoleEnum.Worker,
      sessionId: s.sessionId,
      payload: { leaderId, port, teamName: team.name, taskIndex: workerIndex },
    });

    logger.info(t("worker_registered"), { workerId, port });
  }

  private buildWorkerDispatchPrompt(workerId: string, taskPrompt: string): string {
    return [
      taskPrompt,
      ``,
      `Rules (MUST follow):`,
      `- Update the workspace root CHANGELOG.md according to the system constraints (if there are no code changes, still record the reason).`,
      `- Report execution progress using tool report-progress (JSON args):`,
      `  { "agentId": "${workerId}", "stage": "<stage>", "message": "<short message>" }`,
      `- You MUST call report-progress at least 3 times:`,
      `  1) stage="start" (when you begin working),`,
      `  2) stage="changelog_update" (immediately after finishing CHANGELOG.md update),`,
      `  3) stage="before_notify_complete" (right before calling notify-complete).`,
      `- Optionally call stage="done" after notify-complete returns.`,
      `- After updating CHANGELOG.md, MUST call tool notify-complete exactly once with JSON args:`,
      `  { "agentRole": "${AgentRoleEnum.Worker}", "agentId": "${workerId}" }`,
      `- You MUST NOT omit agentId; the orchestrator relies on it to find the correct Worker runtime.`,
      `- You MUST NOT rely on filling the changelog argument; it can be omitted.`,
    ].join("\n");
  }

  /** 仅注册 N 个 Worker，由 Leader 稍后调用 {@link dispatchWorkerTasks} 下发任务。 */
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
          // 幂等：已存在则跳过 spawn，但确保 leader.workers 里包含它
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

  /** 向已注册的 Worker 下发任务（每条任务按 index 或数组顺序对应 worker-{index}）。 */
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

        const prompt = this.buildWorkerDispatchPrompt(workerId, tasks[i].prompt);
        const session = new AgentSession(`http://127.0.0.1:${agent.spec.port}`);
        await session.connect();
        try {
          const promptPreview = tasks[i].prompt.length > 200 ? `${tasks[i].prompt.slice(0, 197)}...` : tasks[i].prompt;
          this.observabilityHub.emit({
            source: "orchestrator",
            type: "worker.task.dispatched",
            agentId: workerId,
            role: AgentRoleEnum.Worker,
            sessionId: agent.sessionId,
            payload: { leaderId, taskIndex: idx, promptPreview },
          });
          await session.sendPrompt(agent.spec, agent.sessionId, prompt, { agent: agent.spec.name });
          this.observabilityHub.emit({
            source: "orchestrator",
            type: "worker.task.prompt_sent",
            agentId: workerId,
            role: AgentRoleEnum.Worker,
            sessionId: agent.sessionId,
            payload: { leaderId, taskIndex: idx, promptPreview },
          });

          // 如果 worker 在一定时间内仍未回调 notify-complete，则发出超时事件，便于定位卡点
          const NOTIFY_COMPLETE_TIMEOUT_MS = 30_000;
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
        } catch (err) {
          this.observabilityHub.emit({
            source: "orchestrator",
            type: "worker.dispatch_failed",
            agentId: workerId,
            role: AgentRoleEnum.Worker,
            sessionId: agent.sessionId,
            payload: { leaderId, error: err instanceof Error ? err.message : String(err) },
          });
          throw err;
        }

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

  /**
   * 将 admin 决定的任务 prompt 发送给指定 leader（由 leader 进一步分配给 worker）。
   * 注意：leader 在 orchestrator 启动阶段已创建并注册 session。
   */
  async assignLeaderTask(leaderId: string, prompt: string): Promise<{ ok: true }> {
    const leader = this.getAgent(leaderId);
    if (leader.spec.role !== AgentRoleEnum.Leader) {
      throw new Error(`assignLeaderTask: agentId=${leaderId} is not a leader`);
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

    const leaderSession = new AgentSession(`http://127.0.0.1:${leader.spec.port}`);
    await leaderSession.connect();
    await leaderSession.sendPrompt(leader.spec, leader.sessionId, `ADMIN_TASK:\n${prompt}`, {
      agent: leader.spec.name,
    });
    return { ok: true };
  }

  /**
   * Dashboard：仅向 Admin 会话追加操作员指令（DASHBOARD_INSTRUCTION）。
   * 由 Admin 模型根据「Available Leaders」自行判断并调用 assign-leader-task；编排器不默认派给任一 Leader。
   */
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

    const session = new AgentSession(`http://127.0.0.1:${admin.spec.port}`);
    await session.connect();
    await session.sendPrompt(admin.spec, admin.sessionId, `DASHBOARD_INSTRUCTION:\n${trimmed}`, {
      agent: admin.spec.name,
    });
    return { ok: true };
  }

  hasLeaderTaskAssigned(leaderId: string): boolean {
    return this.leaderTaskAssignedAt.has(leaderId);
  }

  hasLeaderDispatchStarted(leaderId: string): boolean {
    return this.leaderDispatchStartedAt.has(leaderId);
  }

  /**
   * 兼容：一次注册并下发（等价于先 {@link registerWorkers} 再 {@link dispatchWorkerTasks}）。
   * 推荐 Leader 使用 register-workers + dispatch-worker-tasks 两步。
   */
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
    try {
      const agent = this.getAgent(agentId);
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "notify_complete",
        agentId,
        role: agentRole,
        sessionId: agent.sessionId,
        payload: { hasChangelog: Boolean(body.changelog) },
      });
    } catch {
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "notify_complete.unknown_agent",
        agentId,
        role: agentRole,
        payload: { hasChangelog: Boolean(body.changelog) },
      });
    }
    if (agentRole === AgentRoleEnum.Worker) {
      try {
        this.workerNotifyCompleteAt.set(agentId, Date.now());
        return await this.handleWorkerComplete(agentId, body.changelog);
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
      try {
        return await this.handleLeaderComplete(agentId, body.changelog);
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

    // leader id
    const leaderId = `${team.name}-lead`; // not used; may mismatch. We'll infer:
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

    // merge worker -> leader
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

    // notify leader with worker changelog
    const leaderSession = new AgentSession(`http://127.0.0.1:${leader.spec.port}`);
    await leaderSession.connect();
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "prompt.leader.after_worker",
      agentId: leader.spec.id,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: { workerId },
    });
    await leaderSession.sendPrompt(
      leader.spec,
      leader.sessionId,
      `Worker ${workerId} has completed and its changes have been merged into your branch.\n\nSummarize the following worker CHANGELOG into your CHANGELOG:\n${cl}`,
      { agent: leader.spec.name }
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

    // merge leader -> main
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

    // notify admin
    const admin = Array.from(this.agents.values()).find((a) => a.spec.role === AgentRoleEnum.Admin);
    if (!admin) throw new Error(t("admin_not_found"));
    const adminSession = new AgentSession(`http://127.0.0.1:${admin.spec.port}`);
    await adminSession.connect();
    this.observabilityHub.emit({
      source: "orchestrator",
      type: "prompt.admin.after_leader",
      agentId: admin.spec.id,
      role: AgentRoleEnum.Admin,
      sessionId: admin.sessionId,
      payload: { leaderId },
    });
    await adminSession.sendPrompt(
      admin.spec,
      admin.sessionId,
      `Leader ${leaderId} has completed and has been merged into main.\n\nYour delivery summary should include this team's CHANGELOG:\n${cl}`,
      { agent: admin.spec.name }
    );

    // 按当前需求：Worker 作为一组进程池在 team 启动时预创建；
    // 只在 orchestrator 退出时由 runtimeProvider.stopAll() 统一销毁。
    // 因此这里不再 stop/delete worker/leader。

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
      this.onAgentRemoved?.(w.spec.id);
      try {
        await this.runtimeProvider.stop(w.spec.id);
      } catch {}
      try {
        await this.workspaceProvider.removeWorkspace(w.spec);
      } catch {}
      this.agents.delete(w.spec.id);
    }

    this.observabilityHub.emit({
      source: "orchestrator",
      type: "agent.cleanup.leader",
      agentId: leader.spec.id,
      role: AgentRoleEnum.Leader,
      sessionId: leader.sessionId,
      payload: {},
    });
    this.onAgentRemoved?.(leader.spec.id);
    try {
      await this.runtimeProvider.stop(leader.spec.id);
    } catch {}
    try {
      await this.workspaceProvider.removeWorkspace(leader.spec);
    } catch {}
    this.agents.delete(leader.spec.id);
  }
}

