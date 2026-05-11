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
  await git.addConfig("user.name", name, false, "local");
  await git.addConfig("user.email", email, false, "local");
}

/**
 * 对 workspace 执行 git add -A && git commit。
 * 如果没有待提交的变更则跳过（不报错）。
 */
export async function commitWorkspaceChanges(
  workspacePath: string,
  message: string,
): Promise<boolean> {
  const git = simpleGit(workspacePath);
  // 暂存所有变更
  await git.add("-A");
  // 检查是否有变更需要提交
  const status = await git.status();
  if (status.staged.length === 0) {
    logger.debug("commitWorkspaceChanges: nothing to commit", { workspacePath });
    return false;
  }
  await git.commit(message);
  logger.info("commitWorkspaceChanges: committed", { workspacePath, message });
  return true;
}
