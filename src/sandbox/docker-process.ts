import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { simpleGit } from "simple-git";
import type { AgentInstanceSpec } from "../types";
import { t } from "../i18n/i18n";
import type { AgentErrorInfo, AgentEventLine } from "./local-process";
import type { ChildToMain, MainToChild, SerializableToolDef, ToolResultPayload } from "./agent-runner-ipc";
import { assertSafeDockerExtraArgs } from "./docker-policy";
import { roundTripExecutionRuntimeContext, type ExecutionRuntimeContext } from "../program/execution-runtime-context";
import type { RuntimeExecutionAuthorizer } from "./interface";

type ToolLike = { name: string; label: string; description: string; parameters: unknown; execute: (id: string, params: unknown, executionContext?: ExecutionRuntimeContext) => Promise<ToolResultPayload> };
type StartOptions = { systemPrompt?: string; customTools?: ReturnType<typeof defineTool>[]; executionContext?: ExecutionRuntimeContext };
type ControlResult = Extract<ChildToMain, { type: "checkpoint_result" | "abort_result" }>;
type Entry = { child: ChildProcessWithoutNullStreams; spec: AgentInstanceSpec; options: StartOptions; tools: Map<string, ToolLike["execute"]>; containerName: string; startedAt: string; stderr: string[]; gitLinkDir: string; controlWaiters: Map<string, (message: ControlResult) => void> };
export type DockerRuntimeEntry = { agentId: string; role: string; containerName: string; startedAt: string; state: "running" | "stopping"; recentErrors: string[] };

function dockerExecutable(): string {
  const candidates = process.platform === "win32"
    ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe"), "docker.exe"]
    : process.platform === "darwin"
      ? ["/Applications/Docker.app/Contents/Resources/bin/docker", path.join(os.homedir(), "Applications", "Docker.app", "Contents", "Resources", "bin", "docker"), "/opt/homebrew/bin/docker", "/usr/local/bin/docker", "docker"]
      : ["/usr/bin/docker", "/usr/local/bin/docker", "docker"];
  return candidates.find((candidate) => candidate.includes(path.sep) && existsSync(candidate)) ?? candidates.at(-1)!;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 42) || "agent";
}

function managedContainerName(projectName: string, agentId: string): string {
  const hash = createHash("sha256").update(`${projectName}\0${agentId}`).digest("hex").slice(0, 10);
  return `oat-${safeName(projectName)}-${safeName(agentId)}-${hash}`.slice(0, 120);
}

function resolvePackageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(moduleDir, "../.."), path.resolve(moduleDir, ".."), process.cwd()];
  const root = candidates.find((candidate) => existsSync(path.join(candidate, "dist", "sandbox", "agent-runner.js")) && existsSync(path.join(candidate, "package.json")));
  if (!root) throw new Error(t("docker_runtime_bundle_missing"));
  return root;
}

