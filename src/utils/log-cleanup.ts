import fs from "node:fs/promises";
import path from "node:path";

export type AgentLogSummary = {
  agentId: string;
  files: number;
  bytes: number;
  oldestAt?: string;
  newestAt?: string;
};

/** Summarize persisted runtime logs without reading their contents. */
export async function scanAgentLogs(workspaceRootDir: string): Promise<{
  agents: AgentLogSummary[];
  files: number;
  bytes: number;
}> {
  const agents: AgentLogSummary[] = [];
  let workspaceDirs: string[];
  try {
    const entries = await fs.readdir(workspaceRootDir, { withFileTypes: true });
    workspaceDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return { agents, files: 0, bytes: 0 };
  }

  for (const agentId of workspaceDirs) {
    const logsDir = path.join(workspaceRootDir, agentId, "logs");
    let files: string[];
    try { files = (await fs.readdir(logsDir)).filter((file) => file.endsWith(".jsonl")); }
    catch { continue; }
    let bytes = 0; let oldestMs: number | undefined; let newestMs: number | undefined;
    for (const file of files) {
      try {
        const stat = await fs.stat(path.join(logsDir, file));
        bytes += stat.size;
        oldestMs = oldestMs === undefined ? stat.mtimeMs : Math.min(oldestMs, stat.mtimeMs);
        newestMs = newestMs === undefined ? stat.mtimeMs : Math.max(newestMs, stat.mtimeMs);
      } catch { /* a concurrently deleted log can be ignored */ }
    }
    if (files.length) agents.push({ agentId, files: files.length, bytes, oldestAt: oldestMs ? new Date(oldestMs).toISOString() : undefined, newestAt: newestMs ? new Date(newestMs).toISOString() : undefined });
  }
  agents.sort((a, b) => b.bytes - a.bytes || a.agentId.localeCompare(b.agentId));
  return { agents, files: agents.reduce((total, agent) => total + agent.files, 0), bytes: agents.reduce((total, agent) => total + agent.bytes, 0) };
}

/**
 * 扫描 workspace 根目录下所有 agent workspace 的 logs/ 目录，
 * 删除超过 retentionDays 天的 .jsonl 日志文件。
 */
export async function cleanupAgentLogs(
  workspaceRootDir: string,
  retentionDays: number,
): Promise<{ cleaned: string[]; errors: Array<{ file: string; error: string }> }> {
  const cleaned: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let workspaceDirs: string[];
  try {
    const entries = await fs.readdir(workspaceRootDir, { withFileTypes: true });
    workspaceDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(workspaceRootDir, e.name));
  } catch {
    // Workspace root doesn't exist yet — nothing to clean.
    return { cleaned, errors };
  }

  for (const wsDir of workspaceDirs) {
    const logsDir = path.join(wsDir, "logs");
    let logFiles: string[];
    try {
      const entries = await fs.readdir(logsDir);
      logFiles = entries.filter((f) => f.endsWith(".jsonl"));
    } catch {
      // No logs/ directory in this workspace — skip.
      continue;
    }

    for (const file of logFiles) {
      const filePath = path.join(logsDir, file);
      try {
        // Extract date from filename: <agentId>-YYYY-MM-DD.jsonl
        const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (dateMatch) {
          const fileDate = new Date(dateMatch[1]).getTime();
          if (!Number.isNaN(fileDate) && fileDate < cutoff) {
            await fs.unlink(filePath);
            cleaned.push(filePath);
          }
        } else {
          // Fallback: use file mtime
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(filePath);
            cleaned.push(filePath);
          }
        }
      } catch (e) {
        errors.push({
          file: filePath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return { cleaned, errors };
}
