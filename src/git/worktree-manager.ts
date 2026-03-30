import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { AgentInstanceSpec, ResolvedConfig } from "../types";
import { logger } from "../utils/logger";
import type { WorkspaceProvider, WorkspaceResult } from "../sandbox/interface";
import { t } from "../i18n/i18n";

export class WorktreeWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly config: ResolvedConfig) {}

  /** 若 project.repo 下无 .git，则 git init（先创建 main）并做空提交；若 project.base_branch 为 master 则将分支重命名为 master。 */
  private async ensureGitRepository(repoRoot: string): Promise<void> {
    const gitDir = path.join(repoRoot, ".git");
    const hasGit = await fs
      .access(gitDir)
      .then(() => true)
      .catch(() => false);
    if (hasGit) return;

    const baseBranch = this.config.project.base_branch;
    logger.info(t("git_repo_auto_initialized"), { repo: repoRoot, branch: baseBranch });

    const git = simpleGit(repoRoot);
    await git.raw(["init", "-b", "main"]);
    await git.raw([
      "-c",
      "user.name=open-agent-team",
      "-c",
      "user.email=open-agent-team@localhost",
      "commit",
      "--allow-empty",
      "-m",
      "chore: initial commit",
    ]);
    if (baseBranch !== "main") {
      await git.raw(["branch", "-m", "main", baseBranch]);
    }
  }

  async ensureWorkspace(spec: AgentInstanceSpec, sparsePaths: string[]): Promise<WorkspaceResult> {
    const root = this.config.workspace.root_dir;
    const workspacePath = path.join(root, spec.id);
    await fs.mkdir(root, { recursive: true });

    const repoRoot = path.resolve(this.config.project.repo);
    await this.ensureGitRepository(repoRoot);
    const git = simpleGit(repoRoot);

    const exists = await fs
      .access(workspacePath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      // 目录已被删但 git 仍登记该 worktree 时，add 会报 “missing but already registered”；先 prune 再 add
      await git.raw(["worktree", "prune"]).catch(() => undefined);
      // 如果分支已存在则不使用 -b，避免创建失败
      const branchExists = await git
        .raw(["show-ref", "--verify", `refs/heads/${spec.branch}`])
        .then(
          () => true,
          () => false,
        );
      if (branchExists) {
        await git.raw(["worktree", "add", workspacePath, spec.branch]);
      } else {
        await git.raw(["worktree", "add", workspacePath, "-b", spec.branch]);
      }
    }

    if (this.config.workspace.sparse_checkout.enabled && sparsePaths.length > 0) {
      const workspaceGit = simpleGit(workspacePath);
      await workspaceGit.raw(["sparse-checkout", "init", "--cone"]);
      await workspaceGit.raw(["sparse-checkout", "set", ...sparsePaths]);
    }

    if (this.config.workspace.git.lfs === "pull") {
      await simpleGit(workspacePath).raw(["lfs", "pull"]).catch(() => {
        logger.warn(t("git_lfs_pull_failed"), { agentId: spec.id });
      });
    }

    return { path: workspacePath, branch: spec.branch };
  }

  async removeWorkspace(spec: AgentInstanceSpec): Promise<void> {
    const workspacePath = path.join(this.config.workspace.root_dir, spec.id);
    const repoRoot = path.resolve(this.config.project.repo);
    const git = simpleGit(repoRoot);
    await git.raw(["worktree", "remove", "--force", workspacePath]).catch(() => undefined);
    await fs.rm(workspacePath, { force: true, recursive: true }).catch(() => undefined);
  }
}
