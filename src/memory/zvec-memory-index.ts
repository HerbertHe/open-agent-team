import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ZvecIndexManifestSchema, type ZvecIndexManifest } from "./zvec-index-identity";
import {
  readZvecIndexManifest,
  readZvecIndexRegistry,
  readActiveIndexPointer,
  removeZvecIndexRegistryEntry,
  registerZvecIndexManifest,
  writeZvecIndexManifest,
  writeZvecIndexRegistry,
  type ZvecIndexLayout,
} from "./zvec-index-registry";
import {
  ZvecMemoryIndexStatsSchema,
  ZvecDocumentMetadataSchema,
  ZvecQueryRoutesResultSchema,
  ZvecMemoryDocumentSchema,
  ZvecWriteStatusSchema,
  ZvecMemorySchemaDescriptorSchema,
  type ZvecMemoryIndexStats,
  type ZvecDocumentMetadata,
  type ZvecQueryRoutesResult,
  type ZvecMemoryDocument,
  type ZvecMemorySchemaDescriptor,
  type ZvecWriteStatus,
  type ZvecWorkerCommand,
  type ZvecWorkerRequest,
  type ZvecWorkerResponse,
} from "./zvec-memory-index-contract";

export class ZvecMemoryIndexError extends Error {
  constructor(message: string, readonly code = "OAT_ZVEC_LIFECYCLE_ERROR") {
    super(message);
    this.name = "ZvecMemoryIndexError";
  }
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

function defaultWorkerUrl(): URL {
  const current = fileURLToPath(import.meta.url);
  if (current.endsWith(".ts")) return new URL("./zvec-memory-index-worker-dev.mjs", import.meta.url);
  if (path.basename(current) === "index.js") return new URL("./memory/zvec-memory-index-worker.js", import.meta.url);
  return new URL("./zvec-memory-index-worker.js", import.meta.url);
}

export class ZvecMemoryIndexWorkerHost {
  private worker: Worker | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;

  constructor(private readonly workerUrl = defaultWorkerUrl()) {}

