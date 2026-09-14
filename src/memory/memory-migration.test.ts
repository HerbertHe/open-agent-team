import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteMemoryRepository } from "./memory-repository";
import { createHash, randomUUID } from "node:crypto";

const V2_COLUMNS = [
  "schema_version", "scope", "trust_level", "subject", "predicate", "object_json", "valid_from", "valid_to",
  "supersedes_id", "contradiction_ids", "content_hash", "extraction_model", "extraction_version", "index_state",
];

const V7_TABLES = ["memory_index_outbox", "memory_retrieval_runs", "memory_feedback", "memory_relations", "memory_index_memberships", "memory_index_registry", "memory_index_migrations", "memory_extraction_runs", "memory_candidate_matches", "memory_governance_runs", "memory_access_audit"];

function legacySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE memory_events (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_agent_id TEXT NOT NULL, source_agent_id TEXT,
      role TEXT NOT NULL, event_type TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, consolidated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, team_id TEXT,
      level TEXT NOT NULL CHECK(level IN ('L1','L2','L3')), kind TEXT NOT NULL, content TEXT NOT NULL,
      summary TEXT NOT NULL, fingerprint TEXT NOT NULL, confidence REAL NOT NULL, salience REAL NOT NULL,
      evidence_count INTEGER NOT NULL DEFAULT 1, source_event_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_confirmed_at TEXT NOT NULL, UNIQUE(agent_id, level, fingerprint)
    );
    CREATE TABLE dream_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, trigger TEXT NOT NULL, started_at TEXT NOT NULL,
      completed_at TEXT, processed_events INTEGER NOT NULL DEFAULT 0, created_l2 INTEGER NOT NULL DEFAULT 0,
      promoted_l3 INTEGER NOT NULL DEFAULT 0, error TEXT
    );
    CREATE TABLE memory_injections (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, query TEXT NOT NULL, memory_ids TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
}

function insertLegacyRows(db: Database.Database): void {
  const now = "2026-09-01T00:00:00.000Z";
  db.prepare(`INSERT INTO memory_events
    (id, project_id, owner_agent_id, source_agent_id, role, event_type, kind, content, created_at, consolidated)
    VALUES ('event-worker', 'legacy-project', 'alpha-lead', 'alpha-worker-0', 'worker', 'task.completed', 'episodic', 'worker result', ?, 1)`).run(now);
  const insert = db.prepare(`INSERT INTO memory_items
    (id, project_id, agent_id, team_id, level, kind, content, summary, fingerprint, confidence, salience, evidence_count,
     source_event_ids, status, created_at, updated_at, last_confirmed_at)
    VALUES (?, 'legacy-project', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`);
  insert.run("legacy-l1", "alpha-lead", "alpha", "L1", "working", "working item", "working item", "fp-l1", 1, 1, "[]", "active", now, now, now);
  insert.run("legacy-l2", "alpha-lead", "alpha", "L2", "episodic", "worker result", "worker result", "fp-l2", .7, .6, '["event-worker"]', "active", now, now, now);
  insert.run("legacy-l3", "admin", null, "L3", "procedure", "stable procedure", "stable procedure", "fp-l3", .9, .9, "[]", "active", now, now, now);
  insert.run("legacy-forgotten", "admin", null, "L2", "decision", "forgotten item", "forgotten item", "fp-forgotten", .5, .5, "[]", "forgotten", now, now, now);
}

function databasePath(root: string): string {
  const value = path.join(root, "memory", "memory.db");
  mkdirSync(path.dirname(value), { recursive: true });
  return value;
}

