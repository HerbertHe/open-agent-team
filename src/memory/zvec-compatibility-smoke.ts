import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecInitialize,
  ZVecMetricType,
  ZVecOpen,
  ZVecSetDefaultJiebaDictDir,
  type ZVecStatus,
} from "@zvec/zvec";

const nodeRequire = createRequire(import.meta.url);
let initialized = false;

export type ZvecCompatibilityReport = {
  packageVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  electronVersion?: string;
  modulesAbi: string;
  napiVersion: string;
  nativeBindingPath: string;
  nativeBindingBytes: number;
  collection: {
    batchUpsert: true;
    fetch: true;
    scalarFilter: true;
    vectorQuery: true;
    fullTextSearch: true;
    denseFtsRrf: true;
    closeReopenRecovery: true;
    explicitFlushApi: false;
  };
};

function initializeOnce(): void {
  if (initialized) return;
  ZVecInitialize({});
  initialized = true;
}

function assertStatuses(statuses: ZVecStatus | ZVecStatus[], operation: string): void {
  const values = Array.isArray(statuses) ? statuses : [statuses];
  const failed = values.find((status) => !status.ok);
  if (failed) throw new Error(`${operation} failed (${failed.code}): ${failed.message}`);
}

function bindingPackageName(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "@zvec/bindings-darwin-arm64";
  if (process.platform === "linux" && process.arch === "arm64") return "@zvec/bindings-linux-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "@zvec/bindings-linux-x64";
  if (process.platform === "win32" && process.arch === "x64") return "@zvec/bindings-win32-x64";
  throw new Error(`Zvec 0.7.0 has no declared prebuilt target for ${process.platform}-${process.arch}`);
}

function resolveNativeBinding(): string {
  const zvecEntry = nodeRequire.resolve("@zvec/zvec");
  const resolved = nodeRequire.resolve(bindingPackageName(), { paths: [path.dirname(zvecEntry)] });
  const unpacked = resolved.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return unpacked !== resolved && existsSync(unpacked) ? unpacked : resolved;
}

function installedPackageVersion(): string {
  const entry = nodeRequire.resolve("@zvec/zvec");
  const manifest = JSON.parse(readFileSync(path.resolve(path.dirname(entry), "../package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("Unable to determine the installed @zvec/zvec version");
  return manifest.version;
}

function configurePackagedJiebaDictionary(): void {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return;
  const dictionaryPath = path.join(resourcesPath, "app.asar.unpacked", "node_modules", bindingPackageName(), "jieba_dict");
  if (!existsSync(path.join(dictionaryPath, "jieba.dict.utf8")) || !existsSync(path.join(dictionaryPath, "hmm_model.utf8"))) {
    throw new Error(`Packaged Zvec Jieba dictionary is missing: ${dictionaryPath}`);
  }
  ZVecSetDefaultJiebaDictDir(dictionaryPath);
}

export function runZvecCompatibilitySmoke(): ZvecCompatibilityReport {
  configurePackagedJiebaDictionary();
  initializeOnce();
  const root = mkdtempSync(path.join(tmpdir(), "oat-zvec-smoke-"));
  const collectionPath = path.join(root, "memory-index");
  let collection = ZVecCreateAndOpen(collectionPath, new ZVecCollectionSchema({
    name: "oat_memory_compatibility",
    fields: [
      {
        name: "content",
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: "jieba", filters: ["lowercase"] },
      },
      {
        name: "category",
        dataType: ZVecDataType.STRING,
        indexParams: { indexType: ZVecIndexType.INVERT },
      },
    ],
    vectors: [{
      name: "embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: 4,
      indexParams: { indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE },
    }],
  }));

  try {
    assertStatuses(collection.upsertSync([
      { id: "channel", fields: { content: "微信通道默认交给智能体资源主管", category: "channel" }, vectors: { embedding: [1, 0, 0, 0] } },
      { id: "runtime", fields: { content: "模型余额不足只失败当前任务并保留进程", category: "runtime" }, vectors: { embedding: [0, 1, 0, 0] } },
      { id: "other", fields: { content: "桌面蜂巢动画使用蓝灰色", category: "desktop" }, vectors: { embedding: [0, 0, 1, 0] } },
    ]), "batch upsert");

    const fetched = collection.fetchSync(["channel", "runtime"]);
    if (fetched.channel?.fields.content !== "微信通道默认交给智能体资源主管" || !fetched.runtime) {
      throw new Error("fetch did not return the upserted documents");
    }

    const filtered = collection.querySync({ filter: "category = 'runtime'", topk: 10 });
    if (filtered.length !== 1 || filtered[0]?.id !== "runtime") throw new Error("scalar filter returned an unexpected result");

    const vector = collection.querySync({ fieldName: "embedding", vector: [1, 0, 0, 0], topk: 1 });
    if (vector[0]?.id !== "channel") throw new Error("vector query returned an unexpected result");

    const fts = collection.querySync({ fieldName: "content", fts: { matchString: "资源主管" }, topk: 5 });
    if (!fts.some((item) => item.id === "channel")) throw new Error("Jieba FTS did not find the Chinese document");

    const fused = collection.multiQuerySync({
      queries: [
        { fieldName: "embedding", vector: [1, 0, 0, 0] },
        { fieldName: "content", fts: { matchString: "微信资源主管" } },
      ],
      topk: 2,
      rerank: { type: "rrf", rankConstant: 60 },
    });
    if (fused[0]?.id !== "channel") throw new Error("dense + FTS RRF returned an unexpected result");

    // @zvec/zvec 0.7.0 exposes no flush API. close/reopen is the tested
    // durability boundary and mirrors actual process-restart recovery.
    collection.closeSync();
    collection = ZVecOpen(collectionPath, { readOnly: false, enableMMAP: true });
    if (!collection.fetchSync("channel").channel) throw new Error("document was not durable across close/reopen");

    const nativeBindingPath = resolveNativeBinding();
    return {
      packageVersion: installedPackageVersion(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      modulesAbi: process.versions.modules,
      napiVersion: process.versions.napi ?? "unknown",
      nativeBindingPath,
      nativeBindingBytes: statSync(nativeBindingPath).size,
      collection: {
        batchUpsert: true,
        fetch: true,
        scalarFilter: true,
        vectorQuery: true,
        fullTextSearch: true,
        denseFtsRrf: true,
        closeReopenRecovery: true,
        explicitFlushApi: false,
      },
    };
  } finally {
    try { collection.closeSync(); } catch { /* already closed after a failed operation */ }
    rmSync(root, { recursive: true, force: true });
  }
}
