import fs from "node:fs/promises";
import path from "node:path";
import { AgentRoleEnum } from "../types";

/** 用于计算各 Agent 可触碰的目录前缀（绝对路径，统一带尾部 path.sep） */
export type OatWorkspaceScopeContext = {
  workspaceRoot: string;
  workspacePath: string;
  role: AgentRoleEnum;
  teamName?: string;
  teams: Array<{ name: string; worker: { total: number } }>;
};

function prefixDir(absPath: string): string {
  const r = path.resolve(absPath);
  return r.endsWith(path.sep) ? r : r + path.sep;
}

/**
 * Admin：本 workspace + 全部 Leader/Worker 目录。
 * Leader：本 workspace + 本 team 全部 Worker 目录。
 * Worker：仅本 workspace。
 */
export function computeAllowedPathPrefixes(ctx: OatWorkspaceScopeContext): string[] {
  const root = path.resolve(ctx.workspaceRoot);
  const own = prefixDir(ctx.workspacePath);

  if (ctx.role === AgentRoleEnum.Worker) {
    return [own];
  }
  if (ctx.role === AgentRoleEnum.Leader && ctx.teamName) {
    const out: string[] = [own];
    const team = ctx.teams.find((t) => t.name === ctx.teamName);
    const n = team?.worker.total ?? 0;
    for (let i = 0; i < n; i++) {
      out.push(prefixDir(path.join(root, `${ctx.teamName}-worker-${i}`)));
    }
    return out;
  }
  if (ctx.role === AgentRoleEnum.Admin) {
    const out: string[] = [own];
    for (const t of ctx.teams) {
      out.push(prefixDir(path.join(root, `${t.name}-lead`)));
      for (let i = 0; i < t.worker.total; i++) {
        out.push(prefixDir(path.join(root, `${t.name}-worker-${i}`)));
      }
    }
    return out;
  }
  return [own];
}

/** 供 OpenCode external_directory：仅包含「相对当前 agent 工作区而言额外的」允许路径 */
function buildExternalDirectoryMap(
  workspacePath: string,
  prefixes: string[],
): Record<string, "allow"> {
  const ownResolved = path.resolve(workspacePath);
  const out: Record<string, "allow"> = {};
  for (const pref of prefixes) {
    const dir = pref.endsWith(path.sep) ? pref.slice(0, -1) : pref;
    const rp = path.resolve(dir);
    if (rp === ownResolved) continue;
    out[`${rp}${path.sep}**`] = "allow";
    out[rp] = "allow";
  }
  return out;
}

export async function writeOatScopeMeta(
  workspacePath: string,
  ctx: OatWorkspaceScopeContext,
): Promise<void> {
  const prefixes = computeAllowedPathPrefixes(ctx);
  const dir = path.join(workspacePath, ".oat");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "scope.json"),
    normalizeJson({ allowedPrefixes: prefixes }),
    "utf8",
  );
}

export type ToolNames =
  | "request_workers"
  | "register_workers"
  | "dispatch_worker_tasks"
  | "assign_leader_task"
  | "notify_complete"
  | "report_progress"
  | "generate_changelog";

function normalizeJson(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

export async function writeOatAgentMeta(workspacePath: string, meta: Record<string, unknown>): Promise<void> {
  const dir = path.join(workspacePath, ".oat");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "agent.json"), normalizeJson(meta), "utf8");
}

export async function writeOatOrchestratorMeta(workspacePath: string, meta: { baseUrl: string }): Promise<void> {
  const dir = path.join(workspacePath, ".oat");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "orchestrator.json"), normalizeJson(meta), "utf8");
}

