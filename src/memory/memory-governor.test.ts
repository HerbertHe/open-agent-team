import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { EmbeddingProvider } from "./embedding-provider";
import type { GovernedMemoryCandidate, MemoryExtractionEvent } from "./memory-extractor";
import { GovernedMemoryCandidates } from "./memory-governor";
import { SqliteMemoryRepository } from "./memory-repository";

const baseCandidate: GovernedMemoryCandidate = {
  kind: "decision", summary: "SQLite is the authority", subject: "memory storage", predicate: "authority", object: "SQLite",
  scope: "private", confidence: .9, salience: .8, validFrom: null, validTo: null, trustLevel: 100,
  content: "memory storage authority SQLite",
};

function withRepository(run: (repository: SqliteMemoryRepository, databasePath: string) => Promise<void> | void): Promise<void> | void {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-governor-"));
  const databasePath = path.join(root, "memory.db");
  const repository = new SqliteMemoryRepository("project-test", databasePath);
  const complete = () => { repository.close(); rmSync(root, { recursive: true, force: true }); };
  try {
    const result = run(repository, databasePath);
    if (result instanceof Promise) return result.finally(complete);
    complete();
  } catch (error) { complete(); throw error; }
}

function addCandidate(repository: SqliteMemoryRepository, options: {
  id: string; sourceAgentId?: string; taskId?: string; sourceType?: "internal" | "channel" | "a2a";
  candidate?: GovernedMemoryCandidate; createdAt?: string;
}): void {
  const createdAt = options.createdAt ?? `2026-09-10T00:00:${options.id.slice(-2).padStart(2, "0")}.000Z`;
  const sourceType = options.sourceType ?? "internal";
  const trustLevel = sourceType === "a2a" ? 30 : sourceType === "channel" ? 40 : 100;
  repository.capture({
    id: options.id, ownerAgentId: "admin", sourceAgentId: options.sourceAgentId ?? "admin", role: "admin", trustLevel,
    eventType: "report_progress", taskId: options.taskId, kind: "decision", content: options.candidate?.content ?? baseCandidate.content,
    metadataJson: JSON.stringify({ sourceType, trustLevel }), createdAt, fingerprint: `l1-${options.id}`,
  }, 20);
  const event: MemoryExtractionEvent = {
    id: options.id, ownerAgentId: "admin", sourceAgentId: options.sourceAgentId ?? "admin", role: "admin",
    eventType: "report_progress", kind: "decision", content: options.candidate?.content ?? baseCandidate.content,
    createdAt, trustLevel, sourceType, attempts: 0,
  };
  repository.commitExtraction(event, [options.candidate ?? { ...baseCandidate, trustLevel }], {
    id: `run-${options.id}`, eventId: options.id, model: "openai/fact-model", version: "m11-v1", status: "success",
    candidateCount: 1, inputChars: 20, latencyMs: 1, createdAt,
  });
}

test("M12 exact duplicates merge independent evidence, activate L2, and auto-promote trusted internal facts", async () => {
  await withRepository(async (repository) => {
    addCandidate(repository, { id: "event-01", taskId: "task-a" });
    addCandidate(repository, { id: "event-02", taskId: "task-b" });
    const result = await new GovernedMemoryCandidates(repository).govern(20, 2);
    assert.equal(result.activated, 1);
    assert.equal(result.autoPromotedL3, 1);
    const active = repository.list({ level: "L2" });
    assert.equal(active.length, 1);
    assert.equal(active[0]?.evidenceCount, 2);
    assert.equal(active[0]?.independentEvidenceCount, 2);
    assert.equal(active[0]?.governanceVersion, "m12-v1");
    assert.equal(repository.list({ level: "L3" }).length, 1);
  });
});

test("M12 repeated observations from one source task do not count as independent evidence", async () => {
  await withRepository(async (repository) => {
    addCandidate(repository, { id: "event-03", taskId: "same-task" });
    addCandidate(repository, { id: "event-04", taskId: "same-task" });
    await new GovernedMemoryCandidates(repository).govern(20, 2);
    assert.equal(repository.list({ level: "L2" }).length, 0);
    const retained = repository.list({ level: "L2", status: "candidate" });
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.independentEvidenceCount, 1);
    assert.equal(repository.list({ level: "L3" }).length, 0);
  });
});

test("M12 external A2A evidence can merge but can never activate or auto-promote", async () => {
  await withRepository(async (repository) => {
    addCandidate(repository, { id: "event-05", sourceAgentId: "vendor-a", taskId: "a", sourceType: "a2a", candidate: { ...baseCandidate, scope: "private", trustLevel: 30 } });
    addCandidate(repository, { id: "event-06", sourceAgentId: "vendor-b", taskId: "b", sourceType: "a2a", candidate: { ...baseCandidate, scope: "private", trustLevel: 30 } });
    await new GovernedMemoryCandidates(repository).govern(20, 2);
    assert.equal(repository.list({ level: "L2" }).length, 0);
    assert.equal(repository.list({ level: "L2", status: "candidate" })[0]?.independentEvidenceCount, 2);
    assert.equal(repository.list({ level: "L3" }).length, 0);
  });
});

