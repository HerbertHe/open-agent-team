import express from "express";
import type { Server } from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { AgentRoleEnum } from "../types";
import type {
  OrchestratorCtorArgs,
  ResolvedConfig,
  AgentInstanceSpec,
  TeamConfig,
} from "../types";
import { rewriteModelProviderByCompatibleType } from "../utils/model-utils";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { PiSessionProvider } from "../sandbox/local-process";
import { MergeManager } from "../git/merge-manager";
import { setLocalGitIdentity } from "../git/git-identity";
import { SkillResolver } from "../skills/skill-resolver";
import { ChangelogManager } from "../changelog/changelog-manager";
import { WorkspaceProviderFactory } from "../workspace/workspace-provider";
import { TaskManager } from "./task-manager";
import { ObservabilityHub } from "./observability-hub";
import { UsageTracker } from "./usage-tracker";
import { logger } from "../utils/logger";
import { t } from "../i18n/i18n";
import { loadOatConfig, saveOatConfig } from "../utils/oat-config";
import {
  writeAgentWorkspaceConfig,
  buildAgentSystemPrompt,
  type OatWorkspaceScopeContext,
} from "../pi/workspace-inject";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

function parseBaseDir(input: string): string {
  if (input.startsWith("~/") || input.startsWith("~\\"))
    return path.join(os.homedir(), input.slice(2));
  return input;
}

export class Orchestrator {
  private readonly app = express();
  private readonly taskManager: TaskManager;
  private readonly stateDir: string;
  private readonly stateFile: string;
  private readonly configPath: string;
  private readonly runtimeProvider: PiSessionProvider;
  private readonly workspaceProvider: ReturnType<
    WorkspaceProviderFactory["getProvider"]
  >;
  private readonly skillResolver: SkillResolver;
  private readonly observabilityHub: ObservabilityHub;
  private readonly usageTracker: UsageTracker;
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
    this.configPath = args.configPath;
    this.dashboardDist =
      args.dashboardDist &&
      existsSync(path.join(args.dashboardDist, "index.html"))
        ? path.resolve(args.dashboardDist)
        : undefined;
    this.stateDir = parseBaseDir(config.runtime.persistence.state_dir);
    this.stateFile = path.join(this.stateDir, "orchestrator.json");

    for (const [, providerCfg] of Object.entries(config.providers)) {
      if (providerCfg.compatible_type === "openai") {
        if (providerCfg.base_url) process.env.OPENAI_BASE_URL = providerCfg.base_url;
        if (providerCfg.api_key) process.env.OPENAI_API_KEY = providerCfg.api_key;
      } else if (providerCfg.compatible_type === "anthropic") {
        if (providerCfg.base_url) process.env.ANTHROPIC_BASE_URL = providerCfg.base_url;
        if (providerCfg.api_key) process.env.ANTHROPIC_API_KEY = providerCfg.api_key;
      }
    }

    this.observabilityHub = new ObservabilityHub();
    this.usageTracker = new UsageTracker(config.project.name, (agentId, role) => {
      let rawModel = "unknown";
      if (role === "admin") rawModel = config.admin.model || "unknown";
      else if (role === "leader") {
        const teamName = agentId.replace("-lead", "");
        const team = config.teams.find(t => t.name === teamName);
        rawModel = team?.leader?.model || config.model || "unknown";
      }
      else if (role === "worker") {
        const match = agentId.match(/(.+)-worker-\d+/);
        if (match) {
          const team = config.teams.find(t => t.name === match[1]);
          rawModel = team?.worker?.model || team?.leader?.model || config.admin.model || config.model || "unknown";
        }
      }
      return config.models?.[rawModel] || rawModel;
    });
    this.usageTracker.attach(this.observabilityHub);

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
    this.skillResolver = new SkillResolver();

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