export async function createDockerGitLink(workspacePath: string, agentId: string): Promise<{ commonGitDir: string; gitLinkDir: string; gitLinkPath: string }> {
  const workspaceGit = simpleGit(path.resolve(workspacePath));
  const commonGitDir = (await workspaceGit.raw(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const worktreeGitDir = (await workspaceGit.raw(["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
  const gitDirRelative = path.relative(commonGitDir, worktreeGitDir).split(path.sep).join("/");
  if (!gitDirRelative || gitDirRelative.startsWith("..")) throw new Error(t("docker_git_worktree_invalid", { agentId }));
  const gitLinkDir = await fs.mkdtemp(path.join(os.tmpdir(), "oat-docker-git-"));
  const gitLinkPath = path.join(gitLinkDir, ".git");
  await fs.writeFile(gitLinkPath, `gitdir: /oat-git-common/${gitDirRelative}\n`, "utf8");
  return { commonGitDir, gitLinkDir, gitLinkPath };
}

function runDocker(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerExecutable(), args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(t("docker_command_timeout"))); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

/** Docker-backed Agent runtime. Containers are named and labelled for Desktop discovery. */
export class DockerSessionProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly knownSessions = new Map<string, { spec: AgentInstanceSpec; options: StartOptions }>();
  private engineCheck?: Promise<void>;
  private executionAuthorizer?: RuntimeExecutionAuthorizer;
  constructor(
    private readonly dockerConfig: { image: string; network: "none" | "bridge" | "host"; extra_args: string[] },
    private readonly agentDir: string,
    private readonly projectName: string,
    private readonly onAgentEvent?: (info: AgentEventLine) => void,
    private readonly onAgentError?: (info: AgentErrorInfo) => void,
  ) { assertSafeDockerExtraArgs(dockerConfig.extra_args); }

  setExecutionAuthorizer(authorizer?: RuntimeExecutionAuthorizer): void { this.executionAuthorizer = authorizer; }

  listRuntimeEntries(): DockerRuntimeEntry[] {
    return Array.from(this.entries.values(), (entry) => ({ agentId: entry.spec.id, role: entry.spec.role, containerName: entry.containerName, startedAt: entry.startedAt, state: entry.child.exitCode === null ? "running" : "stopping", recentErrors: [...entry.stderr] }));
  }

  private ensureEngine(): Promise<void> {
    if (!this.engineCheck) this.engineCheck = runDocker(["version", "--format", "{{.Server.Version}}"], 10_000).then((result) => {
      if (result.code !== 0) throw new Error(t("docker_engine_unavailable", { error: result.stderr.trim() || result.stdout.trim() }));
    }).catch((error) => { this.engineCheck = undefined; throw error; });
    return this.engineCheck;
  }

  async start(spec: AgentInstanceSpec, options: StartOptions = {}): Promise<{ agentId: string }> {
    if (this.entries.has(spec.id)) throw new Error(t("docker_agent_already_running", { agentId: spec.id }));
    await this.ensureEngine();
    const root = resolvePackageRoot();
    const name = managedContainerName(this.projectName, spec.id);
    const existingOwner = await runDocker(["inspect", "--format", "{{ index .Config.Labels \"oat.project\" }}\t{{ index .Config.Labels \"oat.agent\" }}", name]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (existingOwner.code === 0) {
      const [ownerProject, ownerAgent] = existingOwner.stdout.trim().split("\t");
      if (ownerProject !== this.projectName || ownerAgent !== spec.id) throw new Error(t("docker_container_name_conflict", { name }));
      const removed = await runDocker(["rm", "-f", name]);
      if (removed.code !== 0) throw new Error(t("docker_container_cleanup_failed", { name, error: removed.stderr.trim() }));
    }
    const envArgs = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]
      .filter((envName) => process.env[envName] !== undefined).flatMap((envName) => ["-e", envName]);
    const { commonGitDir, gitLinkDir, gitLinkPath } = await createDockerGitLink(spec.workspacePath, spec.id);
    const args = ["run", "--rm", "-i", "--init", "--name", name,
      "--label", "oat.managed=true", "--label", `oat.project=${this.projectName}`, "--label", `oat.agent=${spec.id}`, "--label", `oat.role=${spec.role}`,
      "--network", this.dockerConfig.network, "--workdir", "/workspace",
      "-v", `${path.resolve(spec.workspacePath)}:/workspace:rw`, "-v", `${gitLinkPath}:/workspace/.git:ro`,
      "-v", `${commonGitDir}:/oat-git-common:rw`, "-v", `${root}:/oat:ro`, "-v", `${path.resolve(this.agentDir)}:/agent:ro`,
      ...envArgs, ...this.dockerConfig.extra_args, this.dockerConfig.image, "node", "/oat/dist/sandbox/agent-runner.js"];
    const child = spawn(dockerExecutable(), args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const tools = new Map<string, ToolLike["execute"]>((options.customTools ?? []).map((tool) => { const value = tool as unknown as ToolLike; return [value.name, value.execute.bind(value)]; }));
    const entry: Entry = { child, spec, options, tools, containerName: name, startedAt: new Date().toISOString(), stderr: [], gitLinkDir, controlWaiters: new Map() };
    this.entries.set(spec.id, entry);
    let readyComplete = false;
    child.stderr.on("data", (chunk) => { entry.stderr.push(String(chunk).trim()); entry.stderr = entry.stderr.filter(Boolean).slice(-20); });
    child.on("exit", (code) => { void fs.rm(gitLinkDir, { recursive: true, force: true }); if (this.entries.delete(spec.id) && readyComplete && code !== 0) this.onAgentError?.({ agentId: spec.id, role: spec.role, error: new Error(t("docker_agent_exited", { agentId: spec.id, code: code ?? 1 })) }); });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(t("docker_agent_start_timeout", { agentId: spec.id }))); }, 60_000);
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onExit = (code: number | null) => { cleanup(); reject(new Error(t("docker_agent_exited", { agentId: spec.id, code: code ?? 1 }))); };
      const cleanup = () => { clearTimeout(timer); child.off("error", onError); child.off("exit", onExit); };
      child.once("error", onError); child.once("exit", onExit);
      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let msg: ChildToMain; try { msg = JSON.parse(line) as ChildToMain; } catch { return; }
        if (msg.type === "ready") { cleanup(); resolve(); return; }
        if (msg.type === "agent_error") { cleanup(); reject(new Error(msg.error)); return; }
        if (msg.type === "checkpoint_result" || msg.type === "abort_result") { entry.controlWaiters.get(msg.requestId)?.(msg); return; }
        if (msg.type === "agent_event") this.onAgentEvent?.({ agentId: spec.id, role: spec.role, event: msg.event as never, executionContext: msg.executionContext });
        if (msg.type === "tool_call") void this.executeTool(entry, msg);
      });
    });
    this.send(spec.id, { type: "start", spec: { id: spec.id, role: spec.role, name: spec.name, branch: spec.branch, workspacePath: "/workspace", model: spec.model, teamName: spec.teamName }, agentDir: "/agent", systemPrompt: options.systemPrompt, executionContext: options.executionContext ? roundTripExecutionRuntimeContext(options.executionContext) : undefined, toolDefs: (options.customTools ?? []).map((tool) => { const value = tool as unknown as ToolLike; return { name: value.name, label: value.label, description: value.description, parameters: value.parameters } as SerializableToolDef; }) });
    try { await ready; readyComplete = true; this.knownSessions.set(spec.id, { spec, options }); } catch (error) { this.entries.delete(spec.id); await runDocker(["rm", "-f", name]).catch(() => undefined); await fs.rm(gitLinkDir, { recursive: true, force: true }); throw error; }
    return { agentId: spec.id };
  }

  private async executeTool(entry: Entry, msg: Extract<ChildToMain, { type: "tool_call" }>): Promise<void> {
    try {
      if (msg.executionContext) await this.executionAuthorizer?.({ phase: "tool", agentId: entry.spec.id, context: msg.executionContext, toolName: msg.toolName });
      this.send(entry.spec.id, { type: "tool_result", callId: msg.callId, result: await entry.tools.get(msg.toolName)?.(msg.toolCallId, msg.params, msg.executionContext) });
    }
    catch (error) { this.send(entry.spec.id, { type: "tool_result", callId: msg.callId, error: error instanceof Error ? error.message : String(error) }); }
  }
  private send(agentId: string, msg: MainToChild): void { this.entries.get(agentId)?.child.stdin.write(`${JSON.stringify(msg)}\n`); }
  async sendPrompt(agentId: string, text: string, executionContext?: ExecutionRuntimeContext): Promise<void> { if (!this.entries.has(agentId)) throw new Error(t("docker_agent_not_running", { agentId })); if (executionContext) await this.executionAuthorizer?.({ phase: "prompt", agentId, context: executionContext }); this.send(agentId, { type: "prompt", text, ...(executionContext ? { executionContext: roundTripExecutionRuntimeContext(executionContext) } : {}) }); }
  async requestCheckpoint(agentId: string, attemptId: string, deadlineAt: string): Promise<{ acknowledged: boolean; state?: import("../program/checkpoint-store").ContinuationState }> {
    const entry = this.entries.get(agentId); if (!entry) throw new Error(t("docker_agent_not_running", { agentId }));
    const requestId = `checkpoint:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); entry.controlWaiters.delete(requestId); };
      const timer = setTimeout(() => { finish(); reject(new Error(`Checkpoint acknowledgement timed out for ${agentId}`)); }, Math.max(1, Math.min(30_000, Date.parse(deadlineAt) - Date.now())));
      entry.controlWaiters.set(requestId, (message) => { finish(); if (message.type !== "checkpoint_result" || message.error) reject(new Error(message.type === "checkpoint_result" ? message.error : "Unexpected control response")); else resolve({ acknowledged: message.acknowledged, ...(message.state ? { state: message.state } : {}) }); });
      this.send(agentId, { type: "checkpoint_request", requestId, attemptId, deadlineAt });
    });
  }
  async abortAttempt(agentId: string, attemptId: string, reason: string): Promise<{ acknowledged: boolean; providerRequests: string[]; toolCalls: string[] }> {
    const entry = this.entries.get(agentId); if (!entry) return { acknowledged: false, providerRequests: [], toolCalls: [] };
    const requestId = `abort:${randomUUID()}`;
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); entry.controlWaiters.delete(requestId); };
      const timer = setTimeout(() => { finish(); resolve({ acknowledged: false, providerRequests: [], toolCalls: [] }); }, 5_000);
      entry.controlWaiters.set(requestId, (message) => { finish(); resolve(message.type === "abort_result" ? { acknowledged: message.acknowledged, providerRequests: message.providerRequests, toolCalls: message.toolCalls } : { acknowledged: false, providerRequests: [], toolCalls: [] }); });
      this.send(agentId, { type: "abort_attempt", requestId, attemptId, reason });
    });
  }
  async terminateSession(agentId: string, _reason: string): Promise<void> { await this.stop(agentId); }
  async stop(agentId: string): Promise<void> { const entry = this.entries.get(agentId); if (!entry) return; this.send(agentId, { type: "stop" }); await Promise.race([new Promise<void>((resolve) => entry.child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]); if (entry.child.exitCode === null) { const stopped = await runDocker(["stop", "--time", "10", entry.containerName], 15_000).catch(() => ({ code: 1, stdout: "", stderr: "" })); if (stopped.code !== 0) await runDocker(["rm", "-f", entry.containerName], 15_000).catch(() => undefined); } this.entries.delete(agentId); if (entry.child.exitCode === null) entry.child.kill("SIGTERM"); }
  async stopAll(): Promise<void> { await Promise.all([...this.entries.keys()].map((id) => this.stop(id))); }
  async health(agentId: string): Promise<boolean> { const entry = this.entries.get(agentId); if (!entry || entry.child.exitCode !== null) return false; return (await runDocker(["inspect", "--format", "{{.State.Running}}", entry.containerName], 5_000).catch(() => ({ code: 1, stdout: "", stderr: "" }))).stdout.trim() === "true"; }
  async resetSession(agentId: string, executionContext?: ExecutionRuntimeContext): Promise<void> { const entry = this.entries.get(agentId); const known = entry ?? this.knownSessions.get(agentId); if (!known) throw new Error(t("docker_agent_not_running", { agentId })); const { spec, options } = known; if (entry) await this.stop(agentId); await this.start(spec, { ...options, ...(executionContext ? { executionContext } : {}) }); }
  describeSession(agentId: string): { agentId: string; workspacePath: string } | undefined { const spec = this.entries.get(agentId)?.spec ?? this.knownSessions.get(agentId)?.spec; return spec ? { agentId, workspacePath: spec.workspacePath } : undefined; }
  async rebindSession(agentId: string, spec: AgentInstanceSpec): Promise<void> { const entry = this.entries.get(agentId); const known = entry ?? this.knownSessions.get(agentId); if (!known) throw new Error(t("docker_agent_not_running", { agentId })); const options = known.options; if (entry) await this.stop(agentId); await this.start(spec, options); }
}
