import { z } from "zod";
import {
  RuntimeModeEnum,
  WorkspaceProviderTypeEnum,
  WorkerLifecycleEnum,
  WorkerSkillSyncEnum,
} from "../types";

export const TeamSchema = z.object({
  name: z.string().min(1),
  branch_prefix: z.string().min(1),
  leader: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    model: z.string().min(1),
    prompt: z.string().min(1),
    skills: z.array(z.string().min(1)).default([]),
    repos: z.array(z.string().min(1)).default([]),
  }),
  worker: z.object({
    max: z.number().int().positive(),
    model: z.string().min(1),
    prompt: z.string().min(1),
    extra_skills: z.array(z.string().min(1)).default([]),
    lifecycle: z.nativeEnum(WorkerLifecycleEnum).default(WorkerLifecycleEnum.EphemeralAfterMergeToMain),
    skill_sync: z.nativeEnum(WorkerSkillSyncEnum).default(WorkerSkillSyncEnum.InheritAndInjectOnSpawn),
  }),
});

export const TeamFileSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    repo: z.string().min(1),
    base_branch: z.string().min(1).default("main"),
  }),
  runtime: z
    .object({
      mode: z.nativeEnum(RuntimeModeEnum).default(RuntimeModeEnum.LocalProcess),
      opencode: z
        .object({
          executable: z.string().min(1).default("opencode"),
        })
        .default({ executable: "opencode" }),
      ports: z
        .object({
          base: z.number().int().positive().default(4096),
          max_agents: z.number().int().positive().default(10),
        })
        .default({ base: 4096, max_agents: 10 }),
      persistence: z
        .object({
          state_dir: z.string().min(1).default("~/.oat/state"),
        })
        .default({ state_dir: "~/.oat/state" }),
    })
    .optional(),
  workspace: z
    .object({
      provider: z.nativeEnum(WorkspaceProviderTypeEnum).default(WorkspaceProviderTypeEnum.Worktree),
      root_dir: z.string().min(1).default("~/.oat/workspaces"),
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
    model: z.string().min(1),
    prompt: z.string().min(1),
    skills: z.array(z.string().min(1)).default([]),
  }),
  teams: z.array(TeamSchema).min(1),
});

export type TeamFileSchemaType = z.infer<typeof TeamFileSchema>;
