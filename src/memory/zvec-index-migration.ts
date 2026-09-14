import { randomUUID } from "node:crypto";
import { setImmediate as yieldImmediate, setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingProvider } from "./embedding-provider";
import { MemoryIndexWorker } from "./memory-index-worker";
import type { MemoryIndexMigrationRecord, MemoryIndexValidationSnapshot, MemoryRepository } from "./memory-repository";
import { ZvecIndexManifestSchema, type ZvecIndexManifest, type ZvecIndexState } from "./zvec-index-identity";
import {
  ActiveIndexPointerSchema,
  readActiveIndexPointer,
  readZvecIndexManifest,
  readZvecIndexRegistry,
  replaceZvecIndexRegistryEntry,
  writeActiveIndexPointer,
  writeZvecIndexManifest,
  writeZvecIndexRegistry,
  ZvecIndexRegistrySchema,
  type ZvecIndexLayout,
  type ZvecIndexRegistry,
  type ZvecIndexRegistryEntry,
} from "./zvec-index-registry";
import { ZvecMemoryIndex, type ZvecMemoryIndexWorkerHost } from "./zvec-memory-index";
import type { ZvecMemoryIndexStats } from "./zvec-memory-index-contract";

type QueueItem<T> = {
  projectId: string;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class MemoryIndexRebuildQueue {
  private active = 0;
  private readonly activeProjects = new Set<string>();
  private readonly pending: Array<QueueItem<unknown>> = [];

  constructor(readonly concurrency = 1) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Rebuild queue concurrency must be a positive integer.");
  }

  enqueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    if (this.activeProjects.has(projectId) || this.pending.some((item) => item.projectId === projectId)) {
      return Promise.reject(new Error(`Project '${projectId}' already has a queued or active index rebuild.`));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ projectId, task, resolve: resolve as (value: unknown) => void, reject });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length) {
      const item = this.pending.shift()!;
      this.active += 1;
      this.activeProjects.add(item.projectId);
      void (async () => {
        try {
          await yieldImmediate();
          item.resolve(await item.task());
        } catch (error) { item.reject(error); }
        finally {
          this.active -= 1;
          this.activeProjects.delete(item.projectId);
          this.drain();
        }
      })();
    }
  }
}

/**
 * Cross-process lease used by Desktop projects, whose orchestrators run in
 * separate processes. The in-process queue remains responsible for fairness;
 * this lease prevents two processes from performing expensive rebuild work at
 * the same time. A live PID is never pre-empted, even when a rebuild is slow.
 */
export class MemoryIndexRebuildLease {
  constructor(
    readonly lockFile: string,
    private readonly pollMs = 250,
    private readonly staleMs = 24 * 60 * 60 * 1_000,
  ) {}

