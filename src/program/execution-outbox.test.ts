import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { ExecutionOutboxError, ExecutionOutboxRepository, ExecutionOutboxWorker } from "./execution-outbox";

const T0 = "2026-10-10T00:00:00.000Z";
const T1 = "2026-10-10T00:01:00.000Z";
const T2 = "2026-10-10T00:02:00.000Z";

test("BLH-009 expired delivery leases are reclaimed with the stable event identity", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-outbox-lease-"));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    const repository = new ExecutionOutboxRepository(handle);
    const event = {
      id: "event-1", dedupeKey: "program-1:created", aggregateType: "program", aggregateId: "program-1",
      eventType: "program.created", payload: { revision: 0 }, availableAt: T0, createdAt: T0,
    } as const;
    repository.enqueue(event);
    assert.deepEqual(repository.enqueue(event), event);

    const firstDelivery = repository.claimNext({ workerId: "worker-1", now: T0, leaseExpiresAt: T1 });
    assert.equal(firstDelivery?.id, "event-1");
    assert.equal(firstDelivery?.attempts, 1);
    assert.equal(repository.claimNext({ workerId: "worker-2", now: T0, leaseExpiresAt: T1 }), undefined);

    // Simulate publish success followed by process death before acknowledgement.
    const replay = repository.claimNext({ workerId: "worker-2", now: T1, leaseExpiresAt: T2 });
    assert.equal(replay?.id, firstDelivery?.id);
    assert.equal(replay?.dedupeKey, firstDelivery?.dedupeKey);
    assert.equal(replay?.attempts, 2);
    repository.markPublished("event-1", "worker-2", T1);
    assert.equal(repository.get("event-1")?.state, "published");
    assert.equal(repository.claimNext({ workerId: "worker-3", now: T2, leaseExpiresAt: "2026-10-10T00:03:00.000Z" }), undefined);
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("BLH-009 dedupe keys reject a different logical event and failed attempts dead-letter", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-outbox-dedupe-"));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    const repository = new ExecutionOutboxRepository(handle);
    repository.enqueue({
      id: "event-1", dedupeKey: "stable-key", aggregateType: "program", aggregateId: "program-1",
      eventType: "program.created", payload: {}, availableAt: T0, createdAt: T0,
    });
    assert.throws(() => repository.enqueue({
      id: "event-2", dedupeKey: "stable-key", aggregateType: "program", aggregateId: "program-1",
      eventType: "program.changed", payload: {}, availableAt: T0, createdAt: T0,
    }), (error) => error instanceof ExecutionOutboxError && error.code === "OUTBOX_DEDUPE_CONFLICT");
    repository.claimNext({ workerId: "worker-1", now: T0, leaseExpiresAt: T1 });
    assert.equal(repository.markFailed({
      id: "event-1", workerId: "worker-1", availableAt: T1, error: "permanent", maxAttempts: 1,
    }), "dead_letter");
    assert.equal(repository.get("event-1")?.state, "dead_letter");
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("BLH-009 worker schedules retry without changing the stable delivery identity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-outbox-worker-"));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    const repository = new ExecutionOutboxRepository(handle);
    repository.enqueue({
      id: "event-1", dedupeKey: "stable-key", aggregateType: "program", aggregateId: "program-1",
      eventType: "program.created", payload: {}, availableAt: T0, createdAt: T0,
    });
    const seen: string[] = [];
    const worker = new ExecutionOutboxWorker(repository, (event) => {
      seen.push(event.id);
      throw new Error("broker unavailable");
    });
    assert.equal(await worker.deliverNext({
      workerId: "worker-1", now: T0, leaseExpiresAt: T1, retryAt: T1, maxAttempts: 2,
    }), "retry_scheduled");
    assert.equal(repository.get("event-1")?.state, "pending");
    assert.equal(repository.get("event-1")?.id, "event-1");
    assert.deepEqual(seen, ["event-1"]);
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
