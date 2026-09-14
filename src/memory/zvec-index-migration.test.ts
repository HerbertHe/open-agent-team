import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { DeterministicFakeEmbeddingProvider, EmbeddingProviderError, type EmbeddingProvider } from "./embedding-provider";
import { SqliteMemoryRepository } from "./memory-repository";
import { createZvecIndexManifest, type ZvecIndexManifest } from "./zvec-index-identity";
import {
  ActiveIndexPointerSchema,
  createZvecIndexLayout,
  readActiveIndexPointer,
  readZvecIndexRegistry,
  writeActiveIndexPointer,
} from "./zvec-index-registry";
import { MemoryIndexMigrationManager, MemoryIndexRebuildLease, MemoryIndexRebuildQueue } from "./zvec-index-migration";
import { ZvecMemoryIndexWorkerHost } from "./zvec-memory-index";

function databasePath(root: string): string {
  const value = path.join(root, "memory", "memory.db");
  mkdirSync(path.dirname(value), { recursive: true });
  return value;
}

function addMemory(repository: SqliteMemoryRepository, content: string, at: string): string {
  repository.capture({
    id: `event-${createHash("sha256").update(`${content}\0${at}`).digest("hex").slice(0, 16)}`,
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
  }, 50);
  repository.consolidate({ maxEvents: 50, minEvidence: 100, retentionDays: 180, l1MaxItems: 50, l1TtlHours: 100_000, isCancelled: () => false });
  return repository.list({ level: "L2" }).find((memory) => memory.content === content)!.id;
}

function target(projectId: string, revision: string, model: string, dimensions = 4): { manifest: ZvecIndexManifest; provider: DeterministicFakeEmbeddingProvider } {
  const catalog = parseGlobalModelCatalog({
    embeddingProfiles: { memory: { kind: "deterministic-fake", model, dimensions, revision, normalization: "l2" } },
  });
  const profile = catalog.embeddingProfiles.memory!;
  if (profile.kind !== "deterministic-fake") throw new Error("Expected deterministic test profile.");
  return {
    provider: new DeterministicFakeEmbeddingProvider(profile),
    manifest: createZvecIndexManifest({ projectId, profileName: "memory", profile, metric: "cosine", index: "flat", createdAt: "2026-09-08T00:00:00.000Z" }),
  };
}

