import express from "express";
import { AgentRoleEnum } from "../types";
import type { OrchestratorCtorArgs, ResolvedConfig, AgentInstanceSpec, TeamConfig } from "../types";
import path from "node:path";
import fs from "node:fs/promises";
import { LocalProcessProvider } from "../sandbox/local-process";
import { MergeManager } from "../git/merge-manager";
import { SkillResolver } from "../skills/skill-resolver";
import { ChangelogManager } from "../changelog/changelog-manager";
import { WorkspaceProviderFactory } from "../workspace/workspace-provider";
import { TaskManager } from "./task-manager";
import { logger } from "../utils/logger";
import { AgentSession } from "./agent-session";
import { t } from "../i18n/i18n";

function parseBaseDir(input: string): string {
  if (input.startsWith("~/")) return path.join(process.env.HOME ?? "", input.slice(2));
  return input;
}

function pickEnvValue(keyName: string): string | undefined {
  const value = process.env[keyName];
  if (!value) return undefined;
  return value;
}

export class Orchestrator {
  private readonly app = express();
  private readonly taskManager: TaskManager;
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly runtimeProvider: LocalProcessProvider;
  private readonly workspaceProvider: ReturnType<WorkspaceProviderFactory["getProvider"]>;
  private readonly skillResolver: SkillResolver;

  private readonly port: number;

