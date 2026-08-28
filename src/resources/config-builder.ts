import { TeamFileSchema } from "../config/schema.js";
import {
  BaseBranchEnum,
  DockerNetworkModeEnum,
  RuntimeModeEnum,
  WorkerSkillSyncEnum,
  WorkspaceProviderTypeEnum,
} from "../types/index.js";
import type { TeamFileConfig } from "../types/index.js";

export interface ResourceTeamInput {
  name: string;
  responsibility: string;
  workers: number;
  repos?: string[];
}

export interface ResourceProjectConfigInput {
  projectName: string;
  repo?: string;
  baseBranch?: BaseBranchEnum;
  modelAlias: string;
  modelId: string;
  runtimeMode?: RuntimeModeEnum;
  dockerImage?: string;
  dockerNetwork?: DockerNetworkModeEnum;
  teams: ResourceTeamInput[];
}

const unique = (values: string[]): boolean => new Set(values).size === values.length;

/** Build one canonical team.json shape for CLI, Desktop and the Resource Manager. */
export function buildResourceProjectConfig(input: ResourceProjectConfigInput): TeamFileConfig {
  const projectName = input.projectName.trim();
  const modelAlias = input.modelAlias.trim();
  const modelId = input.modelId.trim();
  if (!projectName) throw new Error("Project name is required.");
  if (!modelAlias || !modelId) throw new Error("A configured model is required.");
  if (!input.teams.length) throw new Error("At least one team is required.");
  const teamNames = input.teams.map((team) => team.name.trim());
  if (teamNames.some((name) => !name)) throw new Error("Every team requires a name.");
  if (!unique(teamNames)) throw new Error("Team names must be unique.");

  const runtimeMode = input.runtimeMode ?? RuntimeModeEnum.LocalProcess;
  const raw: TeamFileConfig = {
    $schema: "https://raw.githubusercontent.com/HerbertHe/open-agent-team/main/schema/v1.json",
    model: modelAlias,
    models: { [modelAlias]: modelId },
    project: {
      name: projectName,
      repo: input.repo?.trim() || ".",
      base_branch: input.baseBranch ?? BaseBranchEnum.Main,
    },
    runtime: {
      mode: runtimeMode,
      ...(runtimeMode === RuntimeModeEnum.Docker ? {
        docker: {
          image: input.dockerImage?.trim() || "node:22-bookworm",
          network: input.dockerNetwork ?? DockerNetworkModeEnum.Bridge,
          extra_args: [],
        },
      } : {}),
      persistence: { state_dir: ".oat/state" },
    },
    workspace: {
      provider: WorkspaceProviderTypeEnum.Worktree,
      root_dir: "workspaces",
      git: { remote: "origin", lfs: "pull" },
      sparse_checkout: { enabled: true },
    },
    admin: {
      name: "admin",
      description: "Project administrator responsible for prioritization, delivery coordination, and release approval.",
      prompt: "You are the project Admin. Coordinate Leaders, report delivery status, and approve or reject release proposals. Do not implement Worker tasks.",
      skills: [],
    },
    teams: input.teams.map((team) => {
      const name = team.name.trim();
      const responsibility = team.responsibility.trim();
      if (!responsibility) throw new Error(`Team ${name} requires a responsibility.`);
      if (!Number.isInteger(team.workers) || team.workers < 1) throw new Error(`Team ${name} worker capacity must be a positive integer.`);
      return {
        name,
        branch_prefix: `team/${name}`,
        leader: {
          name: `${name}-lead`,
          description: responsibility,
          prompt: `You are the ${name} Leader. Plan independent work, review Worker branches, integrate approved changes, and submit release proposals.`,
          skills: [],
          repos: team.repos?.map((repo) => repo.trim()).filter(Boolean) ?? [],
        },
        worker: {
          total: team.workers,
          prompt: `You are a ${name} Worker. Implement and self-test one task branch, then submit-review with evidence. Never merge directly.`,
          extra_skills: [],
          skill_sync: WorkerSkillSyncEnum.InheritAndInjectOnSpawn,
        },
      };
    }),
  };
  return TeamFileSchema.parse(raw) as TeamFileConfig;
}

export function validateResourceProjectConfig(value: unknown): TeamFileConfig {
  return TeamFileSchema.parse(value) as TeamFileConfig;
}
