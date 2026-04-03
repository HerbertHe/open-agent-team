#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "./config/loader";
import { Orchestrator } from "./orchestrator/orchestrator";
import { logger } from "./utils/logger";
import {
  ensureHomeProjectLink,
  expandHomePath,
  resolvePathFromTeamRoot,
  resolveTeamJsonPath,
} from "./utils/team-paths";
import { getLang, loadLangFromOatYaml, setLang, t, type Lang } from "./i18n/i18n";
import { fileURLToPath } from "node:url";

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

async function resolveStateDirInput(stateDir?: string): Promise<string> {
  if (stateDir && stateDir.trim().length > 0) {
    const expanded = expandHomePath(stateDir.trim());
    return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
  }
  const teamJsonPath = await resolveTeamJsonPath();
  return path.join(path.dirname(teamJsonPath), ".oat", "state");
}

const program = new Command();
program.name("oat").description("OpenCode Agent Team Orchestrator").version("0.1.0");

program.option("--lang <lang>", "Output language: en | zh-CN | fr | ja");

program
  .command("start")
  .description("Start orchestrator (team.json: --config or cwd/team.json / OAT_TEAM_JSON)")
  .option(
    "--config <path>",
    "path to team.json (default: ./team.json under cwd, or OAT_TEAM_JSON when set)",
  )
  .option("--goal <text>", "project goal prompt (optional)")
  .option("--port <number>", "orchestrator HTTP port", "3100")
  .action(
    async (options: {
      port: string;
      config?: string;
      goal?: string;
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
    const goal = (options.goal ?? "").trim();
    const cfg = await loadConfig(abs);
    const stateDir = cfg.runtime.persistence.state_dir;
    await ensureDir(stateDir);
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

    const port = Number(options.port);
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
      dashboardDist: hasDashboard ? dashboardDist : undefined,
    });
    await orch.start();
    logger.success(t("orchestrator_started"));
    logger.info(t("start_observability_hint", { port }));
  });

program
  .command("status")
  .argument("[stateDir]", "state dir")
  .action(async (stateDir?: string) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    const dir = await resolveStateDirInput(stateDir);
    const p = path.join(dir, "orchestrator.json");
    try {
      const raw = await fs.readFile(p, "utf8");
      logger.info(t("log_orchestrator_json"), JSON.parse(raw));
    } catch {
      logger.warn(t("orchestrator_json_not_found"), { path: p });
    }
  });

program
  .command("stop")
  .argument("[stateDir]", "state dir")
  .action(async (stateDir?: string) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    const dir = await resolveStateDirInput(stateDir);
    const p = path.join(dir, "orchestrator.json");
    const orchState = JSON.parse(await fs.readFile(p, "utf8"));
    const pid = orchState?.pid as number | undefined;
    if (!pid) {
      logger.warn(t("orchestrator_pid_not_found"));
      return;
    }
    process.kill(pid, "SIGTERM");
    logger.success(t("stop_signal_sent"));
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
  .argument("<name>", "architecture | config | guide")
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

program.parseAsync();

function toLang(v: any): Lang | null {
  if (v === "en") return "en";
  if (v === "zh-CN" || v === "zh") return "zh-CN";
  if (v === "fr" || v === "fr-FR") return "fr";
  if (v === "ja" || v === "ja-JP") return "ja";
  return null;
}