  constructor(private readonly config: ResolvedConfig, args: OrchestratorCtorArgs) {
    this.port = args.port;
    this.stateDir = parseBaseDir(config.runtime.persistence.state_dir);
    this.stateFile = path.join(this.stateDir, "orchestrator.json");
    const injectedEnv: Record<string, string> = {};
    const opencodeCfg = config.runtime.opencode;
    const providersCfg = config.providers;

    for (const [k, v] of Object.entries(providersCfg.env ?? {})) {
      injectedEnv[k] = v;
    }
    for (const [targetKey, sourceEnvName] of Object.entries(providersCfg.env_from ?? {})) {
      if (injectedEnv[targetKey] !== undefined) continue;
      const value = pickEnvValue(sourceEnvName);
      if (!value) {
        logger.warn(`providers.env_from references missing env: ${sourceEnvName} -> ${targetKey}`);
        continue;
      }
      injectedEnv[targetKey] = value;
    }

    const openaiCompat = providersCfg.openai_compatible ?? {};
    if (openaiCompat.base_url) {
      injectedEnv.OPENAI_BASE_URL = openaiCompat.base_url;
    }
    if (openaiCompat.api_key) {
      injectedEnv.OPENAI_API_KEY = openaiCompat.api_key;
    } else if (openaiCompat.api_key_env) {
      const name = openaiCompat.api_key_env;
      // 先 providers.env / env_from，未命中再读系统环境变量
      const key = injectedEnv[name] ?? pickEnvValue(name);
      if (!key) {
        logger.warn(`providers.openai_compatible.api_key_env not found: ${name}`);
      } else {
        injectedEnv.OPENAI_API_KEY = key;
      }
    }

    this.runtimeProvider = new LocalProcessProvider(config.runtime.opencode.executable ?? "opencode", injectedEnv);

    const workspaceProvider = new WorkspaceProviderFactory(config).getProvider();
    this.workspaceProvider = workspaceProvider;
    const mergeManager = new MergeManager();
    const skillsRoot = path.resolve(config.project.repo);
    this.skillResolver = new SkillResolver(skillsRoot);

    this.taskManager = new TaskManager(
      config,
      workspaceProvider,
      this.runtimeProvider,
      mergeManager,
      `http://127.0.0.1:${this.port}`,
      this.skillResolver
    );

    this.app.use(express.json({ limit: "2mb" }));
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.app.post("/tool/request_workers", async (req, res) => {
      try {
        const body = req.body as any;
        const result = await this.taskManager.requestWorkers(body.leaderId, body);
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.post("/tool/notify_complete", async (req, res) => {
      try {
        const body = req.body as any;
        const result = await this.taskManager.notifyComplete(body);
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.post("/tool/report_progress", async (req, res) => {
      try {
        const body = req.body as any;
        const result = await this.taskManager.reportProgress(body);
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.post("/tool/generate_changelog", async (req, res) => {
      try {
        const body = req.body as any;
        const result = await this.taskManager.generateChangelog(body.agentId);
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });
  }

  private buildAdminSpec(): AgentInstanceSpec {
    const adminModel = this.config.admin.model;
    if (!adminModel) throw new Error("resolved config missing admin.model");
    const base = this.config.runtime.ports.base;
    return {
      id: AgentRoleEnum.Admin,
      role: AgentRoleEnum.Admin,
      // 让 id 与 agent name 一致，便于工具从 context.agent 反查
      name: AgentRoleEnum.Admin,
      branch: this.config.project.base_branch,
      workspacePath: path.join(this.config.workspace.root_dir, AgentRoleEnum.Admin),
      port: base,
      model: adminModel,
      skills: this.config.admin.skills,
    };
  }

  private buildLeaderSpec(team: TeamConfig, index: number): AgentInstanceSpec {
    const leaderModel = team.leader.model;
    if (!leaderModel) throw new Error(`resolved config missing teams[${team.name}].leader.model`);
    const base = this.config.runtime.ports.base + 1 + index;
    return {
      id: `${team.name}-lead`,
      role: AgentRoleEnum.Leader,
      teamName: team.name,
      // 让 id 与 agent name 一致，便于工具从 context.agent 反查
      name: `${team.name}-lead`,
      branch: team.branch_prefix,
      workspacePath: path.join(this.config.workspace.root_dir, `${team.name}-lead`),
      port: base,
      model: leaderModel,
      skills: team.leader.skills,
    };
  }

  async start(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(
      this.stateFile,
      JSON.stringify({ pid: process.pid, orchestratorPort: this.port, startedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );

    const adminSpec = this.buildAdminSpec();
    const leadersSpecs = this.config.teams.map((t, idx) => this.buildLeaderSpec(t, idx));

    // 1) Admin workspace injection + start
    await this.workspaceProvider.ensureWorkspace(adminSpec, []);
    await this.skillResolver.syncSkillsToWorkspace(adminSpec.skills ?? [], adminSpec.workspacePath);
    const adminBaseUrl = `http://127.0.0.1:${this.port}`;
    // tools/plugins + agent definition
    await this.injectBaseOpenCodeForAgent(adminSpec, this.config.admin.prompt, AgentRoleEnum.Admin);
    await this.runtimeProvider.start(adminSpec);
    const adminSession = new AgentSession(`http://127.0.0.1:${adminSpec.port}`);
    await adminSession.connect();
    const adminS = await adminSession.createSession(AgentRoleEnum.Admin);
    await adminSession.sendPrompt(adminSpec, adminS.sessionId, this.config.admin.prompt, { agent: adminSpec.name });

    // 2) Leaders workspace injection + start
    const leaders: Array<{ sessionId: string; spec: AgentInstanceSpec; team: TeamConfig }> = [];
    for (let i = 0; i < leadersSpecs.length; i++) {
      const team = this.config.teams[i];
      const spec = leadersSpecs[i];
      const sparsePaths = team.leader.repos ?? [];
      await this.workspaceProvider.ensureWorkspace(spec, sparsePaths);
      await this.skillResolver.syncSkillsToWorkspace(spec.skills ?? [], spec.workspacePath);

      await this.injectBaseOpenCodeForAgent(spec, team.leader.prompt, AgentRoleEnum.Leader);
      await this.runtimeProvider.start(spec);

      const leaderSession = new AgentSession(`http://127.0.0.1:${spec.port}`);
      await leaderSession.connect();
      const s = await leaderSession.createSession(`${spec.name}`);
      const leaderPrompt = [
        `You are the Leader Agent.`,
        `Team: ${team.name}`,
        `Goal: ${this.config.project.name}`,
        ``,
        `${team.leader.prompt}`,
        ``,
        `When you need new workers, call tool:`,
        `- request-workers`,
        `Then provide worker tasks in the form of a "tasks" array, for example:`,
        `  { "tasks": [ { "index": 0, "prompt": "..." }, { "index": 1, "prompt": "..." } ] }`,
      ].join("\n");
      await leaderSession.sendPrompt(spec, s.sessionId, leaderPrompt, { agent: spec.name });
      leaders.push({ sessionId: s.sessionId, spec, team });
    }

    // After starting static agents, set next port for spawned workers
    this.taskManager.setNextPort(this.config.runtime.ports.base + 1 + leadersSpecs.length);

    // register agents in TaskManager
    await this.taskManager.startAdminAndLeaders({ sessionId: adminS.sessionId, spec: adminSpec }, leaders);

    const appServer = this.app.listen(this.port, "0.0.0.0", () => {
      logger.info(t("orchestrator_listening_on", { port: this.port }));
    });

    // Keep running
    void appServer;
  }

  private async injectBaseOpenCodeForAgent(spec: AgentInstanceSpec, prompt: string, role: AgentRoleEnum.Admin | AgentRoleEnum.Leader): Promise<void> {
    const { writeCustomTools, writeCustomPlugins, writeAgentMarkdown, writeOatAgentMeta, writeOatOrchestratorMeta } = await import("../opencode/workspace-inject");

    await writeOatOrchestratorMeta(spec.workspacePath, { baseUrl: `http://127.0.0.1:${this.port}` });
    await writeOatAgentMeta(spec.workspacePath, { role });

    await writeAgentMarkdown({
      workspacePath: spec.workspacePath,
      agentName: spec.name,
      description: `${role} agent for ${spec.teamName ?? ""}`.trim(),
      role,
      model: spec.model,
      promptText: prompt,
      skills: spec.skills ?? [],
      toolsAllowed: { write: true, edit: true, bash: true },
    });

    await writeCustomTools(spec.workspacePath, `http://127.0.0.1:${this.port}`);
    await writeCustomPlugins(spec.workspacePath, { role });
  }
}

