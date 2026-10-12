import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EXECUTION_DATABASE_BUSY_TIMEOUT_MS,
  ExecutionDatabaseOpenError,
  openExecutionDatabase,
} from "./execution-database";

function temporaryStateDir(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `${name}-`));
}

test("BLH-005 creates the execution directory and configures defensive PRAGMAs", () => {
  const root = temporaryStateDir("oat-execution-db");
  try {
    const handle = openExecutionDatabase(path.join(root, "missing-state"));
    try {
      assert.equal(existsSync(handle.databasePath), true);
      assert.deepEqual(handle.health(), {
        databasePath: handle.databasePath,
        journalMode: "wal",
        foreignKeys: true,
        busyTimeoutMs: EXECUTION_DATABASE_BUSY_TIMEOUT_MS,
        synchronous: "full",
        quickCheck: "ok",
      });
      const tables = handle.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      assert.deepEqual(tables, []);
    } finally {
      handle.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BLH-005 supports concurrent handles and restart", () => {
  const root = temporaryStateDir("oat-execution-db-concurrent");
  try {
    const first = openExecutionDatabase(root);
    const second = openExecutionDatabase(root);
    try {
      assert.equal(first.databasePath, second.databasePath);
      assert.equal(first.health().quickCheck, "ok");
      assert.equal(second.health().quickCheck, "ok");
    } finally {
      first.close();
      second.close();
    }

    const restarted = openExecutionDatabase(root);
    assert.equal(restarted.health().journalMode, "wal");
    restarted.close();
    restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BLH-005 rejects a corrupt database and closes the partial connection", () => {
  const root = temporaryStateDir("oat-execution-db-corrupt");
  const executionDir = path.join(root, "execution");
  const databasePath = path.join(executionDir, "execution.db");
  mkdirSync(executionDir, { recursive: true });
  writeFileSync(databasePath, "this is not sqlite", "utf8");
  try {
    assert.throws(() => openExecutionDatabase(root), (error) => {
      assert.ok(error instanceof ExecutionDatabaseOpenError);
      assert.equal(error.code, "EXECUTION_DATABASE_OPEN_FAILED");
      assert.equal(error.databasePath, databasePath);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BLH-005 rejects an empty state directory instead of writing into cwd", () => {
  assert.throws(() => openExecutionDatabase("  "), ExecutionDatabaseOpenError);
});

test("BLH-005 fails closed when the execution storage is read-only", () => {
  const root = temporaryStateDir("oat-execution-db-readonly");
  const handle = openExecutionDatabase(root);
  const executionDir = path.dirname(handle.databasePath);
  handle.close();
  chmodSync(handle.databasePath, 0o400);
  chmodSync(executionDir, 0o500);
  try {
    assert.throws(() => openExecutionDatabase(root), ExecutionDatabaseOpenError);
  } finally {
    chmodSync(executionDir, 0o700);
    chmodSync(handle.databasePath, 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});
