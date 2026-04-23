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
import { PiSessionProvider } from "../sandbox/local-process";
import { MergeManager } from "../git/merge-manager";
import { SkillResolver } from "../skills/skill-resolver";
import { ChangelogManager } from "../changelog/changelog-manager";
import { WorkspaceProviderFactory } from "../workspace/workspace-provider";
import { TaskManager } from "./task-manager";
import { ObservabilityHub } from "./observability-hub";
import { logger } from "../utils/logger";
import { t } from "../i18n/i18n";
import {
  writeAgentWorkspaceConfig,
  buildAgentSystemPrompt,
  type OatWorkspaceScopeContext,
} from "../pi/workspace-inject";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

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
  private readonly runtimeProvider: PiSessionProvider;
  private readonly workspaceProvider: ReturnType<
    WorkspaceProviderFactory["getProvider"]
  >;
  private readonly skillResolver: SkillResolver;
  private readonly observabilityHub: ObservabilityHub;
  /** 存在且含 index.html 时由 Express 托管观测 Web UI */
  private readonly dashboardDist: string | undefined;

  private readonly port: number;
  private readonly goal: string;

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

    // 根据 providers 配置将 API key/env 注入到当前进程环境变量
    // pi-coding-agent 从进程环境变量读取 API keys（ANTHROPIC_API_KEY / OPENAI_API_KEY 等）
    const providersCfg = config.providers;
    for (const [k, v] of Object.entries(providersCfg.env ?? {})) {
      process.env[k] = v;
    }
    for (const [targetKey, sourceEnvName] of Object.entries(
      providersCfg.env_from ?? {},
    )) {
      if (process.env[targetKey]) continue;
      const value = pickEnvValue(sourceEnvName);
      if (!value) {
        logger.warn(
          t("providers_env_from_missing", { sourceEnvName, targetKey }),
        );
        continue;
      }
      process.env[targetKey] = value;
    }

    const openaiCompat = providersCfg.openai_compatible ?? {};
    if (openaiCompat.base_url) {
      process.env.OPENAI_BASE_URL = openaiCompat.base_url;
    }
    if (openaiCompat.api_key) {
      process.env.OPENAI_API_KEY = openaiCompat.api_key;
    } else if (openaiCompat.api_key_env) {
      const name = openaiCompat.api_key_env;
      const key = process.env[name] ?? pickEnvValue(name);
      if (!key) {
        logger.warn(t("providers_openai_api_key_env_not_found", { name }));
      } else {
        process.env.OPENAI_API_KEY = key;
      }
    }

    this.observabilityHub = new ObservabilityHub();

    this.runtimeProvider = new PiSessionProvider(
      config.runtime.pi.agentDir,
      ({ agentId, event, role }) => {
        this.observabilityHub.emit(
          {
            source: "pi",
            type: `pi.${event.type}`,
            agentId,
            role,
            payload: { piEvent: event as unknown as Record<string, unknown> },
          },
          { skipBuffer: true },
        );
      },
      ({ agentId, error }) => {
        // SDK 上报的 session 级错误：转发给 TaskManager 向上层 Agent 推送崩溃通知
        void this.taskManager.handleAgentCrash(agentId, error).catch((e: unknown) => {
          logger.warn("handleAgentCrash failed", {
            agentId,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      },
    );

    const workspaceProvider = new WorkspaceProviderFactory(
      config,
    ).getProvider();
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
      this.skillResolver,
      this.observabilityHub,
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

  private buildAdminSpec(): AgentInstanceSpec {
    const adminModel = this.config.admin.model;
    if (!adminModel) throw new Error(t("admin_model_missing"));
    return {
      id: AgentRoleEnum.Admin,
      role: AgentRoleEnum.Admin,
      name: AgentRoleEnum.Admin,
      branch: this.config.project.base_branch,
      workspacePath: path.join(
        this.config.workspace.root_dir,
        AgentRoleEnum.Admin,
      ),
      model: adminModel,
      skills: this.config.admin.skills,
    };
  }

  private buildLeaderSpec(team: TeamConfig): AgentInstanceSpec {
    const leaderModel = team.leader.model;
    if (!leaderModel)
      throw new Error(t("leader_model_missing", { teamName: team.name }));
    return {
      id: `${team.name}-lead`,
      role: AgentRoleEnum.Leader,
      teamName: team.name,
      name: `${team.name}-lead`,
      branch: team.branch_prefix,
      workspacePath: path.join(
        this.config.workspace.root_dir,
        `${team.name}-lead`,
      ),
      model: leaderModel,
      skills: team.leader.skills,
    };
  }

  /** 构建各角色在 pi 会话中使用的编排工具（通过 defineTool 直接调用 TaskManager）。 */
  private buildOrchestratorTools(spec: AgentInstanceSpec): ReturnType<typeof defineTool>[] {
    const tm = this.taskManager;

    const registerWorkersTool = defineTool({
      name: "register-workers",
      label: "Register Workers",
      description: "Register N worker agents (spawn sessions) without assigning tasks yet. Call dispatch-worker-tasks next.",
      parameters: Type.Object({
        leaderId: Type.Optional(Type.String({ description: "The caller leader agent id (optional; defaults to current agent)" })),
        count: Type.Number({ description: "How many workers to register (indices 0 .. count-1)" }),
      }),
      execute: async (_toolCallId, params) => {
        const leaderId = params.leaderId ?? spec.id;
        const result = await tm.registerWorkers(leaderId, { leaderId, count: params.count });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      },
    });

    const dispatchWorkerTasksTool = defineTool({
      name: "dispatch-worker-tasks",
      label: "Dispatch Worker Tasks",
      description: "Dispatch task prompts to already-registered workers (after register-workers).",
      parameters: Type.Object({
        leaderId: Type.Optional(Type.String({ description: "The caller leader agent id (optional; defaults to current agent)" })),
        tasks: Type.Array(
          Type.Object({
            index: Type.Optional(Type.Number({ description: "Worker index (0-based); defaults to task order" })),
            prompt: Type.String({ description: "Task prompt for this worker" }),
          }),
          { description: "Tasks to assign to workers" }
        ),
      }),
      execute: async (_toolCallId, params) => {
        const leaderId = params.leaderId ?? spec.id;
        const result = await tm.dispatchWorkerTasks(leaderId, { leaderId, tasks: params.tasks ?? [] });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      },
    });

    const requestWorkersTool = defineTool({
      name: "request-workers",
      label: "Request Workers",
      description: "Shortcut: register workers and dispatch tasks in one call. Prefer register-workers then dispatch-worker-tasks for two-phase flow.",
      parameters: Type.Object({
        leaderId: Type.Optional(Type.String({ description: "The caller leader agent id (optional; defaults to current agent)" })),
        tasks: Type.Array(
          Type.Object({
            index: Type.Optional(Type.Number({ description: "Worker index (0-based)" })),
            prompt: Type.String({ description: "Worker prompt for this task" }),
          }),
          { description: "Worker tasks to run" }
        ),
      }),
      execute: async (_toolCallId, params) => {
        const leaderId = params.leaderId ?? spec.id;
        const result = await tm.requestWorkers(leaderId, { leaderId, tasks: params.tasks ?? [] });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      },
    });

    const assignLeaderTaskTool = defineTool({
      name: "assign-leader-task",
      label: "Assign Leader Task",
      description: "Assign a task prompt to a specific leader. Admin uses this to decide which leader should handle the work.",
      parameters: Type.Object({
        leaderId: Type.String({ description: "Target leader agent id" }),
        prompt: Type.String({ description: "Task prompt to send to the leader (orchestration instruction)" }),
      }),
      execute: async (_toolCallId, params) => {
        const result = await tm.assignLeaderTask(params.leaderId, params.prompt);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      },
    });

    const notifyCompleteTool = defineTool({
      name: "notify-complete",
      label: "Notify Complete",
      description: "Notify orchestrator that an agent has completed its work.",
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
        stage: Type.Optional(Type.String({ description: "Execution stage, e.g. start/changelog_update/before_notify_complete/done" })),
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

    return [
      registerWorkersTool,
      dispatchWorkerTasksTool,
      requestWorkersTool,
      assignLeaderTaskTool,
      notifyCompleteTool,
      reportProgressTool,
      generateChangelogTool,
    ];
  }

  async start(): Promise<void> {
    // 在任何子进程启动前即注册信号处理器。
    // 若启动阶段（workspace 创建、模型加载等）耗时较长，用户 Ctrl-C 仍能触发 stopAll()
    // 避免已 fork 的子进程成为孤儿进程。
    // httpServer 在信号到达时可能尚未创建，用 null 占位，创建后再更新。
    let httpServer: Server | null = null;
    this.registerShutdownHandlers(() => httpServer);

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

    const adminSpec = this.buildAdminSpec();
    const leadersSpecs = this.config.teams.map((team) =>
      this.buildLeaderSpec(team),
    );

    // 1) Admin workspace 配置 + 启动 pi 会话
    await this.workspaceProvider.ensureWorkspace(adminSpec, []);
    await this.skillResolver.syncSkillsToWorkspace(
      adminSpec.skills ?? [],
      adminSpec.workspacePath,
    );

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
      `4) You MUST report execution progress using tool report-progress:`,
      `   { "agentId": "${AgentRoleEnum.Admin}", "stage": "<stage>", "message": "<short message>" }`,
      `5) You MUST call report-progress at least 3 times:`,
      `   1) stage="start" (when you begin orchestration),`,
      `   2) stage="after_assign_leader_task" (right after assign-leader-task returns),`,
      `   3) stage="done" (as the last step before you finish).`,
      `6) If you receive DASHBOARD_INSTRUCTION:, treat it as a new operator goal — choose the best leader again if needed, then assign-leader-task and report-progress as above.`,
    ].join("\n");

    const adminScopeCtx: OatWorkspaceScopeContext = {
      workspaceRoot: this.config.workspace.root_dir,
      workspacePath: adminSpec.workspacePath,
      role: AgentRoleEnum.Admin,
      teams: this.config.teams.map((t) => ({ name: t.name, worker: { total: t.worker.total } })),
    };
    await writeAgentWorkspaceConfig({
      workspacePath: adminSpec.workspacePath,
      agentName: adminSpec.name,
      role: AgentRoleEnum.Admin,
      scopeCtx: adminScopeCtx,
      orchestratorBaseUrl: `http://127.0.0.1:${this.port}`,
    });

    const adminSystemPrompt = buildAgentSystemPrompt({
      agentName: adminSpec.name,
      description: `Admin agent`,
      role: AgentRoleEnum.Admin,
      promptText: adminPromptWithGoal,
      skills: adminSpec.skills ?? [],
    });

    const adminTools = this.buildOrchestratorTools(adminSpec);
    await this.runtimeProvider.start(adminSpec, {
      systemPrompt: adminSystemPrompt,
      customTools: adminTools,
    });
    const adminSessionId = adminSpec.id;

    // 2) Leaders workspace 配置 + 启动 pi 会话（收集 initialPrompt，延后发送）
    const leaders: Array<{
      sessionId: string;
      spec: AgentInstanceSpec;
      team: TeamConfig;
    }> = [];
    const leaderInitialPrompts: Array<{ specId: string; prompt: string }> = [];

    for (let i = 0; i < leadersSpecs.length; i++) {
      const team = this.config.teams[i];
      const spec = leadersSpecs[i];
      const sparsePaths = team.leader.repos ?? [];
      await this.workspaceProvider.ensureWorkspace(spec, sparsePaths);
      await this.skillResolver.syncSkillsToWorkspace(
        spec.skills ?? [],
        spec.workspacePath,
      );

      const leaderScopeCtx: OatWorkspaceScopeContext = {
        workspaceRoot: this.config.workspace.root_dir,
        workspacePath: spec.workspacePath,
        role: AgentRoleEnum.Leader,
        teamName: team.name,
        teams: this.config.teams.map((t) => ({ name: t.name, worker: { total: t.worker.total } })),
      };
      await writeAgentWorkspaceConfig({
        workspacePath: spec.workspacePath,
        agentName: spec.name,
        role: AgentRoleEnum.Leader,
        scopeCtx: leaderScopeCtx,
        orchestratorBaseUrl: `http://127.0.0.1:${this.port}`,
      });

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
        `5) You MUST report execution progress using tool report-progress:`,
        `   { "agentId": "${spec.id}", "stage": "<stage>", "message": "<short message>" }`,
        `6) You MUST call report-progress at least 3 times:`,
        `   1) stage="start" (when you start handling ADMIN_TASK),`,
        `   2) stage="after_dispatch_worker_tasks" (right after dispatch-worker-tasks returns),`,
        `   3) stage="done" (as the last step before you finish).`,
        ``,
        `If you already dispatched, you can wait for workers to call notify-complete.`,
      ].join("\n");

      const leaderSystemPrompt = buildAgentSystemPrompt({
        agentName: spec.name,
        description: `Leader agent for ${team.name}`,
        role: AgentRoleEnum.Leader,
        promptText: team.leader.prompt,
        skills: spec.skills ?? [],
      });

      const leaderTools = this.buildOrchestratorTools(spec);
      await this.runtimeProvider.start(spec, {
        systemPrompt: leaderSystemPrompt,
        customTools: leaderTools,
      });

      leaders.push({ sessionId: spec.id, spec, team });
      leaderInitialPrompts.push({ specId: spec.id, prompt: leaderPrompt });
    }

    // 先将全部 Agent 注册到 TaskManager，再发送任何 prompt（避免 prompt 触发工具调用时 agent 尚未注册的竞态）
    await this.taskManager.startAdminAndLeaders(
      { sessionId: adminSessionId, spec: adminSpec },
      leaders,
    );

    // 3) Team 启动时预先创建 worker 进程池
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

    // 4) 所有 Agent 注册完毕后再统一发送初始 prompt（消除注册竞态）
    await this.runtimeProvider.sendPrompt(adminSpec.id, adminPromptWithGoal);
    for (const { specId, prompt } of leaderInitialPrompts) {
      await this.runtimeProvider.sendPrompt(specId, prompt);
    }

    httpServer = this.app.listen(this.port, "0.0.0.0", () => {
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
  }

  /**
   * 注册进程信号处理器（SIGINT / SIGTERM）。
   *
   * 接受一个返回当前 HTTP Server 的 getter，而非直接传入 Server 实例，
   * 因为在启动阶段信号可能在 app.listen 之前到达，此时 httpServer 为 null。
   * 若关机时 HTTP Server 尚未创建，则跳过 server.close()，直接 stopAll() 后退出。
   */
  private registerShutdownHandlers(getHttpServer: () => Server | null): void {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(t("orchestrator_shutting_down", { signal }));
      void (async () => {
        try {
          await this.runtimeProvider.stopAll();
        } catch (e) {
          logger.warn(t("runtime_stop_all_failed"), {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        const server = getHttpServer();
        if (server) {
          server.close(() => process.exit(0));
        } else {
          process.exit(0);
        }
        const forceExit = setTimeout(() => process.exit(0), 10_000);
        forceExit.unref();
      })();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }
}
