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
import { t } from "../i18n/i18n";
import type {
  AgentRuntimeState,
  NotifyCompleteBody,
  SpawnWorkersResult,
  ToolRequestWorkersBody,
} from "../types";

export class TaskManager {
  private readonly agents = new Map<string, AgentRuntimeState>();
  private readonly teamByLeaderId = new Map<string, TeamConfig>();
  private nextPort: number;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly workspaceProvider: WorkspaceProvider,
    private readonly runtimeProvider: RuntimeProvider,
    private readonly mergeManager: MergeManager,
    private readonly orchestratorBaseUrl: string,
    private readonly skillResolver: SkillResolver
  ) {
    this.nextPort = config.runtime.ports.base;
  }

  setNextPort(p: number): void {
    this.nextPort = p;
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

  allocatePort(): number {
    const p = this.nextPort;
    this.nextPort += 1;
    return p;
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

  async requestWorkers(leaderId: string, body: ToolRequestWorkersBody): Promise<SpawnWorkersResult> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) throw new Error(t("leader_has_no_team", { leaderId }));

    const tasks = body.tasks ?? [];
    const workerCount = tasks.length;
    if (workerCount > team.worker.max) {
      throw new Error(
        t("requested_workers_exceed_max", {
          workerCount,
          teamName: team.name,
          max: team.worker.max,
        })
      );
    }
    const workerIds: string[] = [];

    const leaderSkills = this.getSkillsForLeader(team);
    const sparsePaths = this.getSparsePathsForLeader(team);

    for (let i = 0; i < workerCount; i++) {
      const workerIndex = i;
      const workerId = `${team.name}-worker-${workerIndex}`;
      workerIds.push(workerId);
      const workerModel = team.worker.model ?? team.leader.model ?? this.config.admin.model ?? this.config.model;
      if (!workerModel) {
        throw new Error(t("worker_model_missing", { teamName: team.name }));
      }

      const branch = `${team.branch_prefix}/worker-${workerIndex}`;
      const port = this.allocatePort();
      const spec: AgentInstanceSpec = {
        id: workerId,
        role: AgentRoleEnum.Worker,
        teamName: team.name,
        // OpenCode tool context 的 agent 通常是 agent name，这里让 id 与 name 一致便于反查
        name: workerId,
        branch,
        workspacePath: path.join(this.config.workspace.root_dir, workerId),
        port,
        model: workerModel,
        skills: this.computeWorkerSkills(team),
      };

      // 1) ensure workspace (worktree + sparse checkout + lfs)
      await this.workspaceProvider.ensureWorkspace(spec, sparsePaths);

      // 2) inject skills + tools/plugins + agent definition + oat meta
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

      await writeCustomTools(spec.workspacePath, this.orchestratorBaseUrl);
      await writeCustomPlugins(spec.workspacePath, { role: AgentRoleEnum.Worker });

      // 3) start runtime process
      await this.runtimeProvider.start(spec);

      // 4) connect and create session
      const session = new AgentSession(`http://127.0.0.1:${port}`);
      await session.connect();
      const s = await session.createSession(`worker-${workerIndex}`);

      // 5) send prompt to worker
      const prompt = [
        tasks[i].prompt,
        ``,
        `Requirements:`,
        `- Update the workspace root CHANGELOG.md according to the system constraints (if there are no code changes, still record the reason).`,
        `- Call tool notify-complete with parameters like:`,
        `  { "agentRole": "${AgentRoleEnum.Worker}", "agentId": "${workerId}", "changelog": "<CHANGELOG.md content>" }`,
      ].join("\n");
      await session.sendPrompt(spec, s.sessionId, prompt, { agent: spec.name });

      this.registerAgent({ spec, sessionId: s.sessionId, workers: [] });

      // 记录到 leader
      leader.workers.push(workerId);
      logger.info(t("worker_spawned"), { workerId, port });
    }

    return { workerIds };
  }

  async notifyComplete(body: NotifyCompleteBody): Promise<any> {
    const { agentRole, agentId } = body;
    if (agentRole === AgentRoleEnum.Worker) {
      return await this.handleWorkerComplete(agentId, body.changelog);
    }
    if (agentRole === AgentRoleEnum.Leader) {
      return await this.handleLeaderComplete(agentId, body.changelog);
    }
    return { ok: true };
  }

  async reportProgress(_body: any): Promise<any> {
    return { ok: true };
  }

  async generateChangelog(agentId: string): Promise<any> {
    const agent = this.getAgent(agentId);
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

    // merge worker -> leader
    await this.mergeManager.mergeBranch(leader.spec.workspacePath, worker.spec.branch, leader.spec.branch);

    const mgr = new ChangelogManager();
    const cl = changelog ?? (await mgr.readChangelog(worker.spec.workspacePath));

    // notify leader with worker changelog
    const leaderSession = new AgentSession(`http://127.0.0.1:${leader.spec.port}`);
    await leaderSession.connect();
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

    // merge leader -> main
    await this.mergeManager.mergeToMain(
      leader.spec.workspacePath,
      leader.spec.branch,
      this.config.project.base_branch
    );

    const mgr = new ChangelogManager();
    const cl = changelog ?? (await mgr.readChangelog(leader.spec.workspacePath));

    // notify admin
    const admin = Array.from(this.agents.values()).find((a) => a.spec.role === AgentRoleEnum.Admin);
    if (!admin) throw new Error(t("admin_not_found"));
    const adminSession = new AgentSession(`http://127.0.0.1:${admin.spec.port}`);
    await adminSession.connect();
    await adminSession.sendPrompt(
      admin.spec,
      admin.sessionId,
      `Leader ${leaderId} has completed and has been merged into main.\n\nYour delivery summary should include this team's CHANGELOG:\n${cl}`,
      { agent: admin.spec.name }
    );

    // cleanup leader and its workers
    // 为避免误删，这里先只 stop 进程并删除 workspace（若 worker/leader 生命周期要求）。默认用 worker ephemeral_after_merge_to_main
    await this.cleanupLeaderAndWorkers(leader.spec.id);

    return { ok: true, mergedToMain: true };
  }

  private async cleanupLeaderAndWorkers(leaderId: string): Promise<void> {
    const leader = this.getAgent(leaderId);
    const team = leader.leaderTeam;
    if (!team) return;

    for (const wId of leader.workers) {
      const w = this.agents.get(wId);
      if (!w) continue;
      try {
        await this.runtimeProvider.stop(w.spec.id);
      } catch {}
      try {
        await this.workspaceProvider.removeWorkspace(w.spec);
      } catch {}
      this.agents.delete(w.spec.id);
    }

    try {
      await this.runtimeProvider.stop(leader.spec.id);
    } catch {}
    try {
      await this.workspaceProvider.removeWorkspace(leader.spec);
    } catch {}
    this.agents.delete(leader.spec.id);
  }
}

