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
 * 通用路径：相对路径相对于 team.json 所在目录；`~/` 展开为真实 $HOME；已是绝对路径则规范化。
 * （用于 project.repo 等仍可能指向 home 外任意目录的配置。）
 */
export function resolvePathFromTeamRoot(teamJsonAbs: string, p: string): string {
  const baseDir = path.dirname(teamJsonAbs);
  const homeExpanded = expandHomePath(p);
  if (path.isAbsolute(homeExpanded)) return path.resolve(homeExpanded);
  return path.resolve(baseDir, homeExpanded);
}

/**
 * 仅用于 `runtime.persistence.state_dir` 与 `workspace.root_dir`：
 * 必须落在 team.json 所在目录下，**不**使用用户主目录。
 * - 相对路径、`~/xxx` 均相对于 team 根目录解析（此处 `~` 仅作「从 team 根起算」的写法，不表示 $HOME）。
 * - 若配置成 $HOME 下的绝对路径，则改为 team 根下相同相对后缀（例如曾写 `~/.oat/state` 会得到 `<team>/.oat/state`）。
 * - 已在 team 根下的绝对路径保持不变；其它绝对路径则归一到 `<team>/<basename>`，避免指到盘符任意位置。
 */
export function resolveTeamDataPath(teamJsonAbs: string, p: string): string {
  const base = teamRootDir(teamJsonAbs);
  const t = p.trim();
  if (t.startsWith("~/")) {
    return path.resolve(base, t.slice(2));
  }
  const home = os.homedir();
  if (path.isAbsolute(t) && (t === home || t.startsWith(home + path.sep))) {
    const suffix = t === home ? "" : t.slice(home.length + 1);
    return path.resolve(base, suffix || ".");
  }
  if (path.isAbsolute(t)) {
    const normalized = path.resolve(t);
    if (normalized === base || normalized.startsWith(base + path.sep)) {
      return normalized;
    }
    return path.resolve(base, path.basename(t));
  }
  return path.resolve(base, t);
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