test("M07-A globally queues low-priority rebuilds and rejects duplicate project work", async () => {
  const queue = new MemoryIndexRebuildQueue(1);
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.enqueue("project-a", async () => { order.push("a:start"); await gate; order.push("a:end"); });
  const second = queue.enqueue("project-b", async () => { order.push("b:start"); order.push("b:end"); });
  await assert.rejects(() => queue.enqueue("project-a", async () => undefined), /already has a queued or active/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["a:start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("M15 serializes rebuild work across independent process queues", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m15-rebuild-lease-"));
  const lockFile = path.join(root, "locks", "memory-index-rebuild.lock");
  const first = new MemoryIndexRebuildLease(lockFile, 5, 100);
  const second = new MemoryIndexRebuildLease(lockFile, 5, 100);
  let active = 0;
  let maximum = 0;
  const work = async () => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
  };
  try {
    await Promise.all([first.run("project-a", work), second.run("project-b", work)]);
    assert.equal(maximum, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M07-A/M07-B rebuild, catch up, atomically activate, rollback, recover deletion and safely clean retired indexes", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m07-lifecycle-"));
  const projectId = "migration-project";
  const repository = new SqliteMemoryRepository(projectId, databasePath(root));
  const layout = createZvecIndexLayout(path.join(root, "indexes"), projectId);
  const host = new ZvecMemoryIndexWorkerHost();
  let clock = new Date("2026-09-09T00:00:00.000Z");
  const manager = new MemoryIndexMigrationManager({ projectId, repository, layout, workerHost: host, queue: new MemoryIndexRebuildQueue(1), now: () => clock, batchSize: 1 });
  context.after(async () => { await host.dispose(); repository.close(); rmSync(root, { recursive: true, force: true }); });

  const firstId = addMemory(repository, "memory before first index", "2026-09-08T01:00:00.000Z");
  const old = target(projectId, "1", "embedding-old");
  const estimate = await manager.estimate(old.manifest);
  assert.equal(estimate.itemCount, 1);
  assert.equal(estimate.embeddingRequests, 1);
  assert.equal(estimate.rawVectorBytes, 16);
  assert.equal(estimate.excludesIndexAmplification, false);
  assert.equal(estimate.estimatedNewCollectionBytes >= estimate.rawVectorBytes * 2, true);
  assert.equal(estimate.minimumPeakBytes, estimate.sqliteBytes + estimate.retainedCollectionBytes + estimate.estimatedNewCollectionBytes + estimate.temporaryOverheadBytes);
  assert.equal((await manager.rebuild(old.manifest, old.provider)).status, "ready");
  assert.equal((await manager.activate(old.manifest.collectionRevision, old.provider)).status, "active");
  assert.equal((await readActiveIndexPointer(layout, projectId))?.collectionRevision, old.manifest.collectionRevision);

  const next = target(projectId, "2", "embedding-new");
  let injected = false;
  let secondId = "";
  const catchupProvider: EmbeddingProvider = {
    available: true,
    identity: next.provider.identity,
    embedQuery: (text) => next.provider.embedQuery(text),
    embedDocuments: async (texts) => {
      if (!injected) {
        injected = true;
        secondId = addMemory(repository, "memory written after snapshot watermark", "2026-09-08T02:00:00.000Z");
      }
      return next.provider.embedDocuments(texts);
    },
  };
  clock = new Date("2026-09-09T01:00:00.000Z");
  const built = await manager.rebuild(next.manifest, catchupProvider);
  assert.equal(built.status, "ready", JSON.stringify(repository.indexRevisionValidation(next.manifest.collectionRevision)));
  assert.equal(built.validation?.repository.expectedCount, 2);
  assert.equal(built.validation?.index.documentCount, 2);
  assert.equal(repository.listIndexMemberships(secondId).find(({ collectionRevision }) => collectionRevision === next.manifest.collectionRevision)?.status, "indexed");
  assert.equal(repository.listIndexMemberships(secondId).find(({ collectionRevision }) => collectionRevision === old.manifest.collectionRevision)?.status, "pending");

  clock = new Date("2026-09-09T02:00:00.000Z");
  assert.equal((await manager.activate(next.manifest.collectionRevision, next.provider)).status, "active");
  let registry = await readZvecIndexRegistry(layout, projectId);
  assert.equal(registry.collections[next.manifest.collectionRevision]?.state, "active");
  assert.equal(registry.collections[old.manifest.collectionRevision]?.state, "retired");
  assert.equal(repository.indexRevisionValidation(next.manifest.collectionRevision).pendingOutbox, 0);

  clock = new Date("2026-09-09T03:00:00.000Z");
  assert.equal((await manager.rollback(old.manifest.collectionRevision, old.provider)).status, "active");
  assert.equal((await readActiveIndexPointer(layout, projectId))?.collectionRevision, old.manifest.collectionRevision);
  assert.equal(repository.indexRevisionValidation(old.manifest.collectionRevision).expectedCount, 2);
  assert.equal(repository.indexRevisionValidation(old.manifest.collectionRevision).indexedCount, 2);

  rmSync(layout.collectionDirectory(old.manifest.collectionRevision), { recursive: true, force: true });
  clock = new Date("2026-09-09T04:00:00.000Z");
  assert.equal((await manager.rebuild(old.manifest, old.provider)).status, "ready");
  assert.equal((await manager.activate(old.manifest.collectionRevision, old.provider)).status, "active");
  assert.equal(repository.indexRevisionValidation(old.manifest.collectionRevision).indexedCount, 2);
  assert.ok(repository.listIndexMemberships(firstId).some(({ collectionRevision, status }) => collectionRevision === old.manifest.collectionRevision && status === "indexed"));

  registry = await readZvecIndexRegistry(layout, projectId);
  assert.equal(registry.collections[next.manifest.collectionRevision]?.state, "retired");
  clock = new Date("2026-09-10T00:00:00.000Z");
  await manager.cleanupRetired(next.manifest, 0);
  registry = await readZvecIndexRegistry(layout, projectId);
  assert.equal(registry.collections[next.manifest.collectionRevision], undefined);
  assert.equal(repository.listIndexTargets().some(({ collectionRevision }) => collectionRevision === next.manifest.collectionRevision), false);
});

