import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { DeterministicFakeEmbeddingProvider, EmbeddingProviderError, type EmbeddingProvider } from "./embedding-provider";
import { MemoryIndexWorker, type MemoryVectorIndexWriter } from "./memory-index-worker";
import { SqliteMemoryRepository } from "./memory-repository";
import { createZvecIndexManifest } from "./zvec-index-identity";
import { createZvecIndexLayout } from "./zvec-index-registry";
import { ZvecMemoryIndex, ZvecMemoryIndexWorkerHost } from "./zvec-memory-index";
import type { ZvecMemoryDocument, ZvecWriteStatus } from "./zvec-memory-index-contract";

function databasePath(root: string): string {
  const value = path.join(root, "memory", "memory.db");
  mkdirSync(path.dirname(value), { recursive: true });
  return value;
}

function addMemory(repository: SqliteMemoryRepository, content: string, at: string): string {
  repository.capture({
    id: `event-${createHash("sha256").update(content).digest("hex").slice(0, 12)}`,
    ownerAgentId: "admin",
    sourceAgentId: "admin",
    role: "admin",
    trustLevel: 100,
    eventType: "report_progress",
    kind: "decision",
    content,
    metadataJson: "{}",
    createdAt: at,
    fingerprint: createHash("sha256").update(content).digest("hex"),
  }, 20);
  repository.consolidate({ maxEvents: 20, minEvidence: 50, retentionDays: 180, l1MaxItems: 20, l1TtlHours: 100_000, isCancelled: () => false });
  return repository.list({ level: "L2" }).find((item) => item.content === content)!.id;
}

function register(repository: SqliteMemoryRepository, projectId: string, revision: string, embeddingRevision = TEST_EMBEDDING_REVISION): void {
  repository.registerIndexTarget({
    collectionRevision: revision,
    projectId,
    embeddingRevision,
    state: "building",
    path: `collections/${revision}`,
    documentCount: 0,
    createdAt: "2026-09-05T00:00:00.000Z",
  });
}

class FakeIndex implements MemoryVectorIndexWriter {
  documents = new Map<string, ZvecMemoryDocument>();
  failId: string | undefined;
  constructor(readonly collectionRevision: string, readonly embeddingRevision = TEST_EMBEDDING_REVISION) {}
  async upsert(documents: ZvecMemoryDocument[]): Promise<ZvecWriteStatus[]> {
    return documents.map((document) => {
      if (document.id === this.failId) return { id: document.id, ok: false, code: "DISK_BUSY", message: "retry me" };
      this.documents.set(document.id, document);
      return { id: document.id, ok: true };
    });
  }
  async delete(ids: string[]): Promise<ZvecWriteStatus[]> {
    return ids.map((id) => { this.documents.delete(id); return { id, ok: true }; });
  }
  async verifyDurability(ids: string[]): Promise<string[]> {
    return ids.filter((id) => this.documents.has(id));
  }
}

function fakeEmbedding(dimensions = 4): DeterministicFakeEmbeddingProvider {
  return new DeterministicFakeEmbeddingProvider({ kind: "deterministic-fake", model: "test-only", dimensions, normalization: "l2", batchSize: 64, maxAttempts: 1, timeoutMs: 1_000, revision: "1" });
}

const TEST_EMBEDDING_REVISION = fakeEmbedding().identity.revision;

test("M06-A tracks old indexed and new pending memberships independently", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m06a-membership-"));
  const repository = new SqliteMemoryRepository("project-a", databasePath(root));
  try {
    register(repository, "project-a", "old-revision", "embedding-old");
    const memoryId = addMemory(repository, "Keep revision memberships separate", "2026-09-05T01:00:00.000Z");
    // Use a clock safely after the wall-clock enqueue timestamp so this fixture
    // remains deterministic when the suite is run after its original authoring date.
    const claimed = repository.claimIndexOutbox({ workerId: "seed", collectionRevision: "old-revision", limit: 10, now: "2099-09-11T02:00:00.000Z", leaseMs: 60_000 });
    assert.equal(claimed.length, 1);
    assert.equal(repository.completeIndexOutbox(claimed[0]!.id, "seed", "2026-09-05T02:00:01.000Z"), true);
    register(repository, "project-a", "new-revision", "embedding-new");
    assert.equal(repository.enqueueIndexBackfill("new-revision", "2026-09-05T03:00:00.000Z"), 1);
    assert.deepEqual(repository.listIndexMemberships(memoryId).map(({ collectionRevision, status }) => ({ collectionRevision, status })), [
      { collectionRevision: "new-revision", status: "pending" },
      { collectionRevision: "old-revision", status: "indexed" },
    ]);
  } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
});

