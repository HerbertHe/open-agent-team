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
    database: z.string().min(1).optional(),
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