export async function writeAgentMarkdown(args: {
  workspacePath: string;
  agentName: string;
  description: string;
  role: AgentRoleEnum;
  model: string;
  promptText: string;
  skills: string[];
  toolsAllowed?: {
    write?: boolean;
    edit?: boolean;
    bash?: boolean;
  };
}): Promise<void> {
  const agentsDir = path.join(args.workspacePath, ".opencode", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const filePath = path.join(agentsDir, `${args.agentName}.md`);

  // OpenCode v1.1+：legacy `tools:` 已并入 permission；自定义工具须在 permission 中显式 allow，否则模型侧可能看不到
  const toolsAllowed = args.toolsAllowed ?? { write: true, edit: true, bash: true };
  const canEdit = (toolsAllowed.write ?? true) || (toolsAllowed.edit ?? true);
  const canBash = toolsAllowed.bash ?? true;
  const frontmatter = [
    "---",
    `description: ${JSON.stringify(args.description)}`,
    "mode: primary",
    `model: ${JSON.stringify(args.model)}`,
    "permission:",
    "  read: allow",
    "  glob: allow",
    "  grep: allow",
    "  list: allow",
    "  skill: allow",
    "  webfetch: allow",
    "  todowrite: allow",
    "  question: allow",
    canEdit ? "  edit: allow" : "  edit: deny",
    canBash ? "  bash: allow" : "  bash: deny",
    "  assign-leader-task: allow",
    "  register-workers: allow",
    "  dispatch-worker-tasks: allow",
    "  request-workers: allow",
    "  notify-complete: allow",
    "  report-progress: allow",
    "  generate-changelog: allow",
    "---",
  ].join("\n");

  const skillsHint = args.skills.length
    ? `\n\n# Skills\nYou may call the following skills as needed:\n${args.skills.map((s) => `- ${s}`).join("\n")}\n`
    : "";

  const workerChangelogSystem = (() => {
    if (args.role !== AgentRoleEnum.Worker) return "";
    return [
      "\n\n## System constraint: CHANGELOG.md (Worker must follow)",
      "- Create or update `CHANGELOG.md` at the workspace root.",
      "- Clearly describe what you did, which key files/modules were involved, and a brief conclusion.",
      "- After finishing, MUST call tool `notify-complete` exactly once.",
      `- You MUST provide required args: { "agentRole": "worker", "agentId": "${args.agentName}" } (you may omit \`changelog\`).`,
      "- You may omit the `changelog` argument: orchestrator will read `CHANGELOG.md` from the workspace automatically.",
      "- If there were no code changes, you must still record the reason/analysis in `CHANGELOG.md`.",
    ].join("\n");
  })();

  // 这里把 promptText 作为正文给模型（并为 Worker 追加系统约束）
  const body = `${frontmatter}\n${args.promptText}${skillsHint}${workerChangelogSystem}\n`;

  await fs.writeFile(filePath, body, "utf8");
}

export async function writeCustomTools(
  workspacePath: string,
  orchestratorBaseUrl: string,
  scopeCtx: OatWorkspaceScopeContext,
): Promise<void> {
  await writeOatScopeMeta(workspacePath, scopeCtx);
  const scopePrefixes = computeAllowedPathPrefixes(scopeCtx);
  const external_directory = buildExternalDirectoryMap(workspacePath, scopePrefixes);

  const toolsDir = path.join(workspacePath, ".opencode", "tools");
  await fs.mkdir(toolsDir, { recursive: true });

  const commonHeader = `import fs from "node:fs/promises";\nimport path from "node:path";\nimport { tool } from "@opencode-ai/plugin";\n`;

  const orchestratorFetch = `
async function getOrchestratorBaseUrl(context: any): Promise<string> {
  const fromEnv =
    typeof process !== "undefined" && typeof process.env?.OAT_ORCHESTRATOR_BASE_URL === "string"
      ? process.env.OAT_ORCHESTRATOR_BASE_URL.trim()
      : "";
  if (fromEnv) return fromEnv;
  const worktree = context.worktree ?? context.directory ?? "";
  const metaPath = path.join(worktree, ".oat", "orchestrator.json");
  const raw = await fs.readFile(metaPath, "utf8");
  return JSON.parse(raw).baseUrl;
}
`;

  const registerWorkers = `
export default tool({
  description: "Register N worker agents (spawn runtimes) without assigning tasks yet. Call dispatch-worker-tasks next.",
  args: {
    leaderId: tool.schema.string().optional().describe("The caller leader agent id (optional; will fallback to context.agent)"),
    count: tool.schema.number().int().min(1).describe("How many workers to register (indices 0 .. count-1)")
  },
  async execute(args, context) {
    const baseUrl = await getOrchestratorBaseUrl(context);
    const leaderId = args.leaderId ?? context?.agent ?? "";
    const res = await fetch(\`\${baseUrl}/tool/register_workers\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaderId, count: args.count })
    });
    if (!res.ok) throw new Error(\`register_workers failed: \${res.status}\`);
    return await res.json();
  }
});
`;

  const dispatchWorkerTasks = `
export default tool({
  description: "Dispatch task prompts to already-registered workers (after register-workers).",
  args: {
    leaderId: tool.schema.string().optional().describe("The caller leader agent id (optional; will fallback to context.agent)"),
    tasks: tool.schema.array(
      tool.schema.object({
        index: tool.schema.number().int().optional().describe("Worker index (0-based); defaults to task order"),
        prompt: tool.schema.string().describe("Task prompt for this worker")
      })
    ).describe("Tasks to assign to workers")
  },
  async execute(args, context) {
    const baseUrl = await getOrchestratorBaseUrl(context);
    const leaderId = args.leaderId ?? context?.agent ?? "";
    const res = await fetch(\`\${baseUrl}/tool/dispatch_worker_tasks\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaderId, tasks: args.tasks ?? [] })
    });
    if (!res.ok) throw new Error(\`dispatch_worker_tasks failed: \${res.status}\`);
    return await res.json();
  }
});
`;

  const requestWorkers = `
export default tool({
  description: "Shortcut: register workers and dispatch tasks in one call. Prefer register-workers then dispatch-worker-tasks for two-phase flow.",
  args: {
    leaderId: tool.schema.string().optional().describe("The caller leader agent id (optional; will fallback to context.agent)"),
    tasks: tool.schema.array(
      tool.schema.object({
        index: tool.schema.number().int().optional().describe("Worker index (0-based)"),
        prompt: tool.schema.string().describe("Worker prompt for this task")
      })
    ).describe("Worker tasks to run")
  },
  async execute(args, context) {
    const baseUrl = await getOrchestratorBaseUrl(context);
    const leaderId = args.leaderId ?? context?.agent ?? "";
    const res = await fetch(\`\${baseUrl}/tool/request_workers\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...args, leaderId })
    });
    if (!res.ok) throw new Error(\`request_workers failed: \${res.status}\`);
    return await res.json();
  }
});
`;

  const assignLeaderTask = `
export default tool({
  description: "Assign a task prompt to a specific leader. Admin uses this to decide which leader should handle the work.",
  args: {
    leaderId: tool.schema.string().describe("Target leader agent id"),
    prompt: tool.schema.string().describe("Task prompt to send to the leader (orchestration instruction)")
  },
  async execute(args, context) {
    const baseUrl = await getOrchestratorBaseUrl(context);
    const res = await fetch(\`\${baseUrl}/tool/assign_leader_task\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaderId: args.leaderId, prompt: args.prompt })
    });
    if (!res.ok) throw new Error(\`assign_leader_task failed: \${res.status}\`);
    return await res.json();
  }
});
`;

  const notifyComplete = `
export default tool({
  description: "Notify orchestrator that an agent has completed its work.",
  args: {
    agentRole: tool.schema.picklist([${JSON.stringify(AgentRoleEnum.Worker)}, ${JSON.stringify(AgentRoleEnum.Leader)}, ${JSON.stringify(AgentRoleEnum.Admin)}]).describe("Which role is completing"),
    agentId: tool.schema.string().optional().describe("Agent id (optional; will fallback to context.agent)"),
    changelog: tool.schema.string().optional().describe("Optional CHANGELOG content")
  },
  async execute(args, context) {
    const baseUrl = await getOrchestratorBaseUrl(context);
    const agentId = args.agentId ?? context?.agent ?? "";
    const res = await fetch(\`\${baseUrl}/tool/notify_complete\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...args, agentId })
    });
    if (!res.ok) throw new Error(\`notify_complete failed: \${res.status}\`);
    return await res.json();
  }
});
`;

  const reportProgress = `
export default tool({
  description: "Report progress for long running tasks.",
  args: {
    agentId: tool.schema.string(),
    stage: tool.schema.string().optional().describe("Execution stage, e.g. start/changelog_update/before_notify_complete/done"),
    message: tool.schema.string()
  },
  async execute(args, context) {
    const baseUrl = await getOrchestratorBaseUrl(context);
    const res = await fetch(\`\${baseUrl}/tool/report_progress\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args)
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  }
});
`;

  const generateChangelog = `
export default tool({
  description: "Generate or read CHANGELOG.md for an agent workspace.",
  args: {
    agentId: tool.schema.string()
  },
  async execute(args, context) {
    const baseUrl = await getOrchestratorBaseUrl(context);
    const res = await fetch(\`\${baseUrl}/tool/generate_changelog\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args)
    });
    if (!res.ok) throw new Error(\`generate_changelog failed: \${res.status}\`);
    return await res.json();
  }
});
`;

  // Important：OpenCode tool name is based on filename.
  await fs.writeFile(
    path.join(toolsDir, "register-workers.ts"),
    `${commonHeader}\n${orchestratorFetch}\n${registerWorkers}`,
    "utf8"
  );
  await fs.writeFile(
    path.join(toolsDir, "dispatch-worker-tasks.ts"),
    `${commonHeader}\n${orchestratorFetch}\n${dispatchWorkerTasks}`,
    "utf8"
  );
  await fs.writeFile(
    path.join(toolsDir, "assign-leader-task.ts"),
    `${commonHeader}\n${orchestratorFetch}\n${assignLeaderTask}`,
    "utf8"
  );
  await fs.writeFile(
    path.join(toolsDir, "request-workers.ts"),
    `${commonHeader}\n${orchestratorFetch}\n${requestWorkers}`,
    "utf8"
  );
  await fs.writeFile(
    path.join(toolsDir, "notify-complete.ts"),
    `${commonHeader}\n${orchestratorFetch}\n${notifyComplete}`,
    "utf8"
  );
  await fs.writeFile(
    path.join(toolsDir, "report-progress.ts"),
    `${commonHeader}\n${orchestratorFetch}\n${reportProgress}`,
    "utf8"
  );
  await fs.writeFile(
    path.join(toolsDir, "generate-changelog.ts"),
    `${commonHeader}\n${orchestratorFetch}\n${generateChangelog}`,
    "utf8"
  );

  // 工作区内默认 allow（不弹授权）；Admin/Leader 经 external_directory 访问下级目录；越界由 scope-guard 拒绝
  const opencodeJson: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permission: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      skill: "allow",
      webfetch: "allow",
      todowrite: "allow",
      question: "allow",
      edit: "allow",
      bash: "allow",
      external_directory,
      "assign-leader-task": "allow",
      "register-workers": "allow",
      "dispatch-worker-tasks": "allow",
      "request-workers": "allow",
      "notify-complete": "allow",
      "report-progress": "allow",
      "generate-changelog": "allow",
    },
  };
  await fs.writeFile(
    path.join(workspacePath, "opencode.json"),
    normalizeJson(opencodeJson),
    "utf8"
  );
}