test("M12 enforces validity windows before a candidate can become current", async () => {
  await withRepository(async (repository) => {
    const expired = { ...baseCandidate, validFrom: "2026-09-01T00:00:00.000Z", validTo: "2026-09-02T00:00:00.000Z" };
    addCandidate(repository, { id: "event-11", taskId: "a", candidate: expired });
    const result = await new GovernedMemoryCandidates(repository, undefined, () => new Date("2026-09-10T00:00:00.000Z")).govern(20, 2);
    assert.equal(result.expired, 1);
    assert.equal(repository.list({ level: "L2", status: "superseded" }).length, 1);
    assert.equal(repository.list({ level: "L2" }).length, 0);
  });
});

test("M12 conflicts stay auditable until human confirmation supersedes the old current fact", async () => {
  await withRepository(async (repository, databasePath) => {
    addCandidate(repository, { id: "event-07", taskId: "old" });
    const old = repository.list({ status: "candidate" })[0]!;
    assert.equal(repository.confirmCandidate(old.id, "user", "2026-09-10T01:00:00.000Z")?.status, "active");
    addCandidate(repository, { id: "event-08", taskId: "new", candidate: { ...baseCandidate, summary: "Postgres is the authority", object: "Postgres", content: "memory storage authority Postgres" } });
    const governed = await new GovernedMemoryCandidates(repository).govern(20, 2);
    assert.equal(governed.disputed, 1);
    const current = repository.list({ level: "L2" })[0]!;
    const disputed = repository.list({ level: "L2", status: "disputed" })[0]!;
    assert.deepEqual(current.contradictionIds, [disputed.id]);
    const confirmed = repository.confirmCandidate(disputed.id, "user", "2026-09-10T02:00:00.000Z")!;
    assert.equal(confirmed.status, "active");
    assert.equal(confirmed.object, "Postgres");
    assert.equal(confirmed.supersedesId, current.id);
    assert.equal(repository.list({ level: "L2" }).length, 1);
    assert.equal(repository.list({ level: "L2", status: "superseded" }).some((memory) => memory.id === current.id), true);
    const database = new Database(databasePath, { readonly: true });
    try {
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM memory_relations WHERE relation='supersedes'").get() as { count: number }).count, 1);
    } finally { database.close(); }
  });
});

test("M12 rejecting a disputed candidate clears the unresolved warning from the current fact", async () => {
  await withRepository(async (repository) => {
    addCandidate(repository, { id: "event-12", taskId: "old" });
    repository.confirmCandidate(repository.list({ status: "candidate" })[0]!.id, "user", "2026-09-10T01:00:00.000Z");
    addCandidate(repository, { id: "event-13", taskId: "new", candidate: { ...baseCandidate, object: "Postgres", content: "memory storage authority Postgres" } });
    await new GovernedMemoryCandidates(repository).govern(20, 2);
    const disputed = repository.list({ status: "disputed" })[0]!;
    assert.equal(repository.list({ level: "L2" })[0]?.contradictionIds.length, 1);
    assert.equal(repository.forget(disputed.id, "2026-09-10T02:00:00.000Z"), true);
    assert.deepEqual(repository.list({ level: "L2" })[0]?.contradictionIds, []);
  });
});

test("M12 semantic similarity creates a review suggestion but never overwrites or activates by itself", async () => {
  await withRepository(async (repository, databasePath) => {
    addCandidate(repository, { id: "event-09", taskId: "a" });
    addCandidate(repository, { id: "event-10", taskId: "b", candidate: { ...baseCandidate, subject: "database", predicate: "canonical source", content: "database canonical source SQLite" } });
    let embeddingCalls = 0;
    const provider: EmbeddingProvider = {
      available: true,
      identity: { provider: "test", model: "same", dimensions: 2, normalization: "l2", revision: "semantic-v1" },
      embedDocuments: async (texts) => { embeddingCalls += 1; return texts.map(() => [1, 0]); },
      embedQuery: async () => [1, 0],
    };
    const result = await new GovernedMemoryCandidates(repository, provider).govern(20, 2);
    assert.equal(result.semanticAvailable, true);
    assert.equal(repository.list({ level: "L2", status: "candidate" }).length, 2);
    const database = new Database(databasePath, { readonly: true });
    try {
      const matches = database.prepare("SELECT match_type, status FROM memory_candidate_matches").all() as Array<{ match_type: string; status: string }>;
      assert.equal(matches.some((match) => match.match_type === "semantic_duplicate" && match.status === "suggested"), true);
    } finally { database.close(); }
    assert.equal((await new GovernedMemoryCandidates(repository, provider).govern(20, 2)).processed, 0);
    assert.equal(embeddingCalls, 1);
  });
});
