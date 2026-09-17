import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryConfig } from "../types/config";
import { loadGlobalModelCatalog, embeddingIdentityRevision, type GlobalModelCatalog } from "../models/global-models";
import { resolveEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
import { MemoryIndexWorker, type MemoryIndexWorkerRun } from "./memory-index-worker";
import { SemanticIndexWorker } from "../semantic/index-worker";
import type { MemoryRepository } from "./memory-repository";
import type { MemoryOverview, MemoryRetrievalRuntimeStatus } from "./types";
import { createZvecIndexManifest, type ZvecIndexManifest } from "./zvec-index-identity";
import { ZvecMemoryIndex, ZvecMemoryIndexWorkerHost } from "./zvec-memory-index";
import {
  createZvecIndexLayout,
  readActiveIndexPointer,
  readZvecIndexManifest,
  readZvecIndexRegistry,
  type ZvecIndexLayout,
} from "./zvec-index-registry";
import {
  MemoryIndexMigrationManager,
  MemoryIndexRebuildLease,
  type MemoryIndexMigrationResult,
  type MemoryIndexRebuildEstimate,
} from "./zvec-index-migration";

export type MemoryOperationName = "rebuild" | "resume" | "activate" | "rollback";
export type MemoryOperationJob = {
  id: string;
  operation: MemoryOperationName;
  collectionRevision: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  result?: MemoryIndexMigrationResult;
  error?: string;
};

export type MemoryCollectionOperationalStatus = {
  collectionRevision: string;
  embeddingRevision: string;
  embeddingProfile?: string;
  embeddingModel?: string;
  dimensions?: number;
  index?: "flat" | "hnsw";
  state: "building" | "ready" | "active" | "retired" | "failed";
  documentCount: number;
  diskBytes: number;
  createdAt: string;
  readyAt?: string;
  activatedAt?: string;
  retiredAt?: string;
  migration?: ReturnType<MemoryRepository["getIndexMigration"]>;
  validation: ReturnType<MemoryRepository["indexRevisionValidation"]>;
  completeness: number;
};

export type MemoryIndexMaintenanceStatus = {
  running: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  collectionRevision?: string;
  lastRun?: MemoryIndexWorkerRun;
  optimizedAt?: string;
};

export type MemoryOperationalSnapshot = {
  generatedAt: string;
  projectId: string;
  enabled: boolean;
  health: "disabled" | "lexical" | "healthy" | "degraded" | "rebuilding" | "error";
  warnings: Array<{ code: string; message: string }>;
  configured: {
    backend: MemoryConfig["retrieval"]["backend"];
    embeddingProfile?: string;
    embeddingState: "disabled" | "ready" | "misconfigured";
    embeddingReason?: string;
    embeddingRevision?: string;
    dimensions?: number;
    collectionRevision?: string;
  };
  activeCollectionRevision?: string;
  overview: MemoryOverview;
  collections: MemoryCollectionOperationalStatus[];
  estimate?: MemoryIndexRebuildEstimate & { availableDiskBytes: number; diskSufficient: boolean };
  operation?: MemoryOperationJob;
  maintenance: MemoryIndexMaintenanceStatus;
  retrievalRuns: ReturnType<MemoryRepository["listRetrievalRuns"]>;
  accessAudits: ReturnType<MemoryRepository["listAccessAudits"]>;
};

export type MemoryOperationsOptions = {
  projectId: string;
  stateDir: string;
  config: MemoryConfig;
  repository: MemoryRepository;
  modelsFile?: string;
  allowDeterministicFake?: boolean;
  availableDiskBytes?: () => Promise<number>;
  workerHost?: ZvecMemoryIndexWorkerHost;
  now?: () => Date;
};

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        try { total += (await fs.stat(target)).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }));
  };
  await visit(root);
  return total;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:sk|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]").slice(0, 800);
}

