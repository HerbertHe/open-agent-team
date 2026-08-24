import fs from "node:fs/promises";
import path from "node:path";
import type { GitTaskArtifact, ReleaseProposal, ReviewRequest } from "../types";

/**
 * Keeps orchestration artefacts out of Git worktrees. The JSON documents are
 * deliberately human-readable so an interrupted local run can be inspected or
 * resumed without relying on an Agent transcript.
 */
export class GitCollaborationStore {
  readonly root: string;
  private readonly tasksDir: string;
  private readonly reviewsDir: string;
  private readonly releasesDir: string;
  private readonly worktreesDir: string;
  private readonly schedulerStatePath: string;

  constructor(stateDir: string) {
    this.root = path.join(stateDir, "git-collaboration");
    this.tasksDir = path.join(this.root, "tasks");
    this.reviewsDir = path.join(this.root, "reviews");
    this.releasesDir = path.join(this.root, "releases");
    this.worktreesDir = path.join(this.root, "worktrees");
    this.schedulerStatePath = path.join(this.root, "scheduler-state.json");
  }

  async init(): Promise<void> {
    await Promise.all([this.tasksDir, this.reviewsDir, this.releasesDir, this.worktreesDir]
      .map((dir) => fs.mkdir(dir, { recursive: true })));
  }

  workerWorkspace(taskId: string, attempt: number): string {
    return path.join(this.worktreesDir, "worker", taskId, `attempt-${attempt}`);
  }

  leaderWorkspace(teamName: string, taskId: string): string {
    return path.join(this.worktreesDir, "leader", teamName, taskId);
  }

  releaseWorkspace(proposalId: string): string {
    return path.join(this.worktreesDir, "release", proposalId);
  }

  taskArtifactPath(taskId: string): string {
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  async saveArtifact(artifact: GitTaskArtifact): Promise<string> {
    const target = this.taskArtifactPath(artifact.taskId);
    await this.writeJson(target, artifact);
    return target;
  }

  async saveReview(review: ReviewRequest): Promise<string> {
    const target = path.join(this.reviewsDir, `${review.id}.json`);
    await this.writeJson(target, review);
    return target;
  }

  async loadReview(id: string): Promise<ReviewRequest> {
    return this.readJson<ReviewRequest>(path.join(this.reviewsDir, `${id}.json`));
  }

  async listReviews(leaderId?: string): Promise<ReviewRequest[]> {
    return (await this.listJson<ReviewRequest>(this.reviewsDir))
      .filter((review) => !leaderId || review.leaderId === leaderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveRelease(proposal: ReleaseProposal): Promise<string> {
    const target = path.join(this.releasesDir, `${proposal.id}.json`);
    await this.writeJson(target, proposal);
    return target;
  }

  async loadRelease(id: string): Promise<ReleaseProposal> {
    return this.readJson<ReleaseProposal>(path.join(this.releasesDir, `${id}.json`));
  }

  async listReleases(): Promise<ReleaseProposal[]> {
    return (await this.listJson<ReleaseProposal>(this.releasesDir))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveSchedulerState(state: unknown): Promise<void> {
    await this.writeJson(this.schedulerStatePath, state);
  }

  async loadSchedulerState<T>(): Promise<T | undefined> {
    try {
      return await this.readJson<T>(this.schedulerStatePath);
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) {
        const quarantine = `${this.schedulerStatePath}.corrupt-${Date.now()}`;
        await fs.rename(this.schedulerStatePath, quarantine).catch(() => undefined);
        return undefined;
      }
      throw error;
    }
  }

  async quarantineSchedulerState(): Promise<string | undefined> {
    const quarantine = `${this.schedulerStatePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.schedulerStatePath, quarantine);
      return quarantine;
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeJson(target: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
  }

  private async readJson<T>(target: string): Promise<T> {
    return JSON.parse(await fs.readFile(target, "utf8")) as T;
  }

  private async listJson<T>(dir: string): Promise<T[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.readJson<T>(path.join(dir, entry.name))));
  }
}
