import { existsSync } from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecInitialize,
  ZVecMetricType,
  ZVecOpen,
  ZVecSetDefaultJiebaDictDir,
  isZVecError,
  type ZVecCollection,
  type ZVecDocInput,
  type ZVecFieldSchema,
  type ZVecInvertIndexParams,
} from "@zvec/zvec";
import { ZvecIndexManifestSchema, type ZvecIndexManifest } from "./zvec-index-identity";
import {
  expectedZvecMemorySchema,
  ZvecDocumentMetadataSchema,
  ZvecQueryRoutesResultSchema,
  ZvecMemoryIndexStatsSchema,
  ZvecMemoryDocumentSchema,
  ZvecWriteStatusSchema,
  ZvecMemorySchemaDescriptorSchema,
  type ZvecMemorySchemaDescriptor,
  type ZvecWorkerRequest,
  type ZvecWorkerResponse,
} from "./zvec-memory-index-contract";

if (!parentPort) throw new Error("The Zvec memory index owner must run in a Worker Thread.");
const port = parentPort;

type OpenHandle = {
  collection: ZVecCollection;
  collectionRevision: string;
  path: string;
  readOnly: boolean;
  manifest: ZvecIndexManifest;
  enableMMAP: boolean;
};

type IndexParams = {
  indexType?: number;
  metricType?: number;
  enableRangeOptimization?: boolean;
  tokenizerName?: string;
  filters?: string[];
};

const handles = new Map<string, OpenHandle>();

function bindingPackageName(): string | undefined {
  if (process.platform === "darwin" && process.arch === "arm64") return "@zvec/bindings-darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "@zvec/bindings-darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "@zvec/bindings-linux-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "@zvec/bindings-linux-x64";
  if (process.platform === "win32" && process.arch === "x64") return "@zvec/bindings-win32-x64";
  return undefined;
}

function configurePackagedJiebaDictionary(): void {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const binding = bindingPackageName();
  if (!resourcesPath || !binding) return;
  const dictionaryPath = path.join(resourcesPath, "app.asar.unpacked", "node_modules", binding, "jieba_dict");
  if (!existsSync(path.join(dictionaryPath, "jieba.dict.utf8")) || !existsSync(path.join(dictionaryPath, "hmm_model.utf8"))) {
    throw new Error(`Packaged Zvec Jieba dictionary is missing: ${dictionaryPath}`);
  }
  ZVecSetDefaultJiebaDictDir(dictionaryPath);
}

configurePackagedJiebaDictionary();
ZVecInitialize({});

function scalarType(dataType: number): "string" | "int32" | "int64" | "float" {
  if (dataType === ZVecDataType.STRING) return "string";
  if (dataType === ZVecDataType.INT32) return "int32";
  if (dataType === ZVecDataType.INT64) return "int64";
  if (dataType === ZVecDataType.FLOAT) return "float";
  throw new Error(`Unexpected scalar data type in Zvec memory schema: ${dataType}`);
}

function scalarDescriptor(field: ZVecFieldSchema): ZvecMemorySchemaDescriptor["fields"][number] {
  const params = field.indexParams as IndexParams | undefined;
  if (params && params.indexType !== ZVecIndexType.FTS && params.indexType !== ZVecIndexType.INVERT) {
    throw new Error(`Unexpected scalar index type for Zvec memory field '${field.name}'.`);
  }
  const index = params?.indexType === ZVecIndexType.FTS
    ? "fts"
    : params?.indexType === ZVecIndexType.INVERT ? "invert" : "none";
  return {
    name: field.name,
    dataType: scalarType(field.dataType),
    nullable: Boolean(field.nullable),
    index,
    ...(index === "invert" && params?.enableRangeOptimization ? { rangeOptimization: true } : {}),
    ...(index === "fts" ? {
      tokenizer: params?.tokenizerName,
      filters: [...(params?.filters ?? [])].sort(),
    } : {}),
  };
}