export class MemoryOperations {
  private readonly layout: ZvecIndexLayout;
  private readonly now: () => Date;
  private readonly workerHost: ZvecMemoryIndexWorkerHost;
  private readonly ownsWorkerHost: boolean;
  private readonly rebuildLease: MemoryIndexRebuildLease;
  private job?: MemoryOperationJob;
  private jobPromise?: Promise<void>;
  private maintenance: MemoryIndexMaintenanceStatus = { running: false };
  private maintenancePromise?: Promise<MemoryIndexWorkerRun | undefined>;
  private indexedSinceOptimize = 0;

  constructor(private readonly options: MemoryOperationsOptions) {
    const root = path.isAbsolute(options.config.zvec.path)
      ? options.config.zvec.path
      : path.resolve(options.stateDir, options.config.zvec.path);
    this.layout = createZvecIndexLayout(root, options.projectId);
    this.now = options.now ?? (() => new Date());
    this.workerHost = options.workerHost ?? new ZvecMemoryIndexWorkerHost();
    this.ownsWorkerHost = !options.workerHost;
    const globalDataDir = options.modelsFile ? path.dirname(options.modelsFile) : path.join(os.homedir(), ".oat");
    this.rebuildLease = new MemoryIndexRebuildLease(path.join(globalDataDir, "locks", "memory-index-rebuild.lock"));
  }

  async close(): Promise<void> {
    if (this.ownsWorkerHost) await this.workerHost.dispose();
    await this.jobPromise?.catch(() => undefined);
  }

  syncActiveOnce(): Promise<MemoryIndexWorkerRun | undefined> {
    if (this.maintenancePromise) return this.maintenancePromise;
    if (this.job?.status === "running") return Promise.resolve(undefined);
    const startedAt = this.timestamp();
    this.maintenance = { ...this.maintenance, running: true, lastStartedAt: startedAt, lastError: undefined };
    const task = this.syncActiveOnceUnlocked().then((run) => {
      const completedAt = this.timestamp();
      this.maintenance = {
        ...this.maintenance,
        running: false,
        lastCompletedAt: completedAt,
        lastSuccessAt: completedAt,
        lastError: undefined,
        ...(run ? { lastRun: run } : {}),
      };
      return run;
    }, (error) => {
      this.maintenance = {
        ...this.maintenance,
        running: false,
        lastCompletedAt: this.timestamp(),
        lastError: safeError(error),
      };
      throw error;
    }).finally(() => {
      if (this.maintenancePromise === task) this.maintenancePromise = undefined;
    });
    this.maintenancePromise = task;
    return task;
  }

