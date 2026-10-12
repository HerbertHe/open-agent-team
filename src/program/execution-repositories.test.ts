import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionDatabase, type ExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import {
  ExecutionRepositoryError,
  PlanVersionRepository,
  ProgramRepository,
  WorkPackageRepository,
} from "./execution-repositories";
import {
  PlanVersionSchema,
  ProgramSchema,
  WorkPackageSchema,
  type PlanVersion,
  type Program,
  type WorkPackage,
} from "./program-types";

const T0 = "2026-10-10T00:00:00.000Z";
const T1 = "2026-10-10T00:01:00.000Z";

function program(id = "program-1"): Program {
  return ProgramSchema.parse({
    id, projectId: "project-1", goal: "Deliver the minimum viable result", status: "draft",
    executionEpoch: 0, revision: 0, createdAt: T0, updatedAt: T0,
  });
}

function plan(id = "plan-1"): PlanVersion {
  return PlanVersionSchema.parse({
    id, programId: "program-1", version: 1, reason: "initial", scopeTier: "minimum",
    status: "draft", workPackageIds: ["work-1", "work-2"], createdBy: "admin-1",
    revision: 0, createdAt: T0,
  });
}

function workPackage(id: string, dependsOn: string[] = []): WorkPackage {
  return WorkPackageSchema.parse({
    id, stableKey: id, programId: "program-1", planVersionId: "plan-1",
    title: id, prompt: `Execute ${id}`, targetAgentRole: "worker", dependsOn,
    conflictKeys: [], scopeTier: "minimum", mandatory: true, priority: 1,
    hardEnvelope: {}, status: "planned", revision: 0, createdAt: T0, updatedAt: T0,
  });
}

function withDatabase(name: string, run: (root: string, handle: ExecutionDatabase) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    run(root, handle);
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("BLH-008 repositories round-trip strict entities and forward dependencies", () => {
  withDatabase("oat-repositories", (_root, handle) => {
    const programs = new ProgramRepository(handle);
    const plans = new PlanVersionRepository(handle);
    const work = new WorkPackageRepository(handle);
    programs.create(program());
    plans.create(plan());
    work.createBatch([workPackage("work-2", ["work-1"]), workPackage("work-1")]);

    assert.deepEqual(programs.get("program-1"), program());
    assert.deepEqual(plans.get("plan-1"), plan());
    assert.deepEqual(work.get("work-2"), workPackage("work-2", ["work-1"]));
    assert.equal(plans.transitionStatus("plan-1", 0, "validated").revision, 1);
    const activePlan = plans.transitionStatus("plan-1", 1, "active", T1);
    assert.equal(activePlan.activatedAt, T1);
    assert.equal(plans.get("plan-1")?.status, "active");
    assert.equal(work.transitionStatus("work-1", 0, "blocked", T1).revision, 1);
    assert.equal(work.get("work-1")?.status, "blocked");
    const dependencyCount = handle.connection.prepare(
      "SELECT COUNT(*) FROM work_package_dependencies",
    ).pluck().get();
    assert.equal(dependencyCount, 1);
  });
});

test("BLH-008 revision CAS allows only one writer and returns a structured conflict", () => {
  withDatabase("oat-repository-cas", (root, firstHandle) => {
    const secondHandle = openExecutionDatabase(root);
    try {
      const first = new ProgramRepository(firstHandle);
      const second = new ProgramRepository(secondHandle);
      first.create(program());
      assert.equal(first.get("program-1")?.revision, 0);
      assert.equal(second.get("program-1")?.revision, 0);

      const winner = first.transitionStatus("program-1", 0, "planning", T1);
      assert.equal(winner.revision, 1);
      assert.throws(
        () => second.transitionStatus("program-1", 0, "cancelled", T1),
        (error) => error instanceof ExecutionRepositoryError && error.code === "REVISION_CONFLICT",
      );
      assert.equal(second.get("program-1")?.status, "planning");
    } finally {
      secondHandle.close();
    }
  });
});

test("BLH-008 status mutation and outbox append roll back together", () => {
  withDatabase("oat-repository-atomic", (_root, handle) => {
    const repository = new ProgramRepository(handle);
    repository.create(program());
    const event = {
      id: "event-program-planning", dedupeKey: "program-1:planning:1", aggregateType: "program",
      aggregateId: "program-1", eventType: "program.planning", payload: { revision: 1 },
      availableAt: T1, createdAt: T1,
    } as const;
    assert.throws(() => repository.transitionStatus("program-1", 0, "planning", T1, {
      outboxEvents: [event],
      faultInjector: (point) => { if (point === "after_outbox_write") throw new Error("crash"); },
    }));
    assert.equal(repository.get("program-1")?.revision, 0);
    assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM execution_outbox").pluck().get(), 0);

    repository.transitionStatus("program-1", 0, "planning", T1, { outboxEvents: [event] });
    assert.equal(repository.get("program-1")?.revision, 1);
    assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM execution_outbox").pluck().get(), 1);
  });
});
