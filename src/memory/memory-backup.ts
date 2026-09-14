import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";

const MemoryBackupManifestSchema = z.object({
  formatVersion: z.literal(1),
  projectId: z.string().min(1),
  createdAt: z.string().datetime(),
  sqliteUserVersion: z.number().int().nonnegative(),
  databaseFile: z.literal("memory.db"),
  databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  zvecIncluded: z.literal(false),
  restoreStrategy: z.literal("restore-sqlite-and-rebuild-derived-index"),
});

export type MemoryBackupManifest = z.infer<typeof MemoryBackupManifestSchema>;

export type CreateMemoryBackupOptions = {
  projectId: string;
  databasePath: string;
  destinationDirectory: string;
  overwrite?: boolean;
  now?: () => Date;
};

export type RestoreMemoryBackupOptions = {
  projectId: string;
  backupDirectory: string;
  databasePath: string;
  zvecRoot?: string;
  /** Restore is intentionally unavailable while the project service is live. */
  serviceStopped: boolean;
  /** Must exactly match projectId to prevent accidental cross-project restore. */
  confirmProjectId: string;
  now?: () => Date;
};

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function safeSegment(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "project"; }

async function verifyDatabase(file: string): Promise<number> {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
    return Number(database.pragma("user_version", { simple: true }));
  } finally { database.close(); }
}

export async function createMemoryBackup(options: CreateMemoryBackupOptions): Promise<MemoryBackupManifest> {
  const destination = path.resolve(options.destinationDirectory);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  if (!options.overwrite && await fs.stat(destination).then(() => true, () => false)) throw new Error(`Backup destination already exists: ${destination}`);
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const targetDatabase = path.join(temporary, "memory.db");
  const source = new Database(path.resolve(options.databasePath), { readonly: true, fileMustExist: true });
  try { await source.backup(targetDatabase); }
  finally { source.close(); }
  try {
    const sqliteUserVersion = await verifyDatabase(targetDatabase);
    const manifest: MemoryBackupManifest = {
      formatVersion: 1,
      projectId: options.projectId,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      sqliteUserVersion,
      databaseFile: "memory.db",
      databaseSha256: await sha256(targetDatabase),
      zvecIncluded: false,
      restoreStrategy: "restore-sqlite-and-rebuild-derived-index",
    };
    await fs.writeFile(path.join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    if (options.overwrite) await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(temporary, destination);
    return manifest;
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreMemoryBackup(options: RestoreMemoryBackupOptions): Promise<{
  manifest: MemoryBackupManifest;
  preservedDatabasePath?: string;
  quarantinedZvecPath?: string;
}> {
  if (!options.serviceStopped) throw new Error("Stop the project before restoring memory.");
  if (options.confirmProjectId !== options.projectId) throw new Error("Restore confirmation must exactly match the project ID.");
  const backup = path.resolve(options.backupDirectory);
  const manifest = MemoryBackupManifestSchema.parse(JSON.parse(await fs.readFile(path.join(backup, "manifest.json"), "utf8")));
  if (manifest.projectId !== options.projectId) throw new Error(`Backup belongs to project '${manifest.projectId}', not '${options.projectId}'.`);
  const sourceDatabase = path.join(backup, manifest.databaseFile);
  if (await sha256(sourceDatabase) !== manifest.databaseSha256) throw new Error("Backup checksum does not match its manifest.");
  if (await verifyDatabase(sourceDatabase) !== manifest.sqliteUserVersion) throw new Error("Backup SQLite schema version does not match its manifest.");

  const target = path.resolve(options.databasePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.restore-${randomUUID()}`;
  await fs.copyFile(sourceDatabase, temporary);
  await verifyDatabase(temporary);
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const suffix = `.pre-restore-${safeSegment(options.projectId)}-${stamp}`;
  let preservedDatabasePath: string | undefined;
  let quarantinedZvecPath: string | undefined;
  try {
    // Quarantine the derived index first. If this fails, the authoritative
    // database has not been touched. A successful restore intentionally starts
    // in lexical mode until an operator rebuilds and activates a collection.
    if (options.zvecRoot && await fs.stat(options.zvecRoot).then(() => true, () => false)) {
      quarantinedZvecPath = `${options.zvecRoot}${suffix}`;
      await fs.rename(options.zvecRoot, quarantinedZvecPath);
    }
    if (await fs.stat(target).then(() => true, () => false)) {
      preservedDatabasePath = `${target}${suffix}`;
      await fs.rename(target, preservedDatabasePath);
      for (const extension of ["-wal", "-shm"]) {
        await fs.rename(`${target}${extension}`, `${preservedDatabasePath}${extension}`).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
    await fs.rename(temporary, target);
    return { manifest, preservedDatabasePath, quarantinedZvecPath };
  } catch (error) {
    await fs.rm(temporary, { force: true });
    if (!await fs.stat(target).then(() => true, () => false) && preservedDatabasePath) await fs.rename(preservedDatabasePath, target).catch(() => undefined);
    if (options.zvecRoot && quarantinedZvecPath && !await fs.stat(options.zvecRoot).then(() => true, () => false)) {
      await fs.rename(quarantinedZvecPath, options.zvecRoot).catch(() => undefined);
    }
    throw error;
  }
}