test("M07-B pauses on 402, resumes explicitly, and recovers a pointer-committed activation", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m07-recovery-"));
  const projectId = "recovery-project";
  const repository = new SqliteMemoryRepository(projectId, databasePath(root));
  const layout = createZvecIndexLayout(path.join(root, "indexes"), projectId);
  const host = new ZvecMemoryIndexWorkerHost();
  let clock = new Date("2026-09-09T00:00:00.000Z");
  const manager = new MemoryIndexMigrationManager({ projectId, repository, layout, workerHost: host, queue: new MemoryIndexRebuildQueue(1), now: () => clock });
  context.after(async () => { await host.dispose(); repository.close(); rmSync(root, { recursive: true, force: true }); });
  addMemory(repository, "pause-safe memory", "2026-09-08T01:00:00.000Z");

  const old = target(projectId, "1", "old");
  await manager.rebuild(old.manifest, old.provider);
  await manager.activate(old.manifest.collectionRevision, old.provider);
  const next = target(projectId, "2", "new");
  const insufficient: EmbeddingProvider = {
    available: true,
    identity: next.provider.identity,
    embedDocuments: async () => { throw new EmbeddingProviderError("Insufficient Balance", "insufficient_balance", false, 402); },
    embedQuery: async () => { throw new EmbeddingProviderError("Insufficient Balance", "insufficient_balance", false, 402); },
  };
  clock = new Date("2026-09-09T01:00:00.000Z");
  const paused = await manager.rebuild(next.manifest, insufficient);
  assert.equal(paused.status, "paused");
  assert.match(paused.migration?.pauseReason ?? "", /402/);
  assert.equal((await readActiveIndexPointer(layout, projectId))?.collectionRevision, old.manifest.collectionRevision);

  clock = new Date("2026-09-09T02:00:00.000Z");
  assert.equal((await manager.resume(next.manifest.collectionRevision, next.provider)).status, "ready");
  await writeActiveIndexPointer(layout, projectId, ActiveIndexPointerSchema.parse({
    formatVersion: 1, projectId, collectionRevision: next.manifest.collectionRevision, activatedAt: clock.toISOString(),
  }));
  const restarted = new MemoryIndexMigrationManager({ projectId, repository, layout, workerHost: host, queue: new MemoryIndexRebuildQueue(1), now: () => clock });
  assert.equal(await restarted.recoverActivation(), next.manifest.collectionRevision);
  const registry = await readZvecIndexRegistry(layout, projectId);
  assert.equal(registry.collections[next.manifest.collectionRevision]?.state, "active");
  assert.equal(registry.collections[old.manifest.collectionRevision]?.state, "retired");

  const third = target(projectId, "3", "third");
  const invalid: EmbeddingProvider = {
    available: true,
    identity: third.provider.identity,
    embedDocuments: async () => { throw new EmbeddingProviderError("invalid provider response", "invalid_response", false); },
    embedQuery: async () => { throw new EmbeddingProviderError("invalid provider response", "invalid_response", false); },
  };
  clock = new Date("2026-09-09T03:00:00.000Z");
  assert.equal((await manager.rebuild(third.manifest, invalid)).status, "failed");
  clock = new Date("2026-09-09T04:00:00.000Z");
  assert.equal((await manager.resume(third.manifest.collectionRevision, third.provider)).status, "ready");
});
