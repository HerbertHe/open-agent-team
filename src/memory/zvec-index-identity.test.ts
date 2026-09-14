import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import {
  collectionIdentityRevision,
  createZvecIndexManifest,
  ZvecIndexManifestSchema,
} from "./zvec-index-identity";
import {
  ActiveIndexPointerSchema,
  createZvecIndexLayout,
  emptyZvecIndexRegistry,
  readActiveIndexPointer,
  readZvecIndexManifest,
  readZvecIndexRegistry,
  registerZvecIndexManifest,
  resolveActiveRegistryEntry,
  writeActiveIndexPointer,
  writeZvecIndexManifest,
  writeZvecIndexRegistry,
  ZvecIndexRegistrySchema,
} from "./zvec-index-registry";

function catalog(overrides: Record<string, unknown> = {}) {
  return parseGlobalModelCatalog({
    providers: { openai: { compatible_type: "openai", base_url: "https://api.example/v1", api_key: "top-secret" } },
    embeddingProfiles: {
      memory: {
        kind: "openai-compatible",
        provider: "openai",
        model: "embed-v1",
        dimensions: 768,
        normalization: "provider-default",
        ...overrides,
      },
    },
  });
}

function manifest(overrides: Record<string, unknown> = {}) {
  const models = catalog(overrides);
  return createZvecIndexManifest({
    projectId: "project/alpha",
    profileName: "memory",
    profile: models.embeddingProfiles.memory!,
    provider: models.providers.openai,
    metric: "cosine",
    index: "flat",
    createdAt: "2026-09-03T00:00:00.000Z",
  });
}

test("embedding and collection revisions separate content identity from runtime settings", () => {
  const baseline = manifest();
  const runtimeOnly = manifest({ timeoutMs: 60_000, batchSize: 7, maxAttempts: 8 });
  const secretOnlyCatalog = parseGlobalModelCatalog({
    providers: { openai: { compatible_type: "openai", base_url: "https://api.example/v1", api_key: "another-secret" } },
    embeddingProfiles: { memory: catalog().embeddingProfiles.memory },
  });
  const secretOnly = createZvecIndexManifest({
    projectId: "project/alpha",
    profileName: "memory",
    profile: secretOnlyCatalog.embeddingProfiles.memory!,
    provider: secretOnlyCatalog.providers.openai,
    metric: "cosine",
    index: "flat",
    createdAt: "2026-09-03T00:00:00.000Z",
  });

  assert.equal(catalog().embeddingProfiles.memory?.revision, "1");
  assert.equal(baseline.embeddingRevision, runtimeOnly.embeddingRevision);
  assert.equal(baseline.collectionRevision, runtimeOnly.collectionRevision);
  assert.equal(baseline.embeddingRevision, secretOnly.embeddingRevision);
  assert.notEqual(baseline.embeddingRevision, manifest({ revision: "2" }).embeddingRevision);
  assert.notEqual(baseline.embeddingRevision, manifest({ model: "embed-v2" }).embeddingRevision);
  assert.notEqual(baseline.embeddingRevision, manifest({ dimensions: 1_536 }).embeddingRevision);
  assert.notEqual(baseline.collectionRevision, collectionIdentityRevision({
    embeddingRevision: baseline.embeddingRevision,
    metric: "cosine",
    index: "hnsw",
  }));
  assert.notEqual(baseline.collectionRevision, collectionIdentityRevision({
    embeddingRevision: baseline.embeddingRevision,
    metric: "cosine",
    index: "flat",
    vectorSchemaVersion: 2,
  }));
  assert.notEqual(baseline.collectionRevision, collectionIdentityRevision({
    embeddingRevision: baseline.embeddingRevision,
    metric: "cosine",
    index: "flat",
    indexProjectionVersion: 2,
  }));
  assert.doesNotMatch(JSON.stringify(baseline), /top-secret|another-secret/);

  const canonical = catalog();
  const equivalent = parseGlobalModelCatalog({
    providers: { openai: { compatible_type: "openai", base_url: "https://API.EXAMPLE:443/v1/", api_key: "secret" } },
    embeddingProfiles: { memory: canonical.embeddingProfiles.memory },
  });
  const equivalentManifest = createZvecIndexManifest({
    projectId: "project/alpha",
    profileName: "memory",
    profile: equivalent.embeddingProfiles.memory!,
    provider: equivalent.providers.openai,
    metric: "cosine",
    index: "flat",
    createdAt: baseline.createdAt,
  });
  assert.equal(baseline.embeddingRevision, equivalentManifest.embeddingRevision);
});

