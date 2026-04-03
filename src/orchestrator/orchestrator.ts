import express from "express";
import type { Server } from "node:http";
import { AgentRoleEnum } from "../types";
import type {
  OrchestratorCtorArgs,
  ResolvedConfig,
  AgentInstanceSpec,
  TeamConfig,
} from "../types";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { LocalProcessProvider } from "../sandbox/local-process";
import { waitForRuntimeReady } from "../sandbox/runtime-ready";
import { MergeManager } from "../git/merge-manager";
import { SkillResolver } from "../skills/skill-resolver";
import { ChangelogManager } from "../changelog/changelog-manager";
import { WorkspaceProviderFactory } from "../workspace/workspace-provider";
import { TaskManager } from "./task-manager";
import { ObservabilityHub } from "./observability-hub";
import { OpencodeLocalLogWatcher } from "./opencode-local-log-watcher";
import { OpencodeEventBridge } from "./opencode-event-bridge";
import { logger } from "../utils/logger";
import { AgentSession } from "./agent-session";
import { t } from "../i18n/i18n";
import { findContiguousAvailablePorts } from "../utils/available-port";

function parseBaseDir(input: string): string {
  if (input.startsWith("~/"))
    return path.join(process.env.HOME ?? "", input.slice(2));
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
  private readonly workspaceProvider: ReturnType<
    WorkspaceProviderFactory["getProvider"]
  >;
  private readonly skillResolver: SkillResolver;
  private readonly observabilityHub: ObservabilityHub;
  private readonly opencodeEventBridge: OpencodeEventBridge;
  private readonly localLogWatcher: OpencodeLocalLogWatcher;
  /** 存在且含 index.html 时由 Express 托管观测 Web UI */
  private readonly dashboardDist: string | undefined;

  private readonly port: number;
  private readonly goal: string;
  private adminSessionId: string | undefined;

  constructor(
    private readonly config: ResolvedConfig,
    args: OrchestratorCtorArgs,
  ) {
    this.port = args.port;
    this.goal = args.goal;
    this.dashboardDist =
      args.dashboardDist &&
      existsSync(path.join(args.dashboardDist, "index.html"))
        ? path.resolve(args.dashboardDist)
        : undefined;
    this.stateDir = parseBaseDir(config.runtime.persistence.state_dir);
    this.stateFile = path.join(this.stateDir, "orchestrator.json");
    const injectedEnv: Record<string, string> = {};
    const opencodeCfg = config.runtime.opencode;
    const providersCfg = config.providers;

    for (const [k, v] of Object.entries(providersCfg.env ?? {})) {
      injectedEnv[k] = v;
    }
    for (const [targetKey, sourceEnvName] of Object.entries(
      providersCfg.env_from ?? {},
    )) {
      if (injectedEnv[targetKey] !== undefined) continue;
      const value = pickEnvValue(sourceEnvName);
      if (!value) {
        logger.warn(
          t("providers_env_from_missing", { sourceEnvName, targetKey }),
        );
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
        logger.warn(t("providers_openai_api_key_env_not_found", { name }));
      } else {
        injectedEnv.OPENAI_API_KEY = key;
      }
    }

    // 供 .opencode/tools 内 fetch 编排器：避免仅依赖 context.worktree + .oat/orchestrator.json 时路径为空
    injectedEnv.OAT_ORCHESTRATOR_BASE_URL = `http://127.0.0.1:${this.port}`;

    this.observabilityHub = new ObservabilityHub();

    this.runtimeProvider = new LocalProcessProvider(
      config.runtime.opencode.executable ?? "opencode",
      injectedEnv,
      (info) => {
        const line = `[${info.stream}] ${info.line}`;
        this.observabilityHub.appendAgentProcessLog(info.agentId, line);
        this.observabilityHub.emit(
          {
            source: "opencode",
            type: "opencode.process.log",
            agentId: info.agentId,
            payload: { line: info.line, stream: info.stream },
          },
          { skipBuffer: true },
        );
      },
    );

    const workspaceProvider = new WorkspaceProviderFactory(
      config,
    ).getProvider();
    this.workspaceProvider = workspaceProvider;
    const mergeManager = new MergeManager();
    const skillsRoot = path.resolve(config.project.repo);
    this.skillResolver = new SkillResolver(skillsRoot);
    this.opencodeEventBridge = new OpencodeEventBridge(this.observabilityHub);

    this.taskManager = new TaskManager(
      config,
      workspaceProvider,
      this.runtimeProvider,
      mergeManager,
      `http://127.0.0.1:${this.port}`,
      this.skillResolver,
      this.observabilityHub,
      (state) => this.opencodeEventBridge.subscribeAgent(state),
      (agentId) => this.opencodeEventBridge.unsubscribeAgent(agentId),
    );

    this.localLogWatcher = new OpencodeLocalLogWatcher(
      this.observabilityHub,
      () => this.taskManager.getAgentPortList(),
    );

    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (
        origin &&
        (/^http:\/\/localhost:\d+$/.test(origin) ||
          /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
      ) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Cache-Control",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      }
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });
    this.app.use(express.json({ limit: "2mb" }));
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.app.get("/observability/graph", (_req, res) => {
      try {
        res.json(this.taskManager.getObservabilityGraph());
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.get("/observability/agent/:agentId/logs", (req, res) => {
      try {
        const agentId = req.params.agentId;
        res.json(this.observabilityHub.getAgentLogBundle(agentId));
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.get("/observability/events", (req, res) => {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      const flush = (res as { flushHeaders?: () => void }).flushHeaders;
      if (typeof flush === "function") flush.call(res);

      const hub = this.observabilityHub;
      for (const e of hub.snapshot()) {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      }
      const unsub = hub.subscribe((ev) => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      });
      const ping = setInterval(() => {
        res.write(`: ping\n\n`);
      }, 30_000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
      });
    });

    this.app.post("/tool/request_workers", async (req, res) => {
      try {
        const body = req.body as any;
        const result = await this.taskManager.requestWorkers(
          body.leaderId,
          body,
        );
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.post("/tool/register_workers", async (req, res) => {
      try {
        const body = req.body as any;
        const result = await this.taskManager.registerWorkers(
          body.leaderId,
          body,
        );
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.post("/tool/dispatch_worker_tasks", async (req, res) => {
      try {
        const body = req.body as any;
        const result = await this.taskManager.dispatchWorkerTasks(
          body.leaderId,
          body,
        );
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.post("/tool/assign_leader_task", async (req, res) => {
      try {
        const body = req.body as any;
        const result = await this.taskManager.assignLeaderTask(
          body.leaderId,
          body.prompt,
        );
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

    this.app.post("/tool/admin_instruction", async (req, res) => {
      try {
        const body = req.body as any;
        const prompt = typeof body?.prompt === "string" ? body.prompt : "";
        const result = await this.taskManager.sendAdminDashboardInstruction(prompt);
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    if (this.dashboardDist) {
      this.app.use(express.static(this.dashboardDist));
      this.app.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return next();
        }
        if (
          req.path.startsWith("/tool") ||
          req.path.startsWith("/observability")
        ) {
          return next();
        }
        res.sendFile(path.join(this.dashboardDist!, "index.html"), (err) => {
          if (err) next(err);
        });
      });
    }
  }

  private buildAdminSpec(portBase: number): AgentInstanceSpec {
    const adminModel = this.config.admin.model;
    if (!adminModel) throw new Error(t("admin_model_missing"));
    return {
      id: AgentRoleEnum.Admin,
      role: AgentRoleEnum.Admin,
      // 让 id 与 agent name 一致，便于工具从 context.agent 反查
      name: AgentRoleEnum.Admin,
      branch: this.config.project.base_branch,
      workspacePath: path.join(
        this.config.workspace.root_dir,
        AgentRoleEnum.Admin,
      ),
      port: portBase,
      model: adminModel,
      skills: this.config.admin.skills,
    };
  }

  private buildLeaderSpec(
    team: TeamConfig,
    index: number,
    portBase: number,
  ): AgentInstanceSpec {
    const leaderModel = team.leader.model;
    if (!leaderModel)
      throw new Error(t("leader_model_missing", { teamName: team.name }));
    const leaderPort = portBase + 1 + index;
    return {
      id: `${team.name}-lead`,
      role: AgentRoleEnum.Leader,
      teamName: team.name,
      // 让 id 与 agent name 一致，便于工具从 context.agent 反查
      name: `${team.name}-lead`,
      branch: team.branch_prefix,
      workspacePath: path.join(
        this.config.workspace.root_dir,
        `${team.name}-lead`,
      ),
      port: leaderPort,
      model: leaderModel,
      skills: team.leader.skills,
    };
  }

  async start(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(
      this.stateFile,
      JSON.stringify(
        {
          pid: process.pid,
          orchestratorPort: this.port,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    this.localLogWatcher.start();

    const staticAgentCount = 1 + this.config.teams.length;
    const maxScan = Math.max(
      staticAgentCount * 2,
      this.config.runtime.ports.max_agents * 10,
      100,
    );
    const resolvedBase = await findContiguousAvailablePorts(
      this.config.runtime.ports.base,
      staticAgentCount,
      maxScan,
    );
    if (resolvedBase === null) {
      throw new Error(
        t("agent_ports_no_contiguous_block", {
          count: staticAgentCount,
          base: this.config.runtime.ports.base,
          maxScan,
        }),
      );
    }
    const portBase = resolvedBase;
    if (portBase !== this.config.runtime.ports.base) {
      logger.info(
        t("agent_port_base_shifted", {
          configured: this.config.runtime.ports.base,
          actual: portBase,
        }),
      );
    }

    const adminSpec = this.buildAdminSpec(portBase);
    const leadersSpecs = this.config.teams.map((team, idx) =>
      this.buildLeaderSpec(team, idx, portBase),
    );

    // 1) Admin workspace injection + start
    await this.workspaceProvider.ensureWorkspace(adminSpec, []);
    await this.skillResolver.syncSkillsToWorkspace(
      adminSpec.skills ?? [],
      adminSpec.workspacePath,
    );
    const adminBaseUrl = `http://127.0.0.1:${this.port}`;
    // tools/plugins + agent definition
    const leadersCatalog = this.config.teams
      .map((team) => {
        const leaderId = `${team.name}-lead`;
        const leaderName = team.leader.name;
        const desc = team.leader.description ?? "";
        return [
          `- leaderId: ${leaderId}`,
          `  config.leader.name: ${leaderName}`,
          `  description: ${desc}`,
          `  workerPool.total: ${team.worker.total}`,
        ].join("\n");
      })
      .join("\n");

    const hasCliGoal = this.goal.trim().length > 0;
    const cliGoalDisplay = hasCliGoal
      ? this.goal
      : "(No CLI goal on startup. Operator goals may arrive as messages starting with DASHBOARD_INSTRUCTION: — you still choose the leader yourself.)";

    const adminPromptWithGoal = [
      this.config.admin.prompt,
      ``,
      `CLI Goal:\n${cliGoalDisplay}`,
      ``,
      `Available Leaders (pick exactly one per task — use descriptions and team fit; there is no default/first leader):\n${leadersCatalog}`,
      ``,
      `Rules (MUST follow):`,
      `1) For every concrete objective (CLI Goal and/or DASHBOARD_INSTRUCTION), you MUST decide which single leaderId from "Available Leaders" is the best match and call tool assign-leader-task. The orchestrator does not auto-route to any leader.`,
      `2) You MUST call tool assign-leader-task with:`,
      `   { "leaderId": "<chosen_leaderId>", "prompt": "<task prompt>" }`,
      `3) Do NOT dispatch worker tasks yourself; the chosen leader assigns workers.`,
      `4) You MUST report execution progress using tool report-progress (JSON args):`,
      `   { "agentId": "${AgentRoleEnum.Admin}", "stage": "<stage>", "message": "<short message>" }`,
      `5) You MUST call report-progress at least 3 times:`,
      `   1) stage="start" (when you begin orchestration),`,
      `   2) stage="after_assign_leader_task" (right after assign-leader-task returns),`,
      `   3) stage="done" (as the last step before you finish).`,
      `6) If you receive DASHBOARD_INSTRUCTION:, treat it as a new operator goal — choose the best leader again if needed, then assign-leader-task and report-progress as above.`,
    ].join("\n");
    await this.injectBaseOpenCodeForAgent(
      adminSpec,
      adminPromptWithGoal,
      AgentRoleEnum.Admin,
    );
    await this.runtimeProvider.start(adminSpec);
    await waitForRuntimeReady(this.runtimeProvider, adminSpec.port);
    const adminSession = new AgentSession(`http://127.0.0.1:${adminSpec.port}`);
    await adminSession.connect();
    const adminS = await adminSession.createSession(AgentRoleEnum.Admin);
    this.adminSessionId = adminS.sessionId;
    await adminSession.sendPrompt(
      adminSpec,
      adminS.sessionId,
      adminPromptWithGoal,
      { agent: adminSpec.name },
    );

    // 2) Leaders workspace injection + start
    const leaders: Array<{
      sessionId: string;
      spec: AgentInstanceSpec;
      team: TeamConfig;
    }> = [];
    for (let i = 0; i < leadersSpecs.length; i++) {
      const team = this.config.teams[i];
      const spec = leadersSpecs[i];
      const sparsePaths = team.leader.repos ?? [];
      await this.workspaceProvider.ensureWorkspace(spec, sparsePaths);
      await this.skillResolver.syncSkillsToWorkspace(
        spec.skills ?? [],
        spec.workspacePath,
      );

      // Leader workspace prompt 不直接包含 CLI Goal；由 admin 通过 assign-leader-task 下发时再触发 worker 分配
      await this.injectBaseOpenCodeForAgent(
        spec,
        team.leader.prompt,
        AgentRoleEnum.Leader,
      );
      await this.runtimeProvider.start(spec);
      await waitForRuntimeReady(this.runtimeProvider, spec.port);

      const leaderSession = new AgentSession(`http://127.0.0.1:${spec.port}`);
      await leaderSession.connect();
      const s = await leaderSession.createSession(`${spec.name}`);

      const taskWorkerCount = team.worker.total;
      const workerDesc =
        team.worker.prompt.length > 120
          ? `${team.worker.prompt.slice(0, 117)}...`
          : team.worker.prompt;
      const workersCatalog = Array.from(
        { length: team.worker.total },
        (_, idx) => {
          const workerId = `${team.name}-worker-${idx}`;
          return [
            `   - worker-${idx}: ${workerId}`,
            `     description: ${workerDesc}`,
          ].join("\n");
        },
      ).join("\n");

      const leaderPrompt = [
        `You are the Leader Agent.`,
        `Team: ${team.name}`,
        ``,
        `Available workers:`,
        workersCatalog,
        ``,
        `Rules (MUST follow):`,
        `1) Wait until you receive an ADMIN_TASK message from admin (the message always starts with "ADMIN_TASK:").`,
        `2) Before receiving ADMIN_TASK, do NOT call request-workers/register-workers/dispatch-worker-tasks.`,
        `3) After receiving ADMIN_TASK, parse the goal and split into subtasks (at most ${taskWorkerCount}). For each subtask, choose the most suitable worker by index (0..${taskWorkerCount - 1}) using each worker's description in "Available workers"; call dispatch-worker-tasks with tasks[].index and tasks[].prompt. You are NOT required to map the i-th subtask to worker-i — assign by fit.`,
        `4) After dispatch-worker-tasks, do NOT directly fetch the sources in the leader. Let workers do it; then summarize workers' CHANGELOG outputs.`,
        ``,
        `5) You MUST report execution progress using tool report-progress (JSON args):`,
        `   { "agentId": "${spec.id}", "stage": "<stage>", "message": "<short message>" }`,
        `6) You MUST call report-progress at least 3 times:`,
        `   1) stage="start" (when you start handling ADMIN_TASK),`,
        `   2) stage="after_dispatch_worker_tasks" (right after dispatch-worker-tasks returns),`,
        `   3) stage="done" (as the last step before you finish).`,
        ``,
        `If you already dispatched, you can wait for workers to call notify-complete.`,
      ].join("\n");
      await leaderSession.sendPrompt(spec, s.sessionId, leaderPrompt, {
        agent: spec.name,
      });
      leaders.push({ sessionId: s.sessionId, spec, team });
    }

    // After starting static agents, set next port for spawned workers
    this.taskManager.setNextPort(portBase + 1 + leadersSpecs.length);

    // register agents in TaskManager
    await this.taskManager.startAdminAndLeaders(
      { sessionId: adminS.sessionId, spec: adminSpec },
      leaders,
    );

    // 3) Team 启动时预先创建 worker（Worker 作为进程池，直到 orchestrator 退出才统一 stopAll）
    for (const team of this.config.teams) {
      const leaderId = `${team.name}-lead`;
      const total = team.worker.total;
      if (total <= 0) {
        throw new Error(
          `team.worker.total must be an integer > 0 (team=${team.name})`,
        );
      }
      logger.info("pre-spawning worker pool", {
        team: team.name,
        total,
        leaderId,
      });
      await this.taskManager.registerWorkers(leaderId, {
        leaderId,
        count: total,
      });
    }

    const appServer: Server = this.app.listen(this.port, "0.0.0.0", () => {
      logger.info(t("orchestrator_listening_on", { port: this.port }));
      this.observabilityHub.emit({
        source: "orchestrator",
        type: "orchestrator.ready",
        payload: {
          orchestratorPort: this.port,
          dashboardUrl: this.dashboardDist
            ? `http://127.0.0.1:${this.port}/`
            : undefined,
        },
      });
    });
    this.registerShutdownHandlers(appServer);
  }

  private registerShutdownHandlers(httpServer: Server): void {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(t("orchestrator_shutting_down", { signal }));
      void (async () => {
        try {
          this.localLogWatcher.stop();
        } catch {
          /* noop */
        }
        try {
          this.opencodeEventBridge.disposeAll();
        } catch {
          /* noop */
        }
        // 清理 admin session，避免 orchestrator 退出后 opencode 内残留大量 session。
        if (this.adminSessionId) {
          try {
            await this.deleteOpencodeSession(this.adminSessionId);
          } catch (e) {
            logger.warn("opencode session delete failed", {
              sessionId: this.adminSessionId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        try {
          await this.runtimeProvider.stopAll();
        } catch (e) {
          logger.warn(t("runtime_stop_all_failed"), {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        httpServer.close(() => {
          process.exit(0);
        });
        const forceExit = setTimeout(() => process.exit(0), 10_000);
        forceExit.unref();
      })();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  private async deleteOpencodeSession(sessionId: string): Promise<void> {
    const executable = this.config.runtime.opencode.executable ?? "opencode";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ["session", "delete", sessionId], {
        stdio: ["ignore", "ignore", "pipe"],
        env: process.env,
      });
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr += d.toString("utf8");
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) return resolve();
        reject(
          new Error(
            `opencode session delete exited: code=${code}. stderr=${stderr.trim()}`,
          ),
        );
      });
    });
  }

  private async injectBaseOpenCodeForAgent(
    spec: AgentInstanceSpec,
    prompt: string,
    role: AgentRoleEnum.Admin | AgentRoleEnum.Leader,
  ): Promise<void> {
    const {
      writeCustomTools,
      writeCustomPlugins,
      writeAgentMarkdown,
      writeOatAgentMeta,
      writeOatOrchestratorMeta,
    } = await import("../opencode/workspace-inject");

    await writeOatOrchestratorMeta(spec.workspacePath, {
      baseUrl: `http://127.0.0.1:${this.port}`,
    });
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

    await writeCustomTools(spec.workspacePath, `http://127.0.0.1:${this.port}`, {
      workspaceRoot: this.config.workspace.root_dir,
      workspacePath: spec.workspacePath,
      role,
      teamName: spec.teamName,
      teams: this.config.teams.map((t) => ({
        name: t.name,
        worker: { total: t.worker.total },
      })),
    });
    await writeCustomPlugins(spec.workspacePath, { role });
  }
}
