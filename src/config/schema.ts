import { z } from "zod";
import {
  RuntimeModeEnum,
  WorkspaceProviderTypeEnum,
  WorkerLifecycleEnum,
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
    lifecycle: z.nativeEnum(WorkerLifecycleEnum).default(WorkerLifecycleEnum.EphemeralAfterMergeToMain),
    skill_sync: z.nativeEnum(WorkerSkillSyncEnum).default(WorkerSkillSyncEnum.InheritAndInjectOnSpawn),
  }),
});

export const TeamFileSchema = z.object({
  model: z.string().min(1).optional(),
  providers: z
    .record(
      z.string(),
      z.object({
        compatible_type: z.enum(["openai", "anthropic"]),
        base_url: z.string().min(1).optional(),
        api_key: z.string().min(1).optional(),
      }),
    )
    .optional(),
  project: z.object({
    name: z.string().min(1),
    repo: z.string().min(1),
    base_branch: z.enum(["main", "master"]).default("main"),
  }),
  runtime: z
    .object({
      mode: z.nativeEnum(RuntimeModeEnum).default(RuntimeModeEnum.LocalProcess),
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
      persistent: z.boolean().default(true),
      git: z
        .object({
          remote: z.string().min(1).default("origin"),
          lfs: z.enum(["pull", "skip", "allow_pull_deny_change"]).default("pull"),
        })
        .default({ remote: "origin", lfs: "pull" }),
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
  }),
  teams: z.array(TeamSchema).min(1),
});

export type TeamFileSchemaType = z.infer<typeof TeamFileSchema>;
