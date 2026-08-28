import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TeamFileSchema } from "../config/schema";
import { buildResourceProjectConfig } from "./config-builder";
import {
  BaseBranchEnum,
  DockerNetworkModeEnum,
  ProviderCompatibleTypeEnum,
  RuntimeModeEnum,
} from "../types";
import { t } from "../i18n/i18n";

type Ask = (question: string, fallback?: string) => Promise<string>;

function createAsker(): { ask: Ask; close: () => void } {
  const rl = readline.createInterface({ input, output });
  return {
    ask: async (question, fallback = "") => {
      const suffix = fallback ? ` [${fallback}]` : "";
      const value = (await rl.question(`${question}${suffix}: `)).trim();
      return value || fallback;
    },
    close: () => rl.close(),
  };
}

/** A constrained HR-style interview that creates valid declarative team files. */
export async function runResourcesInterview(configPath: string, force = false): Promise<{ path: string; teamCount: number }> {
  const target = path.resolve(configPath);
  const exists = await fs.access(target).then(() => true).catch(() => false);
  if (exists && !force) throw new Error(t("resources_file_exists", { path: target }));
  const { ask, close } = createAsker();
  try {
    output.write(`\n${t("resources_intro")}\n\n`);
    const projectName = await ask(t("resources_project_name"), path.basename(path.dirname(target)));
    const repo = await ask(t("resources_repo_path"), ".");
    const baseBranch = await ask(t("resources_base_branch"), BaseBranchEnum.Main);
    if (baseBranch !== BaseBranchEnum.Main && baseBranch !== BaseBranchEnum.Master) throw new Error(t("resources_base_branch_invalid"));
    const model = await ask(t("resources_default_model"), "openai/gpt-4o-mini");
    const provider = model.split("/")[0] || ProviderCompatibleTypeEnum.OpenAI;
    const compatibleType = await ask(t("resources_provider_protocol"), provider === ProviderCompatibleTypeEnum.Anthropic ? ProviderCompatibleTypeEnum.Anthropic : ProviderCompatibleTypeEnum.OpenAI);
    if (compatibleType !== ProviderCompatibleTypeEnum.OpenAI && compatibleType !== ProviderCompatibleTypeEnum.Anthropic) throw new Error(t("resources_provider_protocol_invalid"));
    const baseUrl = await ask(t("resources_provider_base_url"));
    const apiKey = await ask(t("resources_provider_api_key"));
    const runtimeMode = await ask(t("resources_runtime_mode"), RuntimeModeEnum.Docker);
    if (runtimeMode !== RuntimeModeEnum.LocalProcess && runtimeMode !== RuntimeModeEnum.Docker) throw new Error(t("resources_runtime_mode_invalid"));
    const dockerNetwork = runtimeMode === RuntimeModeEnum.Docker
      ? await ask(t("resources_docker_network"), DockerNetworkModeEnum.Bridge)
      : undefined;
    if (dockerNetwork !== undefined && !Object.values(DockerNetworkModeEnum).includes(dockerNetwork as DockerNetworkModeEnum)) throw new Error(t("resources_runtime_mode_invalid"));
    const docker = runtimeMode === RuntimeModeEnum.Docker ? {
      image: await ask(t("resources_docker_image"), "node:22-bookworm"),
      network: dockerNetwork as DockerNetworkModeEnum,
      extra_args: (await ask(t("resources_docker_extra_args"))).split(",").map((x) => x.trim()).filter(Boolean),
    } : undefined;
    const teamCount = Number(await ask(t("resources_team_count"), "1"));
    if (!Number.isInteger(teamCount) || teamCount < 1) throw new Error(t("resources_positive_integer", { field: t("resources_team_count") }));
    const teams = [];
    for (let index = 0; index < teamCount; index++) {
      output.write(`\n${t("resources_team_heading", { index: index + 1, count: teamCount })}\n`);
      const name = await ask(t("resources_team_id"), `team-${index + 1}`);
      const description = await ask(t("resources_leader_responsibility"), "Own task planning, review, integration, and release proposals.");
      const workers = Number(await ask(t("resources_worker_capacity"), "2"));
      if (!Number.isInteger(workers) || workers < 1) throw new Error(t("resources_positive_integer", { field: t("resources_worker_capacity") }));
      const repos = (await ask(t("resources_allowed_paths"))).split(",").map((x) => x.trim()).filter(Boolean);
      teams.push({ name, responsibility: description, workers, repos });
    }
    const raw = {
      ...buildResourceProjectConfig({
        projectName,
        repo,
        baseBranch: baseBranch as BaseBranchEnum,
        modelAlias: "default",
        modelId: model,
        runtimeMode: runtimeMode as RuntimeModeEnum,
        dockerImage: docker?.image,
        dockerNetwork: docker?.network,
        teams,
      }),
      providers: { [provider]: { compatible_type: compatibleType, ...(baseUrl ? { base_url: baseUrl } : {}), ...(apiKey ? { api_key: apiKey } : {}) } },
    };
    TeamFileSchema.parse(raw);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return { path: target, teamCount };
  } finally { close(); }
}