  async snapshot(overview: MemoryOverview, retrieval: MemoryRetrievalRuntimeStatus): Promise<MemoryOperationalSnapshot> {
    const catalog = await this.catalog();
    const embedding = resolveEmbeddingProvider(catalog, this.options.config.embeddingRef, { allowDeterministicFake: this.options.allowDeterministicFake });
    const profile = this.options.config.embeddingRef ? catalog.embeddingProfiles[this.options.config.embeddingRef] : undefined;
    const providerConfig = profile?.kind === "openai-compatible" ? catalog.providers[profile.provider] : undefined;
    const embeddingRevision = profile ? embeddingIdentityRevision(profile, providerConfig) : undefined;
    const target = profile && embedding.state === "ready" ? createZvecIndexManifest({
      projectId: this.options.projectId,
      profileName: this.options.config.embeddingRef!,
      profile,
      provider: providerConfig,
      metric: this.options.config.zvec.metric,
      index: this.options.config.zvec.index,
    }) : undefined;
    const [registry, pointer, availableDiskBytes] = await Promise.all([
      readZvecIndexRegistry(this.layout, this.options.projectId),
      readActiveIndexPointer(this.layout, this.options.projectId),
      this.availableDiskBytes(),
    ]);
    const collections = await Promise.all(Object.values(registry.collections).map(async (entry): Promise<MemoryCollectionOperationalStatus> => {
      const [manifest, diskBytes] = await Promise.all([
        readZvecIndexManifest(this.layout, this.options.projectId, entry.collectionRevision),
        directoryBytes(this.layout.collectionDirectory(entry.collectionRevision)),
      ]);
      const validation = this.options.repository.indexRevisionValidation(entry.collectionRevision, 20);
      const completeness = validation.expectedCount === 0 ? 1 : Math.max(0, Math.min(1, validation.indexedCount / validation.expectedCount));
      return {
        ...entry,
        embeddingProfile: manifest?.embedding.profile,
        embeddingModel: manifest?.embedding.model,
        dimensions: manifest?.embedding.dimensions,
        index: manifest?.index,
        diskBytes,
        readyAt: entry.readyAt ?? undefined,
        activatedAt: entry.activatedAt ?? undefined,
        retiredAt: entry.retiredAt ?? undefined,
        migration: this.options.repository.getIndexMigration(entry.collectionRevision),
        validation,
        completeness,
      };
    }));
    let estimate: MemoryOperationalSnapshot["estimate"];
    if (target) {
      const value = await this.manager().estimate(target);
      estimate = { ...value, availableDiskBytes, diskSufficient: availableDiskBytes >= value.minimumPeakBytes };
    }
    const warnings: MemoryOperationalSnapshot["warnings"] = [];
    if (embedding.state !== "ready") warnings.push({ code: "embedding_unavailable", message: embedding.reason ?? "Embedding is unavailable." });
    if (this.options.config.retrieval.backend !== "lexical" && !pointer) warnings.push({ code: "active_collection_missing", message: "No active Zvec collection is available; retrieval falls back to lexical." });
    if (pointer && embeddingRevision) {
      const active = collections.find((collection) => collection.collectionRevision === pointer.collectionRevision);
      if (active?.embeddingRevision !== embeddingRevision) warnings.push({ code: "embedding_mismatch", message: "The active collection was built with a different embedding revision." });
    }
    if (collections.some(({ validation }) => validation.deadLetters > 0)) warnings.push({ code: "dead_letters", message: "One or more index writes require retry or operator review." });
    if (collections.some(({ validation }) => validation.pendingOutbox > 0 || validation.processingOutbox > 0)) warnings.push({ code: "index_incomplete", message: "Index synchronization is still in progress." });
    if (retrieval.lastFallbackReason) warnings.push({ code: "retrieval_fallback", message: retrieval.lastFallbackReason });
    if (estimate && !estimate.diskSufficient) warnings.push({ code: "disk_insufficient", message: "Available disk space is below the conservative rebuild estimate." });
    if (this.job?.status === "failed") warnings.push({ code: "operation_failed", message: this.job.error ?? "The last index operation failed." });
    if (this.maintenance.lastError) warnings.push({ code: "index_maintenance_failed", message: this.maintenance.lastError });
    const rebuilding = this.job?.status === "running" || collections.some(({ migration }) => migration && ["backfilling", "validating"].includes(migration.status));
    const error = collections.some(({ state }) => state === "failed") || this.job?.status === "failed";
    const degraded = warnings.length > 0 || retrieval.circuitState !== "closed";
    const health = !this.options.config.enabled ? "disabled"
      : this.options.config.retrieval.backend === "lexical" ? "lexical"
        : error ? "error" : rebuilding ? "rebuilding" : degraded ? "degraded" : "healthy";
    return {
      generatedAt: this.timestamp(), projectId: this.options.projectId, enabled: this.options.config.enabled,
      health, warnings,
      configured: {
        backend: this.options.config.retrieval.backend,
        embeddingProfile: this.options.config.embeddingRef,
        embeddingState: embedding.state,
        embeddingReason: embedding.reason,
        embeddingRevision,
        dimensions: profile?.dimensions,
        collectionRevision: target?.collectionRevision,
      },
      activeCollectionRevision: pointer?.collectionRevision,
      overview: { ...overview, retrieval }, collections, estimate,
      operation: this.job,
      maintenance: { ...this.maintenance },
      retrievalRuns: this.options.repository.listRetrievalRuns(30),
      accessAudits: this.options.repository.listAccessAudits(30),
    };
  }

