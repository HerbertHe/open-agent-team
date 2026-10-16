import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BudgetAccountRepository, buildProgramAccountTree } from "../budget/budget-ledger";
import { QueuedTaskStatusEnum, type QueuedTask } from "../types";
import { openExecutionDatabase, type ExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { ProgramRepository, PlanVersionRepository, WorkPackageRepository } from "./execution-repositories";
import { ProgramSchema, PlanVersionSchema, WorkPackageSchema } from "./program-types";
import { ProgramExecutionCoordinator } from "./program-execution-coordinator";
import { ProgramWakeupRuntime } from "./program-wakeup-runtime";
import { ExecutionOutboxRepository } from "./execution-outbox";
import { ExecutionBarrier } from "./execution-barrier";
import { WakeupService } from "./wakeup-service";

const T0 = "2026-10-16T00:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
function fixture(notBefore?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "wakeup-runtime-"));
  let handle = openExecutionDatabase(root); migrateExecutionDatabase(handle);
  new ProgramRepository(handle).create(ProgramSchema.parse({ id: "program-1", projectId: "project-1", goal: "ship", status: "admitted", executionEpoch: 0, revision: 0, createdAt: T0, updatedAt: T0 }));
  new PlanVersionRepository(handle).create(PlanVersionSchema.parse({ id: "plan-1", programId: "program-1", version: 1, reason: "initial", scopeTier: "minimum", status: "active", workPackageIds: ["work-1"], createdBy: "admin", revision: 0, createdAt: T0, activatedAt: T0 }));
  handle.connection.prepare("UPDATE programs SET active_plan_version_id='plan-1' WHERE id='program-1'").run();
  new WorkPackageRepository(handle).create(WorkPackageSchema.parse({ id: "work-1", stableKey: "work-1", programId: "program-1", planVersionId: "plan-1", title: "work", prompt: "ship", targetAgentRole: "worker", dependsOn: [], conflictKeys: [], scopeTier: "minimum", mandatory: true, priority: 0, hardEnvelope: {}, acceptanceCriteria: [], status: "runnable", revision: 0, createdAt: T0, updatedAt: T0, ...(notBefore ? { notBefore } : {}) }));
  BudgetAccountRepository.from(handle).createBatch(buildProgramAccountTree("program-1", { planning: {}, minimumDelivery: {}, upgradePool: {}, validation: {}, contingency: {}, closeout: {} }, T0));
  const tasks: QueuedTask[] = [];
  let now = T0;
  const coordinator = (db: ExecutionDatabase) => new ProgramExecutionCoordinator(db, {
    resolveAgent: () => "worker-1", getTask: (id) => tasks.find((t) => t.id === id), findTaskByConflictKey: (key) => tasks.find((t) => t.conflictKey === key),
    createTask: async (body) => { const task = { ...body, id: `task-${tasks.length}`, status: QueuedTaskStatusEnum.Queued, createdAt: now, updatedAt: now }; tasks.push(task); return task; },
  }, 4, { clock: () => now });
  return { root, get handle() { return handle; }, tasks, clock: () => now, time: (seconds: number) => { now = at(seconds); }, coordinator,
    reopen: () => { handle.close(); handle = openExecutionDatabase(root); migrateExecutionDatabase(handle); },
    close: () => { handle.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("persistent heartbeat catches up once after restart, ignores clock rollback and leaves unrelated outbox events alone", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const runtime = () => { const c = f.coordinator(f.handle); return new ProgramWakeupRuntime(f.handle, async (id, now) => { calls++; return c.tick(id, now); }, f.clock); };
    let r = runtime(); await r.poll();
    assert.equal(calls, 1); assert.equal(f.tasks.length, 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM wakeups WHERE state='pending'").pluck().get(), 1);
    await r.poll(); f.time(-60); await r.poll(); assert.equal(calls, 1);
    await r.stop(); f.reopen(); f.time(3600); r = runtime(); await r.poll();
    assert.equal(calls, 2); assert.equal(f.tasks.length, 1);
    assert.equal(f.handle.connection.prepare("SELECT wake_at FROM wakeups WHERE state='pending'").pluck().get(), at(3610));
    await r.poll(); assert.equal(calls, 2);
    const outbox = new ExecutionOutboxRepository(f.handle);
    outbox.enqueue({ id: "unrelated", dedupeKey: "unrelated", aggregateType: "program", aggregateId: "program-1", eventType: "program.other", payload: {}, availableAt: T0, createdAt: T0 });
    f.time(3610); await r.poll(); assert.equal(outbox.get("unrelated")?.state, "pending");
    await r.stop();
  } finally { f.close(); }
});

test("expired delivery lease replays a crash after task creation without duplicating task or attempt", async () => {
  const f = fixture();
  try {
    new WakeupService(f.handle).schedule({ programId: "program-1", dedupeKey: "crash", wakeAt: T0, createdAt: T0, payload: { kind: "scheduler_tick", executionEpoch: 0, planVersionId: "plan-1" } });
    new WakeupService(f.handle).dispatchDue({ now: T0 });
    const claimed = new ExecutionOutboxRepository(f.handle).claimNext({ workerId: "crashed", now: T0, leaseExpiresAt: at(60), eventType: "program.wakeup_due" })!;
    await f.coordinator(f.handle).tick("program-1", T0);
    f.reopen(); const c = f.coordinator(f.handle); let calls = 0;
    const r = new ProgramWakeupRuntime(f.handle, async (id, now) => { calls++; return c.tick(id, now); }, f.clock);
    f.time(59); await r.poll(); assert.equal(calls, 0);
    f.time(60); await r.poll(); assert.equal(calls, 1); assert.equal(f.tasks.length, 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM work_package_attempts").pluck().get(), 1);
    assert.equal(new ExecutionOutboxRepository(f.handle).get(claimed.id)?.state, "published");
    await r.stop();
  } finally { f.close(); }
});

test("paused wakeups retain retry budget; resumed epoch ignores old event and schedules only the new epoch", async () => {
  const f = fixture(at(60));
  try {
    const c = f.coordinator(f.handle); let calls = 0;
    const r = new ProgramWakeupRuntime(f.handle, async (id, now) => { calls++; return c.tick(id, now); }, f.clock);
    await r.poll(); assert.equal(f.tasks.length, 0);
    f.handle.connection.prepare("UPDATE programs SET status='suspended' WHERE id='program-1'").run();
    new ExecutionBarrier(f.handle).freeze("program-1", 0, "pause", at(1));
    for (const seconds of [10, 20, 30, 40, 50, 60]) { f.time(seconds); await r.poll(); }
    assert.equal(calls, 1); assert.equal(f.tasks.length, 0);
    assert.equal(f.handle.connection.prepare("SELECT MAX(attempts) FROM execution_outbox WHERE state='pending' AND event_type='program.wakeup_due'").pluck().get(), 0);
    await assert.rejects(() => c.tick("program-1", at(60)), /not schedulable/);
    f.handle.connection.prepare("UPDATE programs SET status='running',execution_epoch=1 WHERE id='program-1'").run();
    new ExecutionBarrier(f.handle).freeze("program-1", 1, "resume", at(61));
    new ExecutionBarrier(f.handle).release("program-1", 1, at(62));
    f.time(70); await r.poll(); assert.equal(calls, 2); assert.equal(f.tasks.length, 1);
    assert.equal(f.tasks[0].executionContext?.executionEpoch, 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM audit_events WHERE event_type='program.wakeup_consumed' AND json_extract(metadata_json,'$.outcome')='stale'").pluck().get(), 1);
    await r.stop();
  } finally { f.close(); }
});

test("failed callback retries the same event and shutdown drains a single shared poll", async () => {
  const f = fixture();
  try {
    let calls = 0; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const errors: unknown[] = [];
    const r = new ProgramWakeupRuntime(f.handle, async () => { calls++; if (calls === 1) throw new Error("transient"); await gate; }, f.clock, 10_000, (e) => errors.push(e));
    await r.poll(); assert.equal(errors.length, 1);
    f.time(10); const pending = r.poll(); assert.equal(r.poll(), pending);
    let stopped = false; const stop = r.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    release(); await pending; await stop; assert.equal(stopped, true);
    f.time(20); await r.poll(); assert.equal(calls, 2);
    assert.equal(f.handle.connection.prepare("SELECT attempts FROM execution_outbox WHERE event_type='program.wakeup_due'").pluck().get(), 2);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM wakeups WHERE state='pending'").pluck().get(), 1);
  } finally { f.close(); }
});

test("pending future notBefore survives restart and never dispatches early", async () => {
  const f = fixture(at(60));
  try {
    let c = f.coordinator(f.handle); let r = new ProgramWakeupRuntime(f.handle, (id, now) => c.tick(id, now), f.clock);
    await r.poll(); assert.equal(f.tasks.length, 0); await r.stop(); f.reopen();
    c = f.coordinator(f.handle); r = new ProgramWakeupRuntime(f.handle, (id, now) => c.tick(id, now), f.clock);
    f.time(59); await r.poll(); assert.equal(f.tasks.length, 0);
    f.time(69); await r.poll(); assert.equal(f.tasks.length, 1); await r.stop();
  } finally { f.close(); }
});

test("malformed wakeup payload cannot run the scheduler and reaches dead letter", async () => {
  const f = fixture();
  try {
    new WakeupService(f.handle).schedule({ programId: "program-1", dedupeKey: "bad", wakeAt: T0, createdAt: T0, payload: { kind: "scheduler_tick", executionEpoch: "invalid", planVersionId: "plan-1", wakeupId: "spoofed" } });
    let calls = 0; const r = new ProgramWakeupRuntime(f.handle, async () => { calls++; }, f.clock);
    // Only the malformed event is outstanding under this payload's plan/epoch.
    f.handle.connection.prepare("UPDATE programs SET status='suspended' WHERE id='program-1'").run();
    for (let i = 0; i < 5; i++) { f.time(i * 10); await r.poll(); }
    assert.equal(calls, 0);
    assert.equal(f.handle.connection.prepare("SELECT state FROM execution_outbox WHERE event_type='program.wakeup_due'").pluck().get(), "dead_letter");
    assert.notEqual(JSON.parse(f.handle.connection.prepare("SELECT payload_json FROM execution_outbox WHERE event_type='program.wakeup_due'").pluck().get() as string).wakeupId, "spoofed");
    await r.stop();
  } finally { f.close(); }
});

test("acknowledgement, audit and successor roll back together if persistence fails after dispatch", async () => {
  const f = fixture();
  try {
    const c = f.coordinator(f.handle); let fail = true;
    const r = new ProgramWakeupRuntime(f.handle, async (id, now) => {
      await c.tick(id, now);
      if (fail) f.handle.connection.exec("CREATE TEMP TRIGGER fail_successor BEFORE INSERT ON wakeups BEGIN SELECT RAISE(ABORT,'disk failure'); END");
    }, f.clock);
    await r.poll();
    assert.equal(f.tasks.length, 1);
    assert.equal(f.handle.connection.prepare("SELECT state FROM execution_outbox WHERE event_type='program.wakeup_due'").pluck().get(), "pending");
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM audit_events WHERE event_type='program.wakeup_consumed'").pluck().get(), 0);
    f.handle.connection.exec("DROP TRIGGER fail_successor"); fail = false;
    f.time(10); await r.poll();
    assert.equal(f.tasks.length, 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM audit_events WHERE event_type='program.wakeup_consumed'").pluck().get(), 1);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM wakeups WHERE state='pending'").pluck().get(), 1);
    await r.stop();
  } finally { f.close(); }
});

test("active barrier blocks both automatic wakeup and direct manual tick", async () => {
  const f = fixture();
  try {
    const c = f.coordinator(f.handle);
    new ExecutionBarrier(f.handle).freeze("program-1", 0, "pause-in-progress", T0);
    const r = new ProgramWakeupRuntime(f.handle, (id, now) => c.tick(id, now), f.clock);
    await r.poll(); assert.equal(f.tasks.length, 0);
    await assert.rejects(() => c.tick("program-1", T0), /frozen/);
    assert.equal(f.handle.connection.prepare("SELECT COUNT(*) FROM work_package_attempts").pluck().get(), 0);
    await r.stop();
  } finally { f.close(); }
});