test("manifest schema detects frozen identity drift", () => {
  const valid = manifest();
  assert.throws(() => ZvecIndexManifestSchema.parse({ ...valid, embeddingRevision: "0000000000000000" }), /Embedding revision/);
  assert.throws(() => ZvecIndexManifestSchema.parse({ ...valid, collectionRevision: "0000000000000000" }), /Collection revision/);
  assert.throws(() => ZvecIndexManifestSchema.parse({ ...valid, state: "building", readyAt: "2026-09-03T01:00:00.000Z" }), /building manifest/);
  assert.throws(() => ZvecIndexManifestSchema.parse({ ...valid, state: "ready" }), /requires a ready timestamp/);
  const unsafe = parseGlobalModelCatalog({
    providers: { openai: { compatible_type: "openai", base_url: "https://user:password@api.example/v1" } },
    embeddingProfiles: { memory: { kind: "openai-compatible", provider: "openai", model: "embed", dimensions: 3 } },
  });
  assert.throws(() => createZvecIndexManifest({
    projectId: "project",
    profileName: "memory",
    profile: unsafe.embeddingProfiles.memory!,
    provider: unsafe.providers.openai,
    metric: "cosine",
    index: "flat",
  }), /cannot contain credentials/);
});

test("revision-addressed layouts cannot escape the configured root", () => {
  const root = path.join(tmpdir(), "oat-index-root");
  const first = createZvecIndexLayout(root, "../../Project Alpha");
  const second = createZvecIndexLayout(root, "../../Project Beta");
  assert.ok(first.projectDirectory.startsWith(`${path.resolve(root)}${path.sep}`));
  assert.notEqual(first.projectDirectory, second.projectDirectory);
  assert.doesNotMatch(path.relative(root, first.projectDirectory), /\.\./);
  assert.throws(() => first.collectionDirectory("../../escape"));
  assert.equal(path.dirname(first.manifestFile(manifest().collectionRevision)), first.collectionDirectory(manifest().collectionRevision));
});

