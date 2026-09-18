import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SkillEntry } from "../types/team";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);
const SKILL_CACHE_VERSION = 1;
const SKILL_MANIFEST = path.join(".oat", "skills-manifest.json");

type SkillsCommandRunner = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout?: string; stderr?: string }>;

type SkillManifest = {
  version: number;
  fingerprint: string;
  installedSkills: string[];
  updatedAt: string;
};

type ResolvedSkillEntry = {
  entry: SkillEntry;
  localPath?: string;
  localDigest?: string;
};

/**
 * 使用 `npx skills add` 将 skill 安装到指定 workspace。
 *
 * 安装路径：`<workspace>/skills/`（通过 `-a openclaw` 实现，openclaw 的 project path 恰好是 `skills/`）
 * 兼容路径：创建 `.pi/skills` → `skills` 符号链接，供 pi-coding-agent 的 DefaultResourceLoader 扫描。
 */
export class SkillResolver {
  constructor(private readonly commandRunner: SkillsCommandRunner = execFileAsync) {}

  /**
   * 将一组 SkillEntry 同步到指定 workspace。
   * 本地源直接复制或原地复用；远程源仅在缓存未命中时调用 `npx skills add`。
   */
  async installSkillsToWorkspace(
    entries: SkillEntry[],
    workspacePath: string,
  ): Promise<void> {
    if (entries.length === 0) return;

    const skillsDir = path.join(workspacePath, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    const resolvedEntries = await Promise.all(entries.map((entry) => this.resolveEntry(entry, workspacePath)));
    const fingerprint = this.fingerprint(resolvedEntries);

    if (await this.cacheIsValid(workspacePath, skillsDir, fingerprint)) {
      logger.info("Skills cache hit; skipping installation", { workspacePath });
      await this.ensurePiSkillsSymlink(workspacePath);
      return;
    }

    for (const resolved of resolvedEntries) {
      const installedLocally = resolved.localPath
        ? await this.installLocalSkills(resolved.entry, resolved.localPath, skillsDir)
        : false;
      if (!installedLocally) await this.runSkillsAdd(resolved.entry, workspacePath);
    }

    await this.ensurePiSkillsSymlink(workspacePath);
    await this.writeManifest(workspacePath, fingerprint, await this.installedSkillNames(skillsDir));
  }

  private async resolveEntry(entry: SkillEntry, workspacePath: string): Promise<ResolvedSkillEntry> {
    const candidate = path.isAbsolute(entry.source) ? entry.source : path.resolve(workspacePath, entry.source);
    try {
      await fs.access(candidate);
      return { entry, localPath: candidate, localDigest: await this.hashLocalSource(candidate) };
    } catch {
      return { entry };
    }
  }

  private fingerprint(entries: ResolvedSkillEntry[]): string {
    const normalized = entries.map(({ entry, localPath, localDigest }) => ({
      source: entry.source,
      names: [...(entry.names ?? ["*"])].sort(),
      localPath,
      localDigest,
    }));
    return createHash("sha256").update(JSON.stringify({ version: SKILL_CACHE_VERSION, entries: normalized })).digest("hex");
  }

  private async hashLocalSource(sourcePath: string): Promise<string> {
    const hash = createHash("sha256");
    const visit = async (current: string, relativePath: string): Promise<void> => {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        hash.update(`link:${relativePath}:${await fs.readlink(current)}\n`);
        return;
      }
      if (stat.isDirectory()) {
        hash.update(`dir:${relativePath}\n`);
        const entries = (await fs.readdir(current, { withFileTypes: true }))
          .filter((entry) => ![".git", ".oat", "node_modules"].includes(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) await visit(path.join(current, entry.name), path.join(relativePath, entry.name));
        return;
      }
      hash.update(`file:${relativePath}:${stat.mode}:${stat.size}\n`);
      hash.update(await fs.readFile(current));
    };
    await visit(sourcePath, ".");
    return hash.digest("hex");
  }

  private async discoverLocalSkills(sourcePath: string): Promise<Map<string, string>> {
    const discovered = new Map<string, string>();
    if (await fs.access(path.join(sourcePath, "SKILL.md")).then(() => true).catch(() => false)) {
      discovered.set(path.basename(sourcePath), sourcePath);
      return discovered;
    }
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(sourcePath, entry.name);
      if (await fs.access(path.join(skillPath, "SKILL.md")).then(() => true).catch(() => false)) {
        discovered.set(entry.name, skillPath);
      }
    }
    return discovered;
  }

  /** Returns false when the local layout is not a direct skill collection and the CLI must handle it. */
  private async installLocalSkills(entry: SkillEntry, sourcePath: string, skillsDir: string): Promise<boolean> {
    const discovered = await this.discoverLocalSkills(sourcePath);
    if (discovered.size === 0) return false;
    const requested = entry.names ?? ["*"];
    const selected = requested.length === 0 || requested.includes("*")
      ? [...discovered.keys()]
      : requested;
    for (const name of selected) {
      const sourceSkill = discovered.get(name);
      if (!sourceSkill) throw new Error(`Local skill "${name}" was not found in ${sourcePath}`);
      const destination = path.join(skillsDir, name);
      if (path.resolve(sourceSkill) === path.resolve(destination)) continue;
      await fs.rm(destination, { recursive: true, force: true });
      await fs.cp(sourceSkill, destination, { recursive: true, force: true });
    }
    logger.info("Synchronized local skills without npx", { source: entry.source, names: selected, workspacePath: path.dirname(skillsDir) });
    return true;
  }

  private async installedSkillNames(skillsDir: string): Promise<string[]> {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await fs.access(path.join(skillsDir, entry.name, "SKILL.md")).then(() => true).catch(() => false)) names.push(entry.name);
    }
    return names.sort();
  }

  private async cacheIsValid(workspacePath: string, skillsDir: string, fingerprint: string): Promise<boolean> {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(workspacePath, SKILL_MANIFEST), "utf8")) as SkillManifest;
      if (manifest.version !== SKILL_CACHE_VERSION || manifest.fingerprint !== fingerprint || manifest.installedSkills.length === 0) return false;
      return (await this.installedSkillNames(skillsDir)).join("\0") === [...manifest.installedSkills].sort().join("\0");
    } catch {
      return false;
    }
  }

  private async writeManifest(workspacePath: string, fingerprint: string, installedSkills: string[]): Promise<void> {
    const manifestPath = path.join(workspacePath, SKILL_MANIFEST);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const temporary = `${manifestPath}.${process.pid}.tmp`;
    const manifest: SkillManifest = { version: SKILL_CACHE_VERSION, fingerprint, installedSkills, updatedAt: new Date().toISOString() };
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, manifestPath);
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
      const { stdout, stderr } = await this.commandRunner("npx", args, {
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