function describeSchema(collection: ZVecCollection): ZvecMemorySchemaDescriptor {
  const vectors = collection.schema.vectors();
  if (vectors.length !== 1 || vectors[0]?.name !== "dense_embedding") {
    throw new Error("Zvec memory schema must contain exactly one dense_embedding vector field.");
  }
  const vector = collection.schema.vector("dense_embedding");
  const vectorParams = vector.indexParams as IndexParams | undefined;
  if (vector.dataType !== ZVecDataType.VECTOR_FP32) throw new Error("Zvec memory dense_embedding must use VECTOR_FP32.");
  if (vectorParams?.indexType !== ZVecIndexType.FLAT && vectorParams?.indexType !== ZVecIndexType.HNSW) {
    throw new Error("Zvec memory dense_embedding must use FLAT or HNSW.");
  }
  if (vectorParams.metricType !== ZVecMetricType.COSINE) throw new Error("Zvec memory dense_embedding must use COSINE.");
  const descriptor = {
    name: collection.schema.name,
    fields: collection.schema.fields().map(scalarDescriptor).sort((left, right) => left.name.localeCompare(right.name)),
    vector: {
      name: "dense_embedding" as const,
      dataType: "vector_fp32" as const,
      dimensions: vector.dimension,
      index: vectorParams.indexType === ZVecIndexType.HNSW ? "hnsw" as const : "flat" as const,
      metric: "cosine" as const,
    },
  };
  return ZvecMemorySchemaDescriptorSchema.parse(descriptor);
}