export async function writeCustomPlugins(workspacePath: string, roleMeta: Record<string, unknown>): Promise<void> {
  const pluginsDir = path.join(workspacePath, ".opencode", "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  // commit-guard.ts: keep it minimal (block push to main by default)
  const commitGuard = `
import fs from "node:fs/promises";
import path from "node:path";

export const CommitGuard = async ({ worktree }) => {
  const metaPath = path.join(worktree ?? "", ".oat", "agent.json");
  let meta = {};
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    meta = JSON.parse(raw);
  } catch {}

  const role = meta.role;
  const allowedPushPattern = meta.allowedPushPattern ?? null;

  const isPushAllowed = (command) => {
    if (!command) return true;
    if (!command.includes("git push")) return true;
    if (role === ${JSON.stringify(AgentRoleEnum.Admin)} || role === ${JSON.stringify(AgentRoleEnum.Leader)}) return true; // orchestrator handles final merges
    if (!allowedPushPattern) return false;
    try {
      const re = new RegExp(allowedPushPattern);
      return re.test(command);
    } catch {
      return false;
    }
  };

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && output?.args?.command) {
        const cmd = output.args.command;
        if (!isPushAllowed(cmd)) {
          throw new Error("commit-guard: git push rejected (only allowed to push worker branches)");
        }
        if (cmd.includes("git add -A") || cmd.includes("git add --all")) {
          throw new Error("commit-guard: git add -A is not allowed; use allowlist staging instead");
        }
      }
    }
  };
};
`;

  const scopeGuard = `
import fs from "node:fs/promises";
import path from "node:path";

/** 路径必须在 .oat/scope.json 的 allowedPrefixes 之下；Worker 仅本人目录，Leader 含本队 Worker，Admin 含全部 Leader/Worker */
export const ScopeGuard = async ({ worktree }) => {
  const scopePath = path.join(worktree ?? "", ".oat", "scope.json");
  let allowedPrefixes = [];
  try {
    const raw = await fs.readFile(scopePath, "utf8");
    allowedPrefixes = JSON.parse(raw).allowedPrefixes ?? [];
  } catch {
    allowedPrefixes = [];
  }
  const wt = path.resolve(worktree ?? "");
  if (allowedPrefixes.length === 0) {
    allowedPrefixes = [wt + path.sep];
  }

  const isUnderAllowed = (absResolved) => {
    const a = absResolved;
    for (const pref of allowedPrefixes) {
      const base = pref.endsWith(path.sep) ? pref.slice(0, -1) : pref;
      const rp = path.resolve(base);
      if (a === rp || a.startsWith(rp + path.sep)) return true;
    }
    return false;
  };

  const checkPath = async (p) => {
    if (p == null || typeof p !== "string") return;
    const trimmed = p.trim();
    if (trimmed === "") return;
    const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(wt, trimmed);
    let real = abs;
    try {
      real = await fs.realpath(abs);
    } catch {
      /* 新文件路径可能尚不存在 */
    }
    if (!isUnderAllowed(real)) {
      throw new Error("oat-scope: path outside allowed workspaces: " + trimmed);
    }
  };

  return {
    "tool.execute.before": async (input, output) => {
      const tool = input.tool;
      const args = output?.args ?? {};
      if (tool === "read" || tool === "write" || tool === "edit" || tool === "multiedit") {
        await checkPath(args.filePath ?? args.path ?? args.file);
      }
      if (tool === "glob" || tool === "grep" || tool === "list") {
        await checkPath(args.path ?? args.directory ?? args.glob ?? ".");
      }
      if (tool === "apply_patch" && typeof args.patchText === "string") {
        const re = /^\\*\\*\\* (Add File|Update File|Delete File|Move to):\\s*(.+)$/;
        for (const line of args.patchText.replace(/\\r/g, "").split("\\n")) {
          const m = line.match(re);
          if (m) await checkPath(m[2].trim());
        }
      }
      if (tool === "bash" && output?.args?.command) {
        const cmd = output.args.command;
        if (cmd.includes("rm -rf /")) throw new Error("oat-scope: unsafe command blocked");
      }
    }
  };
};
`;

  await writeOatAgentMeta(workspacePath, roleMeta);
  await fs.writeFile(path.join(pluginsDir, "commit-guard.ts"), commitGuard, "utf8");
  await fs.writeFile(path.join(pluginsDir, "scope-guard.ts"), scopeGuard, "utf8");
}

