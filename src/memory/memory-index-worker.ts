import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "./embedding-provider";
import { EmbeddingProviderError } from "./embedding-provider";
import type { MemoryIndexOutboxItem, MemoryRepository } from "./memory-repository";
import type { ZvecMemoryDocument, ZvecWriteStatus } from "./zvec-memory-index-contract";

export interface MemoryVectorIndexWriter {
  readonly collectionRevision: string;
  readonly embeddingRevision: string;
  upsert(documents: ZvecMemoryDocument[]): Promise<ZvecWriteStatus[]>;
  delete(ids: string[]): Promise<ZvecWriteStatus[]>;
  verifyDurability(ids: string[]): Promise<string[]>;
}

export type MemoryIndexWorkerOptions = {
  repository: MemoryRepository;
  index: MemoryVectorIndexWriter;
  embeddingProvider: EmbeddingProvider;
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => Date;
};

export type MemoryIndexWorkerRun = {
  claimed: number;
  indexed: number;
  deleted: number;
  retried: number;
  deadLettered: number;
  lostLeases: number;
};

function epoch(value: string | undefined, fallback: string): number {
  const parsed = Date.parse(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : Date.parse(fallback);
}

function projection(item: MemoryIndexOutboxItem, vector: number[]): ZvecMemoryDocument {
  const memory = item.memory;
  const content = memory.summary === memory.content ? memory.content : `${memory.summary}\n${memory.content}`;
  return {
    id: memory.id,
    vector,
    fields: {
      content,
      project_id: memory.projectId,
      owner_agent_id: memory.agentId,
      team_id: memory.teamId ?? null,
      scope: memory.scope,
      level: memory.level,
      kind: memory.kind,
      status: memory.status,
      trust_level: memory.trustLevel,
      valid_from_ms: epoch(memory.validFrom, memory.createdAt),
      valid_to_ms: memory.validTo ? epoch(memory.validTo, memory.updatedAt) : null,
      updated_at_ms: epoch(memory.updatedAt, memory.createdAt),
      salience: memory.salience,
      confidence: memory.confidence,
      content_hash: item.contentHash,
    },
  };
}

function errorInfo(error: unknown): { message: string; retryable: boolean; retryAfterMs?: number } {
  if (error instanceof EmbeddingProviderError) {
    return { message: `${error.code}: ${error.message}`, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
  }
  const value = error as Error & { code?: string };
  const nonRetryable = value?.code === "OAT_ZVEC_DIMENSION_MISMATCH" || value?.code === "OAT_ZVEC_READ_ONLY";
  return { message: error instanceof Error ? error.message : String(error), retryable: !nonRetryable };
}

function statusError(status: ZvecWriteStatus): Error {
  return new Error(`Zvec write failed${status.code === undefined ? "" : ` (${status.code})`}: ${status.message ?? "unknown status"}`);
}

export class MemoryIndexWorker {
  readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(private readonly options: MemoryIndexWorkerOptions) {
    this.workerId = options.workerId ?? `memory-index-${randomUUID()}`;
    this.batchSize = Math.min(500, Math.max(1, Math.floor(options.batchSize ?? 64)));
    this.leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
    this.now = options.now ?? (() => new Date());
    if (!options.embeddingProvider.available) throw new EmbeddingProviderError("The memory index worker requires an available embedding provider.", "disabled", false);
    if (options.embeddingProvider.identity.revision === "disabled") throw new EmbeddingProviderError("The memory index worker cannot use a disabled embedding identity.", "disabled", false);
    if (options.embeddingProvider.identity.revision !== options.index.embeddingRevision) {
      throw new EmbeddingProviderError("The memory index worker embedding identity does not match the target collection.", "invalid_config", false);
    }
  }

  async runOnce(): Promise<MemoryIndexWorkerRun> {
    const report: MemoryIndexWorkerRun = { claimed: 0, indexed: 0, deleted: 0, retried: 0, deadLettered: 0, lostLeases: 0 };
    const startedAt = this.now();
    const items = this.options.repository.claimIndexOutbox({
      workerId: this.workerId,
      collectionRevision: this.options.index.collectionRevision,
      limit: this.batchSize,
      now: startedAt.toISOString(),
      leaseMs: this.leaseMs,
    });
    report.claimed = items.length;
    if (!items.length) return report;

    const upserts = items.filter((item) => item.operation === "upsert");
    const deletes = items.filter((item) => item.operation === "delete");
    if (upserts.length) await this.processUpserts(upserts, report);
    if (deletes.length) await this.processDeletes(deletes, report);
    return report;
  }

  private async processUpserts(items: MemoryIndexOutboxItem[], report: MemoryIndexWorkerRun): Promise<void> {
    try {
      const vectors = await this.options.embeddingProvider.embedDocuments(items.map((item) => {
        const memory = item.memory;
        return memory.summary === memory.content ? memory.content : `${memory.summary}\n${memory.content}`;
      }));
      if (vectors.length !== items.length) throw new Error("Embedding provider returned an unexpected number of vectors.");
      const statuses = await this.options.index.upsert(items.map((item, index) => projection(item, vectors[index]!)));
      const successful = statuses.filter(({ ok }) => ok).map(({ id }) => id);
      const durable = new Set(await this.options.index.verifyDurability(successful));
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        const status = statuses[index];
        if (status?.ok && durable.has(item.memoryId)) this.complete(item, "indexed", report);
        else this.fail(item, status?.ok ? new Error("Document was missing after close/reopen durability verification.") : statusError(status ?? { id: item.memoryId, ok: false }), report);
      }
    } catch (error) {
      for (const item of items) this.fail(item, error, report);
    }
  }

  private async processDeletes(items: MemoryIndexOutboxItem[], report: MemoryIndexWorkerRun): Promise<void> {
    try {
      const statuses = await this.options.index.delete(items.map(({ memoryId }) => memoryId));
      const successful = statuses.filter(({ ok }) => ok).map(({ id }) => id);
      const stillPresent = new Set(await this.options.index.verifyDurability(successful));
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        const status = statuses[index];
        if (status?.ok && !stillPresent.has(item.memoryId)) this.complete(item, "deleted", report);
        else this.fail(item, status?.ok ? new Error("Document remained after close/reopen delete verification.") : statusError(status ?? { id: item.memoryId, ok: false }), report);
      }
    } catch (error) {
      for (const item of items) this.fail(item, error, report);
    }
  }

  private complete(item: MemoryIndexOutboxItem, operation: "indexed" | "deleted", report: MemoryIndexWorkerRun): void {
    if (!this.options.repository.completeIndexOutbox(item.id, this.workerId, this.now().toISOString())) {
      report.lostLeases += 1;
      return;
    }
    report[operation] += 1;
  }

  private fail(item: MemoryIndexOutboxItem, error: unknown, report: MemoryIndexWorkerRun): void {
    const info = errorInfo(error);
    const delay = info.retryAfterMs ?? Math.min(300_000, 1_000 * 2 ** Math.max(0, item.attempts - 1));
    const failedAt = this.now();
    const result = this.options.repository.failIndexOutbox(item.id, this.workerId, {
      error: info.message,
      retryable: info.retryable,
      retryAt: new Date(failedAt.getTime() + delay).toISOString(),
      maxAttempts: this.maxAttempts,
    }, failedAt.toISOString());
    if (result === "retry") report.retried += 1;
    else if (result === "dead_letter") report.deadLettered += 1;
    else report.lostLeases += 1;
  }
}