function canonicalDescriptor(descriptor: ZvecMemorySchemaDescriptor): ZvecMemorySchemaDescriptor {
  return {
    ...descriptor,
    fields: [...descriptor.fields].map((field) => ({
      ...field,
      ...(field.filters ? { filters: [...field.filters].sort() } : {}),
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function assertSchema(collection: ZVecCollection, manifest: ZvecIndexManifest): ZvecMemorySchemaDescriptor {
  const actual = canonicalDescriptor(describeSchema(collection));
  const expected = canonicalDescriptor(expectedZvecMemorySchema(manifest));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Zvec collection schema does not match manifest ${manifest.collectionRevision}.`);
  }
  return actual;
}

function createSchema(manifest: ZvecIndexManifest): ZVecCollectionSchema {
  const invert = (rangeOptimization = false): ZVecInvertIndexParams => ({
    indexType: ZVecIndexType.INVERT,
    enableRangeOptimization: rangeOptimization,
    enableExtendedWildcard: false,
  });
  return new ZVecCollectionSchema({
    name: `oat_memory_${manifest.collectionRevision}`,
    fields: [
      { name: "content", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: "jieba", filters: ["lowercase"] } },
      { name: "project_id", dataType: ZVecDataType.STRING, indexParams: invert() },
      { name: "owner_agent_id", dataType: ZVecDataType.STRING, indexParams: invert() },
      { name: "team_id", dataType: ZVecDataType.STRING, nullable: true, indexParams: invert() },
      { name: "scope", dataType: ZVecDataType.STRING, indexParams: invert() },
      { name: "level", dataType: ZVecDataType.STRING, indexParams: invert() },
      { name: "kind", dataType: ZVecDataType.STRING, indexParams: invert() },
      { name: "status", dataType: ZVecDataType.STRING, indexParams: invert() },
      { name: "trust_level", dataType: ZVecDataType.INT32, indexParams: invert() },
      { name: "valid_from_ms", dataType: ZVecDataType.INT64, indexParams: invert(true) },
      { name: "valid_to_ms", dataType: ZVecDataType.INT64, nullable: true, indexParams: invert(true) },
      { name: "updated_at_ms", dataType: ZVecDataType.INT64, indexParams: invert(true) },
      { name: "salience", dataType: ZVecDataType.FLOAT },
      { name: "confidence", dataType: ZVecDataType.FLOAT },
      { name: "content_hash", dataType: ZVecDataType.STRING, indexParams: invert() },
    ],
    vectors: [{
      name: "dense_embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: manifest.embedding.dimensions,
      indexParams: {
        indexType: manifest.index === "hnsw" ? ZVecIndexType.HNSW : ZVecIndexType.FLAT,
        metricType: ZVecMetricType.COSINE,
      },
    }],
  });
}

function stats(handle: OpenHandle) {
  const current = handle.collection.stats;
  return ZvecMemoryIndexStatsSchema.parse({
    documentCount: current.docCount,
    indexCompleteness: current.indexCompleteness,
    readOnly: handle.readOnly,
    path: handle.path,
    collectionRevision: handle.collectionRevision,
  });
}

function open(request: Extract<ZvecWorkerRequest, { operation: "create" | "open" }>): unknown {
  if (handles.has(request.handleId)) throw new Error(`Zvec handle '${request.handleId}' is already open.`);
  const manifest = ZvecIndexManifestSchema.parse(request.manifest);
  const collectionPath = path.resolve(request.path);
  if (!request.readOnly && [...handles.values()].some((handle) => !handle.readOnly && handle.path === collectionPath)) {
    const error = new Error(`A writable Zvec handle is already open for ${collectionPath}.`) as Error & { code?: string };
    error.code = "OAT_ZVEC_WRITER_CONFLICT";
    throw error;
  }
  if (request.operation === "create" && request.readOnly) throw new Error("A Zvec collection cannot be created in read-only mode.");

  const collection = request.operation === "create"
    ? ZVecCreateAndOpen(collectionPath, createSchema(manifest), { readOnly: false, enableMMAP: request.enableMMAP })
    : ZVecOpen(collectionPath, { readOnly: request.readOnly, enableMMAP: request.enableMMAP });
  try {
    const schema = assertSchema(collection, manifest);
    handles.set(request.handleId, { collection, collectionRevision: manifest.collectionRevision, path: collectionPath, readOnly: request.readOnly, manifest, enableMMAP: request.enableMMAP });
    return { schema, stats: stats(handles.get(request.handleId)!) };
  } catch (error) {
    collection.closeSync();
    throw error;
  }
}

function writableHandle(handleId: string): OpenHandle {
  const handle = handles.get(handleId);
  if (!handle) throw new Error(`Zvec handle '${handleId}' is not open.`);
  if (handle.readOnly) throw new Error(`Zvec handle '${handleId}' is read-only.`);
  return handle;
}

function normalizeStatuses(ids: string[], result: unknown): unknown {
  const values = Array.isArray(result) ? result : [result];
  if (values.length !== ids.length) throw new Error(`Zvec returned ${values.length} statuses for ${ids.length} writes.`);
  return values.map((value, index) => {
    const status = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return ZvecWriteStatusSchema.parse({
      id: ids[index],
      ok: status.ok === true,
      ...(typeof status.code === "string" || typeof status.code === "number" ? { code: status.code } : {}),
      ...(typeof status.message === "string" ? { message: status.message } : {}),
    });
  });
}

function upsert(handleId: string, input: unknown[]): unknown {
  const handle = writableHandle(handleId);
  const documents = input.map((document) => ZvecMemoryDocumentSchema.parse(document));
  const docs: ZVecDocInput[] = documents.map((document) => {
    const { team_id, valid_to_ms, ...requiredFields } = document.fields;
    return {
      id: document.id,
      fields: {
        ...requiredFields,
        ...(team_id === null ? {} : { team_id }),
        ...(valid_to_ms === null ? {} : { valid_to_ms }),
      },
      vectors: { dense_embedding: document.vector },
    };
  });
  return normalizeStatuses(documents.map(({ id }) => id), handle.collection.upsertSync(docs));
}

function remove(handleId: string, ids: string[]): unknown {
  const handle = writableHandle(handleId);
  return normalizeStatuses(ids, handle.collection.deleteSync(ids));
}

function durability(handleId: string, ids: string[]): { foundIds: string[] } {
  const handle = writableHandle(handleId);
  handle.collection.closeSync();
  let reopened: ZVecCollection | undefined;
  try {
    reopened = ZVecOpen(handle.path, { readOnly: false, enableMMAP: handle.enableMMAP });
    assertSchema(reopened, handle.manifest);
    const fetched = reopened.fetchSync(ids) as unknown as Record<string, unknown>;
    handle.collection = reopened;
    return { foundIds: ids.filter((id) => Object.prototype.hasOwnProperty.call(fetched, id)) };
  } catch (error) {
    try { reopened?.closeSync(); } catch { /* retain original failure */ }
    handles.delete(handleId);
    throw error;
  }
}

function fetchMetadata(handleId: string, ids: string[]): unknown {
  const handle = handles.get(handleId);
  if (!handle) throw new Error(`Zvec handle '${handleId}' is not open.`);
  const fetched = handle.collection.fetchSync(ids) as unknown as Record<string, {
    id?: unknown; vectors?: Record<string, unknown>; fields?: Record<string, unknown>;
  }>;
  return ids.flatMap((id) => {
    const document = fetched[id];
    if (!document) return [];
    const vector = document.vectors?.dense_embedding;
    const contentHash = document.fields?.content_hash;
    return [ZvecDocumentMetadataSchema.parse({
      id,
      contentHash,
      vectorDimensions: Array.isArray(vector) ? vector.length : 0,
    })];
  });
}

function optimize(handleId: string): unknown {
  const handle = writableHandle(handleId);
  handle.collection.optimizeSync();
  return stats(handle);
}

function queryRoutes(handleId: string, request: Extract<ZvecWorkerRequest, { operation: "query-routes" }>): unknown {
  const handle = handles.get(handleId);
  if (!handle) throw new Error(`Zvec handle '${handleId}' is not open.`);
  const topK = Math.min(500, Math.max(1, Math.floor(request.topK)));
  const toHits = (documents: Array<{ id: string; score?: number }>) => documents.map((document) => ({
    id: document.id,
    score: typeof document.score === "number" && Number.isFinite(document.score) ? document.score : 0,
  }));
  const dense: Array<{ id: string; score: number }> = [];
  const fts: Array<{ id: string; score: number }> = [];
  const errors: Array<{ route: "dense" | "fts"; message: string }> = [];
  if (request.denseVector) {
    try {
      dense.push(...toHits(handle.collection.querySync({
        fieldName: "dense_embedding",
        vector: request.denseVector,
        filter: request.filter,
        topk: topK,
        includeVector: false,
        outputFields: ["content_hash"],
      })));
    } catch (error) { errors.push({ route: "dense", message: serializeError(error).message }); }
  }
  if (request.matchString.trim()) {
    try {
      fts.push(...toHits(handle.collection.querySync({
        fieldName: "content",
        fts: { matchString: request.matchString },
        filter: request.filter,
        topk: topK,
        includeVector: false,
        outputFields: ["content_hash"],
      })));
    } catch (error) { errors.push({ route: "fts", message: serializeError(error).message }); }
  }
  return ZvecQueryRoutesResultSchema.parse({ dense, fts, errors });
}

function destroy(request: Extract<ZvecWorkerRequest, { operation: "destroy" }>): { destroyed: true } {
  const collectionPath = path.resolve(request.path);
  if ([...handles.values()].some((handle) => handle.path === collectionPath)) {
    throw new Error(`Cannot destroy open Zvec collection '${collectionPath}'.`);
  }
  const manifest = ZvecIndexManifestSchema.parse(request.manifest);
  const collection = ZVecOpen(collectionPath, { readOnly: false, enableMMAP: request.enableMMAP });
  try {
    assertSchema(collection, manifest);
    collection.destroySync();
    return { destroyed: true };
  } catch (error) {
    try { collection.closeSync(); } catch { /* retain original failure */ }
    throw error;
  }
}

function close(handleId: string): { closed: boolean } {
  const handle = handles.get(handleId);
  if (!handle) return { closed: false };
  handle.collection.closeSync();
  handles.delete(handleId);
  return { closed: true };
}

function dispose(): void {
  for (const handle of handles.values()) {
    try { handle.collection.closeSync(); } catch { /* best effort during worker shutdown */ }
  }
  handles.clear();
}

function serializeError(error: unknown): { message: string; code?: string } {
  if (isZVecError(error)) return { message: error.message, code: error.code };
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return { message: error.message, ...(typeof code === "string" ? { code } : {}) };
  }
  return { message: String(error) };
}

port.on("message", (request: ZvecWorkerRequest) => {
  let response: ZvecWorkerResponse;
  try {
    const value = request.operation === "create" || request.operation === "open"
      ? open(request)
      : request.operation === "stats"
        ? stats(handles.get(request.handleId) ?? (() => { throw new Error(`Zvec handle '${request.handleId}' is not open.`); })())
        : request.operation === "upsert"
          ? upsert(request.handleId, request.documents)
          : request.operation === "delete"
            ? remove(request.handleId, request.ids)
            : request.operation === "durability"
              ? durability(request.handleId, request.ids)
              : request.operation === "fetch-metadata"
                ? fetchMetadata(request.handleId, request.ids)
                : request.operation === "query-routes"
                  ? queryRoutes(request.handleId, request)
                : request.operation === "optimize"
                  ? optimize(request.handleId)
                  : request.operation === "destroy"
                    ? destroy(request)
        : request.operation === "close"
          ? close(request.handleId)
          : (dispose(), undefined);
    response = { id: request.id, ok: true, value };
  } catch (error) {
    response = { id: request.id, ok: false, error: serializeError(error) };
  }
  port.postMessage(response);
  if (request.operation === "dispose") port.close();
});
