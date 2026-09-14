import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { createZvecIndexManifest, type ZvecIndexManifest } from "./zvec-index-identity";
import {
  createZvecIndexLayout,
  emptyZvecIndexRegistry,
  readZvecIndexManifest,
  readZvecIndexRegistry,
  registerZvecIndexManifest,
  writeZvecIndexManifest,
  writeZvecIndexRegistry,
} from "./zvec-index-registry";
import { ZvecMemoryIndex, ZvecMemoryIndexWorkerHost } from "./zvec-memory-index";

function manifest(projectId: string, options: { model?: string; dimensions?: number; index?: "flat" | "hnsw" } = {}): ZvecIndexManifest {
  const catalog = parseGlobalModelCatalog({
    providers: { embeddings: { compatible_type: "openai", base_url: "https://api.example/v1", api_key: "never-persist" } },
    embeddingProfiles: {
      memory: {
        kind: "openai-compatible",
        provider: "embeddings",
        model: options.model ?? "embed-v1",
        dimensions: options.dimensions ?? 4,
        revision: "1",
      },
    },
  });
  return createZvecIndexManifest({
    projectId,
    profileName: "memory",
    profile: catalog.embeddingProfiles.memory!,
    provider: catalog.providers.embeddings,
    metric: "cosine",
    index: options.index ?? "flat",
    createdAt: "2026-09-04T00:00:00.000Z",
  });
}

test("M05-B creates, inspects, closes and reopens the fixed Zvec memory schema off the main thread", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "oat-m05b-lifecycle-"));
  const host = new ZvecMemoryIndexWorkerHost();
  const secondHost = new ZvecMemoryIndexWorkerHost();
  context.after(async () => { await host.dispose(); await secondHost.dispose(); await rm(root, { recursive: true, force: true }); });
  const projectId = "project/alpha";
  const expected = manifest(projectId);
  const layout = createZvecIndexLayout(root, projectId);

  let mainThreadTicked = false;
  const tick = new Promise<void>((resolve) => setImmediate(() => { mainThreadTicked = true; resolve(); }));
  const creating = ZvecMemoryIndex.create({ layout, manifest: expected, workerHost: host });
  await tick;
  const index = await creating;
  assert.equal(mainThreadTicked, true);
  assert.equal(index.schema.name, `oat_memory_${expected.collectionRevision}`);
  assert.equal(index.schema.fields.length, 15);
  assert.deepEqual(index.schema.vector, {
    name: "dense_embedding",
    dataType: "vector_fp32",
    dimensions: 4,
    index: "flat",
    metric: "cosine",
  });
  assert.deepEqual(index.schema.fields.find((field) => field.name === "content"), {
    name: "content",
    dataType: "string",
    nullable: false,
    index: "fts",
    tokenizer: "jieba",
    filters: ["lowercase"],
  });
  assert.deepEqual(index.schema.fields.find((field) => field.name === "valid_to_ms"), {
    name: "valid_to_ms",
    dataType: "int64",
    nullable: true,
    index: "invert",
    rangeOptimization: true,
  });

  const stats = await index.stats();
  assert.equal(stats.documentCount, 0);
  assert.equal(stats.readOnly, false);
  assert.equal(stats.collectionRevision, expected.collectionRevision);
  assert.equal(stats.path, layout.collectionDirectory(expected.collectionRevision));
  assert.deepEqual(await readZvecIndexManifest(layout, projectId, expected.collectionRevision), expected);
  assert.equal((await readZvecIndexRegistry(layout, projectId)).collections[expected.collectionRevision]?.state, "building");

  await assert.rejects(
    () => ZvecMemoryIndex.create({ layout, manifest: expected, workerHost: host }),
    (error: Error & { code?: string }) => error.code === "OAT_ZVEC_ALREADY_EXISTS",
  );
  await assert.rejects(
    () => ZvecMemoryIndex.open({ layout, manifest: expected, workerHost: secondHost }),
    (error: Error & { code?: string }) => error.code === "OAT_ZVEC_WRITER_CONFLICT",
  );

  await index.close();
  await index.close();
  await assert.rejects(() => index.stats(), /closed Zvec memory index/);

  const readOnly = await ZvecMemoryIndex.open({ layout, manifest: expected, workerHost: host, readOnly: true });
  assert.equal((await readOnly.stats()).readOnly, true);
  await readOnly.close();

  const reopened = await ZvecMemoryIndex.open({ layout, manifest: expected, workerHost: host });
  assert.equal((await reopened.stats()).documentCount, 0);
  await reopened.close();
});

test("M05-B rejects manifest drift before open and actual schema drift without retaining a handle", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "oat-m05b-drift-"));
  const host = new ZvecMemoryIndexWorkerHost();
  context.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }); });
  const projectId = "project/drift";
  const original = manifest(projectId);
  const layout = createZvecIndexLayout(root, projectId);
  const originalIndex = await ZvecMemoryIndex.create({ layout, manifest: original, workerHost: host });
  await originalIndex.close();

  await writeFile(layout.manifestFile(original.collectionRevision), JSON.stringify({
    ...original,
    embedding: { ...original.embedding, model: "tampered-model" },
  }), "utf8");
  await assert.rejects(
    () => ZvecMemoryIndex.open({ layout, manifest: original, workerHost: host }),
    /Embedding revision does not match/,
  );
  await writeZvecIndexManifest(layout, projectId, original);

  const differentModel = manifest(projectId, { model: "embed-v2" });
  await cp(layout.collectionDirectory(original.collectionRevision), layout.collectionDirectory(differentModel.collectionRevision), { recursive: true });
  await writeZvecIndexManifest(layout, projectId, differentModel);
  const differentRegistry = registerZvecIndexManifest(emptyZvecIndexRegistry(projectId, differentModel.createdAt), differentModel, differentModel.createdAt);
  await writeZvecIndexRegistry(layout, projectId, differentRegistry);
  await assert.rejects(
    () => ZvecMemoryIndex.open({ layout, manifest: differentModel, workerHost: host }),
    /schema does not match manifest/,
  );

  const differentDimensions = manifest(projectId, { dimensions: 8 });
  await cp(layout.collectionDirectory(original.collectionRevision), layout.collectionDirectory(differentDimensions.collectionRevision), { recursive: true });
  await writeZvecIndexManifest(layout, projectId, differentDimensions);
  const dimensionRegistry = registerZvecIndexManifest(emptyZvecIndexRegistry(projectId, differentDimensions.createdAt), differentDimensions, differentDimensions.createdAt);
  await writeZvecIndexRegistry(layout, projectId, dimensionRegistry);
  await assert.rejects(
    () => ZvecMemoryIndex.open({ layout, manifest: differentDimensions, workerHost: host }),
    /schema does not match manifest/,
  );

  await writeZvecIndexManifest(layout, projectId, original);
  const originalRegistry = registerZvecIndexManifest(emptyZvecIndexRegistry(projectId, original.createdAt), original, original.createdAt);
  await writeZvecIndexRegistry(layout, projectId, originalRegistry);
  const reopened = await ZvecMemoryIndex.open({ layout, manifest: original, workerHost: host });
  await reopened.close();
});
