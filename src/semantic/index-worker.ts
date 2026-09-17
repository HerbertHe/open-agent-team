import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../memory/embedding-provider";
import type { MemoryVectorIndexWriter, MemoryIndexWorkerRun } from "../memory/memory-index-worker";
import type { MemoryRepository, SemanticIndexOutboxItem } from "../memory/memory-repository";
import type { ZvecMemoryDocument, ZvecWriteStatus } from "../memory/zvec-memory-index-contract";

export type SemanticIndexWorkerOptions = {
  repository: MemoryRepository;
  index: MemoryVectorIndexWriter;
  embeddingProvider: EmbeddingProvider;
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => Date;
};

function projection(item: SemanticIndexOutboxItem, vector: number[]): ZvecMemoryDocument {
  const document = item.document;
  const metadata = document.metadata;
  const number = (key: string, fallback: number) => typeof metadata[key] === "number" ? metadata[key] as number : fallback;
  const text = (key: string, fallback: string) => typeof metadata[key] === "string" ? metadata[key] as string : fallback;
  return {
    id: document.id,
    vector,
    fields: {
      content: document.content,
      project_id: document.projectId,
      owner_agent_id: document.ownerAgentId ?? "__knowledge__",
      team_id: document.teamId ?? null,
      scope: document.visibility,
      level: text("level", document.resourceType === "knowledge" ? "KNOWLEDGE" : "L2"),
      kind: text("kind", document.resourceType),
      status: document.status,
      trust_level: Math.floor(number("trustLevel", 100)),
      valid_from_ms: Date.parse(document.createdAt),
      valid_to_ms: null,
      updated_at_ms: Date.parse(document.updatedAt),
      salience: number("salience", 1),
      confidence: number("confidence", 1),
      content_hash: document.contentHash,
    },
  };
}

function failed(status: ZvecWriteStatus): Error {
  return new Error(status.message ?? `Zvec write failed for '${status.id}'.`);
}

export class SemanticIndexWorker {
  readonly workerId: string;
  private readonly now: () => Date;
  constructor(private readonly options: SemanticIndexWorkerOptions) {
    this.workerId = options.workerId ?? `semantic-index-${randomUUID()}`;
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<MemoryIndexWorkerRun> {
    const report: MemoryIndexWorkerRun = { claimed: 0, indexed: 0, deleted: 0, retried: 0, deadLettered: 0, lostLeases: 0 };
    const items = this.options.repository.claimSemanticIndexOutbox({
      workerId: this.workerId, collectionRevision: this.options.index.collectionRevision,
      limit: this.options.batchSize ?? 64, now: this.now().toISOString(), leaseMs: this.options.leaseMs ?? 60_000,
    });
    report.claimed = items.length;
    const upserts = items.filter((item) => item.operation === "upsert");
    const deletes = items.filter((item) => item.operation === "delete");
    if (upserts.length) {
      try {
        const vectors = await this.options.embeddingProvider.embedDocuments(upserts.map((item) => item.document.content));
        const statuses = await this.options.index.upsert(upserts.map((item, index) => projection(item, vectors[index]!)));
        for (const item of upserts) {
          const status = statuses.find(({ id }) => id === item.document.id);
          if (!status?.ok) this.fail(item, status ? failed(status) : new Error("Missing Zvec status."), report);
          else if (this.options.repository.completeSemanticIndexOutbox(item.id, this.workerId, this.now().toISOString())) report.indexed += 1;
          else report.lostLeases += 1;
        }
      } catch (error) { for (const item of upserts) this.fail(item, error, report); }
    }
    if (deletes.length) {
      try {
        const statuses = await this.options.index.delete(deletes.map((item) => item.document.id));
        for (const item of deletes) {
          const status = statuses.find(({ id }) => id === item.document.id);
          if (!status?.ok) this.fail(item, status ? failed(status) : new Error("Missing Zvec status."), report);
          else if (this.options.repository.completeSemanticIndexOutbox(item.id, this.workerId, this.now().toISOString())) report.deleted += 1;
          else report.lostLeases += 1;
        }
      } catch (error) { for (const item of deletes) this.fail(item, error, report); }
    }
    return report;
  }

  private fail(item: SemanticIndexOutboxItem, error: unknown, report: MemoryIndexWorkerRun): void {
    const dead = item.attempts >= Math.max(1, this.options.maxAttempts ?? 8);
    const now = this.now();
    const retryAt = new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** Math.max(0, item.attempts - 1))).toISOString();
    const ok = this.options.repository.failSemanticIndexOutbox(item.id, this.workerId, error instanceof Error ? error.message : String(error), retryAt, dead, now.toISOString());
    if (!ok) report.lostLeases += 1;
    else if (dead) report.deadLettered += 1;
    else report.retried += 1;
  }
}

