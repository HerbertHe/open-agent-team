import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 展开 ~/ 为家目录；其余原样返回。 */
export function expandHomePath(input: string): string {
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** 解析 team.json 绝对路径：优先环境变量 OAT_TEAM_JSON，否则为 cwd/team.json。 */
export async function resolveTeamJsonPath(teamJsonExplicit?: string): Promise<string> {
  const fromEnv = process.env.OAT_TEAM_JSON?.trim();
  const candidate = teamJsonExplicit
    ? path.isAbsolute(teamJsonExplicit)
      ? teamJsonExplicit
      : path.resolve(process.cwd(), teamJsonExplicit)
    : fromEnv
      ? path.isAbsolute(fromEnv)
        ? fromEnv
        : path.resolve(process.cwd(), fromEnv)
      : path.resolve(process.cwd(), "team.json");

  try {
    await fs.access(candidate);
  } catch {
    throw new Error(
      fromEnv && !teamJsonExplicit
        ? `team.json not found (OAT_TEAM_JSON): ${candidate}`
        : `team.json not found: ${candidate} (cd to project dir or set OAT_TEAM_JSON)`
    );
  }
  return path.resolve(candidate);
}

export function teamRootDir(teamJsonAbs: string): string {
  return path.resolve(path.dirname(teamJsonAbs));
}

/**
 * 与 loadConfig 中一致：相对路径相对于 team.json 所在目录；~/ 展开；绝对路径不变。
 */
export function resolvePathFromTeamRoot(teamJsonAbs: string, p: string): string {
  const baseDir = path.dirname(teamJsonAbs);
  const homeExpanded = expandHomePath(p);
  if (path.isAbsolute(homeExpanded)) return path.resolve(homeExpanded);
  return path.resolve(baseDir, homeExpanded);
}

function sanitizeProjectSlug(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return s.length > 0 ? s.slice(0, 96) : "project";
}

/**
 * 在 ~/.oat/projects/<name>-<hash>/ 创建指向 team 根目录（team.json 所在目录）的符号链接或 junction，
 * 便于在 home 下按项目浏览，且与真实产出目录隔离（多团队、多目录并存）。
 * 失败时不抛错，由调用方记录 warn。
 */
export async function ensureHomeProjectLink(teamJsonAbs: string, projectName: string): Promise<
  | { ok: true; linkPath: string; target: string }
  | { ok: false; reason: string }
> {
  const target = teamRootDir(teamJsonAbs);
  // 由 team 根目录绝对路径确定性哈希（非时间戳）：同一路径始终同一 slug，便于幂等更新；不同路径同名 project 可区分。
  const hash = createHash("sha256").update(target).digest("hex").slice(0, 12);
  const slug = `${sanitizeProjectSlug(projectName)}-${hash}`;
  const linkRoot = path.join(os.homedir(), ".oat", "projects");
  const linkPath = path.join(linkRoot, slug);

  try {
    await fs.mkdir(linkRoot, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      reason: `mkdir ${linkRoot}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    let st: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      st = await fs.lstat(linkPath);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw e;
    }

    if (st) {
      try {
        if ((await fs.realpath(linkPath)) === target) {
          return { ok: true, linkPath, target };
        }
      } catch {
        /* replace broken link */
      }
      if (st.isSymbolicLink()) {
        await fs.unlink(linkPath);
      } else if (st.isDirectory()) {
        try {
          await fs.readlink(linkPath);
          await fs.unlink(linkPath);
        } catch {
          return {
            ok: false,
            reason: `path exists and is a directory (not replacing): ${linkPath}`,
          };
        }
      } else {
        await fs.unlink(linkPath);
      }
    }

    if (process.platform === "win32") {
      await fs.symlink(target, linkPath, "junction");
    } else {
      await fs.symlink(target, linkPath, "dir");
    }
    return { ok: true, linkPath, target };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