test("registry, manifest and active pointer persist atomically with project ownership checks", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "oat-m05a-"));
  context.after(async () => { await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })); });
  const projectId = "project/alpha";
  const layout = createZvecIndexLayout(root, projectId);
  const indexManifest = manifest();
  const readyManifest = ZvecIndexManifestSchema.parse({
    ...indexManifest,
    state: "ready",
    readyAt: "2026-09-03T00:30:00.000Z",
  });
  const buildingRegistry = registerZvecIndexManifest(emptyZvecIndexRegistry(projectId, indexManifest.createdAt), indexManifest, indexManifest.createdAt);
  const buildingEntry = buildingRegistry.collections[indexManifest.collectionRevision]!;
  const registry = ZvecIndexRegistrySchema.parse({
    ...buildingRegistry,
    collections: {
      [indexManifest.collectionRevision]: { ...buildingEntry, state: "ready", readyAt: "2026-09-03T00:30:00.000Z" },
    },
  });

  await writeZvecIndexManifest(layout, projectId, indexManifest);
  await writeZvecIndexRegistry(layout, projectId, buildingRegistry);
  const pointer = ActiveIndexPointerSchema.parse({
    formatVersion: 1,
    projectId,
    collectionRevision: indexManifest.collectionRevision,
    activatedAt: "2026-09-03T01:00:00.000Z",
  });
  await assert.rejects(() => writeActiveIndexPointer(layout, projectId, pointer), /'building' state/);
  await writeZvecIndexRegistry(layout, projectId, registry);
  await assert.rejects(() => writeActiveIndexPointer(layout, projectId, pointer), /manifest in 'building' state/);
  await writeZvecIndexManifest(layout, projectId, readyManifest);
  await writeActiveIndexPointer(layout, projectId, pointer);

  assert.deepEqual(await readZvecIndexManifest(layout, projectId, indexManifest.collectionRevision), readyManifest);
  assert.deepEqual(await readZvecIndexRegistry(layout, projectId), registry);
  assert.deepEqual(await readActiveIndexPointer(layout, projectId), pointer);
  assert.equal((await stat(layout.registryFile)).mode & 0o777, 0o600);
  assert.equal((await stat(layout.activePointerFile)).mode & 0o777, 0o600);
  assert.equal((await stat(layout.manifestFile(indexManifest.collectionRevision))).mode & 0o777, 0o600);
  assert.equal((await readdir(layout.projectDirectory)).some((name) => name.endsWith(".tmp")), false);
  assert.doesNotMatch(await readFile(layout.manifestFile(indexManifest.collectionRevision), "utf8"), /top-secret/);

  await assert.rejects(() => readZvecIndexRegistry(layout, "another-project"), /belongs to project/);
  await assert.rejects(() => writeActiveIndexPointer(layout, "another-project", pointer), /belongs to project/);

  const otherLayout = createZvecIndexLayout(root, "another-project");
  await assert.rejects(() => writeZvecIndexRegistry(otherLayout, projectId, registry), /Index layout belongs to project/);
});

test("registry rejects ambiguous active/building state and untrusted paths", async () => {
  const first = manifest();
  const second = manifest({ revision: "2" });
  let registry = registerZvecIndexManifest(emptyZvecIndexRegistry(first.projectId, first.createdAt), first, first.createdAt);
  assert.deepEqual(registerZvecIndexManifest(registry, first, "2026-09-03T02:00:00.000Z"), registry);
  assert.throws(() => registerZvecIndexManifest(registry, second, second.createdAt), /at most one building/);
  registry = registerZvecIndexManifest(emptyZvecIndexRegistry(first.projectId, first.createdAt), first, first.createdAt);
  const entry = registry.collections[first.collectionRevision]!;
  assert.throws(() => ZvecIndexRegistrySchema.parse({
    ...registry,
    collections: { [first.collectionRevision]: { ...entry, path: "../../escape" } },
  }));

  const pointer = ActiveIndexPointerSchema.parse({
    formatVersion: 1,
    projectId: first.projectId,
    collectionRevision: first.collectionRevision,
    activatedAt: "2026-09-03T01:00:00.000Z",
  });
  assert.throws(() => resolveActiveRegistryEntry(registry, pointer), /'building' state/);
  const ready = ZvecIndexRegistrySchema.parse({
    ...registry,
    collections: { [first.collectionRevision]: { ...entry, state: "ready", readyAt: "2026-09-03T00:30:00.000Z" } },
  });
  assert.equal(resolveActiveRegistryEntry(ready, pointer).collectionRevision, first.collectionRevision);

  const firstActive = { ...entry, state: "active", readyAt: "2026-09-03T00:30:00.000Z", activatedAt: "2026-09-03T01:00:00.000Z" };
  const secondEntry = {
    ...firstActive,
    collectionRevision: second.collectionRevision,
    embeddingRevision: second.embeddingRevision,
    path: `collections/${second.collectionRevision}`,
  };
  assert.throws(() => ZvecIndexRegistrySchema.parse({
    ...registry,
    collections: { [first.collectionRevision]: firstActive, [second.collectionRevision]: secondEntry },
  }), /at most one active/);
});
