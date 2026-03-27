import { simpleGit } from "simple-git";

export class MergeManager {
  async mergeBranch(repoPath: string, fromBranch: string, toBranch: string): Promise<void> {
    const git = simpleGit(repoPath);
    await git.checkout(toBranch);
    await git.merge(["--no-ff", fromBranch]);
  }

  async mergeToMain(repoPath: string, fromBranch: string, mainBranch: string): Promise<void> {
    await this.mergeBranch(repoPath, fromBranch, mainBranch);
  }
}
