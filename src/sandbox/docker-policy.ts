import { t } from "../i18n/i18n";

const SAFE_EXACT_ARGS = new Set(["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"]);
const SAFE_VALUE_ARGS = [
  /^--cpus=\d+(?:\.\d+)?$/,
  /^--memory=\d+[kKmMgG]?$/,
  /^--memory-swap=-?\d+[kKmMgG]?$/,
  /^--pids-limit=\d+$/,
  /^--ulimit=[a-z_]+=[0-9]+(?::[0-9]+)?$/,
  /^--tmpfs=\/tmp(?::[A-Za-z0-9,=_-]+)?$/,
];

/** Only resource and hardening flags are accepted; mounts, privileges, env and identity are owned by OAT. */
export function assertSafeDockerExtraArgs(args: string[]): void {
  for (const arg of args) {
    if (SAFE_EXACT_ARGS.has(arg) || SAFE_VALUE_ARGS.some((pattern) => pattern.test(arg))) continue;
    throw new Error(t("docker_extra_arg_unsafe", { arg }));
  }
}
