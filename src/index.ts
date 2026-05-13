#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "./config/loader";
import { Orchestrator } from "./orchestrator/orchestrator";
import { logger } from "./utils/logger";
import {
  cleanupStaleProjectLinks,
  ensureHomeProjectLink,
  expandHomePath,
  resolvePathFromTeamRoot,
  resolveTeamJsonPath,
} from "./utils/team-paths";
import { getLang, loadLangFromOatYaml, setLang, t, type Lang } from "./i18n/i18n";
import { fileURLToPath } from "node:url";
import { cleanupAgentLogs } from "./utils/log-cleanup";
import { getLogRetentionDays } from "./utils/oat-config";
import net from "node:net";

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_PORT = 8787;
const PORT_SCAN_LIMIT = 100; // 最多扫描 100 个端口

/** 检测端口是否可用 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, "0.0.0.0");
  });
}

/**
 * 自动解析端口：
 * 1. 用户通过 --port 显式指定 → 直接使用
 * 2. 存在 state 文件中记录的端口 → 优先使用
 * 3. 从 DEFAULT_PORT (8787) 开始向上扫描可用端口
 */
async function resolvePort(explicitPort: number, stateFile: string): Promise<number> {
  // 用户显式指定了端口
  if (explicitPort > 0) return explicitPort;

  // 尝试从上次启动的 state 文件读取端口
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const state = JSON.parse(raw) as Record<string, unknown>;
    const savedPort = Number(state.orchestratorPort);
    if (savedPort > 0 && await isPortFree(savedPort)) {
      logger.info(`Reusing port ${savedPort} from previous state`);
      return savedPort;
    }
  } catch { /* no state file or unreadable */ }

  // 从 8787 开始扫描
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_SCAN_LIMIT; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No available port found in range ${DEFAULT_PORT}–${DEFAULT_PORT + PORT_SCAN_LIMIT - 1}`);
}

async function resolveStateDirInput(stateDir?: string): Promise<string> {
  if (stateDir && stateDir.trim().length > 0) {
    const expanded = expandHomePath(stateDir.trim());
    return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
  }
  const teamJsonPath = await resolveTeamJsonPath();
  return path.join(path.dirname(teamJsonPath), ".oat", "state");
}

import { readFileSync } from "node:fs";

const program = new Command();

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

program.name("oat").description("Agent Team Orchestrator").version(pkg.version, "-v, --version");

program.option("--lang <lang>", "Output language: en | zh-CN | fr | ja");

program
  .command("start")
  .description("Start orchestrator (team.json: --config or cwd/team.json / OAT_TEAM_JSON)")
  .option(
    "--config <path>",
    "path to team.json (default: ./team.json under cwd, or OAT_TEAM_JSON when set)",
  )
  .option("--goal <text>", "project goal prompt (optional)")
  .option("--port <number>", "orchestrator HTTP port (0 = auto)", "0")
  .option("--daemon", "run orchestrator in background (internal use)")
  .action(
    async (options: {
      port: string;
      config?: string;
      goal?: string;
      daemon?: boolean;
    }) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }
    // default is already English ("en") in i18n.ts

    const configArg = options.config?.trim();
    const abs = await resolveTeamJsonPath(
      configArg && configArg.length > 0 ? configArg : undefined,
    );
    const cfg = await loadConfig(abs);
    const stateDir = cfg.runtime.persistence.state_dir;
    await ensureDir(stateDir);

    if (!options.daemon) {
      const { spawn } = await import("node:child_process");
      const fsSync = await import("node:fs");
      const logPath = path.join(stateDir, "orchestrator.log");
      const out = fsSync.openSync(logPath, "a");
      const err = fsSync.openSync(logPath, "a");

      const args = process.argv.slice(2);
      if (!args.includes("--daemon")) {
        args.push("--daemon");
      }

      const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
        detached: true,
        stdio: ["ignore", out, err],
      });
      child.unref();

      logger.success(t("started_in_background", { logPath }));
      logger.info(t("dashboard_hint"));
      process.exit(0);
    }

    const goal = (options.goal ?? "").trim();
    logger.info(t("log_startup_context"), {
      configPath: abs,
      cliGoal: goal.length > 0 ? goal : "(empty)",
      projectRepo: cfg.project.repo,
      baseBranch: cfg.project.base_branch,
      stateDir: cfg.runtime.persistence.state_dir,
      workspaceRoot: cfg.workspace.root_dir,
      orchestratorPort: Number(options.port),
      teams: cfg.teams.map((team) => team.name),
    });
    const link = await ensureHomeProjectLink(abs, cfg.project.name);
    if (link.ok) {
      logger.info(t("log_home_project_link"), { linkPath: link.linkPath, target: link.target });
    } else {
      logger.warn(t("log_home_project_link_skipped"), { reason: link.reason });
    }

    // Clean up stale project symlinks in ~/.oat/projects/
    const cleanup = await cleanupStaleProjectLinks();
    if (cleanup.cleaned.length > 0) {
      logger.info("cleaned stale project links", { cleaned: cleanup.cleaned });
    }
    if (cleanup.errors.length > 0) {
      logger.warn("errors cleaning project links", { errors: cleanup.errors });
    }

    // Clean up old agent logs based on retention config
    try {
      const retentionDays = await getLogRetentionDays();
      const logCleanup = await cleanupAgentLogs(cfg.workspace.root_dir, retentionDays);
      if (logCleanup.cleaned.length > 0) {
        logger.info("cleaned old agent logs", { count: logCleanup.cleaned.length, retentionDays });
      }
    } catch (e) {
      logger.warn("agent log cleanup failed", { error: e instanceof Error ? e.message : String(e) });
    }

    const stateFile = path.join(stateDir, "orchestrator.json");
    const port = await resolvePort(Number(options.port), stateFile);
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dashboardDist = path.join(packageRoot, "dashboard", "dist");
    const dashboardIndex = path.join(dashboardDist, "index.html");
    const hasDashboard = await fileExists(dashboardIndex);
    if (!hasDashboard) {
      logger.warn(t("dashboard_dist_missing", { path: dashboardDist }));
    }
    const orch = new Orchestrator(cfg, {
      goal,
      port,
      configPath: abs,
      dashboardDist: hasDashboard ? dashboardDist : undefined,
    });
    await orch.start();
    logger.success(t("orchestrator_started"));
    logger.info(t("start_observability_hint", { port }));
  });

program
  .command("list")
  .alias("ls")
  .description("List all local OAT projects and their orchestrator status")
  .action(async () => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    const os = await import("node:os");
    const chalk = (await import("chalk")).default;
    const linkRoot = path.join(os.homedir(), ".oat", "projects");
    let entries: any[];
    try {
      entries = await fs.readdir(linkRoot, { withFileTypes: true });
    } catch {
      logger.info(t("no_oat_projects_found") || "No OAT projects found.");
      return;
    }

    const projects = [];
    for (const entry of entries) {
      if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
      const linkPath = path.join(linkRoot, entry.name);
      let target: string;
      try {
        target = await fs.realpath(linkPath);
      } catch {
        continue;
      }

      let stateDir = path.join(target, ".oat", "state");
      try {
        const config = await loadConfig(path.join(target, "team.json"));
        if (config.runtime?.persistence?.state_dir) {
          stateDir = config.runtime.persistence.state_dir;
        }
      } catch {}

      let running = false;
      let pid: number | undefined;
      let port: number | undefined;
      let startTime: number | undefined;

      const orchJson = path.join(stateDir, "orchestrator.json");
      try {
        const raw = await fs.readFile(orchJson, "utf8");
        const data = JSON.parse(raw);
        pid = data.pid;
        port = data.port;
        startTime = data.startTime;
        if (pid) {
          try {
            process.kill(pid, 0);
            running = true;
          } catch {}
        }
      } catch {}

      projects.push({
        id: entry.name,
        target,
        running,
        pid,
        port,
        startTime,
      });
    }

    if (projects.length === 0) {
      logger.info(t("no_oat_projects_found") || "No valid OAT projects found.");
      return;
    }

    console.log(`\nOAT Projects (${projects.length}):\n`);
    for (const p of projects) {
      const statusStr = p.running 
        ? chalk.green(`RUNNING (PID: ${p.pid}, Port: ${p.port})`) 
        : chalk.gray(`STOPPED`);
      console.log(`  Project: ${chalk.cyan(p.id)}`);
      console.log(`  Path:    ${p.target}`);
      console.log(`  Status:  ${statusStr}`);
      if (p.running && p.startTime) {
        console.log(`  Uptime:  ${Math.round((Date.now() - p.startTime) / 60000)} mins`);
      }
      console.log("");
    }
  });

program
  .command("stop")
  .argument("[projectId]", "Project ID to stop")
  .option("--all", "Stop all running projects")
  .action(async (projectId: string | undefined, options: { all?: boolean }) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    if (!options.all && !projectId) {
      logger.error("Please specify a <projectId> or use --all to stop all projects.");
      process.exit(1);
    }

    const os = await import("node:os");
    const linkRoot = path.join(os.homedir(), ".oat", "projects");
    let entries: any[];
    try {
      entries = await fs.readdir(linkRoot, { withFileTypes: true });
    } catch {
      if (options.all) {
        logger.info(t("no_oat_projects_found") || "No OAT projects found.");
        return;
      }
      logger.error(t("project_not_found", { projectId: projectId! }));
      return;
    }

    const projectsToStop = options.all ? entries.map(e => e.name) : [projectId!];

    let stoppedCount = 0;
    for (const pidName of projectsToStop) {
      const linkPath = path.join(linkRoot, pidName);
      let target: string;
      try {
        target = await fs.realpath(linkPath);
      } catch {
        if (!options.all) logger.error(t("project_not_found", { projectId: pidName }));
        continue;
      }

      let stateDir = path.join(target, ".oat", "state");
      try {
        const config = await loadConfig(path.join(target, "team.json"));
        if (config.runtime?.persistence?.state_dir) {
          stateDir = config.runtime.persistence.state_dir;
        }
      } catch {}

      const orchJson = path.join(stateDir, "orchestrator.json");
      try {
        const raw = await fs.readFile(orchJson, "utf8");
        const data = JSON.parse(raw);
        if (data.pid) {
          process.kill(data.pid, "SIGTERM");
          logger.success(`Stopped project: ${pidName}`);
          stoppedCount++;
          continue;
        }
      } catch {}
      if (!options.all) logger.warn(t("orchestrator_pid_not_found"));
    }

    if (options.all && stoppedCount === 0) {
      logger.info("No running projects found to stop.");
    }
  });

program
  .command("rm")
  .argument("<projectId>", "Project ID to remove")
  .action(async (projectId: string) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    const os = await import("node:os");
    const linkPath = path.join(os.homedir(), ".oat", "projects", projectId);
    let target: string;
    try {
      target = await fs.realpath(linkPath);
    } catch {
      logger.error(t("project_not_found", { projectId }));
      return;
    }

    let stateDir = path.join(target, ".oat", "state");
    let workspaceRoot = path.join(target, ".oat", "workspaces");
    try {
      const config = await loadConfig(path.join(target, "team.json"));
      if (config.runtime?.persistence?.state_dir) {
        stateDir = config.runtime.persistence.state_dir;
      }
      if (config.workspace?.root_dir) {
        workspaceRoot = config.workspace.root_dir;
      }
    } catch {}

    const orchJson = path.join(stateDir, "orchestrator.json");
    let running = false;
    try {
      const raw = await fs.readFile(orchJson, "utf8");
      const data = JSON.parse(raw);
      if (data.pid) {
        try {
          process.kill(data.pid, 0);
          running = true;
        } catch {}
      }
    } catch {}

    if (running) {
      logger.error(t("project_running_cannot_rm", { projectId }));
      process.exit(1);
    }

    try {
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      if ((await fs.lstat(linkPath)).isSymbolicLink() || (await fs.lstat(linkPath)).isDirectory()) {
         await fs.unlink(linkPath);
      }
      logger.success(t("project_removed_success", { projectId }));
    } catch (e) {
      logger.error(`Failed to remove project data: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