test("M13 creates schema v7 on an empty database", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-v2-empty-"));
  const file = databasePath(root);
  const repository = new SqliteMemoryRepository("empty-project", file);
  repository.close();
  try {
    const db = new Database(file, { readonly: true });
    try {
      assert.equal(db.pragma("user_version", { simple: true }), 7);
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
      for (const table of V7_TABLES) assert.ok(tables.has(table), `missing ${table}`);
      const eventColumns = new Set((db.prepare("PRAGMA table_info(memory_events)").all() as Array<{ name: string }>).map((row) => row.name));
      assert.ok(eventColumns.has("extraction_attempts"));
      assert.ok(eventColumns.has("extraction_error"));
      const itemColumns = new Set((db.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>).map((row) => row.name));
      for (const column of ["independent_evidence_count", "governance_version", "confirmed_at", "confirmed_by"]) assert.ok(itemColumns.has(column));
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_index_outbox").get() as { count: number }).count, 0);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M06-A migrates legacy rows and creates concrete idempotent backfill memberships", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-v2-legacy-"));
  const file = databasePath(root);
  const legacy = new Database(file);
  legacySchema(legacy);
  insertLegacyRows(legacy);
  legacy.close();
  try {
    const repository = new SqliteMemoryRepository("legacy-project", file);
    repository.registerIndexTarget({ collectionRevision: "collection-v1", projectId: "legacy-project", embeddingRevision: "embedding-v1", state: "building", path: "collections/collection-v1", documentCount: 0, createdAt: "2026-09-03T00:00:00.000Z" });
    assert.equal(repository.enqueueIndexBackfill("collection-v1"), 2);
    assert.equal(repository.enqueueIndexBackfill("collection-v1"), 2);
    repository.close();
    new SqliteMemoryRepository("legacy-project", file).close();
    const db = new Database(file, { readonly: true });
    try {
      assert.equal(db.pragma("user_version", { simple: true }), 7);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as { count: number }).count, 4);
      const columns = new Set((db.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>).map((row) => row.name));
      for (const column of V2_COLUMNS) assert.ok(columns.has(column), `missing ${column}`);
      const outbox = db.prepare("SELECT memory_id, operation, target_index, status FROM memory_index_outbox ORDER BY memory_id").all();
      assert.deepEqual(outbox, [
        { memory_id: "legacy-l2", operation: "upsert", target_index: "collection-v1", status: "pending" },
        { memory_id: "legacy-l3", operation: "upsert", target_index: "collection-v1", status: "pending" },
      ]);
      const migrated = db.prepare("SELECT id, scope, trust_level, index_state, length(content_hash) AS hash_length FROM memory_items ORDER BY id").all() as Array<Record<string, unknown>>;
      assert.equal(migrated.find((row) => row.id === "legacy-l2")?.trust_level, 80);
      assert.equal(migrated.find((row) => row.id === "legacy-l2")?.index_state, "pending");
      assert.equal(migrated.find((row) => row.id === "legacy-l1")?.index_state, "not_applicable");
      assert.equal(migrated.find((row) => row.id === "legacy-l2")?.scope, "team");
      assert.ok(migrated.filter((row) => row.id !== "legacy-l2").every((row) => row.scope === "project"));
      assert.ok(migrated.every((row) => row.hash_length === 64));
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M06-A resumes a partially applied migration without dropping data or retaining default targets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-v2-partial-"));
  const file = databasePath(root);
  const partial = new Database(file);
  legacySchema(partial);
  insertLegacyRows(partial);
  partial.exec("ALTER TABLE memory_items ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 2");
  partial.exec("ALTER TABLE memory_items ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
  partial.exec("ALTER TABLE memory_items ADD COLUMN trust_level INTEGER NOT NULL DEFAULT 100");
  partial.exec("ALTER TABLE memory_items ADD COLUMN index_state TEXT NOT NULL DEFAULT 'not_applicable'");
  partial.pragma("user_version = 1");
  partial.close();
  try {
    new SqliteMemoryRepository("legacy-project", file).close();
    const db = new Database(file, { readonly: true });
    try {
      assert.equal(db.pragma("user_version", { simple: true }), 7);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_items").get() as { count: number }).count, 4);
      const columns = new Set((db.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>).map((row) => row.name));
      for (const column of V2_COLUMNS) assert.ok(columns.has(column), `missing ${column}`);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_index_outbox").get() as { count: number }).count, 0);
      const recovered = db.prepare("SELECT trust_level, index_state FROM memory_items WHERE id='legacy-l2'").get() as { trust_level: number; index_state: string };
      assert.deepEqual(recovered, { trust_level: 80, index_state: "not_applicable" });
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M06-A writes concrete per-target upsert and idempotent delete operations", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-v2-outbox-"));
  const file = databasePath(root);
  const repository = new SqliteMemoryRepository("outbox-project", file);
  try {
    repository.registerIndexTarget({ collectionRevision: "collection-v1", projectId: "outbox-project", embeddingRevision: "embedding-v1", state: "building", path: "collections/collection-v1", documentCount: 0, createdAt: "2026-09-03T00:00:00.000Z" });
    const content = "A canonical memory pending indexing";
    repository.capture({
      id: randomUUID(), ownerAgentId: "admin", sourceAgentId: "admin", role: "admin", eventType: "report_progress",
      trustLevel: 100,
      kind: "decision", content, metadataJson: "{}", createdAt: "2026-09-03T00:00:00.000Z",
      fingerprint: createHash("sha256").update(content).digest("hex"),
    }, 10);
    repository.consolidate({ maxEvents: 10, minEvidence: 20, retentionDays: 180, l1MaxItems: 10, l1TtlHours: 100_000, isCancelled: () => false });
    const memory = repository.list({ level: "L2" })[0];
    assert.ok(memory);
    assert.equal(repository.forget(memory.id, "2026-09-03T01:00:00.000Z"), true);
    assert.equal(repository.forget(memory.id, "2026-09-03T02:00:00.000Z"), true);
  } finally { repository.close(); }
  try {
    const db = new Database(file, { readonly: true });
    try {
      const operations = db.prepare("SELECT operation, target_index, status FROM memory_index_outbox ORDER BY operation DESC").all();
      assert.deepEqual(operations, [
        { operation: "upsert", target_index: "collection-v1", status: "completed" },
        { operation: "delete", target_index: "collection-v1", status: "pending" },
      ]);
      assert.equal((db.prepare("SELECT index_state FROM memory_items WHERE level='L2'").get() as { index_state: string }).index_state, "pending");
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
