import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionDatabase, type ExecutionDatabase } from "./execution-database";
import {
  EXECUTION_SCHEMA_VERSION,
  ExecutionMigrationError,
  migrateExecutionDatabase,
} from "./execution-migrations";

function withDatabase(name: string, run: (handle: ExecutionDatabase) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), `${name}-`));
  const handle = openExecutionDatabase(root);
  try {
    run(handle);
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function tableNames(handle: ExecutionDatabase): string[] {
  return handle.connection.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).pluck().all() as string[];
}

test("BLH-006 migrates an empty execution database through schema v6 atomically", () => {
  withDatabase("oat-execution-migration", (handle) => {
    const result = migrateExecutionDatabase(handle, { appliedAt: "2026-10-10T00:00:00.000Z" });
    assert.deepEqual(result, { fromVersion: 0, toVersion: 6, appliedVersions: [1, 2, 3, 4, 5, 6] });
    assert.equal(handle.connection.pragma("user_version", { simple: true }), EXECUTION_SCHEMA_VERSION);
    assert.deepEqual(tableNames(handle), [
      "acceptance_criteria",
      "admission_decisions",
      "attempt_leases",
      "audit_events",
      "budget_accounts",
      "budget_reservations",
      "effects",
      "estimation_observations",
      "execution_barriers",
      "execution_checkpoints",
      "execution_outbox",
      "execution_schema_migrations",
      "plan_versions",
      "pricing_snapshots",
      "program_alerts",
      "program_closeouts",
      "program_control_requests",
      "programs",
      "release_gate_records",
      "replan_failures",
      "simulation_runs",
      "spend_events",
      "suspension_snapshots",
      "task_board_projections",
      "threat_model_reviews",
      "verification_evidence",
      "wakeups",
      "work_package_attempts",
      "work_package_dependencies",
      "work_package_estimates",
      "work_packages",
    ]);
    assert.deepEqual(handle.connection.pragma("foreign_key_check"), []);
  });
});

test("BLH-006 repeated migration is a validated no-op", () => {
  withDatabase("oat-execution-migration-repeat", (handle) => {
    migrateExecutionDatabase(handle, { appliedAt: "2026-10-10T00:00:00.000Z" });
    const repeated = migrateExecutionDatabase(handle, { appliedAt: "2026-10-11T00:00:00.000Z" });
    assert.deepEqual(repeated, { fromVersion: 6, toVersion: 6, appliedVersions: [] });
    const count = handle.connection.prepare("SELECT COUNT(*) FROM execution_schema_migrations").pluck().get();
    assert.equal(count, 6);
  });
});

test("BLH-006 interruption rolls back DDL, history and user_version", () => {
  withDatabase("oat-execution-migration-interrupt", (handle) => {
    assert.throws(() => migrateExecutionDatabase(handle, {
      faultInjector: () => { throw new Error("simulated crash"); },
    }), (error) => error instanceof ExecutionMigrationError && error.code === "MIGRATION_FAILED");
    assert.equal(handle.connection.pragma("user_version", { simple: true }), 0);
    assert.deepEqual(tableNames(handle), []);

    const recovered = migrateExecutionDatabase(handle);
    assert.deepEqual(recovered.appliedVersions, [1, 2, 3, 4, 5, 6]);
  });
});

test("BLH-012 v2 interruption preserves v1 and resumes cleanly", () => {
  withDatabase("oat-execution-migration-v2-interrupt", (handle) => {
    assert.throws(() => migrateExecutionDatabase(handle, {
      faultInjector: (point) => { if (point === "v2_after_schema") throw new Error("simulated crash"); },
    }), (error) => error instanceof ExecutionMigrationError && error.code === "MIGRATION_FAILED");
    assert.equal(handle.connection.pragma("user_version", { simple: true }), 1);
    assert.equal(tableNames(handle).includes("budget_accounts"), false);
    assert.deepEqual(migrateExecutionDatabase(handle).appliedVersions, [2, 3, 4, 5, 6]);
  });
});

test("BLH-021 v3 interruption preserves v2 and resumes cleanly", () => {
  withDatabase("oat-execution-migration-v3-interrupt", (handle) => {
    assert.throws(() => migrateExecutionDatabase(handle, {
      faultInjector: (point) => { if (point === "v3_after_schema") throw new Error("simulated crash"); },
    }), (error) => error instanceof ExecutionMigrationError && error.code === "MIGRATION_FAILED");
    assert.equal(handle.connection.pragma("user_version", { simple: true }), 2);
    assert.equal(tableNames(handle).includes("wakeups"), false);
    assert.deepEqual(migrateExecutionDatabase(handle).appliedVersions, [3, 4, 5, 6]);
  });
});

