#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "./config/loader";
import { Orchestrator } from "./orchestrator/orchestrator";
import { logger } from "./utils/logger";
import { getLang, loadLangFromOatYaml, setLang, t, type Lang } from "./i18n/i18n";
import { fileURLToPath } from "node:url";

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

const program = new Command();
program.name("oat").description("OpenCode Agent Team Orchestrator").version("0.1.0");

program.option("--lang <lang>", "Output language: en | zh-CN | fr | ja");

program
  .command("start")
  .argument("[configPath]", "team.json path", "team.json")
  .argument("<goal>", "project goal prompt")
  .option("--port <number>", "orchestrator HTTP port", "3100")
  .action(async (configPath: string, goal: string, options: { port: string }) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }
    // default is already English ("en") in i18n.ts

    const abs = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
    const cfg = await loadConfig(abs);
    const stateDir = cfg.runtime.persistence.state_dir;
    await ensureDir(stateDir);
    const orch = new Orchestrator(cfg, { goal, port: Number(options.port) });
    await orch.start();
    logger.success(t("orchestrator_started"));
  });

program
  .command("status")
  .argument("[stateDir]", "state dir", "~/.oat/state")
  .action(async (stateDir: string) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    const dir = stateDir.startsWith("~/") ? path.join(process.env.HOME ?? "", stateDir.slice(2)) : stateDir;
    const p = path.join(dir, "orchestrator.json");
    try {
      const raw = await fs.readFile(p, "utf8");
      logger.info("orchestrator.json", JSON.parse(raw));
    } catch {
      logger.warn(t("orchestrator_json_not_found"), { path: p });
    }
  });

program
  .command("stop")
  .argument("[stateDir]", "state dir", "~/.oat/state")
  .action(async (stateDir: string) => {
    const cliLang = toLang((program.opts() as any).lang);
    if (cliLang) setLang(cliLang);
    if (!cliLang) {
      const oatLang = await loadLangFromOatYaml();
      if (oatLang) setLang(oatLang);
    }

    const dir = stateDir.startsWith("~/") ? path.join(process.env.HOME ?? "", stateDir.slice(2)) : stateDir;
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

