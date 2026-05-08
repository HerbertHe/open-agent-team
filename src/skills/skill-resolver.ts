import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { SkillEntry } from "../types/team";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);

/**
 * 使用 `npx skills add` 将 skill 安装到指定 workspace。
 *
 * 安装路径：`<workspace>/skills/`（通过 `-a openclaw` 实现，openclaw 的 project path 恰好是 `skills/`）
 * 兼容路径：创建 `.pi/skills` → `skills` 符号链接，供 pi-coding-agent 的 DefaultResourceLoader 扫描。
 */
export class SkillResolver {
  /**
   * 将一组 SkillEntry 安装到指定 workspace。
   * 对每个 entry 调用一次 `npx skills add`。
   */
  async installSkillsToWorkspace(
    entries: SkillEntry[],
    workspacePath: string,
  ): Promise<void> {
    if (entries.length === 0) return;

    // Ensure the skills directory exists
    const skillsDir = path.join(workspacePath, "skills");
    await fs.mkdir(skillsDir, { recursive: true });

    for (const entry of entries) {
      await this.runSkillsAdd(entry, workspacePath);
    }

    // Create .pi/skills → skills symlink for pi-coding-agent compatibility
    await this.ensurePiSkillsSymlink(workspacePath);
  }

  /**
   * 执行 `npx -y skills add <source> [--skill ...] -a openclaw --copy -y`
   */
  private async runSkillsAdd(
    entry: SkillEntry,
    cwd: string,
  ): Promise<void> {
    const args = ["-y", "skills", "add", entry.source];

    // Add skill name filters
    const names = entry.names ?? [];
    if (names.length === 0 || (names.length === 1 && names[0] === "*")) {
      // Install all skills from the source
      args.push("--skill", "*");
    } else {
      for (const name of names) {
        args.push("--skill", name);
      }
    }

    // Target the openclaw agent (project path = skills/)
    args.push("-a", "openclaw", "--copy", "-y");

    logger.info(`Installing skills: npx ${args.join(" ")}`, { cwd });

    try {
      const { stdout, stderr } = await execFileAsync("npx", args, {
        cwd,
        timeout: 120_000, // 2 minutes per source
        env: { ...process.env, DISABLE_TELEMETRY: "1" },
      });
      if (stdout) logger.info(stdout.trim());
      if (stderr) logger.info(stderr.trim());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to install skills from "${entry.source}": ${msg}`);
      throw err;
    }
  }

  /**
   * 创建 `.pi/skills` → `skills` 符号链接。
   * pi-coding-agent 的 DefaultResourceLoader 会从 `<cwd>/.pi/skills/` 读取 skills。
   */
  private async ensurePiSkillsSymlink(workspacePath: string): Promise<void> {
    const piDir = path.join(workspacePath, ".pi");
    const piSkillsLink = path.join(piDir, "skills");
    const target = path.join(workspacePath, "skills");

    await fs.mkdir(piDir, { recursive: true });

    // Remove existing symlink or directory if present
    try {
      const stat = await fs.lstat(piSkillsLink);
      if (stat.isSymbolicLink()) {
        const existingTarget = await fs.readlink(piSkillsLink);
        if (path.resolve(piDir, existingTarget) === target) {
          return; // Already correct
        }
        await fs.unlink(piSkillsLink);
      } else {
        // Not a symlink — remove (could be a leftover dir)
        await fs.rm(piSkillsLink, { recursive: true, force: true });
      }
    } catch {
      // Does not exist — fine
    }

    // Create relative symlink: .pi/skills → ../skills
    await fs.symlink(path.relative(piDir, target), piSkillsLink);
  }
}