test("BLH-031 v4 interruption preserves v3 and resumes cleanly", () => {
  withDatabase("oat-execution-migration-v4-interrupt", (handle) => {
    assert.throws(() => migrateExecutionDatabase(handle, {
      faultInjector: (point) => { if (point === "v4_after_schema") throw new Error("simulated crash"); },
    }), (error) => error instanceof ExecutionMigrationError && error.code === "MIGRATION_FAILED");
    assert.equal(handle.connection.pragma("user_version", { simple: true }), 3);
    assert.equal(tableNames(handle).includes("effects"), false);
    assert.deepEqual(migrateExecutionDatabase(handle).appliedVersions, [4, 5, 6]);
  });
});

test("BLH-041 v5 interruption preserves v4 and resumes cleanly", () => {
  withDatabase("oat-execution-migration-v5-interrupt", (handle) => {
    assert.throws(() => migrateExecutionDatabase(handle, {
      faultInjector: (point) => { if (point === "v5_after_schema") throw new Error("simulated crash"); },
    }), (error) => error instanceof ExecutionMigrationError && error.code === "MIGRATION_FAILED");
    assert.equal(handle.connection.pragma("user_version", { simple: true }), 4);
    assert.equal(tableNames(handle).includes("verification_evidence"), false);
    assert.deepEqual(migrateExecutionDatabase(handle).appliedVersions, [5, 6]);
  });
});

test("BLH-051 v6 interruption preserves v5 and resumes cleanly", () => {
  withDatabase("oat-execution-migration-v6-interrupt", (handle) => {
    assert.throws(() => migrateExecutionDatabase(handle, {
      faultInjector: (point) => { if (point === "v6_after_schema") throw new Error("simulated crash"); },
    }), (error) => error instanceof ExecutionMigrationError && error.code === "MIGRATION_FAILED");
    assert.equal(handle.connection.pragma("user_version", { simple: true }), 5);
    assert.equal(tableNames(handle).includes("simulation_runs"), false);
    assert.deepEqual(migrateExecutionDatabase(handle).appliedVersions, [6]);
  });
});

test("BLH-006 rejects a database created by a newer binary", () => {
  withDatabase("oat-execution-migration-newer", (handle) => {
    handle.connection.pragma("user_version = 99");
    assert.throws(() => migrateExecutionDatabase(handle), (error) =>
      error instanceof ExecutionMigrationError && error.code === "SCHEMA_TOO_NEW");
    assert.equal(handle.connection.pragma("user_version", { simple: true }), 99);
  });
});

test("BLH-006 detects migration checksum drift", () => {
  withDatabase("oat-execution-migration-drift", (handle) => {
    migrateExecutionDatabase(handle);
    handle.connection.prepare("UPDATE execution_schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    assert.throws(() => migrateExecutionDatabase(handle), (error) =>
      error instanceof ExecutionMigrationError && error.code === "SCHEMA_DRIFT");
  });
});

test("BLH-006 enforces foreign keys and JSON checks", () => {
  withDatabase("oat-execution-migration-constraints", (handle) => {
    migrateExecutionDatabase(handle);
    assert.throws(() => handle.connection.prepare(`
      INSERT INTO plan_versions(id, program_id, version, scope_tier, status, plan_json, created_at)
      VALUES('plan-1', 'missing-program', 1, 'minimum', 'draft', '{}', '2026-10-10T00:00:00Z')
    `).run());
    assert.throws(() => handle.connection.prepare(`
      INSERT INTO execution_outbox(id, aggregate_type, aggregate_id, event_type, payload_json, available_at, created_at)
      VALUES('event-1', 'program', 'program-1', 'program.created', 'not-json', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')
    `).run());
  });
});

test("BLH-006 prevents active plans and Work Packages from crossing Program boundaries", () => {
  withDatabase("oat-execution-migration-ownership", (handle) => {
    migrateExecutionDatabase(handle);
    const insertProgram = handle.connection.prepare(`
      INSERT INTO programs(id, project_id, goal, status, created_at, updated_at)
      VALUES(?, 'project', 'goal', 'draft', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')
    `);
    insertProgram.run("program-a");
    insertProgram.run("program-b");
    handle.connection.prepare(`
      INSERT INTO plan_versions(id, program_id, version, scope_tier, status, plan_json, created_at)
      VALUES('plan-a', 'program-a', 1, 'minimum', 'draft', '{}', '2026-10-10T00:00:00Z')
    `).run();

    assert.throws(() => handle.connection.prepare(
      "UPDATE programs SET active_plan_version_id = 'plan-a' WHERE id = 'program-b'",
    ).run());
    assert.throws(() => handle.connection.prepare(`
      INSERT INTO work_packages(
        id, program_id, plan_version_id, stable_key, status, definition_json, created_at, updated_at
      ) VALUES(
        'work-b', 'program-b', 'plan-a', 'work-b', 'planned', '{}',
        '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z'
      )
    `).run());
  });
});