  async estimate(): Promise<{ manifest: ZvecIndexManifest; estimate: MemoryIndexRebuildEstimate & { availableDiskBytes: number; diskSufficient: boolean } }> {
    const { manifest } = await this.currentTarget();
    const [estimate, availableDiskBytes] = await Promise.all([this.manager().estimate(manifest), this.availableDiskBytes()]);
    return { manifest, estimate: { ...estimate, availableDiskBytes, diskSufficient: availableDiskBytes >= estimate.minimumPeakBytes } };
  }

  async startRebuild(): Promise<MemoryOperationJob> {
    const { manifest, provider } = await this.currentTarget();
    return this.schedule("rebuild", manifest.collectionRevision, () => this.manager().rebuild(manifest, provider));
  }

  async startResume(collectionRevision: string): Promise<MemoryOperationJob> {
    const provider = await this.providerForManifest(collectionRevision);
    return this.schedule("resume", collectionRevision, () => this.manager().resume(collectionRevision, provider));
  }

  async startActivate(collectionRevision: string): Promise<MemoryOperationJob> {
    const provider = await this.providerForManifest(collectionRevision);
    return this.schedule("activate", collectionRevision, () => this.manager().activate(collectionRevision, provider));
  }

  async startRollback(collectionRevision: string): Promise<MemoryOperationJob> {
    const provider = await this.providerForManifest(collectionRevision);
    return this.schedule("rollback", collectionRevision, () => this.manager().rollback(collectionRevision, provider));
  }

  pause(collectionRevision: string): ReturnType<MemoryIndexMigrationManager["pause"]> {
    return this.manager().pause(collectionRevision, "Paused by user from Desktop");
  }

  private schedule(operation: MemoryOperationName, collectionRevision: string, task: () => Promise<MemoryIndexMigrationResult>): MemoryOperationJob {
    if (this.job?.status === "running") throw new Error(`Memory operation '${this.job.operation}' is already running.`);
    const job: MemoryOperationJob = {
      id: `${operation}-${this.now().getTime()}`,
      operation,
      collectionRevision,
      status: "running",
      startedAt: this.timestamp(),
    };
    this.job = job;
    const running = (async () => {
      await this.maintenancePromise?.catch(() => undefined);
      return task();
    })().then((result) => {
      if (this.job?.id !== job.id) return;
      this.job = { ...job, status: "completed", result, completedAt: this.timestamp() };
    }, (error) => {
      if (this.job?.id !== job.id) return;
      this.job = { ...job, status: "failed", error: safeError(error), completedAt: this.timestamp() };
    });
    const tracked = running.finally(() => {
      if (this.jobPromise === tracked) this.jobPromise = undefined;
    });
    this.jobPromise = tracked;
    return job;
  }

