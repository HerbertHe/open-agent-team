import { z } from "zod";
import {
  BaseBranchEnum,
  DockerNetworkModeEnum,
  ProviderCompatibleTypeEnum,
  RuntimeModeEnum,
  WorkspaceProviderTypeEnum,
  WorkerSkillSyncEnum,
} from "../types";

/** 单条 skill 安装声明的 Zod schema */
const SkillEntrySchema = z.object({
  source: z.string().min(1),
  names: z.array(z.string().min(1)).optional(),
});

export const TeamSchema = z.object({
  name: z.string().min(1),
  branch_prefix: z.string().min(1),
  leader: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
    skills: z.array(SkillEntrySchema).default([]),
    repos: z.array(z.string().min(1)).default([]),
  }),
  worker: z.object({
    total: z.number().int().positive(),
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
    extra_skills: z.array(SkillEntrySchema).default([]),
    skill_sync: z.nativeEnum(WorkerSkillSyncEnum).default(WorkerSkillSyncEnum.InheritAndInjectOnSpawn),
  }),
});

export const TeamFileSchema = z.object({
  $schema: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  providers: z
    .record(
      z.string(),
      z.object({
        compatible_type: z.nativeEnum(ProviderCompatibleTypeEnum),
        base_url: z.string().min(1).optional(),
        api_key: z.string().min(1).optional(),
      }),
    )
    .optional(),
  memory: z.object({
    enabled: z.boolean().default(true),
    roles: z.array(z.enum(["admin", "leader"])).default(["admin", "leader"]),
    access: z.object({
      leaderProjectScopeTeams: z.array(z.string().trim().min(1)).max(200).default([]),
    }).strict().default({ leaderProjectScopeTeams: [] }),
    database: z.string().min(1).optional(),
    embeddingRef: z.string().trim().min(1).nullable().optional(),
    retrieval: z.object({
      backend: z.enum(["lexical", "zvec_fts", "zvec_hybrid"]).default("lexical"),
      fallback: z.literal("lexical").default("lexical"),
      shadow: z.boolean().default(false),
      candidateLimit: z.number().int().min(1).max(500).default(30),
      maxResults: z.number().int().min(1).max(50).default(8),
      maxPromptTokens: z.number().int().min(128).max(32_768).default(1800),
      timeoutMs: z.number().int().min(100).max(120_000).default(3_000),
      circuitBreakerFailureThreshold: z.number().int().min(1).max(20).default(3),
      circuitBreakerCooldownSeconds: z.number().int().min(1).max(3_600).default(60),
    }).strict().default({ backend: "lexical", fallback: "lexical", shadow: false, candidateLimit: 30, maxResults: 8, maxPromptTokens: 1800, timeoutMs: 3_000, circuitBreakerFailureThreshold: 3, circuitBreakerCooldownSeconds: 60 }),
    zvec: z.object({
      path: z.string().trim().min(1).default("memory/zvec"),
      index: z.enum(["flat", "hnsw"]).default("flat"),
      metric: z.literal("cosine").default("cosine"),
      readOnlyFallback: z.boolean().default(true),
      batchSize: z.number().int().min(1).max(2_048).default(64),
      maxAttempts: z.number().int().min(1).max(32).default(8),
      optimizePendingThreshold: z.number().int().min(1).default(100_000),
    }).strict().default({ path: "memory/zvec", index: "flat", metric: "cosine", readOnlyFallback: true, batchSize: 64, maxAttempts: 8, optimizePendingThreshold: 100_000 }),
    extraction: z.object({
      enabled: z.boolean().default(false),
      model: z.string().trim().min(1).optional(),
      version: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).default("m11-v1"),
      timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
      maxInputChars: z.number().int().min(256).max(32_000).default(4_000),
      maxOutputTokens: z.number().int().min(64).max(4_096).default(800),
      maxFactsPerEvent: z.number().int().min(1).max(20).default(5),
      maxAttempts: z.number().int().min(1).max(8).default(3),
    }).strict().default({ enabled: false, version: "m11-v1", timeoutMs: 15_000, maxInputChars: 4_000, maxOutputTokens: 800, maxFactsPerEvent: 5, maxAttempts: 3 }),
    l1: z.object({
      maxItems: z.number().int().min(5).max(100).default(24),
      completedTaskTtlHours: z.number().int().min(1).max(720).default(48),
    }).default({ maxItems: 24, completedTaskTtlHours: 48 }),
    l2: z.object({
      maxResults: z.number().int().min(1).max(20).default(5),
      retentionDays: z.number().int().min(1).max(3650).default(180),
    }).default({ maxResults: 5, retentionDays: 180 }),
    l3: z.object({
      maxPromptItems: z.number().int().min(1).max(20).default(5),
      minEvidence: z.number().int().min(2).max(20).default(2),
    }).default({ maxPromptItems: 5, minEvidence: 2 }),
    dream: z.object({
      enabled: z.boolean().default(true),
      idleAfterSeconds: z.number().int().min(30).max(86400).default(300),
      pollSeconds: z.number().int().min(5).max(3600).default(30),
      maxEventsPerRun: z.number().int().min(10).max(5000).default(250),
      cancelOnNewTask: z.boolean().default(true),
    }).default({ enabled: true, idleAfterSeconds: 300, pollSeconds: 30, maxEventsPerRun: 250, cancelOnNewTask: true }),
  }).optional(),
  project: z.object({
    name: z.string().min(1),
    repo: z.string().min(1),
    base_branch: z.nativeEnum(BaseBranchEnum).default(BaseBranchEnum.Main),
  }),
  runtime: z
    .object({
      mode: z.nativeEnum(RuntimeModeEnum).default(RuntimeModeEnum.LocalProcess),
      docker: z.object({
        image: z.string().min(1),
        network: z.nativeEnum(DockerNetworkModeEnum).default(DockerNetworkModeEnum.Bridge),
        extra_args: z.array(z.string().min(1)).default([]),
      }).optional(),
      persistence: z
        .object({
          state_dir: z.string().min(1).optional(),
        })
        .default({}),
    })
    .optional(),
  workspace: z
    .object({
      provider: z.nativeEnum(WorkspaceProviderTypeEnum).default(WorkspaceProviderTypeEnum.Worktree),
      root_dir: z.string().min(1).optional(),
      git: z
        .object({
          remote: z.string().trim().min(1).optional(),
          remote_url: z.string().trim().min(1).optional(),
          user_name: z.string().trim().min(1).optional(),
          user_email: z.string().trim().min(3).optional(),
          push_enabled: z.boolean().default(false),
          lfs: z.enum(["pull", "skip", "allow_pull_deny_change"]).default("pull"),
        })
        .default({ push_enabled: false, lfs: "pull" }),
      sparse_checkout: z
        .object({
          enabled: z.boolean().default(true),
        })
        .default({ enabled: true }),
    })
    .optional(),
  models: z.record(z.string(), z.string().min(1)),
  admin: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
    skills: z.array(SkillEntrySchema).default([]),
    push_channel: z
      .object({
        channel: z.string().min(1),
        account: z.string().min(1),
      })
      .optional(),
  }),
  teams: z.array(TeamSchema).min(1),
});

export type TeamFileSchemaType = z.infer<typeof TeamFileSchema>;
