import fs from "node:fs/promises";
import path from "node:path";
import { AgentRoleEnum } from "../types";

export type ToolNames = "request_workers" | "notify_complete" | "report_progress" | "generate_changelog";

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

  // OpenCode markdown agent：文件名即 agent name
  const toolsAllowed = args.toolsAllowed ?? { write: true, edit: true, bash: true };
  const frontmatter = [
    "---",
    `description: ${JSON.stringify(args.description)}`,
    "mode: primary",
    `model: ${JSON.stringify(args.model)}`,
    "tools:",
    `  write: ${toolsAllowed.write ? "true" : "false"}`,
    `  edit: ${toolsAllowed.edit ? "true" : "false"}`,
    `  bash: ${toolsAllowed.bash ? "true" : "false"}`,
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
      "- After finishing, call tool `notify-complete` and set the `changelog` argument to the CHANGELOG content you prepared (copy the text directly).",
      "- If there were no code changes, you must still record the reason/analysis in `CHANGELOG.md`.",
    ].join("\n");
  })();

  // 这里把 promptText 作为正文给模型（并为 Worker 追加系统约束）
  const body = `${frontmatter}\n${args.promptText}${skillsHint}${workerChangelogSystem}\n`;

  await fs.writeFile(filePath, body, "utf8");
}

export async function writeCustomTools(workspacePath: string, orchestratorBaseUrl: string): Promise<void> {
  const toolsDir = path.join(workspacePath, ".opencode", "tools");
  await fs.mkdir(toolsDir, { recursive: true });

  const commonHeader = `import fs from "node:fs/promises";\nimport path from "node:path";\nimport { tool } from "@opencode-ai/plugin";\n`;

  const orchestratorFetch = `
async function getOrchestratorBaseUrl(context: any): Promise<string> {
  const worktree = context.worktree ?? context.directory ?? "";
  const metaPath = path.join(worktree, ".oat", "orchestrator.json");
  const raw = await fs.readFile(metaPath, "utf8");
  return JSON.parse(raw).baseUrl;
}
`;

  const requestWorkers = `
export default tool({
  description: "Request new worker agents and dispatch tasks to them.",
  args: {
    leaderId: tool.schema.string().optional().describe("The caller leader agent id (optional; will fallback to context.agent)"),
    tasks: tool.schema.array(
      tool.schema.object({
        index: tool.schema.number().int().describe("Worker index (0-based)"),
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
export const ScopeGuard = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      // TODO：可以进一步对 file 编辑路径做 allowlist 校验
      // 这里先做轻量保护，避免明显危险命令
      if (input.tool === "bash" && output?.args?.command) {
        const cmd = output.args.command;
        if (cmd.includes("rm -rf /")) throw new Error("scope-guard: unsafe command blocked");
      }
    }
  };
};
`;

  await writeOatAgentMeta(workspacePath, roleMeta);
  await fs.writeFile(path.join(pluginsDir, "commit-guard.ts"), commitGuard, "utf8");
  await fs.writeFile(path.join(pluginsDir, "scope-guard.ts"), scopeGuard, "utf8");
}