  async run<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const nonce = randomUUID();
    await fs.mkdir(path.dirname(this.lockFile), { recursive: true });
    while (!await this.tryAcquire(projectId, nonce)) await delay(this.pollMs);
    try { return await task(); }
    finally { await this.release(nonce); }
  }

  private async tryAcquire(projectId: string, nonce: string): Promise<boolean> {
    try {
      const handle = await fs.open(this.lockFile, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, projectId, nonce, acquiredAt: new Date().toISOString() }));
        await handle.sync();
      } finally { await handle.close(); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await this.removeStaleLease();
      return false;
    }
  }

  private async removeStaleLease(): Promise<void> {
    try {
      const [raw, stat] = await Promise.all([fs.readFile(this.lockFile, "utf8"), fs.stat(this.lockFile)]);
      const value = JSON.parse(raw) as { pid?: unknown };
      const pid = typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : undefined;
      if (pid) {
        if (processAlive(pid)) return;
        await fs.rm(this.lockFile, { force: true });
        return;
      }
      if (Date.now() - stat.mtimeMs < this.staleMs) return;
      await fs.rm(this.lockFile, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      if (error instanceof SyntaxError) {
        const stat = await fs.stat(this.lockFile).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs >= this.staleMs) await fs.rm(this.lockFile, { force: true });
      }
    }
  }

  private async release(nonce: string): Promise<void> {
    try {
      const value = JSON.parse(await fs.readFile(this.lockFile, "utf8")) as { nonce?: unknown };
      if (value.nonce === nonce) await fs.rm(this.lockFile, { force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

let globalRebuildQueue: MemoryIndexRebuildQueue | undefined;
export function sharedMemoryIndexRebuildQueue(): MemoryIndexRebuildQueue {
  globalRebuildQueue ??= new MemoryIndexRebuildQueue(1);
  return globalRebuildQueue;
}

export type MemoryIndexMigrationValidation = {
  repository: MemoryIndexValidationSnapshot;
  index: ZvecMemoryIndexStats;
  sampledDocuments: number;
};

export type MemoryIndexRebuildEstimate = {
  itemCount: number;
  embeddingRequests: number;
  estimatedEmbeddingTokens: number;
  rawVectorBytes: number;
  sqliteBytes: number;
  retainedCollectionBytes: number;
  estimatedNewCollectionBytes: number;
  temporaryOverheadBytes: number;
  safetyFactor: number;
  minimumPeakBytes: number;
  excludesIndexAmplification: false;
};

export type MemoryIndexMigrationResult = {
  collectionRevision: string;
  status: MemoryIndexMigrationRecord["status"] | "already_active";
  migration?: MemoryIndexMigrationRecord;
  validation?: MemoryIndexMigrationValidation;
};

export type MemoryIndexMigrationManagerOptions = {
  projectId: string;
  repository: MemoryRepository;
  layout: ZvecIndexLayout;
  workerHost?: ZvecMemoryIndexWorkerHost;
  queue?: MemoryIndexRebuildQueue;
  /** Optional global cross-process lease. M14/M15 Desktop operations provide it. */
  rebuildLease?: MemoryIndexRebuildLease;
  batchSize?: number;
  maxDrainBatches?: number;
  sampleSize?: number;
  now?: () => Date;
};

function lifecycleManifest(manifest: ZvecIndexManifest, state: ZvecIndexState, at: string, documentCount = manifest.documentCount): ZvecIndexManifest {
  return ZvecIndexManifestSchema.parse({
    ...manifest,
    state,
    documentCount,
    readyAt: state === "building" || state === "failed" ? null : manifest.readyAt ?? at,
    lastRebuildAt: state === "ready" ? at : manifest.lastRebuildAt,
  });
}

function lifecycleEntry(entry: ZvecIndexRegistryEntry, state: ZvecIndexState, at: string, documentCount = entry.documentCount, snapshotWatermark = entry.snapshotWatermark): ZvecIndexRegistryEntry {
  return {
    ...entry,
    state,
    snapshotWatermark,
    documentCount,
    readyAt: state === "building" || state === "failed" ? null : entry.readyAt ?? at,
    activatedAt: state === "active" || state === "retired" ? entry.activatedAt ?? at : null,
    retiredAt: state === "retired" ? at : null,
  };
}

export class MemoryIndexMigrationManager {
  private readonly queue: MemoryIndexRebuildQueue;
  private readonly batchSize: number;
  private readonly maxDrainBatches: number;
  private readonly sampleSize: number;
  private readonly now: () => Date;

  constructor(private readonly options: MemoryIndexMigrationManagerOptions) {
    if (options.layout.projectId !== options.projectId) throw new Error("Migration layout and project do not match.");
    this.queue = options.queue ?? sharedMemoryIndexRebuildQueue();
    this.batchSize = Math.min(500, Math.max(1, options.batchSize ?? 64));
    this.maxDrainBatches = Math.max(1, options.maxDrainBatches ?? 10_000);
    this.sampleSize = Math.min(100, Math.max(1, options.sampleSize ?? 20));
    this.now = options.now ?? (() => new Date());
  }

  async estimate(manifestInput: ZvecIndexManifest): Promise<MemoryIndexRebuildEstimate> {
    const manifest = ZvecIndexManifestSchema.parse(manifestInput);
    if (manifest.projectId !== this.options.projectId) throw new Error("Migration manifest belongs to another project.");
    const workload = this.options.repository.indexRebuildWorkload();
    const retainedCollectionBytes = await directoryBytes(this.options.layout.collectionsDirectory);
    const rawVectorBytes = workload.itemCount * manifest.embedding.dimensions * 4;
    // SQLite content is a conservative proxy for FTS/scalar payload. Vector
    // indexes and transient compaction can exceed their raw vector size, so M15
    // reserves 2x the projected new collection plus 25% temporary overhead.
    const estimatedNewCollectionBytes = Math.max(1, workload.sqliteBytes + rawVectorBytes * 2);
    const temporaryOverheadBytes = Math.ceil(estimatedNewCollectionBytes * 0.25);
    return {
      itemCount: workload.itemCount,
      embeddingRequests: Math.ceil(workload.itemCount / this.batchSize),
      estimatedEmbeddingTokens: Math.ceil(workload.searchableCharacters / 4),
      rawVectorBytes,
      sqliteBytes: workload.sqliteBytes,
      retainedCollectionBytes,
      estimatedNewCollectionBytes,
      temporaryOverheadBytes,
      safetyFactor: 1.25,
      minimumPeakBytes: workload.sqliteBytes + retainedCollectionBytes + estimatedNewCollectionBytes + temporaryOverheadBytes,
      excludesIndexAmplification: false,
    };
  }

  rebuild(manifestInput: ZvecIndexManifest, provider: EmbeddingProvider): Promise<MemoryIndexMigrationResult> {
    const manifest = this.assertTarget(manifestInput, provider);
    return this.enqueue(async () => {
      const pointer = await readActiveIndexPointer(this.options.layout, this.options.projectId);
      let registry = await readZvecIndexRegistry(this.options.layout, this.options.projectId);
      const targetPath = this.options.layout.collectionDirectory(manifest.collectionRevision);
      const targetExists = await fs.stat(targetPath).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
      if (pointer?.collectionRevision === manifest.collectionRevision && targetExists) {
        const persisted = await readZvecIndexManifest(this.options.layout, this.options.projectId, manifest.collectionRevision);
        if (persisted?.state === "active") return { collectionRevision: manifest.collectionRevision, status: "already_active" };
      }
      const competing = Object.values(registry.collections).find((entry) => entry.state === "building" && entry.collectionRevision !== manifest.collectionRevision);
      if (competing) throw new Error(`Project already has building collection '${competing.collectionRevision}'.`);

      let index: ZvecMemoryIndex;
      const existingEntry = registry.collections[manifest.collectionRevision];
      if (!targetExists && existingEntry) {
        const at = this.timestamp();
        const buildingEntry = lifecycleEntry(existingEntry, "building", at, 0, null);
        await writeZvecIndexRegistry(this.options.layout, this.options.projectId, replaceZvecIndexRegistryEntry(registry, buildingEntry, at));
        this.registerSqlite(buildingEntry);
        this.options.repository.updateIndexTargetState(manifest.collectionRevision, "building", { documentCount: 0 });
        this.options.repository.resetIndexRevisionData(manifest.collectionRevision);
        this.options.repository.prepareIndexMigration(manifest.collectionRevision, pointer?.collectionRevision, at);
        const repairManifest = ZvecIndexManifestSchema.parse({ ...manifest, state: "building", documentCount: 0, createdAt: existingEntry.createdAt, readyAt: null, lastRebuildAt: null });
        index = await ZvecMemoryIndex.create({ layout: this.options.layout, manifest: repairManifest, workerHost: this.options.workerHost });
        registry = await readZvecIndexRegistry(this.options.layout, this.options.projectId);
      } else if (!existingEntry) {
        index = await ZvecMemoryIndex.create({ layout: this.options.layout, manifest, workerHost: this.options.workerHost });
        registry = await readZvecIndexRegistry(this.options.layout, this.options.projectId);
      } else {
        const persisted = await this.requiredManifest(manifest.collectionRevision);
        const migration = this.options.repository.getIndexMigration(manifest.collectionRevision);
        if (migration?.status === "paused") return { collectionRevision: manifest.collectionRevision, status: "paused", migration };
        index = await ZvecMemoryIndex.open({ layout: this.options.layout, manifest: persisted, workerHost: this.options.workerHost });
      }
      try {
        const entry = registry.collections[manifest.collectionRevision]!;
        this.registerSqlite(entry);
        const existing = this.options.repository.getIndexMigration(manifest.collectionRevision);
        const migration = existing ?? this.options.repository.prepareIndexMigration(manifest.collectionRevision, pointer?.collectionRevision, this.timestamp());
        if (migration.status === "failed" || migration.status === "retired") {
          throw new Error(`Migration '${manifest.collectionRevision}' must be explicitly resumed or rolled back.`);
        }
        return await this.drainAndReady(index, provider);
      } finally { await index.close(); }
    });
  }

  resume(collectionRevision: string, provider: EmbeddingProvider): Promise<MemoryIndexMigrationResult> {
    return this.enqueue(async () => {
      let manifest = this.assertTarget(await this.requiredManifest(collectionRevision), provider);
      const migration = this.options.repository.getIndexMigration(collectionRevision);
      if (!migration) throw new Error(`Unknown index migration '${collectionRevision}'.`);
      if (manifest.state === "failed") {
        const registry = await readZvecIndexRegistry(this.options.layout, this.options.projectId);
        const entry = registry.collections[collectionRevision];
        if (!entry || entry.state !== "failed") throw new Error("Failed manifest and registry states do not match.");
        const at = this.timestamp();
        manifest = lifecycleManifest(manifest, "building", at, entry.documentCount);
        await writeZvecIndexManifest(this.options.layout, this.options.projectId, manifest);
        await writeZvecIndexRegistry(this.options.layout, this.options.projectId,
          replaceZvecIndexRegistryEntry(registry, lifecycleEntry(entry, "building", at, entry.documentCount, entry.snapshotWatermark), at));
        this.options.repository.updateIndexTargetState(collectionRevision, "building", { documentCount: entry.documentCount });
      }
      this.options.repository.retryIndexDeadLetters(collectionRevision, this.timestamp());
      this.options.repository.setIndexMigrationStatus(collectionRevision, "backfilling", { updatedAt: this.timestamp() });
      const index = await ZvecMemoryIndex.open({ layout: this.options.layout, manifest, workerHost: this.options.workerHost });
      try {
        this.options.repository.reconcileIndexRevision(collectionRevision, this.timestamp());
        return await this.drainAndReady(index, provider);
      } finally { await index.close(); }
    });
  }

  pause(collectionRevision: string, reason = "Paused by user"): MemoryIndexMigrationRecord {
    return this.options.repository.setIndexMigrationStatus(collectionRevision, "paused", { pauseReason: reason, updatedAt: this.timestamp() });
  }

  activate(collectionRevision: string, provider: EmbeddingProvider): Promise<MemoryIndexMigrationResult> {
    return this.enqueue(async () => {
      let manifest = this.assertTarget(await this.requiredManifest(collectionRevision), provider);
      const migration = this.options.repository.getIndexMigration(collectionRevision);
      if (!migration || (migration.status !== "ready" && migration.status !== "backfilling")) {
        throw new Error(`Migration '${collectionRevision}' is not ready for activation.`);
      }
      this.options.repository.setIndexMigrationStatus(collectionRevision, "backfilling", { updatedAt: this.timestamp() });
      const index = await ZvecMemoryIndex.open({ layout: this.options.layout, manifest, workerHost: this.options.workerHost });
      let result: MemoryIndexMigrationResult;
      try {
        this.options.repository.reconcileIndexRevision(collectionRevision, this.timestamp());
        result = await this.drainAndReady(index, provider);
      } finally { await index.close(); }
      if (result.status !== "ready") return result;

      manifest = await this.requiredManifest(collectionRevision);
      const activatedAt = this.timestamp();
      await writeActiveIndexPointer(this.options.layout, this.options.projectId, ActiveIndexPointerSchema.parse({
        formatVersion: 1,
        projectId: this.options.projectId,
        collectionRevision,
        activatedAt,
      }));
      await this.finalizePointer(activatedAt);
      return {
        ...result,
        status: "active",
        migration: this.options.repository.getIndexMigration(collectionRevision),
      };
    });
  }

  rollback(collectionRevision: string, provider: EmbeddingProvider): Promise<MemoryIndexMigrationResult> {
    return this.enqueue(async () => {
      const manifest = this.assertTarget(await this.requiredManifest(collectionRevision), provider);
      const registry = await readZvecIndexRegistry(this.options.layout, this.options.projectId);
      const entry = registry.collections[collectionRevision];
      if (!entry || entry.state !== "retired") throw new Error("Rollback target must be a retained retired collection.");
      const at = this.timestamp();
      const buildingManifest = lifecycleManifest(manifest, "building", at, entry.documentCount);
      const buildingEntry = lifecycleEntry(entry, "building", at, entry.documentCount, entry.snapshotWatermark);
      await writeZvecIndexManifest(this.options.layout, this.options.projectId, buildingManifest);
      await writeZvecIndexRegistry(this.options.layout, this.options.projectId, replaceZvecIndexRegistryEntry(registry, buildingEntry, at));
      this.options.repository.updateIndexTargetState(collectionRevision, "building", { documentCount: entry.documentCount });
      this.options.repository.setIndexMigrationStatus(collectionRevision, "backfilling", { updatedAt: at });
      this.options.repository.retryIndexDeadLetters(collectionRevision, at);
      const index = await ZvecMemoryIndex.open({ layout: this.options.layout, manifest: buildingManifest, workerHost: this.options.workerHost });
      let ready: MemoryIndexMigrationResult;
      try {
        this.options.repository.reconcileIndexRevision(collectionRevision, at);
        ready = await this.drainAndReady(index, provider);
      } finally { await index.close(); }
      if (ready.status !== "ready") return ready;
      return this.activateUnlocked(collectionRevision, provider, ready);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(this.options.projectId, () => this.options.rebuildLease
      ? this.options.rebuildLease.run(this.options.projectId, task)
      : task());
  }

  async recoverActivation(): Promise<string | undefined> {
    const pointer = await readActiveIndexPointer(this.options.layout, this.options.projectId);
    if (!pointer) return undefined;
    const registry = await readZvecIndexRegistry(this.options.layout, this.options.projectId);
    const pointed = registry.collections[pointer.collectionRevision];
    const active = Object.values(registry.collections).filter((entry) => entry.state === "active");
    if (!pointed) throw new Error("Active pointer references an unknown collection.");
    if (pointed.state !== "active" || active.some((entry) => entry.collectionRevision !== pointer.collectionRevision)) {
      await this.finalizePointer(pointer.activatedAt);
    } else {
      this.registerSqlite(pointed);
      this.options.repository.updateIndexTargetState(pointed.collectionRevision, "active", { documentCount: pointed.documentCount, readyAt: pointed.readyAt ?? undefined, activatedAt: pointer.activatedAt });
    }
    return pointer.collectionRevision;
  }

  async cleanupRetired(manifestInput: ZvecIndexManifest, retentionMs: number): Promise<void> {
    const manifest = ZvecIndexManifestSchema.parse(manifestInput);
    if (manifest.projectId !== this.options.projectId) throw new Error("Cleanup manifest belongs to another project.");
    await ZvecMemoryIndex.destroyRetired({ layout: this.options.layout, manifest, workerHost: this.options.workerHost, retentionMs, now: this.timestamp() });
    this.options.repository.removeIndexTarget(manifest.collectionRevision);
  }

  private async activateUnlocked(collectionRevision: string, provider: EmbeddingProvider, ready: MemoryIndexMigrationResult): Promise<MemoryIndexMigrationResult> {
    this.assertTarget(await this.requiredManifest(collectionRevision), provider);
    const activatedAt = this.timestamp();
    await writeActiveIndexPointer(this.options.layout, this.options.projectId, ActiveIndexPointerSchema.parse({
      formatVersion: 1, projectId: this.options.projectId, collectionRevision, activatedAt,
    }));
    await this.finalizePointer(activatedAt);
    return { ...ready, status: "active", migration: this.options.repository.getIndexMigration(collectionRevision) };
  }

  private async drainAndReady(index: ZvecMemoryIndex, provider: EmbeddingProvider): Promise<MemoryIndexMigrationResult> {
    this.options.repository.reconcileIndexRevision(index.collectionRevision, this.timestamp());
    const worker = new MemoryIndexWorker({
      repository: this.options.repository,
      index,
      embeddingProvider: provider,
      batchSize: this.batchSize,
      workerId: `migration-${index.collectionRevision}`,
      now: this.now,
    });
    for (let batch = 0; batch < this.maxDrainBatches; batch += 1) {
      const current = this.options.repository.getIndexMigration(index.collectionRevision);
      if (current?.status === "paused") {
        return { collectionRevision: index.collectionRevision, status: "paused", migration: current };
      }
      // Reconcile at every batch boundary. Canonical writes can arrive while an
      // embedding request is in flight; a one-time pre-drain reconciliation
      // would otherwise miss (or leave future-scheduled) that catch-up work.
      this.options.repository.reconcileIndexRevision(index.collectionRevision, this.timestamp());
      const run = await worker.runOnce();
      if (!run.claimed) break;
      await yieldImmediate();
    }
    const snapshot = this.options.repository.indexRevisionValidation(index.collectionRevision, this.sampleSize);
    if (snapshot.deadLetters) {
      const balance = snapshot.errors.some((error) => /insufficient_balance|\b402\b|Insufficient Balance/i.test(error));
      const status = balance ? "paused" : "failed";
      const reason = balance ? "Embedding provider balance is insufficient (402)." : undefined;
      const migration = this.options.repository.setIndexMigrationStatus(index.collectionRevision, status, {
        pauseReason: reason,
        error: balance ? undefined : snapshot.errors.join("; ").slice(0, 800),
        updatedAt: this.timestamp(),
      });
      if (!balance) await this.persistLifecycle(index.collectionRevision, "failed", snapshot.indexedCount, migration.snapshotWatermark);
      return { collectionRevision: index.collectionRevision, status, migration };
    }
    if (snapshot.pendingOutbox || snapshot.processingOutbox || snapshot.missingIds.length || snapshot.mismatchedIds.length || snapshot.staleIds.length) {
      const migration = this.options.repository.setIndexMigrationStatus(index.collectionRevision, "backfilling", { updatedAt: this.timestamp() });
      return { collectionRevision: index.collectionRevision, status: "backfilling", migration };
    }
    this.options.repository.setIndexMigrationStatus(index.collectionRevision, "validating", { updatedAt: this.timestamp() });
    let validation: MemoryIndexMigrationValidation;
    try {
      await index.optimize();
      validation = await this.validate(index, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const at = this.timestamp();
      const migration = this.options.repository.setIndexMigrationStatus(index.collectionRevision, "failed", { error: message.slice(0, 800), updatedAt: at });
      await this.persistLifecycle(index.collectionRevision, "failed", snapshot.indexedCount, migration.snapshotWatermark, at);
      return { collectionRevision: index.collectionRevision, status: "failed", migration };
    }
    const at = this.timestamp();
    await this.persistLifecycle(index.collectionRevision, "ready", validation.index.documentCount, this.options.repository.getIndexMigration(index.collectionRevision)!.snapshotWatermark, at);
    this.options.repository.updateIndexTargetState(index.collectionRevision, "ready", { documentCount: validation.index.documentCount, readyAt: at });
    const migration = this.options.repository.setIndexMigrationStatus(index.collectionRevision, "ready", { updatedAt: at, completedAt: at });
    return { collectionRevision: index.collectionRevision, status: "ready", migration, validation };
  }

  private async validate(index: ZvecMemoryIndex, snapshot: MemoryIndexValidationSnapshot): Promise<MemoryIndexMigrationValidation> {
    const stats = await index.stats();
    if (stats.documentCount !== snapshot.expectedCount) throw new Error(`Zvec document count ${stats.documentCount} does not match expected ${snapshot.expectedCount}.`);
    const documents = await index.fetchMetadata(snapshot.sample.map(({ id }) => id));
    const byId = new Map(documents.map((document) => [document.id, document]));
    for (const expected of snapshot.sample) {
      const actual = byId.get(expected.id);
      if (!actual) throw new Error(`Validation sample '${expected.id}' is missing from Zvec.`);
      if (actual.contentHash !== expected.contentHash) throw new Error(`Validation sample '${expected.id}' has a stale content hash.`);
      if (actual.vectorDimensions !== index.schema.vector.dimensions) throw new Error(`Validation sample '${expected.id}' has the wrong vector dimension.`);
    }
    const completeness = stats.indexCompleteness.dense_embedding;
    if (completeness !== undefined && completeness < 0.999) throw new Error(`Zvec index completeness is ${completeness}.`);
    return { repository: snapshot, index: stats, sampledDocuments: documents.length };
  }

  private async persistLifecycle(collectionRevision: string, state: ZvecIndexState, count: number, watermark: string | null, at = this.timestamp()): Promise<void> {
    const registry = await readZvecIndexRegistry(this.options.layout, this.options.projectId);
    const entry = registry.collections[collectionRevision];
    if (!entry) throw new Error(`Unknown file registry collection '${collectionRevision}'.`);
    const manifest = await this.requiredManifest(collectionRevision);
    await writeZvecIndexManifest(this.options.layout, this.options.projectId, lifecycleManifest(manifest, state, at, count));
    await writeZvecIndexRegistry(this.options.layout, this.options.projectId,
      replaceZvecIndexRegistryEntry(registry, lifecycleEntry(entry, state, at, count, watermark), at));
  }

  private async finalizePointer(activatedAt: string): Promise<void> {
    const pointer = await readActiveIndexPointer(this.options.layout, this.options.projectId);
    if (!pointer) throw new Error("Cannot finalize activation without an active pointer.");
    const registry = await readZvecIndexRegistry(this.options.layout, this.options.projectId);
    const target = registry.collections[pointer.collectionRevision];
    if (!target || (target.state !== "ready" && target.state !== "active")) throw new Error("Active pointer target is not ready.");
    const collections: ZvecIndexRegistry["collections"] = { ...registry.collections };
    for (const entry of Object.values(registry.collections)) {
      const nextState: ZvecIndexState = entry.collectionRevision === pointer.collectionRevision
        ? "active" : entry.state === "active" ? "retired" : entry.state;
      if (nextState === entry.state && nextState !== "active") continue;
      const nextEntry = lifecycleEntry(entry, nextState, activatedAt, entry.documentCount, entry.snapshotWatermark);
      collections[entry.collectionRevision] = nextEntry;
      const manifest = await this.requiredManifest(entry.collectionRevision);
      await writeZvecIndexManifest(this.options.layout, this.options.projectId, lifecycleManifest(manifest, nextState, activatedAt, entry.documentCount));
    }
    const finalRegistry = ZvecIndexRegistrySchema.parse({ ...registry, collections, updatedAt: activatedAt });
    await writeZvecIndexRegistry(this.options.layout, this.options.projectId, finalRegistry);
    for (const entry of Object.values(finalRegistry.collections)) {
      this.registerSqlite(entry);
      if (entry.state === "active") {
        this.options.repository.updateIndexTargetState(entry.collectionRevision, "active", { documentCount: entry.documentCount, readyAt: entry.readyAt ?? undefined, activatedAt });
        const migration = this.options.repository.getIndexMigration(entry.collectionRevision);
        if (migration) this.options.repository.setIndexMigrationStatus(entry.collectionRevision, "active", { updatedAt: activatedAt, completedAt: activatedAt });
      } else if (entry.state === "retired") {
        this.options.repository.updateIndexTargetState(entry.collectionRevision, "retired", { documentCount: entry.documentCount, readyAt: entry.readyAt ?? undefined, activatedAt: entry.activatedAt ?? activatedAt, retiredAt: activatedAt });
        const migration = this.options.repository.getIndexMigration(entry.collectionRevision);
        if (migration) this.options.repository.setIndexMigrationStatus(entry.collectionRevision, "retired", { updatedAt: activatedAt, completedAt: activatedAt });
      }
    }
  }

  private registerSqlite(entry: ZvecIndexRegistryEntry): void {
    this.options.repository.registerIndexTarget({
      collectionRevision: entry.collectionRevision,
      projectId: this.options.projectId,
      embeddingRevision: entry.embeddingRevision,
      state: entry.state,
      path: entry.path,
      snapshotWatermark: entry.snapshotWatermark ?? undefined,
      documentCount: entry.documentCount,
      createdAt: entry.createdAt,
      readyAt: entry.readyAt ?? undefined,
      activatedAt: entry.activatedAt ?? undefined,
      retiredAt: entry.retiredAt ?? undefined,
    });
  }

  private assertTarget(manifestInput: ZvecIndexManifest, provider: EmbeddingProvider): ZvecIndexManifest {
    const manifest = ZvecIndexManifestSchema.parse(manifestInput);
    if (manifest.projectId !== this.options.projectId) throw new Error("Migration manifest belongs to another project.");
    if (!provider.available || provider.identity.revision !== manifest.embeddingRevision) throw new Error("Migration embedding provider does not match the frozen target identity.");
    if (provider.identity.dimensions !== manifest.embedding.dimensions) throw new Error("Migration embedding dimensions do not match the target schema.");
    return manifest;
  }

  private async requiredManifest(collectionRevision: string): Promise<ZvecIndexManifest> {
    const manifest = await readZvecIndexManifest(this.options.layout, this.options.projectId, collectionRevision);
    if (!manifest) throw new Error(`Missing manifest for collection '${collectionRevision}'.`);
    return manifest;
  }

  private timestamp(): string { return this.now().toISOString(); }
}

async function directoryBytes(directory: string): Promise<number> {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) {
      try { total += (await fs.stat(target)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return total;
}
