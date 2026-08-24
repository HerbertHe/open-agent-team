import { DockerNetworkModeEnum, RuntimeModeEnum } from "../types";
import { t } from "../i18n/i18n";
import { assertSafeDockerExtraArgs } from "../sandbox/docker-policy";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

export function configuredRuntimeMode(config: unknown): RuntimeModeEnum {
  if (!record(config) || !record(config.runtime)) return RuntimeModeEnum.LocalProcess;
  return config.runtime.mode === RuntimeModeEnum.Docker ? RuntimeModeEnum.Docker : RuntimeModeEnum.LocalProcess;
}

export function validateRuntimeConfiguration(config: unknown): void {
  if (configuredRuntimeMode(config) !== RuntimeModeEnum.Docker) return;
  const runtime = record(config) && record(config.runtime) ? config.runtime : undefined;
  const docker = runtime && record(runtime.docker) ? runtime.docker : undefined;
  if (!docker || typeof docker.image !== "string" || !docker.image.trim()) throw new Error(t("runtime_docker_required"));
  if (docker.network !== undefined && !Object.values(DockerNetworkModeEnum).includes(docker.network as DockerNetworkModeEnum)) throw new Error(t("docker_network_invalid"));
  const extraArgs = docker.extra_args === undefined ? [] : docker.extra_args;
  if (!Array.isArray(extraArgs) || !extraArgs.every((arg) => typeof arg === "string")) throw new Error(t("docker_extra_args_invalid"));
  assertSafeDockerExtraArgs(extraArgs);
}

export function assertRuntimeTransition(current: unknown, next: unknown): void {
  const before = configuredRuntimeMode(current);
  const after = configuredRuntimeMode(next);
  if (before === RuntimeModeEnum.Docker && after !== RuntimeModeEnum.Docker) throw new Error(t("docker_runtime_downgrade_forbidden"));
  validateRuntimeConfiguration(next);
}
