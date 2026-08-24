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
import { getLang, loadLangFromOatJson, setLang, t, type Lang } from "./i18n/i18n";
import { fileURLToPath } from "node:url";
import { cleanupAgentLogs } from "./utils/log-cleanup";
import { getLogRetentionDays } from "./utils/oat-config";
import net from "node:net";
import { runResourcesInterview } from "./resources/agent";

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
      logger.info(t("reusing_port", { savedPort }));
      return savedPort;
    }
  } catch { /* no state file or unreadable */ }

  // 从 8787 开始扫描
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_SCAN_LIMIT; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(t("no_port_available", { start: DEFAULT_PORT, end: DEFAULT_PORT + PORT_SCAN_LIMIT - 1 }));
}

async function resolveStateDirInput(stateDir?: string): Promise<string> {
  if (stateDir && stateDir.trim().length > 0) {
    const expanded = expandHomePath(stateDir.trim());
    return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
  }
  const teamJsonPath = await resolveTeamJsonPath();
  return path.join(path.dirname(teamJsonPath), ".oat", "state");
}

function toLang(v: any): Lang | null {
  if (v === "en") return "en";
  if (v === "zh-CN" || v === "zh") return "zh-CN";
  if (v === "fr" || v === "fr-FR") return "fr";
  if (v === "ja" || v === "ja-JP") return "ja";
  return null;
}

function getLangFromArgv(): Lang | null {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--lang" && i + 1 < args.length) {
      return toLang(args[i + 1]);
    }
    if (arg.startsWith("--lang=")) {
      return toLang(arg.slice(7));
    }
  }
  return null;
}

