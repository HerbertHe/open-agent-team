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

    // 提取 worktree 创建逻辑（目录不存在 或 git 引用失效时均需执行）
    const createWorktree = async () => {
      await git.raw(["worktree", "prune"]).catch(() => undefined);
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
    };

    if (exists) {
      // 目录存在时验证 git 仓库引用是否有效（worktree 引用可能已被 prune 或 cleanup 清除）
      const gitValid = await simpleGit(workspacePath)
        .raw(["rev-parse", "--git-dir"])
        .then(() => true)
        .catch(() => false);
      if (!gitValid) {
        logger.warn("Workspace directory exists but git is invalid, re-creating worktree", { workspacePath, agentId: spec.id });
        await fs.rm(workspacePath, { force: true, recursive: true }).catch(() => undefined);
        await createWorktree();
      }
    } else {
      await createWorktree();
    }

    if (this.config.workspace.sparse_checkout.enabled && sparsePaths.length > 0) {
      const workspaceGit = simpleGit(workspacePath);
      await workspaceGit.raw(["sparse-checkout", "init", "--cone"]);
      await workspaceGit.raw(["sparse-checkout", "set", ...sparsePaths]);
    }

    const lfsMode = this.config.workspace.git.lfs;
    
    if (lfsMode === "pull" || lfsMode === "allow_pull_deny_change") {
      await simpleGit(workspacePath).raw(["lfs", "pull"]).catch(() => {
        logger.warn(t("git_lfs_pull_failed"), { agentId: spec.id });
      });
      
      if (lfsMode === "allow_pull_deny_change") {
        // Setup local hooks path for this worktree to prevent LFS modifications
        const hooksDir = path.join(workspacePath, ".githooks");
        await fs.mkdir(hooksDir, { recursive: true });
        
        const preCommitHook = `#!/bin/sh
# Prevent modifying LFS tracked files
git diff --cached --name-only | while read file; do
  if git check-attr filter -- "$file" | grep -q "lfs"; then
    echo "Error: modifying LFS tracked file ($file) is denied in this workspace."
    exit 1
  fi
done
`;
        const hookPath = path.join(hooksDir, "pre-commit");
        await fs.writeFile(hookPath, preCommitHook, { mode: 0o755 });
        
        const workspaceGit = simpleGit(workspacePath);
        await workspaceGit.raw(["config", "core.hooksPath", ".githooks"]);
      }
    } else if (lfsMode === "skip") {
      // Explicitly skip lfs pull
    }

    return { path: workspacePath, branch: spec.branch };
  }
}
