import fs from "node:fs/promises";
import path from "node:path";
import { TeamFileSchema } from "./schema";
import { resolvePathFromTeamRoot } from "../utils/team-paths";
import {
  RuntimeModeEnum,
  WorkspaceProviderTypeEnum,
  WorkerLifecycleEnum,
  WorkerSkillSyncEnum,
} from "../types";
import type { ResolvedConfig, TeamConfig, TeamFileConfig } from "../types";

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
  const configPathAbs = path.resolve(configPath);
  const raw = await fs.readFile(configPathAbs, "utf8");
  const baseDir = path.dirname(configPathAbs);
  const parsedJson = JSON.parse(raw) as TeamFileConfig;
  const validated = TeamFileSchema.parse(parsedJson);

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

  const resolveInheritedModel = (candidate: string | undefined, fallback: string | undefined, fieldPath: string): string => {
    const picked = candidate ?? fallback;
    if (!picked) {
      throw new Error(
        `missing model for ${fieldPath}. Please set it explicitly, or provide a parent model (team.worker.model -> team.leader.model -> admin.model -> model).`
      );
    }
    return resolveModelAlias(picked);
  };

  const globalModel = validated.model ? resolveModelAlias(validated.model) : undefined;
  const adminModel = resolveInheritedModel(validated.admin.model, globalModel, "admin.model");

  const withInheritance: any = {
    ...validated,
    model: globalModel,
    teams: await Promise.all(
      validated.teams.map(async (t) => {
        const norm = normalizeTeam(t);
        const leaderModel = resolveInheritedModel(norm.leader.model, adminModel, `teams[${norm.name}].leader.model`);
        const workerModel = resolveInheritedModel(norm.worker.model, leaderModel, `teams[${norm.name}].worker.model`);
        norm.leader.prompt = await resolvePrompt(norm.leader.prompt);
        norm.worker.prompt = await resolvePrompt(norm.worker.prompt);
        norm.leader.model = leaderModel;
        norm.worker.model = workerModel;
        return norm;
      }),
    ),
  };

  // admin
  withInheritance.admin.prompt = await resolvePrompt(withInheritance.admin.prompt);
  withInheritance.admin.model = adminModel;

  const runtimeDefaults = {
    mode: RuntimeModeEnum.LocalProcess,
    opencode: { executable: "opencode" },
    ports: { base: 8848, max_agents: 10 },
    persistence: { state_dir: path.join(baseDir, ".oat", "state") },
  };
  const providersDefaults = {
    env: {} as Record<string, string>,
    env_from: {} as Record<string, string>,
    openai_compatible: {} as {
      base_url?: string;
      api_key?: string;
      api_key_env?: string;
    },
  };

  const workspaceDefaults = {
    provider: WorkspaceProviderTypeEnum.Worktree,
    root_dir: path.join(baseDir, "workspaces"),
    persistent: true,
    git: { remote: "origin", lfs: "pull" as const },
    sparse_checkout: { enabled: true },
  };

  const runtime = { ...runtimeDefaults, ...(withInheritance.runtime ?? {}) };
  const workspace = { ...workspaceDefaults, ...(withInheritance.workspace ?? {}) };
  const topProviderCfg = withInheritance.providers ?? {};
  const providers = {
    env: {
      ...(topProviderCfg.env ?? {}),
    },
    env_from: {
      ...(topProviderCfg.env_from ?? {}),
    },
    openai_compatible: {
      ...(topProviderCfg.openai_compatible ?? {}),
    },
  };

  return {
    ...withInheritance,
    project: {
      ...withInheritance.project,
      // Resolve repo relative to team.json location, not process.cwd().
      repo: resolvePathFromTeamRoot(configPathAbs, withInheritance.project.repo),
    },
    providers: {
      ...providersDefaults,
      ...providers,
    },
    runtime: {
      mode: runtime.mode,
      opencode: runtime.opencode,
      ports: runtime.ports,
      persistence: {
        state_dir: resolvePathFromTeamRoot(configPathAbs, runtime.persistence.state_dir),
      },
    },
    workspace: {
      provider: workspace.provider,
      root_dir: resolvePathFromTeamRoot(configPathAbs, workspace.root_dir),
      persistent: workspace.persistent,
      git: workspace.git,
      sparse_checkout: workspace.sparse_checkout,
    },
  } as ResolvedConfig;
}
