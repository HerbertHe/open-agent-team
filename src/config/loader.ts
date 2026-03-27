import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { TeamFileSchema } from "./schema";
import {
  RuntimeModeEnum,
  WorkspaceProviderTypeEnum,
  WorkerLifecycleEnum,
  WorkerSkillSyncEnum,
} from "../types";
import type { ResolvedConfig, TeamConfig, TeamFileConfig } from "../types";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeTeam(team: TeamConfig): TeamConfig {
  return {
    ...team,
    worker: {
      ...team.worker,
      extra_skills: team.worker.extra_skills ?? [],
      lifecycle: team.worker.lifecycle ?? WorkerLifecycleEnum.EphemeralAfterMergeToMain,
      skill_sync: team.worker.skill_sync ?? WorkerSkillSyncEnum.InheritAndInjectOnSpawn,
    },
  };
}

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const baseDir = path.dirname(configPath);
  const parsedYaml = yaml.load(raw) as TeamFileConfig;
  const validated = TeamFileSchema.parse(parsedYaml);

  const resolvePrompt = async (p: string): Promise<string> => {
    // 允许把 prompt 写成 ./path/to/file.md
    if (p.endsWith(".md")) {
      const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
      try {
        return await fs.readFile(abs, "utf8");
      } catch {
        // 文件不存在时退回原始字符串
        return p;
      }
    }
    return p;
  };

  const resolveModelAlias = (m: string): string => {
    return validated.models[m] ?? m;
  };

  const withInheritance: any = {
    ...validated,
    teams: await Promise.all(
      validated.teams.map(async (t) => {
        const norm = normalizeTeam(t);
        norm.leader.prompt = await resolvePrompt(norm.leader.prompt);
        norm.worker.prompt = await resolvePrompt(norm.worker.prompt);
        norm.leader.model = resolveModelAlias(norm.leader.model);
        norm.worker.model = resolveModelAlias(norm.worker.model);
        return norm;
      }),
    ),
  };

  // admin
  withInheritance.admin.prompt = await resolvePrompt(withInheritance.admin.prompt);
  withInheritance.admin.model = resolveModelAlias(withInheritance.admin.model);

  const runtimeDefaults = {
    mode: RuntimeModeEnum.LocalProcess,
    opencode: { executable: "opencode" },
    ports: { base: 4096, max_agents: 10 },
    persistence: { state_dir: "~/.oat/state" },
  };

  const workspaceDefaults = {
    provider: WorkspaceProviderTypeEnum.Worktree,
    root_dir: "~/.oat/workspaces",
    persistent: true,
    git: { remote: "origin", lfs: "pull" as const },
    sparse_checkout: { enabled: true },
  };

  const runtime = { ...runtimeDefaults, ...(withInheritance.runtime ?? {}) };
  const workspace = { ...workspaceDefaults, ...(withInheritance.workspace ?? {}) };

  return {
    ...withInheritance,
    runtime: {
      mode: runtime.mode,
      opencode: runtime.opencode,
      ports: runtime.ports,
      persistence: {
        state_dir: expandHome(runtime.persistence.state_dir),
      },
    },
    workspace: {
      provider: workspace.provider,
      root_dir: expandHome(workspace.root_dir),
      persistent: workspace.persistent,
      git: workspace.git,
      sparse_checkout: workspace.sparse_checkout,
    },
  } as ResolvedConfig;
}
