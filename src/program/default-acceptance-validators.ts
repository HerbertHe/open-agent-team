import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { AcceptanceValidatorRegistry } from "./acceptance-criteria";

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function artifact(root: string, relative: string): Promise<Buffer> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === "..")) throw new Error("ARTIFACT_PATH_OUTSIDE_WORKSPACE");
  const canonical = await fs.realpath(root);
  let current = canonical;
  for (const part of relative.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("ARTIFACT_SYMLINK_REJECTED");
  }
  const stat = await fs.stat(current);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("ARTIFACT_NOT_A_BOUNDED_FILE");
  const resolved = await fs.realpath(current);
  if (!resolved.startsWith(`${canonical}${path.sep}`)) throw new Error("ARTIFACT_PATH_OUTSIDE_WORKSPACE");
  return fs.readFile(resolved);
}

export type VerificationCommandResult = { passed: boolean; output: string; code: number | null };
export type VerificationCommandRunner = (command: string, cwd: string, timeoutSeconds: number, signal?: AbortSignal) => Promise<VerificationCommandResult>;
export function runVerificationProcess(command: string, args: string[], cwd: string, timeoutSeconds: number, signal?: AbortSignal, shell = false): Promise<VerificationCommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("VERIFICATION_ABORTED")); return; }
    const child = spawn(command, args, { cwd, shell, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let timedOut = false;
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const killTree = () => {
      if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
      else if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
    };
    const stop = () => { timedOut = true; killTree(); };
    const timer = setTimeout(stop, Math.min(timeoutSeconds, 300) * 1000);
    signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => { cleanup(); killTree(); resolve({ passed: code === 0 && !timedOut, code, output }); });
  });
}

export function createDefaultAcceptanceValidators(runCommand: VerificationCommandRunner = (command, cwd, seconds, signal) => runVerificationProcess(command, [], cwd, seconds, signal, true)): AcceptanceValidatorRegistry {
  const registry = new AcceptanceValidatorRegistry();
  registry.register("file_exists", "file-v1", async (criterion, input) => {
    if (criterion.type !== "file_exists") throw new Error("CRITERION_TYPE_MISMATCH");
    try {
      const hash = digest(await artifact(input.workspacePath, criterion.path));
      return { passed: criterion.digest === undefined || criterion.digest === hash, validatorVersion: "file-v1", artifactDigest: hash, details: {} };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { passed: false, validatorVersion: "file-v1", artifactDigest: digest(`file-failure:${criterion.path}:${reason}`), details: { reason } };
    }
  });
  registry.register("test_report", "test-report-v1", async (criterion, input) => {
    if (criterion.type !== "test_report") throw new Error("CRITERION_TYPE_MISMATCH");
    const data = await artifact(input.workspacePath, criterion.path);
    const report = JSON.parse(data.toString()) as { passed?: unknown; failed?: unknown };
    const valid = Number.isSafeInteger(report.passed) && Number.isSafeInteger(report.failed)
      && Number(report.passed) >= 0 && Number(report.failed) >= 0;
    return { passed: valid && Number(report.passed) >= criterion.minimumPassed && Number(report.failed) <= criterion.maximumFailed,
      validatorVersion: "test-report-v1", artifactDigest: digest(data), details: {} };
  });
  registry.register("command_exit_zero", "command-v1", async (criterion, input) => {
    if (criterion.type !== "command_exit_zero") throw new Error("CRITERION_TYPE_MISMATCH");
    const result = await runCommand(criterion.command, await fs.realpath(input.workspacePath), criterion.timeoutSeconds, input.signal);
    return { passed: result.passed, validatorVersion: "command-v1", artifactDigest: digest(JSON.stringify({ command: criterion.command, ...result })),
      details: { exitCode: result.code, outputDigest: digest(result.output) } };
  });
  return registry;
}
