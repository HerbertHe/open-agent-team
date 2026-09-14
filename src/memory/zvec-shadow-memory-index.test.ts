import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { DeterministicFakeEmbeddingProvider, EmbeddingProviderError, type EmbeddingProvider } from "./embedding-provider";
import { MemoryIndexWorker } from "./memory-index-worker";
import { SqliteMemoryRepository } from "./memory-repository";
import { ShadowMemoryRetriever, type MemoryIndex, type MemoryRetrievalResult, type MemoryRetriever } from "./memory-retriever";
import type { MemoryRecord } from "./types";
import { createZvecIndexManifest } from "./zvec-index-identity";
import { createZvecIndexLayout } from "./zvec-index-registry";
import { ZvecMemoryIndex, ZvecMemoryIndexWorkerHost } from "./zvec-memory-index";
import { buildZvecMemoryAuthorizationFilter, ZvecShadowMemoryIndex } from "./zvec-shadow-memory-index";

function databasePath(root: string): string {
  const file = path.join(root, "memory", "memory.db");
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function addMemory(repository: SqliteMemoryRepository, owner: string, content: string, at: string): string {
  repository.capture({
    id: `event-${createHash("sha256").update(`${owner}\0${content}`).digest("hex").slice(0, 16)}`,
    ownerAgentId: owner,
    sourceAgentId: owner,
    role: owner === "admin" ? "admin" : "leader",
    trustLevel: owner === "admin" ? 100 : 90,
    eventType: "report_progress",
    kind: "decision",
    content,
    metadataJson: "{}",
    createdAt: at,
    teamId: owner === "admin" ? undefined : owner.replace(/-lead$/, ""),
    fingerprint: createHash("sha256").update(content).digest("hex"),
  }, 20);
  repository.consolidate({ maxEvents: 20, minEvidence: 50, retentionDays: 180, l1MaxItems: 20, l1TtlHours: 100_000, isCancelled: () => false });
  return repository.list({ agentId: owner, level: "L2" }).find((memory) => memory.content === content)!.id;
}

test("M08 filter builder rejects unrepresentable values and never grants admin scope by flag alone", () => {
  const filter = buildZvecMemoryAuthorizationFilter({
    projectId: "project-oat",
    agentId: "external-admin",
    globalScope: true,
    nowMs: 1_000,
  });
  assert.doesNotMatch(filter, /scope in \('project', 'team', 'global'\)/);
  assert.throws(() => buildZvecMemoryAuthorizationFilter({ projectId: "project' OR 1=1 --", agentId: "admin", globalScope: true, nowMs: 1_000 }), /single quotes/);
  assert.throws(() => buildZvecMemoryAuthorizationFilter({ projectId: "project-oat", agentId: "admin' OR scope = 'global", globalScope: true, nowMs: 1_000 }), /single quotes/);
  assert.throws(() => buildZvecMemoryAuthorizationFilter({ projectId: "bad\0project", agentId: "admin", globalScope: true, nowMs: 1_000 }), /control characters/);
});

test("M08 shadow wrapper returns lexical results without waiting for or exposing shadow output", async () => {
  const primaryResult: MemoryRetrievalResult = { l1: [], l2: [], l3: [] };
  const primary: MemoryRetriever = { retrieve: async () => primaryResult };
  let resolveShadow!: (value: MemoryRecord[] | undefined) => void;
  let completed = false;
  const index: MemoryIndex = {
    backend: "test-shadow",
    search: async () => new Promise<MemoryRecord[] | undefined>((resolve) => { resolveShadow = (value) => { completed = true; resolve(value); }; }),
    close() {},
  };
  const retriever = new ShadowMemoryRetriever(primary, index, 30);
  const result = await retriever.retrieve({ agentId: "admin", query: "query", globalScope: true, l2MaxResults: 5, l3MaxPromptItems: 5 });
  assert.equal(result, primaryResult);
  assert.equal(completed, false);
  resolveShadow([]);
  await retriever.waitForShadow();
  assert.equal(completed, true);
});

test("M08 executes Dense, Jieba FTS and exact routes with application-side authorization and redacted audit", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m08-shadow-"));
  const projectId = "project-oat";
  const file = databasePath(root);
  const repository = new SqliteMemoryRepository(projectId, file);
  const adminId = addMemory(repository, "admin", "未绑定的微信通道账号默认交由智能体资源主管处理。", "2026-09-08T01:00:00.000Z");
  const alphaId = addMemory(repository, "alpha-lead", "Worker 完成任务后先向 Leader 汇报。", "2026-09-08T02:00:00.000Z");
  const betaId = addMemory(repository, "beta-lead", "Orion 团队使用隔离的私有部署凭据。", "2026-09-08T03:00:00.000Z");
  const raw = new Database(file);
  raw.prepare("UPDATE memory_items SET scope='team', team_id='alpha' WHERE id=?").run(alphaId);
  raw.prepare("UPDATE memory_items SET scope='team', team_id='beta' WHERE id=?").run(betaId);
  raw.close();

  const catalog = parseGlobalModelCatalog({ embeddingProfiles: { memory: { kind: "deterministic-fake", model: "shadow-test", dimensions: 8, revision: "1", normalization: "l2" } } });
  const profile = catalog.embeddingProfiles.memory!;
  if (profile.kind !== "deterministic-fake") throw new Error("Expected deterministic profile.");
  const provider = new DeterministicFakeEmbeddingProvider(profile);
  const manifest = createZvecIndexManifest({ projectId, profileName: "memory", profile, metric: "cosine", index: "flat", createdAt: "2026-09-09T00:00:00.000Z" });
  const layout = createZvecIndexLayout(path.join(root, "indexes"), projectId);
  const host = new ZvecMemoryIndexWorkerHost();
  const index = await ZvecMemoryIndex.create({ layout, manifest, workerHost: host });
  context.after(async () => { await index.close(); await host.dispose(); repository.close(); rmSync(root, { recursive: true, force: true }); });
  repository.registerIndexTarget({ collectionRevision: manifest.collectionRevision, projectId, embeddingRevision: manifest.embeddingRevision, state: "building", path: `collections/${manifest.collectionRevision}`, documentCount: 0, createdAt: manifest.createdAt });
  assert.equal(repository.enqueueIndexBackfill(manifest.collectionRevision, "2026-09-10T00:00:00.000Z"), 3);
  const writer = new MemoryIndexWorker({ repository, index, embeddingProvider: provider, workerId: "m08-writer", now: () => new Date("2026-09-10T01:00:00.000Z") });
  assert.equal((await writer.runOnce()).indexed, 3);

  const shadow = new ZvecShadowMemoryIndex({ projectId, repository, index, mode: "hybrid", embeddingProvider: provider, maxResults: 8, now: () => new Date("2026-09-10T02:00:00.000Z") });
  const admin = await shadow.search({ agentId: "admin", globalScope: true, query: "api_key=top-secret 微信通道 资源主管", limit: 30 });
  assert.ok(admin?.some(({ id }) => id === adminId));
  let audit = repository.listRetrievalRuns(1)[0]!;
  assert.equal(audit.backend, "zvec_shadow_hybrid");
  assert.doesNotMatch(audit.query, /top-secret/);
  assert.match(audit.query, /\[REDACTED\]/);
  assert.equal(audit.embeddingIdentity, manifest.embeddingRevision);
  assert.equal(audit.fallbackReason, undefined);

  const alpha = await shadow.search({ agentId: "alpha-lead", globalScope: false, query: "Orion 私有部署凭据", limit: 30 });
  assert.equal(alpha?.some(({ id }) => id === betaId), false);
  audit = repository.listRetrievalRuns(1)[0]!;
  assert.equal(audit.candidateIds.includes(betaId), false);
  assert.equal(audit.selectedIds.includes(betaId), false);

  const injected = await shadow.search({ agentId: "alpha-lead' OR scope = 'team", globalScope: true, query: "Orion 私有部署凭据", limit: 30 });
  assert.equal(injected?.some(({ id }) => id === betaId) ?? false, false);
  audit = repository.listRetrievalRuns(1)[0]!;
  assert.match(audit.fallbackReason ?? "", /single quotes/);

  const degradedProvider: EmbeddingProvider = {
    available: true,
    identity: provider.identity,
    embedDocuments: (texts) => provider.embedDocuments(texts),
    embedQuery: async () => { throw new EmbeddingProviderError("query embedding unavailable", "timeout", true); },
  };
  const degraded = new ZvecShadowMemoryIndex({ projectId, repository, index, mode: "hybrid", embeddingProvider: degradedProvider, now: () => new Date("2026-09-10T03:00:00.000Z") });
  const ftsFallback = await degraded.search({ agentId: "admin", globalScope: true, query: "微信通道", limit: 30 });
  assert.ok(ftsFallback?.some(({ id }) => id === adminId));
  audit = repository.listRetrievalRuns(1)[0]!;
  assert.match(audit.fallbackReason ?? "", /dense: query embedding unavailable/);
});
