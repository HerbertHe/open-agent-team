import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { BaseBranchEnum } from "../types";
import type { AgentInstanceSpec, ResolvedConfig } from "../types";
import { logger } from "../utils/logger";
import type { WorkspaceProvider, WorkspaceResult } from "../sandbox/interface";
import { t } from "../i18n/i18n";
import { setWorktreePushPermission } from "./git-identity";

export class WorktreeWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly config: ResolvedConfig) {}

  private async ensureGitRepository(repoRoot: string): Promise<void> {
    // 自动将 .oat 目录加入 .gitignore，防止嵌套 git 仓库导致冲突
    const gitignorePath = path.join(repoRoot, ".gitignore");
    try {
      const gitignoreContent = await fs.readFile(gitignorePath, "utf8");
      if (!gitignoreContent.split("\n").some(line => line.trim() === ".oat" || line.trim() === ".oat/")) {
        await fs.appendFile(gitignorePath, "\n# oat local state\n.oat/\n");
      }
    } catch {
      await fs.writeFile(gitignorePath, "# oat local state\n.oat/\n", "utf8");
    }

    const gitDir = path.join(repoRoot, ".git");
    const hasGit = await fs
      .access(gitDir)
      .then(() => true)
      .catch(() => false);

    const baseBranch = this.config.project.base_branch;

    if (!hasGit) {
      logger.info(t("git_repo_auto_initialized"), { repo: repoRoot, branch: baseBranch });
      const git = simpleGit(repoRoot);
      await git.raw(["init", "-b", BaseBranchEnum.Main]);
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
      if (baseBranch !== BaseBranchEnum.Main) {
        await git.raw(["branch", "-m", BaseBranchEnum.Main, baseBranch]);
      }
      return;
    }

    const git = simpleGit(repoRoot);
    const hasCommits = await git.raw(["rev-parse", "HEAD"]).then(() => true).catch(() => false);
    if (!hasCommits) {
      logger.info(t("git_repo_auto_initialized"), { repo: repoRoot, branch: baseBranch });
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
      const currentBranch = await git.raw(["branch", "--show-current"]).then(s => s.trim()).catch(() => "");
      if (currentBranch && currentBranch !== baseBranch) {
        await git.raw(["branch", "-m", currentBranch, baseBranch]);
      }
    }
  }

  async ensureWorkspace(spec: AgentInstanceSpec, sparsePaths: string[]): Promise<WorkspaceResult> {
    // Task worktrees live below the orchestrator state directory, not inside
    // the repository or a long-lived worker pool. `workspacePath` is therefore
    // supplied by the task lifecycle and may differ for every attempt.
    const workspacePath = path.resolve(spec.workspacePath);
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });

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
        await git.raw(["worktree", "add", "--force", workspacePath, spec.branch]);
      } else {
        await git.raw(["worktree", "add", workspacePath, "-b", spec.branch, spec.baseRef ?? this.config.project.base_branch]);
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
      // Only attempt lfs pull if the repo actually tracks LFS files
      const hasLfs = await simpleGit(workspacePath).raw(["lfs", "ls-files", "--all"])
        .then((out) => out.trim().length > 0)
        .catch(() => false);

      if (hasLfs) {
        await simpleGit(workspacePath).raw(["lfs", "pull"]).catch(() => {
          logger.warn(t("git_lfs_pull_failed"), { agentId: spec.id });
        });
      }
      
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

    await setWorktreePushPermission(
      workspacePath,
      this.config.workspace.git.remote,
      false,
      this.config.workspace.git.remote_url,
    );

    return { path: workspacePath, branch: spec.branch };
  }
}
