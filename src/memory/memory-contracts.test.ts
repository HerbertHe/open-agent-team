import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteMemoryRepository } from "./memory-repository";
import { LexicalMemoryRetriever, NoopMemoryIndex } from "./memory-retriever";

test("SqliteMemoryRepository and LexicalMemoryRetriever satisfy the M02 contracts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-contract-"));
  const databasePath = path.join(root, "memory", "memory.db");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const repository = new SqliteMemoryRepository("contract-project", databasePath);
  const retriever = new LexicalMemoryRetriever(repository);
  try {
    const createdAt = "2026-09-03T00:00:00.000Z";
    const content = "模型余额不足只失败当前任务并保留 Agent 进程。";
    repository.capture({
      id: randomUUID(),
      ownerAgentId: "admin",
      sourceAgentId: "admin",
      role: "admin",
      trustLevel: 100,
      eventType: "report_progress",
      kind: "decision",
      content,
      metadataJson: "{}",
      createdAt,
      fingerprint: createHash("sha256").update(`admin\0report_progress\0${content.toLowerCase()}`).digest("hex"),
    }, 10);
    const consolidated = repository.consolidate({
      maxEvents: 10,
      minEvidence: 20,
      retentionDays: 180,
      l1MaxItems: 10,
      l1TtlHours: 100_000,
      isCancelled: () => false,
    });
    assert.deepEqual(consolidated, { processedEvents: 1, createdL2: 1, promotedL3: 0 });

    const result = await retriever.retrieve({ agentId: "admin", query: "模型余额不足", globalScope: true, l2MaxResults: 5, l3MaxPromptItems: 5 });
    assert.equal(result.l1[0]?.content, content);
    assert.equal(result.l1[0]?.contentHash.length, 64);
    assert.equal(result.l2[0]?.content, content);
    assert.equal(result.l3.length, 0);
    assert.equal(result.l2[0]?.scope, "private");
    assert.equal(result.l2[0]?.indexState, "not_applicable");

    const index = new NoopMemoryIndex();
    assert.equal(index.backend, "disabled");
    assert.equal(await index.search({ agentId: "admin", query: "anything", globalScope: true, limit: 5 }), undefined);
    index.close();
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});