  private start(): Worker {
    if (this.disposed) throw new ZvecMemoryIndexError("The Zvec index worker host has been disposed.", "OAT_ZVEC_WORKER_DISPOSED");
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerUrl);
    worker.on("message", (message: ZvecWorkerResponse) => this.onMessage(message));
    worker.on("error", (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => {
      this.worker = undefined;
      releaseAllWritableLeases(this);
      if (!this.disposed) this.failAll(new ZvecMemoryIndexError(`Zvec index worker exited with code ${code}.`, "OAT_ZVEC_WORKER_EXIT"));
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(message: ZvecWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new ZvecMemoryIndexError(message.error.message, message.error.code));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request(request: ZvecWorkerCommand): Promise<unknown> {
    const id = randomUUID();
    const worker = this.start();
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    worker.postMessage({ ...request, id } satisfies ZvecWorkerRequest);
    return promise;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (!this.worker) {
      this.disposed = true;
      return;
    }
    try { await this.request({ operation: "dispose" }); }
    finally {
      this.disposed = true;
      await this.worker?.terminate();
      this.worker = undefined;
      releaseAllWritableLeases(this);
      this.failAll(new ZvecMemoryIndexError("The Zvec index worker host was disposed.", "OAT_ZVEC_WORKER_DISPOSED"));
    }
  }
}

let sharedWorkerHost: ZvecMemoryIndexWorkerHost | undefined;
const writableCollectionLeases = new Map<string, ZvecMemoryIndexWorkerHost>();

export function sharedZvecMemoryIndexWorkerHost(): ZvecMemoryIndexWorkerHost {
  sharedWorkerHost ??= new ZvecMemoryIndexWorkerHost();
  return sharedWorkerHost;
}

function assertLayout(layout: ZvecIndexLayout, manifest: ZvecIndexManifest): void {
  if (layout.projectId !== manifest.projectId) {
    throw new ZvecMemoryIndexError(`Index layout belongs to project '${layout.projectId}', not '${manifest.projectId}'.`);
  }
}

function assertManifestCompatibility(actual: ZvecIndexManifest, expected: ZvecIndexManifest): void {
  const fields: Array<keyof ZvecIndexManifest> = [
    "formatVersion",
    "projectId",
    "collectionRevision",
    "embeddingRevision",
    "metric",
    "index",
    "vectorSchemaVersion",
    "indexProjectionVersion",
  ];
  for (const field of fields) {
    if (actual[field] !== expected[field]) throw new ZvecMemoryIndexError(`Persisted Zvec manifest ${String(field)} does not match the requested identity.`);
  }
  if (JSON.stringify(actual.embedding) !== JSON.stringify(expected.embedding)) {
    throw new ZvecMemoryIndexError("Persisted Zvec embedding snapshot does not match the requested identity.");
  }
}

function acquireWritableLease(collectionPath: string, host: ZvecMemoryIndexWorkerHost): void {
  if (writableCollectionLeases.has(collectionPath)) {
    throw new ZvecMemoryIndexError(`A writable Zvec handle is already open for ${collectionPath}.`, "OAT_ZVEC_WRITER_CONFLICT");
  }
  writableCollectionLeases.set(collectionPath, host);
}

function releaseWritableLease(collectionPath: string, host: ZvecMemoryIndexWorkerHost): void {
  if (writableCollectionLeases.get(collectionPath) === host) writableCollectionLeases.delete(collectionPath);
}

function releaseAllWritableLeases(host: ZvecMemoryIndexWorkerHost): void {
  for (const [collectionPath, owner] of writableCollectionLeases) {
    if (owner === host) writableCollectionLeases.delete(collectionPath);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type IndexOptions = {
  layout: ZvecIndexLayout;
  manifest: ZvecIndexManifest;
  workerHost?: ZvecMemoryIndexWorkerHost;
  enableMMAP?: boolean;
};

type OpenIndexOptions = IndexOptions & { readOnly?: boolean };

type WorkerOpenResult = { schema: unknown; stats: unknown };

export class ZvecMemoryIndex {
  readonly backend = "zvec";
  readonly schema: ZvecMemorySchemaDescriptor;
  readonly readOnly: boolean;
  readonly collectionRevision: string;
  readonly embeddingRevision: string;
  readonly path: string;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly handleId: string,
    private readonly host: ZvecMemoryIndexWorkerHost,
    manifest: ZvecIndexManifest,
    readOnly: boolean,
    collectionPath: string,
    schema: ZvecMemorySchemaDescriptor,
    private readonly ownsWritableLease: boolean,
  ) {
    this.collectionRevision = manifest.collectionRevision;
    this.embeddingRevision = manifest.embeddingRevision;
    this.readOnly = readOnly;
    this.path = collectionPath;
    this.schema = schema;
  }

  static async create(options: IndexOptions): Promise<ZvecMemoryIndex> {
    const manifest = ZvecIndexManifestSchema.parse(options.manifest);
    assertLayout(options.layout, manifest);
    if (manifest.state !== "building") throw new ZvecMemoryIndexError("New Zvec collections must start with a building manifest.");
    const collectionPath = options.layout.collectionDirectory(manifest.collectionRevision);
    if (await pathExists(collectionPath)) throw new ZvecMemoryIndexError(`Refusing to create over an existing Zvec collection path: ${collectionPath}`, "OAT_ZVEC_ALREADY_EXISTS");

    const registry = await readZvecIndexRegistry(options.layout, manifest.projectId);
    const existingEntry = registry.collections[manifest.collectionRevision];
    if (existingEntry && existingEntry.state !== "building") {
      throw new ZvecMemoryIndexError(`Refusing to recreate a ${existingEntry.state} Zvec registry entry.`, "OAT_ZVEC_REGISTRY_MISMATCH");
    }
    const nextRegistry = registerZvecIndexManifest(registry, manifest);
    const host = options.workerHost ?? sharedZvecMemoryIndexWorkerHost();
    const handleId = randomUUID();
    let opened = false;
    acquireWritableLease(collectionPath, host);
    try {
      const result = await host.request({
        operation: "create",
        handleId,
        path: collectionPath,
        manifest,
        readOnly: false,
        enableMMAP: options.enableMMAP ?? true,
      }) as WorkerOpenResult;
      opened = true;
      const schema = ZvecMemorySchemaDescriptorSchema.parse(result.schema);
      ZvecMemoryIndexStatsSchema.parse(result.stats);
      await writeZvecIndexManifest(options.layout, manifest.projectId, manifest);
      await writeZvecIndexRegistry(options.layout, manifest.projectId, nextRegistry);
      return new ZvecMemoryIndex(handleId, host, manifest, false, collectionPath, schema, true);
    } catch (error) {
      if (opened) await host.request({ operation: "close", handleId }).catch(() => undefined);
      releaseWritableLease(collectionPath, host);
      throw error;
    }
  }

  static async open(options: OpenIndexOptions): Promise<ZvecMemoryIndex> {
    const expected = ZvecIndexManifestSchema.parse(options.manifest);
    assertLayout(options.layout, expected);
    const collectionPath = options.layout.collectionDirectory(expected.collectionRevision);
    const persisted = await readZvecIndexManifest(options.layout, expected.projectId, expected.collectionRevision);
    if (!persisted) throw new ZvecMemoryIndexError("Cannot open a Zvec collection without a validated manifest.", "OAT_ZVEC_MANIFEST_MISSING");
    assertManifestCompatibility(persisted, expected);
    const registry = await readZvecIndexRegistry(options.layout, expected.projectId);
    const entry = registry.collections[expected.collectionRevision];
    if (!entry || entry.embeddingRevision !== expected.embeddingRevision || entry.path !== `collections/${expected.collectionRevision}`) {
      throw new ZvecMemoryIndexError("Zvec registry does not contain the requested collection identity.", "OAT_ZVEC_REGISTRY_MISMATCH");
    }
    if (entry.state !== persisted.state) {
      throw new ZvecMemoryIndexError("Zvec registry and manifest lifecycle states do not match.", "OAT_ZVEC_REGISTRY_MISMATCH");
    }

    const host = options.workerHost ?? sharedZvecMemoryIndexWorkerHost();
    const handleId = randomUUID();
    const readOnly = options.readOnly ?? false;
    if (persisted.state === "failed") {
      throw new ZvecMemoryIndexError("A failed Zvec collection cannot be opened.", "OAT_ZVEC_FAILED_COLLECTION");
    }
    if (!readOnly && persisted.state !== "building" && persisted.state !== "ready" && persisted.state !== "active") {
      throw new ZvecMemoryIndexError(`A ${persisted.state} Zvec collection may only be opened read-only.`, "OAT_ZVEC_READ_ONLY_REQUIRED");
    }
    if (!readOnly) acquireWritableLease(collectionPath, host);
    let opened = false;
    try {
      const result = await host.request({
        operation: "open",
        handleId,
        path: collectionPath,
        manifest: persisted,
        readOnly,
        enableMMAP: options.enableMMAP ?? true,
      }) as WorkerOpenResult;
      opened = true;
      const schema = ZvecMemorySchemaDescriptorSchema.parse(result.schema);
      ZvecMemoryIndexStatsSchema.parse(result.stats);
      return new ZvecMemoryIndex(handleId, host, persisted, readOnly, collectionPath, schema, !readOnly);
    } catch (error) {
      if (opened) await host.request({ operation: "close", handleId }).catch(() => undefined);
      if (!readOnly) releaseWritableLease(collectionPath, host);
      throw error;
    }
  }

  static async destroyRetired(options: IndexOptions & { retentionMs: number; now?: string }): Promise<void> {
    const expected = ZvecIndexManifestSchema.parse(options.manifest);
    assertLayout(options.layout, expected);
    const now = options.now ?? new Date().toISOString();
    const registry = await readZvecIndexRegistry(options.layout, expected.projectId);
    const entry = registry.collections[expected.collectionRevision];
    if (!entry) return;
    if (entry.state !== "retired" && entry.state !== "failed") throw new ZvecMemoryIndexError(`Only retired or failed collections may be destroyed, received '${entry.state}'.`, "OAT_ZVEC_DESTROY_FORBIDDEN");
    const pointer = await readActiveIndexPointer(options.layout, expected.projectId);
    if (pointer?.collectionRevision === expected.collectionRevision) throw new ZvecMemoryIndexError("Refusing to destroy the active collection.", "OAT_ZVEC_DESTROY_ACTIVE");
    const retainedFrom = entry.retiredAt ?? entry.createdAt;
    if (Date.parse(now) - Date.parse(retainedFrom) < Math.max(0, options.retentionMs)) {
      throw new ZvecMemoryIndexError("Collection retention period has not elapsed.", "OAT_ZVEC_RETENTION_ACTIVE");
    }
    const collectionPath = options.layout.collectionDirectory(expected.collectionRevision);
    if (writableCollectionLeases.has(collectionPath)) throw new ZvecMemoryIndexError("Cannot destroy a collection with a writable lease.", "OAT_ZVEC_WRITER_CONFLICT");
    const persisted = await readZvecIndexManifest(options.layout, expected.projectId, expected.collectionRevision);
    if (persisted) assertManifestCompatibility(persisted, expected);
    const host = options.workerHost ?? sharedZvecMemoryIndexWorkerHost();
    if (await pathExists(collectionPath)) {
      await host.request({ operation: "destroy", path: collectionPath, manifest: persisted ?? expected, enableMMAP: options.enableMMAP ?? true });
    }
    await writeZvecIndexRegistry(options.layout, expected.projectId, removeZvecIndexRegistryEntry(registry, expected.collectionRevision, now));
  }

  async stats(): Promise<ZvecMemoryIndexStats> {
    if (this.closed) throw new ZvecMemoryIndexError("Cannot read stats from a closed Zvec memory index.", "OAT_ZVEC_CLOSED");
    return ZvecMemoryIndexStatsSchema.parse(await this.host.request({ operation: "stats", handleId: this.handleId }));
  }

  async upsert(documents: ZvecMemoryDocument[]): Promise<ZvecWriteStatus[]> {
    this.assertWritable();
    const parsed = documents.map((document) => ZvecMemoryDocumentSchema.parse(document));
    for (const document of parsed) {
      if (document.vector.length !== this.schema.vector.dimensions) {
        throw new ZvecMemoryIndexError(`Vector dimension mismatch for '${document.id}': expected ${this.schema.vector.dimensions}, received ${document.vector.length}.`, "OAT_ZVEC_DIMENSION_MISMATCH");
      }
    }
    return ZvecWriteStatusSchema.array().parse(await this.host.request({ operation: "upsert", handleId: this.handleId, documents: parsed }));
  }

  async delete(ids: string[]): Promise<ZvecWriteStatus[]> {
    this.assertWritable();
    if (!ids.length || ids.some((id) => !id)) throw new ZvecMemoryIndexError("Delete requires at least one non-empty document id.");
    return ZvecWriteStatusSchema.array().parse(await this.host.request({ operation: "delete", handleId: this.handleId, ids }));
  }

  async verifyDurability(ids: string[]): Promise<string[]> {
    this.assertWritable();
    const value = await this.host.request({ operation: "durability", handleId: this.handleId, ids }) as { foundIds?: unknown };
    if (!Array.isArray(value.foundIds) || !value.foundIds.every((id): id is string => typeof id === "string")) {
      throw new ZvecMemoryIndexError("Zvec durability verification returned an invalid response.");
    }
    return value.foundIds;
  }

  async fetchMetadata(ids: string[]): Promise<ZvecDocumentMetadata[]> {
    if (this.closed) throw new ZvecMemoryIndexError("Cannot fetch from a closed Zvec memory index.", "OAT_ZVEC_CLOSED");
    if (!ids.length) return [];
    return ZvecDocumentMetadataSchema.array().parse(await this.host.request({ operation: "fetch-metadata", handleId: this.handleId, ids }));
  }

  async optimize(): Promise<ZvecMemoryIndexStats> {
    this.assertWritable();
    return ZvecMemoryIndexStatsSchema.parse(await this.host.request({ operation: "optimize", handleId: this.handleId }));
  }

  async queryRoutes(input: { filter: string; matchString: string; denseVector?: number[]; topK: number }): Promise<ZvecQueryRoutesResult> {
    if (this.closed) throw new ZvecMemoryIndexError("Cannot query a closed Zvec memory index.", "OAT_ZVEC_CLOSED");
    if (input.denseVector && input.denseVector.length !== this.schema.vector.dimensions) {
      throw new ZvecMemoryIndexError(`Query vector dimension mismatch: expected ${this.schema.vector.dimensions}, received ${input.denseVector.length}.`, "OAT_ZVEC_DIMENSION_MISMATCH");
    }
    return ZvecQueryRoutesResultSchema.parse(await this.host.request({
      operation: "query-routes",
      handleId: this.handleId,
      filter: input.filter,
      matchString: input.matchString,
      ...(input.denseVector ? { denseVector: input.denseVector } : {}),
      topK: input.topK,
    }));
  }

  private assertWritable(): void {
    if (this.closed) throw new ZvecMemoryIndexError("Cannot write to a closed Zvec memory index.", "OAT_ZVEC_CLOSED");
    if (this.readOnly) throw new ZvecMemoryIndexError("Cannot write to a read-only Zvec memory index.", "OAT_ZVEC_READ_ONLY");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      try { await this.host.request({ operation: "close", handleId: this.handleId }); }
      finally {
        this.closed = true;
        if (this.ownsWritableLease) releaseWritableLease(this.path, this.host);
      }
    })();
    return this.closePromise;
  }
}
