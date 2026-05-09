import fs from "node:fs/promises";
import path from "node:path";

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
