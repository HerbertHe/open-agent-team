import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DeterministicFakeEmbeddingProvider } from "../memory/embedding-provider";
import type { MemoryVectorIndexWriter } from "../memory/memory-index-worker";
import { SqliteMemoryRepository } from "../memory/memory-repository";
import type { ZvecMemoryDocument, ZvecWriteStatus } from "../memory/zvec-memory-index-contract";
import { SemanticIndexWorker } from "./index-worker";

class FakeIndex implements MemoryVectorIndexWriter {
  documents = new Map<string, ZvecMemoryDocument>();
  constructor(readonly collectionRevision: string, readonly embeddingRevision: string) {}
  async upsert(documents: ZvecMemoryDocument[]): Promise<ZvecWriteStatus[]> {
    for (const document of documents) this.documents.set(document.id, document);
    return documents.map(({ id }) => ({ id, ok: true }));
  }
  async delete(ids: string[]): Promise<ZvecWriteStatus[]> {
    for (const id of ids) this.documents.delete(id);
    return ids.map((id) => ({ id, ok: true }));
  }
  async verifyDurability(ids: string[]): Promise<string[]> { return ids.filter((id) => this.documents.has(id)); }
}

test("semantic outbox vectorizes knowledge with the shared embedding and collection revision", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-semantic-worker-"));
  const databasePath = path.join(root, "memory", "memory.db");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const repository = new SqliteMemoryRepository("semantic-project", databasePath);
  const embedding = new DeterministicFakeEmbeddingProvider({ kind: "deterministic-fake", model: "test", dimensions: 4, normalization: "l2", batchSize: 8, maxAttempts: 1, timeoutMs: 1_000, revision: "1" });
  const index = new FakeIndex("collection-v1", embedding.identity.revision);
  try {
    repository.registerIndexTarget({ collectionRevision: index.collectionRevision, projectId: "semantic-project", embeddingRevision: index.embeddingRevision, state: "active", path: "collections/collection-v1", documentCount: 0, createdAt: "2026-09-16T00:00:00.000Z" });
    const db = new Database(databasePath);
    try {
      db.prepare("INSERT INTO knowledge_collections (id, project_id, name, visibility, created_by, created_at, updated_at) VALUES ('collection', 'semantic-project', 'project', 'project', 'test', ?, ?)").run("2026-09-16T00:00:00.000Z", "2026-09-16T00:00:00.000Z");
      db.prepare(`INSERT INTO knowledge_sources
        (id, project_id, collection_id, path, canonical_path, mime_type, content_hash, size, origin, status, created_at, updated_at)
        VALUES ('source', 'semantic-project', 'collection', 'guide.md', '/guide.md', 'text/markdown', 'source-hash', 10, 'workspace_file', 'ready', ?, ?)`).run("2026-09-16T00:00:00.000Z", "2026-09-16T00:00:00.000Z");
      db.prepare(`INSERT INTO semantic_documents
        (id, project_id, resource_type, resource_id, source_id, visibility, content, content_hash, status, metadata_json, index_state, created_at, updated_at)
        VALUES ('knowledge:chunk', 'semantic-project', 'knowledge', 'chunk', 'source', 'project', 'Shared deployment guide', 'chunk-hash', 'active', '{"kind":"knowledge"}', 'pending', ?, ?)`).run("2026-09-16T00:00:00.000Z", "2026-09-16T00:00:00.000Z");
    } finally { db.close(); }
    assert.equal(repository.reconcileSemanticIndexRevision(index.collectionRevision, "2026-09-16T00:01:00.000Z"), 1);
    let clock = new Date("2026-09-16T00:01:01.000Z");
    const worker = new SemanticIndexWorker({ repository, index, embeddingProvider: embedding, workerId: "semantic-test", now: () => clock });
    const report = await worker.runOnce();
    assert.deepEqual(report, { claimed: 1, indexed: 1, deleted: 0, retried: 0, deadLettered: 0, lostLeases: 0 });
    const stored = index.documents.get("knowledge:chunk");
    assert.equal(stored?.fields.level, "KNOWLEDGE");
    assert.equal(stored?.fields.scope, "project");
    assert.equal(stored?.vector.length, 4);
    const verification = new Database(databasePath, { readonly: true });
    try {
      assert.equal((verification.prepare("SELECT status FROM semantic_index_memberships").get() as { status: string }).status, "indexed");
      assert.equal((verification.prepare("SELECT index_state FROM semantic_documents WHERE id='knowledge:chunk'").get() as { index_state: string }).index_state, "indexed");
    } finally { verification.close(); }

    const mutation = new Database(databasePath);
    try { mutation.prepare("UPDATE semantic_documents SET status='deleted', index_state='pending'").run(); }
    finally { mutation.close(); }
    assert.equal(repository.reconcileSemanticIndexRevision(index.collectionRevision, "2026-09-16T00:02:00.000Z"), 1);
    clock = new Date("2026-09-16T00:02:01.000Z");
    assert.equal((await worker.runOnce()).deleted, 1);
    assert.equal(index.documents.has("knowledge:chunk"), false);

    const restore = new Database(databasePath);
    try { restore.prepare("UPDATE semantic_documents SET status='active', index_state='pending'").run(); }
    finally { restore.close(); }
    assert.equal(repository.reconcileSemanticIndexRevision(index.collectionRevision, "2026-09-16T00:03:00.000Z"), 1);
    clock = new Date("2026-09-16T00:03:01.000Z");
    assert.equal((await worker.runOnce()).indexed, 1);
    assert.equal(index.documents.has("knowledge:chunk"), true);
  } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
});