async function main() {
  // 1. 优先从命令行嗅探语言，其次从 oat.json 加载保存的偏好
  const cliLang = getLangFromArgv() || await loadLangFromOatJson();
  if (cliLang) {
    setLang(cliLang);
  }

  const program = new Command();

  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));

  program
    .name("oat")
    .description(t("cli_description"))
    .version(pkg.version, "-v, --version")
    .option("--lang <lang>", t("cli_lang_desc"));

  program
    .command("start")
    .description(t("start_desc"))
    .option("--config <path>", t("start_config_desc"))
    .option("--goal <text>", t("start_goal_desc"))
    .option("--port <number>", t("start_port_desc"), "0")
    .option("--daemon", t("start_daemon_desc"))
    .action(
      async (options: {
        port: string;
        config?: string;
        goal?: string;
        daemon?: boolean;
      }) => {
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
          logger.info(t("desktop_hint"));
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
          logger.info(t("log_cleaned_stale_project_links"), { cleaned: cleanup.cleaned });
        }
        if (cleanup.errors.length > 0) {
          logger.warn(t("log_errors_cleaning_project_links"), { errors: cleanup.errors });
        }

        // Clean up old agent logs based on retention config
        try {
          const retentionDays = await getLogRetentionDays();
          const logCleanup = await cleanupAgentLogs(cfg.workspace.root_dir, retentionDays);
          if (logCleanup.cleaned.length > 0) {
            logger.info(t("log_cleaned_old_agent_logs"), { count: logCleanup.cleaned.length, retentionDays });
          }
        } catch (e) {
          logger.warn(t("log_agent_log_cleanup_failed"), { error: e instanceof Error ? e.message : String(e) });
        }

        const stateFile = path.join(stateDir, "orchestrator.json");
        const port = await resolvePort(Number(options.port), stateFile);
        const orch = new Orchestrator(cfg, {
          goal,
          port,
          configPath: abs,
        });
        await orch.start();
        logger.success(t("orchestrator_started"));
        logger.info(t("start_observability_hint", { port }));
      }
    );

  program
    .command("list")
    .alias("ls")
    .description(t("list_desc"))
    .action(async () => {
      const os = await import("node:os");
      const chalk = (await import("chalk")).default;
      const linkRoot = path.join(os.homedir(), ".oat", "projects");
      let entries: any[];
      try {
        entries = await fs.readdir(linkRoot, { withFileTypes: true });
      } catch {
        logger.info(t("no_oat_projects_found"));
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
        logger.info(t("no_oat_projects_found"));
        return;
      }

      console.log(t("list_projects_title", { count: projects.length }));
      for (const p of projects) {
        const statusStr = p.running 
          ? chalk.green(t("status_running", { pid: p.pid ?? 0, port: p.port ?? 0 })) 
          : chalk.gray(t("status_stopped"));
        console.log(t("list_project_id", { id: chalk.cyan(p.id) }));
        console.log(t("list_project_path", { path: p.target }));
        console.log(t("list_project_status", { status: statusStr }));
        if (p.running && p.startTime) {
          console.log(t("list_project_uptime", { uptime: Math.round((Date.now() - p.startTime) / 60000) }));
        }
        console.log("");
      }
    });

  program
    .command("stop")
    .argument("[projectId]", t("stop_arg_desc"))
    .option("--all", t("stop_all_desc"))
    .description(t("stop_desc"))
    .action(async (projectId: string | undefined, options: { all?: boolean }) => {
      if (!options.all && !projectId) {
        logger.error(t("stop_usage"));
        process.exit(1);
      }

      const os = await import("node:os");
      const linkRoot = path.join(os.homedir(), ".oat", "projects");
      let entries: any[];
      try {
        entries = await fs.readdir(linkRoot, { withFileTypes: true });
      } catch {
        if (options.all) {
          logger.info(t("no_oat_projects_found"));
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
            logger.success(t("stop_success", { projectId: pidName }));
            stoppedCount++;
            continue;
          }
        } catch {}
        if (!options.all) logger.warn(t("orchestrator_pid_not_found"));
      }

      if (options.all && stoppedCount === 0) {
        logger.info(t("stop_none_running"));
      }
    });

  program
    .command("rm")
    .argument("<projectId>", t("rm_arg_desc"))
    .description(t("rm_desc"))
    .action(async (projectId: string) => {
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
        logger.error(t("rm_failed", { error: e instanceof Error ? e.message : String(e) }));
      }
    });

  program
    .command("inspect")
    .argument("[stateDir]", t("inspect_state_desc"))
    .argument("[workspaceRoot]", t("inspect_ws_desc"), "workspaces")
    .option("--limit <number>", t("inspect_limit_desc"), "50")
    .description(t("inspect_desc"))
    .action(async (stateDir: string | undefined, workspaceRoot: string, options: { limit: string }) => {
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
    .argument("<name>", t("docs_arg_desc"))
    .description(t("docs_desc"))
    .action(async (name: string) => {
      const docLang: Lang = getLang();
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const pkgRoot = path.resolve(thisDir, "..");
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
    .command("init")
    .description(t("init_desc"))
    .action(async () => {
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
        logger.error(t("init_failed", { error: e instanceof Error ? e.message : String(e) }));
        process.exit(1);
      }
    });

  program
    .command("resources")
    .argument("[config]", "team.json path to create or replace", "team.json")
    .option("--force", "replace an existing team.json after the interview")
    .description("Run the Agent Resources interview to create a project and its teams")
    .action(async (config: string, options: { force?: boolean }) => {
      try {
        const result = await runResourcesInterview(config, Boolean(options.force));
        logger.success(`Agent Resources created ${result.path} with ${result.teamCount} team(s).`);
      } catch (error) {
        logger.error(`Agent Resources failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  program
    .command("channels")
    .description(t("channels_desc"))
    .action(async () => {
      try {
        const { loadPlugins } = await import("./plugins/loader");
        await loadPlugins();
        
        const { PluginRegistry } = await import("./plugins/registry");
        const { getSessionPath } = await import("./plugins/notifier");
        const { loadOatConfig } = await import("./utils/oat-config");
        const chalk = (await import("chalk")).default;

        const registeredIds = PluginRegistry.getRegisteredChannels();
        const globalConfig = await loadOatConfig();

        console.log(`\n${chalk.bold(t("channels_title"))}\n`);

        if (registeredIds.length === 0) {
          console.log(t("channels_no_plugins"));
          return;
        }

        for (const id of registeredIds) {
          const plugin = PluginRegistry.getChannel(id)!;
          const configAccounts = globalConfig.channels?.[id]?.accounts || {};
          const isStateful = typeof plugin.login === "function";

          console.log(`  ${chalk.cyan("├─")} ${chalk.bold(plugin.meta.name)} (${id}) [${isStateful ? t("channels_stateful") : t("channels_stateless")}]`);
          
          const accounts = Object.keys(configAccounts);
          if (accounts.length === 0) {
            console.log(`  ${chalk.cyan("│  └─")} ${chalk.yellow(t("channels_no_accounts"))}`);
          } else {
            for (let i = 0; i < accounts.length; i++) {
              const acc = accounts[i];
              const isLast = i === accounts.length - 1;
              const linkSymbol = isLast ? "└─" : "├─";
              
              let statusStr = chalk.green(t("channels_running"));
              if (isStateful) {
                const sessionPath = getSessionPath(id, acc);
                try {
                  await fs.access(sessionPath);
                  statusStr = chalk.green(t("channels_session_active"));
                } catch {
                  statusStr = chalk.red(t("channels_session_expired"));
                }
              }
              console.log(`  ${chalk.cyan("│  " + linkSymbol)} ${t("channels_account_status", { account: chalk.yellow(acc), status: statusStr })}`);
            }
          }
        }
        console.log("");
      } catch (e: any) {
        logger.error(t("channels_failed", { error: e.message }));
      }
    });

  program
    .command("channel")
    .description(t("channel_desc"))
    .action(async () => {
      logger.error(t("channel_usage"));
    });

  const channelCmd = program.commands.find(c => c.name() === "channel") || program.command("channel");
  channelCmd
    .command("login")
    .argument("<channelId>", t("channel_login_arg_channel"))
    .argument("<accountId>", t("channel_login_arg_account"))
    .description(t("channel_login_desc"))
    .action(async (channelId: string, accountId: string) => {
      const finalChannelId = channelId === "weixin" ? "openclaw-weixin" : channelId;

      try {
        const { loadPlugins } = await import("./plugins/loader");
        await loadPlugins();

        const { PluginRegistry } = await import("./plugins/registry");
        const { getSessionPath } = await import("./plugins/notifier");
        const { loadOatConfig } = await import("./utils/oat-config");

        const channelPlugin = PluginRegistry.getChannel(finalChannelId);

        if (!channelPlugin) {
          logger.error(t("channel_plugin_missing", { channelId: finalChannelId }));
          process.exit(1);
        }

        if (typeof channelPlugin.login !== "function") {
          logger.info(t("channel_stateless_no_login", { channelId: finalChannelId }));
          return;
        }

        const globalConfig = await loadOatConfig();
        const accountConfig = globalConfig.channels?.[finalChannelId]?.accounts?.[accountId] || {};

        const sessionCachePath = getSessionPath(finalChannelId, accountId);
        await fs.mkdir(path.dirname(sessionCachePath), { recursive: true });

        logger.info(t("channel_login_start", { channelId: finalChannelId, accountId }));
        await channelPlugin.login({
          config: accountConfig,
          sessionCachePath
        });
        logger.success(t("channel_login_success", { sessionCachePath }));
      } catch (e: any) {
        logger.error(t("channel_login_failed", { error: e.message }));
        process.exit(1);
      }
    });

  program
    .command("plugins")
    .description(t("plugins_desc"))
    .action(() => {
      logger.error(t("plugins_usage"));
    });

  const pluginsCmd = program.commands.find(c => c.name() === "plugins") || program.command("plugins");
  pluginsCmd
    .command("install")
    .argument("<packageName>", t("plugins_install_arg_package"))
    .description(t("plugins_install_desc"))
    .action(async (packageName: string) => {
      logger.info(t("plugins_installing", { packageName }));
      const os = await import("node:os");
      const { exec } = await import("node:child_process");
      
      const targetDir = path.join(os.homedir(), ".oat", "plugins");
      await fs.mkdir(targetDir, { recursive: true });
      
      try {
        await fs.writeFile(
          path.join(targetDir, "package.json"),
          JSON.stringify({ name: "oat-global-plugins", version: "1.0.0", private: true }, null, 2),
          { flag: "wx" }
        );
      } catch {}

      const cmd = `npm install --prefix "${targetDir}" "${packageName}"`;
      
      exec(cmd, async (err, stdout, stderr) => {
        if (err) {
          logger.error(t("plugins_install_failed", { error: err.message }), { stderr });
          process.exit(1);
        }
        logger.success(t("plugins_installed_success", { packageName }));
        logger.info(t("plugins_installed_hint"));
      });
    });

  pluginsCmd
    .command("uninstall")
    .argument("<pluginId>", t("plugins_uninstall_arg_plugin"))
    .description(t("plugins_uninstall_desc"))
    .action(async (pluginId: string) => {
      logger.info(t("plugins_uninstalling", { pluginId }));
      const os = await import("node:os");
      
      try {
        const targetDir = path.join(os.homedir(), ".oat", "plugins", "node_modules", pluginId);
        if (await fileExists(targetDir)) {
          await fs.rm(targetDir, { recursive: true, force: true });
        }

        const sessionsDir = path.join(os.homedir(), ".oat", "sessions");
        if (await fileExists(sessionsDir)) {
          const files = await fs.readdir(sessionsDir);
          for (const file of files) {
            if (file.startsWith(`${pluginId.replace(/^openclaw-/, "")}_`)) {
              await fs.unlink(path.join(sessionsDir, file));
            }
          }
        }

        const { loadOatConfig, saveOatConfig } = await import("./utils/oat-config");
        const globalConfig = await loadOatConfig();
        if (globalConfig.channels && globalConfig.channels[pluginId]) {
          delete globalConfig.channels[pluginId];
          await saveOatConfig({ channels: globalConfig.channels });
        }

        logger.success(t("plugins_uninstalled_success", { pluginId }));
      } catch (e: any) {
        logger.error(t("plugins_uninstall_failed", { error: e.message }));
        process.exit(1);
      }
    });

  await program.parseAsync();
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
