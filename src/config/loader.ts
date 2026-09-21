import fs from "node:fs/promises";
import path from "node:path";
import { TeamFileSchema } from "./schema";
import { resolvePathFromTeamRoot, resolveTeamDataPath } from "../utils/team-paths";
import {
  ProviderCompatibleTypeEnum,
  RuntimeModeEnum,
  WorkspaceProviderTypeEnum,
  WorkerSkillSyncEnum,
} from "../types";
import type { ResolvedConfig, TeamConfig, TeamFileConfig } from "../types";
import { t } from "../i18n/i18n";
import { isMemoryRetrievalRolloutEnabled, loadOatConfig } from "../utils/oat-config";
import { resolveEmbeddingReference } from "../models/global-models";

function normalizeTeam(team: TeamConfig): TeamConfig {
  return {
    ...team,
    worker: {
      ...team.worker,
      extra_skills: team.worker.extra_skills ?? [],
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
      throw new Error(t("model_inheritance_missing", { fieldPath }));
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
    persistence: { state_dir: path.join(baseDir, ".oat", "state") },
  };
  const providersDefaults: Record<string, { compatible_type: ProviderCompatibleTypeEnum; base_url?: string; api_key?: string }> = {};
  const globalOatConfig = await loadOatConfig();
  const configuredEmbeddingRef = withInheritance.memory?.embeddingRef;
  const leaderProjectScopeTeams = [...new Set(withInheritance.memory?.access?.leaderProjectScopeTeams ?? [])];
  const knownTeams = new Set(withInheritance.teams.map((team: TeamConfig) => team.name));
  const unknownMemoryTeams = leaderProjectScopeTeams.filter((name) => !knownTeams.has(name));
  if (unknownMemoryTeams.length) throw new Error(`memory.access.leaderProjectScopeTeams contains unknown teams: ${unknownMemoryTeams.join(", ")}`);
  const memory = {
    enabled: withInheritance.memory?.enabled ?? true,
    roles: withInheritance.memory?.roles ?? ["admin", "leader", "worker"],
    access: {
      leaderProjectScopeTeams,
    },
    database: withInheritance.memory?.database,
    embeddingRef: resolveEmbeddingReference(configuredEmbeddingRef, globalOatConfig.memoryDefaults?.embeddingProfile),
    retrieval: {
      backend: withInheritance.memory?.retrieval?.backend ?? "lexical",
      fallback: "lexical" as const,
      shadow: withInheritance.memory?.retrieval?.shadow ?? false,
      productionEnabled: isMemoryRetrievalRolloutEnabled(globalOatConfig, withInheritance.project.name),
      candidateLimit: withInheritance.memory?.retrieval?.candidateLimit ?? 30,
      maxResults: withInheritance.memory?.retrieval?.maxResults ?? 8,
      maxPromptTokens: withInheritance.memory?.retrieval?.maxPromptTokens ?? 1800,
      timeoutMs: withInheritance.memory?.retrieval?.timeoutMs ?? 3_000,
      circuitBreakerFailureThreshold: withInheritance.memory?.retrieval?.circuitBreakerFailureThreshold ?? 3,
      circuitBreakerCooldownSeconds: withInheritance.memory?.retrieval?.circuitBreakerCooldownSeconds ?? 60,
    },
    zvec: {
      path: withInheritance.memory?.zvec?.path ?? "memory/zvec",
      index: withInheritance.memory?.zvec?.index ?? "flat",
      metric: "cosine" as const,
      readOnlyFallback: withInheritance.memory?.zvec?.readOnlyFallback ?? true,
      batchSize: withInheritance.memory?.zvec?.batchSize ?? 64,
      maxAttempts: withInheritance.memory?.zvec?.maxAttempts ?? 8,
      optimizePendingThreshold: withInheritance.memory?.zvec?.optimizePendingThreshold ?? 100_000,
    },
    extraction: {
      enabled: withInheritance.memory?.extraction?.enabled ?? false,
      model: withInheritance.memory?.extraction?.model ? resolveModelAlias(withInheritance.memory.extraction.model) : undefined,
      version: withInheritance.memory?.extraction?.version ?? "m11-v1",
      timeoutMs: withInheritance.memory?.extraction?.timeoutMs ?? 15_000,
      maxInputChars: withInheritance.memory?.extraction?.maxInputChars ?? 4_000,
      maxOutputTokens: withInheritance.memory?.extraction?.maxOutputTokens ?? 800,
      maxFactsPerEvent: withInheritance.memory?.extraction?.maxFactsPerEvent ?? 5,
      maxAttempts: withInheritance.memory?.extraction?.maxAttempts ?? 3,
    },
    l1: {
      maxItems: withInheritance.memory?.l1?.maxItems ?? 24,
      completedTaskTtlHours: withInheritance.memory?.l1?.completedTaskTtlHours ?? 48,
    },
    l2: {
      maxResults: withInheritance.memory?.l2?.maxResults ?? 5,
      retentionDays: withInheritance.memory?.l2?.retentionDays ?? 180,
    },
    l3: {
      maxPromptItems: withInheritance.memory?.l3?.maxPromptItems ?? 5,
      minEvidence: withInheritance.memory?.l3?.minEvidence ?? 2,
    },
    lifecycle: {
      dailyRetentionDays: withInheritance.memory?.lifecycle?.dailyRetentionDays ?? 90,
      dailyMaxItemsPerAgent: withInheritance.memory?.lifecycle?.dailyMaxItemsPerAgent ?? 5_000,
      completedScratchpadRetentionDays: withInheritance.memory?.lifecycle?.completedScratchpadRetentionDays ?? 30,
      candidateRetentionDays: withInheritance.memory?.lifecycle?.candidateRetentionDays ?? 90,
      candidateMaxItemsPerAgent: withInheritance.memory?.lifecycle?.candidateMaxItemsPerAgent ?? 500,
    },
    dream: {
      enabled: withInheritance.memory?.dream?.enabled ?? true,
      idleAfterSeconds: withInheritance.memory?.dream?.idleAfterSeconds ?? 300,
      pollSeconds: withInheritance.memory?.dream?.pollSeconds ?? 30,
      maxEventsPerRun: withInheritance.memory?.dream?.maxEventsPerRun ?? 250,
      cancelOnNewTask: withInheritance.memory?.dream?.cancelOnNewTask ?? true,
    },
  };

  const knowledge = {
    enabled: withInheritance.knowledge?.enabled ?? true,
    roots: {
      project: withInheritance.knowledge?.roots?.project ?? "knowledge/project",
      teams: withInheritance.knowledge?.roots?.teams ?? "knowledge/teams",
      uploads: withInheritance.knowledge?.roots?.uploads ?? "knowledge/uploads",
    },
    watcher: {
      enabled: withInheritance.knowledge?.watcher?.enabled ?? true,
      debounceMs: withInheritance.knowledge?.watcher?.debounceMs ?? 1_000,
    },
    ingestion: {
      maxFileSizeMb: withInheritance.knowledge?.ingestion?.maxFileSizeMb ?? 50,
      chunkTokens: withInheritance.knowledge?.ingestion?.chunkTokens ?? 1_000,
      chunkOverlapTokens: withInheritance.knowledge?.ingestion?.chunkOverlapTokens ?? 120,
    },
  };

  const workspaceDefaults = {
    provider: WorkspaceProviderTypeEnum.Worktree,
    root_dir: path.join(baseDir, "workspaces"),
    git: { remote: "origin", lfs: "pull" as const },
    sparse_checkout: { enabled: true },
  };

  const runtime = { ...runtimeDefaults, ...(withInheritance.runtime ?? {}) };
  const workspace = { ...workspaceDefaults, ...(withInheritance.workspace ?? {}) };
  const providers = { ...(withInheritance.providers ?? {}) };

  return {
    ...withInheritance,
    memory,
    knowledge,
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
      pi: { agentDir: `${process.env.HOME ?? "~"}/.pi/agent` },
      docker: runtime.docker ? { image: runtime.docker.image, network: runtime.docker.network ?? "bridge", extra_args: runtime.docker.extra_args ?? [] } : undefined,
      persistence: {
        state_dir: resolveTeamDataPath(
          configPathAbs,
          runtime.persistence.state_dir ?? path.join(baseDir, ".oat", "state")
        ),
      },
    },
    workspace: {
      provider: workspace.provider,
      root_dir: resolveTeamDataPath(
        configPathAbs,
        workspace.root_dir ?? path.join(baseDir, "workspaces")
      ),
      git: workspace.git,
      sparse_checkout: workspace.sparse_checkout,
    },
  } as ResolvedConfig;
}
