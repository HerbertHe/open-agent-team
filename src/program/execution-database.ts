import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const EXECUTION_DATABASE_RELATIVE_PATH = path.join("execution", "execution.db");
export const EXECUTION_DATABASE_BUSY_TIMEOUT_MS = 5_000;

export interface ExecutionDatabaseHealth {
  databasePath: string;
  journalMode: "wal";
  foreignKeys: true;
  busyTimeoutMs: number;
  synchronous: "full";
  quickCheck: "ok";
}

export class ExecutionDatabaseOpenError extends Error {
  readonly code = "EXECUTION_DATABASE_OPEN_FAILED";

  constructor(readonly databasePath: string, cause: unknown) {
    super(`Failed to open execution database at ${databasePath}`, { cause });
    this.name = "ExecutionDatabaseOpenError";
  }
}

export class ExecutionDatabase {
  private closed = false;

  constructor(
    readonly databasePath: string,
    readonly connection: Database.Database,
  ) {}

  health(): ExecutionDatabaseHealth {
    if (this.closed) throw new Error("Execution database is closed");
    const journalMode = String(this.connection.pragma("journal_mode", { simple: true })).toLowerCase();
    const foreignKeys = Number(this.connection.pragma("foreign_keys", { simple: true }));
    const busyTimeoutMs = Number(this.connection.pragma("busy_timeout", { simple: true }));
    const synchronous = Number(this.connection.pragma("synchronous", { simple: true }));
    const quickCheck = String(this.connection.pragma("quick_check", { simple: true })).toLowerCase();
    if (journalMode !== "wal" || foreignKeys !== 1 ||
        busyTimeoutMs !== EXECUTION_DATABASE_BUSY_TIMEOUT_MS || synchronous !== 2 || quickCheck !== "ok") {
      throw new Error("Execution database PRAGMA verification failed");
    }
    return {
      databasePath: this.databasePath,
      journalMode: "wal",
      foreignKeys: true,
      busyTimeoutMs,
      synchronous: "full",
      quickCheck: "ok",
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
  }
}

function verifyWritable(database: Database.Database): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("CREATE TABLE __oat_execution_write_probe (id INTEGER PRIMARY KEY)");
    database.exec("DROP TABLE __oat_execution_write_probe");
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Opens the experimental Program database. Callers must only invoke this after
 * the parent feature flag is enabled; importing the module has no side effects.
 */
export function openExecutionDatabase(stateDir: string): ExecutionDatabase {
  if (!stateDir.trim()) {
    throw new ExecutionDatabaseOpenError("<invalid-state-dir>", new Error("stateDir must not be empty"));
  }
  const databasePath = path.join(path.resolve(stateDir), EXECUTION_DATABASE_RELATIVE_PATH);
  let database: Database.Database | undefined;
  try {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    database = new Database(databasePath, {
      timeout: EXECUTION_DATABASE_BUSY_TIMEOUT_MS,
      fileMustExist: false,
    });
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma(`busy_timeout = ${EXECUTION_DATABASE_BUSY_TIMEOUT_MS}`);
    database.pragma("synchronous = FULL");
    database.pragma("trusted_schema = OFF");
    verifyWritable(database);

    const handle = new ExecutionDatabase(databasePath, database);
    handle.health();
    return handle;
  } catch (error) {
    try { database?.close(); } catch { /* preserve the original open error */ }
    throw new ExecutionDatabaseOpenError(databasePath, error);
  }
}