test("M06-B retries only failed batch items and reclaims expired leases", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m06b-retry-"));
  const repository = new SqliteMemoryRepository("project-b", databasePath(root));
  try {
    register(repository, "project-b", "collection-v1");
    const first = addMemory(repository, "first memory", "2026-09-05T01:00:00.000Z");
    const second = addMemory(repository, "second memory", "2026-09-05T01:01:00.000Z");
    const index = new FakeIndex("collection-v1");
    index.failId = second;
    // Canonical writes enqueue with the repository wall clock; keep the injected
    // worker clock in the future so pending work is always claimable.
    let clock = new Date("2099-09-11T02:00:00.000Z");
    const worker = new MemoryIndexWorker({ repository, index, embeddingProvider: fakeEmbedding(), workerId: "worker-live", now: () => clock });
    assert.deepEqual(await worker.runOnce(), { claimed: 2, indexed: 1, deleted: 0, retried: 1, deadLettered: 0, lostLeases: 0 });
    assert.deepEqual(repository.listIndexMemberships().map(({ memoryId, status }) => ({ memoryId, status })).sort((a, b) => a.memoryId.localeCompare(b.memoryId)), [
      { memoryId: first, status: "indexed" }, { memoryId: second, status: "pending" },
    ].sort((a, b) => a.memoryId.localeCompare(b.memoryId)));

    index.failId = undefined;
    clock = new Date("2099-09-11T02:00:02.000Z");
    assert.equal((await worker.runOnce()).indexed, 1);

    const third = addMemory(repository, "lease recovery memory", "2026-09-05T03:00:00.000Z");
    const crashed = repository.claimIndexOutbox({ workerId: "crashed", collectionRevision: "collection-v1", limit: 1, now: "2099-09-11T03:01:00.000Z", leaseMs: 1_000 });
    assert.equal(crashed[0]?.memoryId, third);
    clock = new Date("2099-09-11T03:01:00.500Z");
    assert.equal((await worker.runOnce()).claimed, 0);
    clock = new Date("2099-09-11T03:01:02.000Z");
    assert.equal((await worker.runOnce()).indexed, 1);
  } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
});

test("M06-B dead-letters non-retryable embedding failures without throwing into agent work", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m06b-402-"));
  const repository = new SqliteMemoryRepository("project-c", databasePath(root));
  try {
    register(repository, "project-c", "collection-v1");
    const id = addMemory(repository, "embedding billing failure", "2026-09-05T01:00:00.000Z");
    const provider: EmbeddingProvider = {
      available: true,
      identity: { provider: "test", model: "test", dimensions: 4, normalization: "l2", revision: "embedding-v1" },
      embedDocuments: async () => { throw new EmbeddingProviderError("Insufficient Balance", "insufficient_balance", false, 402); },
      embedQuery: async () => { throw new EmbeddingProviderError("Insufficient Balance", "insufficient_balance", false, 402); },
    };
    const result = await new MemoryIndexWorker({ repository, index: new FakeIndex("collection-v1", "embedding-v1"), embeddingProvider: provider, workerId: "isolated" }).runOnce();
    assert.equal(result.deadLettered, 1);
    assert.equal(repository.listIndexMemberships(id)[0]?.status, "failed");
  } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
});

test("M06-B persists real Zvec upsert and delete across close/reopen durability boundaries", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m06b-zvec-"));
  const host = new ZvecMemoryIndexWorkerHost();
  const projectId = "project-real";
  const catalog = parseGlobalModelCatalog({ embeddingProfiles: { memory: { kind: "deterministic-fake", model: "test-only", dimensions: 4, revision: "1" } } });
  const profile = catalog.embeddingProfiles.memory!;
  if (profile.kind !== "deterministic-fake") throw new Error("test profile kind mismatch");
  const provider = new DeterministicFakeEmbeddingProvider(profile);
  const manifest = createZvecIndexManifest({ projectId, profileName: "memory", profile, metric: "cosine", index: "flat", createdAt: "2026-09-05T00:00:00.000Z" });
  const layout = createZvecIndexLayout(path.join(root, "indexes"), projectId);
  const repository = new SqliteMemoryRepository(projectId, databasePath(root));
  const index = await ZvecMemoryIndex.create({ layout, manifest, workerHost: host });
  context.after(async () => { await index.close(); await host.dispose(); repository.close(); rmSync(root, { recursive: true, force: true }); });
  repository.registerIndexTarget({ collectionRevision: manifest.collectionRevision, projectId, embeddingRevision: manifest.embeddingRevision, state: "building", path: layout.collectionDirectory(manifest.collectionRevision), documentCount: 0, createdAt: manifest.createdAt });
  const memoryId = addMemory(repository, "durable vector memory", "2026-09-05T01:00:00.000Z");
  const worker = new MemoryIndexWorker({ repository, index, embeddingProvider: provider, workerId: "real-zvec" });
  const writeRun = await worker.runOnce();
  assert.equal(writeRun.indexed, 1, JSON.stringify({ writeRun, membership: repository.listIndexMemberships(memoryId) }));
  assert.equal((await index.stats()).documentCount, 1);
  assert.equal(repository.listIndexMemberships(memoryId)[0]?.status, "indexed");
  assert.equal(repository.forget(memoryId, "2026-09-05T02:00:00.000Z"), true);
  assert.equal(repository.list().some(({ id }) => id === memoryId), false);
  assert.equal((await worker.runOnce()).deleted, 1);
  assert.equal((await index.stats()).documentCount, 0);
  assert.equal(repository.listIndexMemberships(memoryId)[0]?.status, "deleted");
});
