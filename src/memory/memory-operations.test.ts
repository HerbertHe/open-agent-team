import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { MemoryConfig } from "../types/config";
import { SqliteMemoryRepository } from "./memory-repository";
import { MemoryOperations, type MemoryOperationalSnapshot } from "./memory-operations";
import type { MemoryOverview, MemoryRetrievalRuntimeStatus } from "./types";

const config: MemoryConfig = {
  enabled: true, roles: ["admin", "leader"], embeddingRef: "memory-v1",
  retrieval: { backend: "zvec_hybrid", fallback: "lexical", shadow: false, productionEnabled: true, candidateLimit: 30, maxResults: 8, maxPromptTokens: 1800, timeoutMs: 3000, circuitBreakerFailureThreshold: 3, circuitBreakerCooldownSeconds: 60 },
  zvec: { path: "memory/zvec", index: "flat", metric: "cosine", readOnlyFallback: true, batchSize: 8, maxAttempts: 3, optimizePendingThreshold: 100_000 },
  extraction: { enabled: false, version: "m11-v1", timeoutMs: 15_000, maxInputChars: 4_000, maxOutputTokens: 800, maxFactsPerEvent: 5, maxAttempts: 3 },
  l1: { maxItems: 10, completedTaskTtlHours: 48 }, l2: { maxResults: 5, retentionDays: 180 }, l3: { maxPromptItems: 5, minEvidence: 50 },
  dream: { enabled: false, idleAfterSeconds: 30, pollSeconds: 30, maxEventsPerRun: 100, cancelOnNewTask: true },
};

const retrieval: MemoryRetrievalRuntimeStatus = { mode: "active", configuredBackend: "zvec_hybrid", effectiveBackend: "zvec_hybrid", rolloutEnabled: true, circuitState: "closed", consecutiveFailures: 0, fallbackCount: 0, maxPromptTokens: 1800 };
const overview: MemoryOverview = { enabled: true, counts: { L1: 1, L2: 1, L3: 0 }, pendingEvents: 0, retrieval };

function addMemory(repository: SqliteMemoryRepository, suffix = "initial"): void {
  const content = `M14 operational snapshot memory ${suffix}`;
  repository.capture({ id: `m14-event-${suffix}`, ownerAgentId: "admin", sourceAgentId: "admin", role: "admin", trustLevel: 100, eventType: "report_progress", kind: "decision", content, metadataJson: "{}", createdAt: "2026-09-14T00:00:00.000Z", fingerprint: createHash("sha256").update(content).digest("hex") }, 10);
  repository.consolidate({ maxEvents: 10, minEvidence: 50, retentionDays: 180, l1MaxItems: 10, l1TtlHours: 100_000, isCancelled: () => false });
}

async function waitForJob(operations: MemoryOperations): Promise<MemoryOperationalSnapshot> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await operations.snapshot(overview, retrieval);
    if (snapshot.operation?.status !== "running") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("M14 background operation did not finish.");
}

test("M14 exposes redacted health, disk estimate and background rebuild/activation progress", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m14-operations-"));
  const database = path.join(root, "memory", "memory.db");
  mkdirSync(path.dirname(database), { recursive: true });
  const modelsFile = path.join(root, "models.json");
  await fs.writeFile(modelsFile, JSON.stringify({ embeddingProfiles: { "memory-v1": { kind: "deterministic-fake", model: "test-hash", dimensions: 4, normalization: "l2", revision: "1" } } }));
  const repository = new SqliteMemoryRepository("m14-project", database);
  const operations = new MemoryOperations({ projectId: "m14-project", stateDir: root, config, repository, modelsFile, allowDeterministicFake: true, availableDiskBytes: async () => 10 ** 15 });
  try {
    addMemory(repository);
    const initial = await operations.snapshot(overview, retrieval);
    assert.equal(initial.health, "degraded");
    assert.equal(initial.warnings.some(({ code }) => code === "active_collection_missing"), true);
    assert.equal(initial.estimate?.diskSufficient, true);
    assert.equal(JSON.stringify(initial).includes("embedding"), true);
    assert.equal(JSON.stringify(initial).includes("api_key"), false);
    assert.equal(JSON.stringify(initial).includes("vectors"), false);

    const scheduled = await operations.startRebuild();
    assert.equal(scheduled.status, "running");
    const ready = await waitForJob(operations);
    assert.equal(ready.operation?.status, "completed");
    assert.equal(ready.collections[0]?.state, "ready");
    assert.equal(ready.collections[0]?.completeness, 1);

    await operations.startActivate(ready.collections[0]!.collectionRevision);
    const active = await waitForJob(operations);
    assert.equal(active.activeCollectionRevision, ready.collections[0]!.collectionRevision);
    assert.equal(active.collections[0]?.state, "active");

    addMemory(repository, "incremental");
    const run = await operations.syncActiveOnce();
    assert.equal(run?.indexed, 1);
    assert.equal(repository.indexRevisionValidation(ready.collections[0]!.collectionRevision).pendingOutbox, 0);
    const synchronized = await operations.snapshot(overview, retrieval);
    assert.equal(synchronized.maintenance.collectionRevision, ready.collections[0]!.collectionRevision);
    assert.equal(synchronized.maintenance.lastRun?.indexed, 1);
    assert.equal(synchronized.maintenance.lastError, undefined);
  } finally { await operations.close(); repository.close(); rmSync(root, { recursive: true, force: true }); }
});

test("M14 reports insufficient rebuild disk without exposing an unsafe start recommendation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m14-disk-"));
  const database = path.join(root, "memory", "memory.db"); mkdirSync(path.dirname(database), { recursive: true });
  const modelsFile = path.join(root, "models.json");
  await fs.writeFile(modelsFile, JSON.stringify({ embeddingProfiles: { "memory-v1": { kind: "deterministic-fake", model: "test-hash", dimensions: 4, normalization: "l2", revision: "1" } } }));
  const repository = new SqliteMemoryRepository("m14-disk", database);
  try {
    addMemory(repository);
    const operations = new MemoryOperations({ projectId: "m14-disk", stateDir: root, config, repository, modelsFile, allowDeterministicFake: true, availableDiskBytes: async () => 0 });
    const snapshot = await operations.snapshot(overview, retrieval);
    assert.equal(snapshot.estimate?.diskSufficient, false);
    assert.equal(snapshot.warnings.some(({ code }) => code === "disk_insufficient"), true);
    await operations.close();
  } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
});
