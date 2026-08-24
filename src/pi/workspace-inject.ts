import fs from "node:fs/promises";
import path from "node:path";
import { AgentRoleEnum } from "../types";
import { RECORDS_DIR, todayRecordsSubPath } from "../utils/records";

/** 用于计算各 Agent 可触碰的目录前缀（绝对路径，统一带尾部 path.sep） */
export type OatWorkspaceScopeContext = {
  workspaceRoot: string;
  workspacePath: string;
  /** Runtime-only metadata root; when set, no `.oat` files are written into the Git worktree. */
  runtimeMetaPath?: string;
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

function normalizeJson(v: unknown): string {
  return JSON.stringify(v, null, 2);
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

/**
 * 写入 Agent 元数据（.oat/ 目录）并计算允许的路径前缀。
 * 工具以 defineTool() 形式直接在编排进程内注册，不生成任何外部文件。
 */
export async function writeAgentWorkspaceConfig(args: {
  workspacePath: string;
  agentName: string;
  role: AgentRoleEnum;
  scopeCtx: OatWorkspaceScopeContext;
  orchestratorBaseUrl: string;
  runtimeMetaPath?: string;
}): Promise<void> {
  const metaPath = args.runtimeMetaPath ?? args.workspacePath;
  await writeOatScopeMeta(metaPath, args.scopeCtx);
  await writeOatOrchestratorMeta(metaPath, { baseUrl: args.orchestratorBaseUrl });
  await writeOatAgentMeta(metaPath, {
    role: args.role,
    agentName: args.agentName,
    ...(args.role === AgentRoleEnum.Worker
      ? { allowedPushPattern: ".*\\/worker-\\d+" }
      : {}),
  });
}

/**
 * 构建 pi Agent 的系统提示词。
 */
export function buildAgentSystemPrompt(args: {
  agentName: string;
  description: string;
  role: AgentRoleEnum;
  promptText: string;
}): string {

  const todayPath = todayRecordsSubPath();
  const recordsHint = [
    `\n\n## File placement rules (ALL roles must follow)`,
    `- Keep the Git worktree clean: only repository source, tests, and deliberate project documentation may be created there.`,
    `- Do NOT create logs, drafts, records, skills, or runtime metadata inside the Git worktree; report evidence paths through the orchestration tools instead.`,
  ].join("\n");

  const changelogSystem = (() => {
    return [
      "\n\n## System constraint: CHANGELOG.md (You must follow)",
      "- Append your new entries to the END of `CHANGELOG.md` at the workspace root. Do NOT overwrite existing content.",
      "- Clearly describe what you did, which key files/modules were involved, and a brief conclusion.",
      ...(args.role === AgentRoleEnum.Worker ? ["- After self-testing, MUST call `submit-review` exactly once; this never merges your branch."] : args.role === AgentRoleEnum.Leader ? ["- After review and an approved release proposal, MUST call `notify-complete` exactly once."] : []),
      "- You may omit the `changelog` argument: orchestrator will read `CHANGELOG.md` from the workspace automatically.",
      "- If there were no code changes, you must still record the reason/analysis in `CHANGELOG.md`.",
    ].join("\n");
  })();

  return `${args.promptText}${recordsHint}${changelogSystem}`;
}
