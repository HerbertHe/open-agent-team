import { simpleGit } from "simple-git";

export class MergeManager {
  /**
   * per-workspace 串行锁：同一个 repoPath 上的 merge 操作必须排队执行。
   * 多个 Worker 几乎同时 notify-complete 时，并发 git checkout/merge 会导致仓库状态损坏。
   * 使用 Promise 链实现无锁串行队列：每次操作链接在上一次之后，无论上一次成功或失败都继续执行。
   */
  private readonly workspaceLocks = new Map<string, Promise<void>>();

  private withLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.workspaceLocks.get(repoPath) ?? Promise.resolve();
    // 无论 prev 成功或失败，都继续执行 fn（不短路后续操作）
    const next = prev.then(() => fn(), () => fn());
    // 存储为 void promise，下一次操作链接在此之后
    this.workspaceLocks.set(repoPath, next.then(() => {}, () => {}));
    return next;
  }

  async mergeBranch(repoPath: string, fromBranch: string, toBranch: string): Promise<void> {
    return this.withLock(repoPath, async () => {
      const git = simpleGit(repoPath);
      await git.checkout(toBranch);
      await git.merge(["--no-ff", fromBranch]);
    });
  }

  async mergeToMain(repoPath: string, fromBranch: string, mainBranch: string): Promise<void> {
    await this.mergeBranch(repoPath, fromBranch, mainBranch);
  }
}