    // --- team.json read/write API ---
    this.app.get("/api/team-config", async (_req, res) => {
      try {
        const raw = await fs.readFile(this.configPath, "utf8");
        res.type("json").send(raw);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.put("/api/team-config", async (req, res) => {
      try {
        const content = JSON.stringify(req.body, null, 2);
        await fs.writeFile(this.configPath, content, "utf8");
        res.json({ ok: true });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    // --- project-specific config read/write ---
    this.app.get("/api/projects/:name/config", async (req, res) => {
      try {
        const linkRoot = path.join(os.homedir(), ".oat", "projects");
        const linkPath = path.join(linkRoot, req.params.name);
        const realTarget = await fs.realpath(linkPath);
        // Try configPath from state, fallback to team.json
        let configFilePath = path.join(realTarget, "team.json");
        try {
          const stateFile = path.join(realTarget, ".oat", "state", "orchestrator.json");
          const raw = await fs.readFile(stateFile, "utf8");
          const state = JSON.parse(raw) as Record<string, unknown>;
          if (typeof state.configPath === "string") {
            configFilePath = path.isAbsolute(state.configPath)
              ? state.configPath
              : path.join(realTarget, state.configPath);
          }
        } catch { /* use default */ }
        const raw = await fs.readFile(configFilePath, "utf8");
        res.type("json").send(raw);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.put("/api/projects/:name/config", async (req, res) => {
      try {
        const linkRoot = path.join(os.homedir(), ".oat", "projects");
        const linkPath = path.join(linkRoot, req.params.name);
        const realTarget = await fs.realpath(linkPath);
        let configFilePath = path.join(realTarget, "team.json");
        try {
          const stateFile = path.join(realTarget, ".oat", "state", "orchestrator.json");
          const raw = await fs.readFile(stateFile, "utf8");
          const state = JSON.parse(raw) as Record<string, unknown>;
          if (typeof state.configPath === "string") {
            configFilePath = path.isAbsolute(state.configPath)
              ? state.configPath
              : path.join(realTarget, state.configPath);
          }
        } catch { /* use default */ }
        const content = JSON.stringify(req.body, null, 2);
        await fs.writeFile(configFilePath, content, "utf8");
        res.json({ ok: true });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    // --- project achievements ---
    this.app.get("/api/projects/:name/workspaces/:agentId/changelog", async (req, res) => {
      try {
        const { name, agentId } = req.params;
        const linkPath = path.join(os.homedir(), ".oat", "projects", name);
        const realTarget = await fs.realpath(linkPath);
        const changelogPath = path.join(realTarget, ".oat", "workspaces", agentId, "CHANGELOG.md");
        let content = "";
        try {
          content = await fs.readFile(changelogPath, "utf8");
        } catch {
          // File may not exist yet
        }
        res.json({ content });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });
    this.app.get("/api/projects/:name/workspaces/:agentId/record-dates", async (req, res) => {
      try {
        const { name, agentId } = req.params;
        const linkPath = path.join(os.homedir(), ".oat", "projects", name);
        const realTarget = await fs.realpath(linkPath);
        const recordsDir = path.join(realTarget, ".oat", "workspaces", agentId, "records");
        
        const dates: string[] = [];
        try {
          const entries = await fs.readdir(recordsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
              dates.push(entry.name);
            }
          }
        } catch {
          // Directory may not exist
        }
        res.json({ dates: dates.sort().reverse() });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });


    this.app.get("/api/projects/:name/workspaces/:agentId/records", async (req, res) => {
      try {
        const { name, agentId } = req.params;
        const date = req.query.date as string;
        if (!date) {
          res.status(400).json({ error: "Missing date query parameter" });
          return;
        }
        const linkPath = path.join(os.homedir(), ".oat", "projects", name);
        const realTarget = await fs.realpath(linkPath);
        const recordsDir = path.join(realTarget, ".oat", "workspaces", agentId, "records", date);
        
        const files: Array<{ name: string; content: string }> = [];
        try {
          const entries = await fs.readdir(recordsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile()) {
              const content = await fs.readFile(path.join(recordsDir, entry.name), "utf8");
              files.push({ name: entry.name, content });
            }
          }
        } catch {
          // Directory may not exist
        }
        res.json({ files });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    // --- multi-team project discovery ---
    this.app.get("/api/projects", async (_req, res) => {
      try {
        const linkRoot = path.join(os.homedir(), ".oat", "projects");
        let entries: Awaited<ReturnType<typeof fs.readdir>>;
        try {
          entries = await fs.readdir(linkRoot, { withFileTypes: true });
        } catch {
          res.json([]);
          return;
        }
        const projects: Array<Record<string, unknown>> = [];
        for (const entry of entries) {
          const linkPath = path.join(linkRoot, entry.name);
          try {
            const realTarget = await fs.realpath(linkPath);
            // Look for .oat/state/orchestrator.json in the project dir
            const stateFile = path.join(realTarget, ".oat", "state", "orchestrator.json");
            let orchState: Record<string, unknown> | null = null;
            try {
              const raw = await fs.readFile(stateFile, "utf8");
              orchState = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              // No state file — project is not running
            }
            let alive = false;
            if (orchState?.pid) {
              try {
                process.kill(orchState.pid as number, 0);
                alive = true;
              } catch {
                alive = false;
              }
            }
            // Read project.name from team.json (configPath in state, or scan for team.json)
            let projectName: string | null = null;
            try {
              const configPath = orchState?.configPath as string | undefined;
              const teamJsonPath = configPath
                ? (path.isAbsolute(configPath) ? configPath : path.join(realTarget, configPath))
                : path.join(realTarget, "team.json");
              const teamRaw = await fs.readFile(teamJsonPath, "utf8");
              const teamJson = JSON.parse(teamRaw) as Record<string, unknown>;
              const proj = teamJson.project as Record<string, unknown> | undefined;
              if (proj?.name && typeof proj.name === "string") {
                projectName = proj.name;
              }
            } catch { /* team.json not found or unreadable */ }
            projects.push({
              name: entry.name,
              projectName,
              projectRootDir: realTarget,
              port: orchState?.orchestratorPort ?? null,
              pid: orchState?.pid ?? null,
              startedAt: orchState?.startedAt ?? null,
              alive,
            });
          } catch {
            // Broken symlink or access error — skip
          }
        }
        res.json(projects);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    // --- delete project ---
    this.app.delete("/api/projects/:name", async (req, res) => {
      try {
        const projectName = req.params.name;
        const linkRoot = path.join(os.homedir(), ".oat", "projects");
        const linkPath = path.join(linkRoot, projectName);

        // Resolve symlink target before deleting
        let realTarget: string | null = null;
        try {
          realTarget = await fs.realpath(linkPath);
        } catch {
          res.status(404).json({ error: "Project link not found" });
          return;
        }

        // Check if project is still running
        try {
          const stateFile = path.join(realTarget, ".oat", "state", "orchestrator.json");
          const raw = await fs.readFile(stateFile, "utf8");
          const state = JSON.parse(raw) as Record<string, unknown>;
          if (state.pid) {
            try {
              process.kill(state.pid as number, 0);
              res.status(409).json({ error: "Project is still running. Stop it first." });
              return;
            } catch {
              // Process not running — safe to delete
            }
          }
        } catch {
          // No state file — safe to proceed
        }

        // Remove the symlink
        try {
          await fs.unlink(linkPath);
        } catch {
          // Already gone
        }

        // Remove the project directory
        if (realTarget) {
          try {
            await fs.rm(realTarget, { recursive: true, force: true });
          } catch (e) {
            // Log but don't fail — symlink is already removed
            logger.warn("Failed to remove project directory", {
              path: realTarget,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        res.json({ ok: true, deleted: projectName, path: realTarget });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    // --- restart project ---
    this.app.post("/api/projects/:name/restart", async (req, res) => {
      try {
        const projectName = req.params.name;
        const linkRoot = path.join(os.homedir(), ".oat", "projects");
        const linkPath = path.join(linkRoot, projectName);
        const realTarget = await fs.realpath(linkPath);
        const stateFile = path.join(realTarget, ".oat", "state", "orchestrator.json");

        let state: Record<string, unknown>;
        try {
          const raw = await fs.readFile(stateFile, "utf8");
          state = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          res.status(404).json({ error: "Project state not found" });
          return;
        }

        const pid = state.pid as number | undefined;
        const argv = state.argv as string[] | undefined;
        if (!argv || argv.length < 2) {
          res.status(400).json({ error: "Cannot determine startup arguments from state" });
          return;
        }

        // Kill existing process
        if (pid) {
          try {
            process.kill(pid, 0); // check if alive
            process.kill(pid, "SIGTERM");
            // Wait briefly for process to exit
            await new Promise((resolve) => setTimeout(resolve, 1500));
          } catch {
            // Already dead
          }
        }

        // Respawn with same argv: argv[0]=node, argv[1]=script, argv[2..]=args
        const [execPath, ...args] = argv;
        const child = spawn(execPath, args, {
          cwd: realTarget,
          detached: true,
          stdio: "ignore",
          env: { ...process.env },
        });
        child.unref();

        res.json({ ok: true, restarted: projectName, newPid: child.pid });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    // --- global config (oat.yaml) ---
    this.app.get("/api/global-config", async (_req, res) => {
      try {
        const config = await loadOatConfig();
        res.json(config);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.put("/api/global-config", async (req, res) => {
      try {
        const updates = req.body as Record<string, unknown>;
        await saveOatConfig(updates);
        res.json({ ok: true });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    // --- global models config (~/.oat/models.json) ---
    const globalModelsPath = path.join(os.homedir(), ".oat", "models.json");

    this.app.get("/api/global-models", async (_req, res) => {
      try {
        const raw = await fs.readFile(globalModelsPath, "utf8");
        res.type("json").send(raw);
      } catch (e: any) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          res.json({ providers: {}, models: {} });
        } else {
          res.status(500).json({ error: String(e?.message ?? e) });
        }
      }
    });

    this.app.put("/api/global-models", async (req, res) => {
      try {
        const incoming = req.body as { providers?: Record<string, unknown>; models?: Record<string, unknown>; replace?: boolean };
        const shouldReplace = incoming.replace === true;
        // Read existing file (if any)
        let existing: { providers: Record<string, unknown>; models: Record<string, unknown> } = { providers: {}, models: {} };
        if (!shouldReplace) {
          try {
            const raw = await fs.readFile(globalModelsPath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
              existing = {
                providers: parsed.providers ?? {},
                models: parsed.models ?? {},
              };
            }
          } catch { /* file doesn't exist yet */ }
        }
        // Merge or replace
        const result = shouldReplace
          ? { providers: incoming.providers ?? {}, models: incoming.models ?? {} }
          : {
              providers: { ...existing.providers, ...(incoming.providers ?? {}) },
              models: { ...existing.models, ...(incoming.models ?? {}) },
            };
        await fs.mkdir(path.dirname(globalModelsPath), { recursive: true });
        await fs.writeFile(globalModelsPath, JSON.stringify(result, null, 2), "utf8");
        res.json({ ok: true });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    // --- usage stats API ---
    this.app.get("/api/usage/projects", async (_req, res) => {
      try {
        const projects = await UsageTracker.listProjects();
        res.json(projects);
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message ?? e) });
      }
    });

    this.app.get("/api/usage/stats", async (req, res) => {
      try {
        const project = req.query.project as string | undefined;
        const range = (req.query.range as string) || "all";
        const groupBy = (req.query.groupBy as string) || "day";
        const validRanges = ["all", "30d", "7d", "yesterday", "today"];
        const validGroupBy = ["day", "hour"];
        const r = validRanges.includes(range) ? range as "all" | "30d" | "7d" | "yesterday" | "today" : "all";
        const g = validGroupBy.includes(groupBy) ? groupBy as "day" | "hour" : "day";

        let stats;
        if (!project || project === "all") {
          stats = await UsageTracker.getAllProjectsStats(r, g);
        } else {
          const tracker = new UsageTracker(project);
          stats = await tracker.getStats(r, g);
        }
        res.json(stats);
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
          req.path.startsWith("/observability") ||
          req.path.startsWith("/api")
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
      model: rewriteModelProviderByCompatibleType(adminModel, this.config.providers),
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
      model: rewriteModelProviderByCompatibleType(leaderModel, this.config.providers),
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
    // ── 端口占用检测 ──
    // 如果端口已被占用，优雅退出而不是 EADDRINUSE 崩溃
    const portInUse = await new Promise<boolean>((resolve) => {
      const tester = net.createServer();
      tester.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") resolve(true);
        else resolve(false);
      });
      tester.once("listening", () => {
        tester.close(() => resolve(false));
      });
      tester.listen(this.port, "0.0.0.0");
    });
    if (portInUse) {
      // 尝试从 state 文件读取已运行实例的信息
      let existing = "";
      try {
        const raw = await fs.readFile(this.stateFile, "utf8");
        const state = JSON.parse(raw) as Record<string, unknown>;
        existing = ` (PID: ${state.pid ?? "unknown"}, started: ${state.startedAt ?? "unknown"})`;
      } catch { /* no state file */ }
      logger.error(
        `Port ${this.port} is already in use${existing}. ` +
        `Another orchestrator instance may be running. ` +
        `Use --port <number> to specify a different port, or stop the existing instance first.`,
      );
      process.exit(1);
    }

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
          configPath: this.configPath,
          goal: this.goal,
          argv: process.argv,
          startedAt: new Date().toISOString(),
          projectRootDir: path.dirname(this.configPath),
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
    const projectName = this.config.project.name;
    await setLocalGitIdentity(
      adminSpec.workspacePath,
      `${projectName}-${this.config.admin.name}`,
      `admin@project-${projectName}.oat`,
    );
    await this.skillResolver.installSkillsToWorkspace(
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
    });

    const adminTools = this.buildOrchestratorTools(adminSpec);
    await this.runtimeProvider.start(adminSpec, {
      systemPrompt: adminSystemPrompt,
      customTools: adminTools,
    });
    this.observabilityHub.enableDiskLogger(adminSpec.workspacePath, adminSpec.id);
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
      await setLocalGitIdentity(
        spec.workspacePath,
        `${team.name}-leader-${team.leader.name}`,
        `leader-${team.name}@project-${projectName}.oat`,
      );
      await this.skillResolver.installSkillsToWorkspace(
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
        `3) After receiving ADMIN_TASK, parse the goal and split into subtasks (at most ${taskWorkerCount}). Dispatch these subtasks via dispatch-worker-tasks.`,
        `   - Prefer to OMIT tasks[].index so the orchestrator auto-assigns tasks to IDLE workers.`,
        `   - Only set tasks[].index when you must target a specific worker.`,
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
      });

      const leaderTools = this.buildOrchestratorTools(spec);
      await this.runtimeProvider.start(spec, {
        systemPrompt: leaderSystemPrompt,
        customTools: leaderTools,
      });
      this.observabilityHub.enableDiskLogger(spec.workspacePath, spec.id);

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