  private async syncActiveOnceUnlocked(): Promise<MemoryIndexWorkerRun | undefined> {
    const pointer = await readActiveIndexPointer(this.layout, this.options.projectId);
    if (!pointer) return undefined;
    const manifest = await readZvecIndexManifest(this.layout, this.options.projectId, pointer.collectionRevision);
    if (!manifest || manifest.state !== "active") {
      throw new Error(`Active Zvec pointer '${pointer.collectionRevision}' does not reference an active collection.`);
    }
    const provider = await this.providerForManifest(pointer.collectionRevision);
    const index = await ZvecMemoryIndex.open({ layout: this.layout, manifest, workerHost: this.workerHost });
    this.maintenance = { ...this.maintenance, collectionRevision: pointer.collectionRevision };
    try {
      this.options.repository.reconcileIndexRevision(pointer.collectionRevision, this.timestamp());
      const worker = new MemoryIndexWorker({
        repository: this.options.repository,
        index,
        embeddingProvider: provider,
        workerId: `active-${this.options.projectId}-${process.pid}`,
        batchSize: this.options.config.zvec.batchSize,
        maxAttempts: this.options.config.zvec.maxAttempts,
        now: this.now,
      });
      const run = await worker.runOnce();
      this.options.repository.reconcileSemanticIndexRevision(pointer.collectionRevision, this.timestamp());
      const semanticRun = await new SemanticIndexWorker({
        repository: this.options.repository,
        index,
        embeddingProvider: provider,
        workerId: `semantic-active-${this.options.projectId}-${process.pid}`,
        batchSize: this.options.config.zvec.batchSize,
        maxAttempts: this.options.config.zvec.maxAttempts,
        now: this.now,
      }).runOnce();
      run.claimed += semanticRun.claimed;
      run.indexed += semanticRun.indexed;
      run.deleted += semanticRun.deleted;
      run.retried += semanticRun.retried;
      run.deadLettered += semanticRun.deadLettered;
      run.lostLeases += semanticRun.lostLeases;
      this.indexedSinceOptimize += run.indexed + run.deleted;
      const stats = await index.stats();
      const completeness = stats.indexCompleteness.dense_embedding ?? 1;
      const pendingIndexEstimate = Math.ceil(stats.documentCount * Math.max(0, 1 - completeness));
      if (this.indexedSinceOptimize >= this.options.config.zvec.optimizePendingThreshold
        || pendingIndexEstimate >= this.options.config.zvec.optimizePendingThreshold) {
        await index.optimize();
        this.indexedSinceOptimize = 0;
        this.maintenance = { ...this.maintenance, optimizedAt: this.timestamp() };
      }
      return run;
    } finally {
      await index.close();
    }
  }

  private async currentTarget(): Promise<{ manifest: ZvecIndexManifest; provider: EmbeddingProvider }> {
    const catalog = await this.catalog();
    const reference = this.options.config.embeddingRef;
    if (!reference) throw new Error("Select a global embedding profile before building a Zvec collection.");
    const profile = catalog.embeddingProfiles[reference];
    if (!profile) throw new Error(`Embedding profile '${reference}' does not exist.`);
    const resolved = resolveEmbeddingProvider(catalog, reference, { allowDeterministicFake: this.options.allowDeterministicFake });
    if (resolved.state !== "ready") throw new Error(resolved.reason ?? "Embedding provider is unavailable.");
    return {
      provider: resolved.provider,
      manifest: createZvecIndexManifest({
        projectId: this.options.projectId, profileName: reference, profile,
        provider: profile.kind === "openai-compatible" ? catalog.providers[profile.provider] : undefined,
        metric: this.options.config.zvec.metric, index: this.options.config.zvec.index,
      }),
    };
  }

  private async providerForManifest(collectionRevision: string): Promise<EmbeddingProvider> {
    const manifest = await readZvecIndexManifest(this.layout, this.options.projectId, collectionRevision);
    if (!manifest) throw new Error(`Collection '${collectionRevision}' has no manifest.`);
    const catalog = await this.catalog();
    const resolved = resolveEmbeddingProvider(catalog, manifest.embedding.profile, { allowDeterministicFake: this.options.allowDeterministicFake });
    if (resolved.state !== "ready") throw new Error(resolved.reason ?? "Embedding provider is unavailable.");
    if (resolved.provider.identity.revision !== manifest.embeddingRevision) {
      throw new Error(`Embedding profile '${manifest.embedding.profile}' changed; restore that immutable revision before operating on this collection.`);
    }
    return resolved.provider;
  }

  private manager(): MemoryIndexMigrationManager {
    return new MemoryIndexMigrationManager({
      projectId: this.options.projectId,
      repository: this.options.repository,
      layout: this.layout,
      workerHost: this.workerHost,
      rebuildLease: this.rebuildLease,
      batchSize: this.options.config.zvec.batchSize,
      now: this.now,
    });
  }

  private catalog(): Promise<GlobalModelCatalog> { return loadGlobalModelCatalog(this.options.modelsFile); }
  private timestamp(): string { return this.now().toISOString(); }
  private async availableDiskBytes(): Promise<number> {
    if (this.options.availableDiskBytes) return this.options.availableDiskBytes();
    const stat = await fs.statfs(this.options.stateDir);
    return Number(stat.bavail) * Number(stat.bsize);
  }
}