program
  .command("inspect")
  .argument("[stateDir]", "state dir")
  .argument("[workspaceRoot]", "workspace root", "workspaces")
  .option("--limit <number>", "max workspace entries to show", "50")
  .action(async (stateDir: string | undefined, workspaceRoot: string, options: { limit: string }) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    const resolvedStateDir = await resolveStateDirInput(stateDir);
    const expandedWs = expandHomePath(workspaceRoot);
    const resolvedWorkspaceRoot = path.isAbsolute(expandedWs)
      ? expandedWs
      : resolvePathFromTeamRoot(await resolveTeamJsonPath(), workspaceRoot);
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 50;

    const orchFile = path.join(resolvedStateDir, "orchestrator.json");
    if (await fileExists(orchFile)) {
      try {
        const raw = await fs.readFile(orchFile, "utf8");
        const orch = JSON.parse(raw);
        logger.info(t("log_orchestrator_state"), {
          stateFile: orchFile,
          pid: orch?.pid,
          port: orch?.orchestratorPort,
          startedAt: orch?.startedAt,
        });
      } catch (e) {
        logger.warn(t("orchestrator_state_parse_failed", { stateFile: orchFile }), {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      logger.warn(t("orchestrator_json_not_found"), { path: orchFile });
    }

    if (!(await fileExists(resolvedWorkspaceRoot))) {
      logger.warn(t("workspace_root_not_found", { workspaceRoot: resolvedWorkspaceRoot }));
      return;
    }

    const dirents = await fs.readdir(resolvedWorkspaceRoot, { withFileTypes: true });
    const directories = dirents.filter((d) => d.isDirectory()).map((d) => d.name);

    const inspections = await Promise.all(
      directories.map(async (name) => {
        const workspacePath = path.join(resolvedWorkspaceRoot, name);
        const changelogPath = path.join(workspacePath, "CHANGELOG.md");
        const hasChangelog = await fileExists(changelogPath);
        const wsStat = await fs.stat(workspacePath);
        const clStat = hasChangelog ? await fs.stat(changelogPath) : null;
        return {
          agentId: name,
          workspacePath,
          workspaceUpdatedAt: wsStat.mtime.toISOString(),
          hasChangelog,
          changelogUpdatedAt: clStat?.mtime.toISOString() ?? null,
        };
      })
    );

    inspections.sort((a, b) => {
      const at = a.changelogUpdatedAt ?? a.workspaceUpdatedAt;
      const bt = b.changelogUpdatedAt ?? b.workspaceUpdatedAt;
      return bt.localeCompare(at);
    });

    const shown = inspections.slice(0, limit);
    logger.info(t("workspace_inspection"), {
      workspaceRoot: resolvedWorkspaceRoot,
      totalAgents: inspections.length,
      shownAgents: shown.length,
      items: shown,
    });
  });

program
  .command("docs")
  .argument("<name>", "architecture | config | guide | cli")
  .action(async (name: string) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    const docLang: Lang = getLang();
    const thisDir = path.dirname(fileURLToPath(import.meta.url)); // .../src or .../dist
    const pkgRoot = path.resolve(thisDir, ".."); // project root or package root
    const file = path.join(pkgRoot, "docs", docLang, `${name}.md`);
    try {
      const content = await fs.readFile(file, "utf8");
      process.stdout.write(content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(t("docs_file_not_found", { file }), { details: msg });
    }
  });

program
  .command("dashboard")
  .description("Open the OAT dashboard in the default browser")
  .action(async () => {
    const os = await import("node:os");
    const projectsDir = path.join(os.homedir(), ".oat", "projects");
    let hasProjects = false;
    try {
      const entries = await fs.readdir(projectsDir);
      if (entries.length > 0) {
        hasProjects = true;
      }
    } catch {}

    if (!hasProjects) {
      logger.warn(t("dashboard_no_projects"));
      process.exit(0);
    }

    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dashboardDist = path.join(packageRoot, "dashboard", "dist");
    const dashboardIndex = path.join(dashboardDist, "index.html");

    if (!(await fileExists(dashboardIndex))) {
      logger.error("Dashboard build not found. Run `pnpm build:dashboard` first.", { path: dashboardDist });
      process.exit(1);
    }

    const dashStatePath = path.join(os.homedir(), ".oat", "dashboard.json");
    try {
      if (await fileExists(dashStatePath)) {
        const dashState = JSON.parse(await fs.readFile(dashStatePath, "utf8"));
        if (dashState.pid && dashState.port) {
          try {
            process.kill(dashState.pid, 0);
            const url = `http://localhost:${dashState.port}`;
            logger.info(`Dashboard is already running. Opening ${url}`);
            const { exec } = await import("node:child_process");
            const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
            exec(`${cmd} ${url}`);
            return;
          } catch {}
        }
      }
    } catch {}

    const net = await import("node:net");
    const findAvailablePort = async (startPort: number): Promise<number> => {
      return new Promise((resolve) => {
        const srv = net.createServer();
        srv.on("error", () => resolve(findAvailablePort(startPort + 1)));
        srv.listen(startPort, () => srv.close(() => resolve(startPort)));
      });
    };

    const port = await findAvailablePort(3737);
    const { createServer } = await import("node:http");
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };

    const server = createServer(async (req, res) => {
      let urlPath = req.url?.split("?")[0] ?? "/";
      if (urlPath === "/") urlPath = "/index.html";

      const filePath = path.join(dashboardDist, urlPath);
      if (!filePath.startsWith(dashboardDist)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      try {
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
        res.end(data);
      } catch {
        try {
          const html = await fs.readFile(dashboardIndex);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);
        } catch {
          res.writeHead(404);
          res.end("Not Found");
        }
      }
    });

    server.listen(port, async () => {
      await ensureDir(path.dirname(dashStatePath));
      await fs.writeFile(dashStatePath, JSON.stringify({ pid: process.pid, port }), "utf8");

      const url = `http://localhost:${port}`;
      logger.success(`Dashboard serving at ${url}`);

      const { exec } = await import("node:child_process");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${cmd} ${url}`);
    });
  });

program
  .command("init")
  .description("Initialize a new team.json in the current directory")
  .action(async () => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    const targetPath = path.join(process.cwd(), "team.json");
    if (await fileExists(targetPath)) {
      logger.warn(t("init_team_json_exists"));
      process.exit(1);
    }

    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const examplePath = path.join(packageRoot, "team.example.json");

    try {
      await fs.copyFile(examplePath, targetPath);
      logger.success(t("init_success"));
    } catch (e) {
      logger.error(`Failed to initialize team.json: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program.parseAsync();

function toLang(v: any): Lang | null {
  if (v === "en") return "en";
  if (v === "zh-CN" || v === "zh") return "zh-CN";
  if (v === "fr" || v === "fr-FR") return "fr";
  if (v === "ja" || v === "ja-JP") return "ja";
  return null;
}

