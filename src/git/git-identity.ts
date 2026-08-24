import { simpleGit } from "simple-git";
import { logger } from "../utils/logger";

/**
 * 为 workspace 设置本地 git 身份（user.name / user.email），仅 --local 作用域。
 */
export async function setLocalGitIdentity(
  workspacePath: string,
  name: string,
  email: string,
): Promise<void> {
  const git = simpleGit(workspacePath);
  // Linked worktrees otherwise share the repository's local config and race
  // on user.name/user.email. Enable Git's worktree-local config before writing
  // identity so every Agent keeps a stable author.
  await git.raw(["config", "extensions.worktreeConfig", "true"]);
  await git.raw(["config", "--worktree", "user.name", name]);
  await git.raw(["config", "--worktree", "user.email", email]);
}

/**
 * Add a defensive per-worktree push boundary. This prevents accidental pushes
 * by Agent Git commands. Remote publication is deliberately executed from the
 * main repository by the Admin-only orchestrator tool instead of a worktree.
 */
export async function setWorktreePushPermission(
  workspacePath: string,
  remote: string | undefined,
  allowed: boolean,
  remoteUrl?: string,
): Promise<void> {
  const git = simpleGit(workspacePath);
  await git.raw(["config", "extensions.worktreeConfig", "true"]);
  if (allowed) {
    if (!remote) return;
    const key = `remote.${remote}.pushurl`;
    if (remoteUrl) await git.raw(["config", "--worktree", key, remoteUrl]);
    else await git.raw(["config", "--worktree", "--unset-all", key]).catch(() => undefined);
  } else {
    // Block every repository remote, not only the one selected for release.
    // Local-only mode may still have historical remotes in .git/config.
    const remotes = await git.getRemotes();
    const names = new Set(remotes.map((entry) => entry.name));
    if (remote) names.add(remote);
    await Promise.all(Array.from(names, (name) => git.raw([
      "config", "--worktree", `remote.${name}.pushurl`, "oat-admin-only://push-disabled",
    ])));
  }
}

/**
 * Commit only files reported by Git instead of `git add -A`. Runtime artefacts
 * must live outside a task worktree; this defensive path list prevents an
 * accidental parent-directory sweep from becoming a production commit.
 */
export async function commitWorkspaceChanges(
  workspacePath: string,
  message: string,
): Promise<boolean> {
  const git = simpleGit(workspacePath);
  const before = await git.status();
  const paths = Array.from(new Set(before.files.map((file) => file.path)));
  if (paths.length === 0) {
    logger.info("commitWorkspaceChanges: nothing to commit", { workspacePath });
    return false;
  }
  await git.add(paths);
  const status = await git.status();
  if (status.staged.length === 0) return false;
  await git.commit(message);
  logger.info("commitWorkspaceChanges: committed", { workspacePath, message });
  return true;
}
