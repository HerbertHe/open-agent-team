import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ObservabilityHub } from "../orchestrator/observability-hub";
import type { KnowledgeConfig } from "../types/config";
import { SqliteMemoryRepository } from "../memory/memory-repository";
import { KnowledgeService } from "./knowledge-service";

const config: KnowledgeConfig = {
  enabled: true,
  roots: { project: ".oat/knowledge/project", teams: ".oat/knowledge/teams", uploads: ".oat/knowledge/uploads" },
  watcher: { enabled: false, debounceMs: 100 },
  ingestion: { maxFileSizeMb: 2, chunkTokens: 128, chunkOverlapTokens: 16 },
};

test("ingests, revisions and deletes file-backed project knowledge in memory.db", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-knowledge-"));
  const databasePath = path.join(root, ".state", "memory", "memory.db");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  new SqliteMemoryRepository("knowledge-project", databasePath).close();
  const file = path.join(root, config.roots.project, "guide.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "# Team guide\n\nUse the shared release checklist.");
  const hub = new ObservabilityHub();
  const service = new KnowledgeService("knowledge-project", root, databasePath, config, hub);
  try {
    await service.start();
    const database = new Database(databasePath);
    try {
      const source = database.prepare("SELECT status, version FROM knowledge_sources").get() as { status: string; version: number };
      assert.deepEqual(source, { status: "ready", version: 1 });
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM knowledge_chunks").get() as { count: number }).count, 1);
      const document = database.prepare("SELECT resource_type, visibility, status, index_state FROM semantic_documents WHERE resource_type='knowledge'").get();
      assert.deepEqual(document, { resource_type: "knowledge", visibility: "project", status: "active", index_state: "pending" });

      await fs.writeFile(file, "# Team guide\n\nUse the updated shared release checklist.");
      await service.scan();
      assert.equal((database.prepare("SELECT version FROM knowledge_sources").get() as { version: number }).version, 2);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM semantic_documents WHERE resource_type='knowledge' AND status='active'").get() as { count: number }).count, 1);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM semantic_documents WHERE resource_type='knowledge' AND status='deleted'").get() as { count: number }).count, 1);

      await fs.writeFile(file, Buffer.alloc(config.ingestion.maxFileSizeMb * 1024 * 1024 + 1, "x"));
      await service.scan();
      assert.equal((database.prepare("SELECT status FROM knowledge_sources").get() as { status: string }).status, "failed");
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM semantic_documents WHERE resource_type='knowledge' AND status='active'").get() as { count: number }).count, 0);

      await fs.unlink(file);
      await service.scan();
      assert.equal((database.prepare("SELECT status FROM knowledge_sources").get() as { status: string }).status, "deleted");
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM semantic_documents WHERE resource_type='knowledge' AND status='active'").get() as { count: number }).count, 0);
    } finally { database.close(); }
    assert.ok(hub.snapshot().some(({ type }) => type === "knowledge.source.ready"));
    assert.ok(hub.snapshot().some(({ type }) => type === "knowledge.source.deleted"));
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrieves project and same-team knowledge while denying other teams", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-knowledge-policy-"));
  const databasePath = path.join(root, ".state", "memory", "memory.db");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  new SqliteMemoryRepository("knowledge-policy", databasePath).close();
  await fs.mkdir(path.join(root, config.roots.project), { recursive: true });
  await fs.mkdir(path.join(root, config.roots.teams, "alpha"), { recursive: true });
  await fs.mkdir(path.join(root, config.roots.teams, "beta"), { recursive: true });
  await fs.writeFile(path.join(root, config.roots.project, "project.md"), "project-orbit shared reference");
  await fs.writeFile(path.join(root, config.roots.teams, "alpha", "alpha.md"), "alpha-nebula private team reference");
  await fs.writeFile(path.join(root, config.roots.teams, "beta", "beta.md"), "beta-comet private team reference");
  const service = new KnowledgeService("knowledge-policy", root, databasePath, config, new ObservabilityHub());
  try {
    await service.start();
    const alpha = { agentId: "alpha-worker-0", projectId: "knowledge-policy", teamId: "alpha" };
    assert.equal((await service.search(alpha, "project-orbit")).length, 1);
    assert.equal((await service.search(alpha, "alpha-nebula")).length, 1);
    assert.equal((await service.search(alpha, "beta-comet")).length, 0);
    assert.equal((await service.search({ agentId: "admin", projectId: "knowledge-policy", role: "admin" }, "alpha-nebula")).length, 1);
    const context = await service.buildContext(alpha, "alpha-nebula");
    assert.match(context.context, /<KNOWLEDGE_CONTEXT>/);
    assert.match(context.context, /\[K1\]/);
    assert.equal(context.references[0]?.teamId, "alpha");
    assert.match(context.references[0]?.path ?? "", /knowledge\/teams\/alpha\/alpha\.md/);
  } finally { await service.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("uploads project and team knowledge, exposes operations state and only deletes user uploads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-knowledge-upload-"));
  const databasePath = path.join(root, ".state", "memory", "memory.db");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  new SqliteMemoryRepository("knowledge-upload", databasePath).close();
  const service = new KnowledgeService("knowledge-upload", root, databasePath, config, new ObservabilityHub());
  try {
    await service.start();
    const project = await service.upload("project-guide.md", Buffer.from("project-shared upload knowledge"));
    const team = await service.upload("team-guide.md", Buffer.from("alpha-shared upload knowledge"), "alpha");
    assert.equal(project.origin, "user_upload");
    assert.equal(team.origin, "user_upload");
    const alpha = { agentId: "alpha-worker-0", projectId: "knowledge-upload", teamId: "alpha" };
    const beta = { agentId: "beta-worker-0", projectId: "knowledge-upload", teamId: "beta" };
    assert.equal((await service.search(alpha, "alpha-shared")).length, 1);
    assert.equal((await service.search(beta, "alpha-shared")).length, 0);
    assert.equal((await service.search(beta, "project-shared")).length, 1);
    const snapshot = service.operationsSnapshot();
    assert.equal(snapshot.sourceCount, 2);
    assert.equal(snapshot.counts.ready, 2);
    assert.equal(snapshot.chunkCount, 2);
    assert.equal(snapshot.index.pending, 2);
    await service.deleteUploadedSource(team.id);
    assert.equal((await service.search(alpha, "alpha-shared")).length, 0);
    assert.equal(service.operationsSnapshot().sourceCount, 1);
    await assert.rejects(() => service.upload("../escape.md", Buffer.from("no")), /Invalid knowledge file name/);
  } finally { await service.stop(); rmSync(root, { recursive: true, force: true }); }
});
