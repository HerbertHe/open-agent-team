import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryBackup, restoreMemoryBackup } from "./memory-backup";
import { SqliteMemoryRepository } from "./memory-repository";

function seed(projectId: string, databasePath: string, content: string): void {
  const repository = new SqliteMemoryRepository(projectId, databasePath);
  try {
    repository.capture({ id: `${content}-event`, ownerAgentId: "admin", sourceAgentId: "admin", role: "admin", trustLevel: 100, eventType: "report_progress", kind: "decision", content, metadataJson: "{}", createdAt: "2026-09-14T00:00:00.000Z", fingerprint: content }, 10);
  } finally { repository.close(); }
}

test("M15 creates a checksummed live-safe SQLite backup and restores it while quarantining derived Zvec data", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m15-backup-"));
  const databasePath = path.join(root, "state", "memory", "memory.db");
  const backupPath = path.join(root, "backup");
  const zvecRoot = path.join(root, "state", "memory", "zvec");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  try {
    seed("project-a", databasePath, "before-backup");
    const manifest = await createMemoryBackup({ projectId: "project-a", databasePath, destinationDirectory: backupPath });
    assert.equal(manifest.zvecIncluded, false);
    assert.match(manifest.databaseSha256, /^[a-f0-9]{64}$/);
    seed("project-a", databasePath, "after-backup");
    await fs.mkdir(zvecRoot, { recursive: true });
    await fs.writeFile(path.join(zvecRoot, "derived"), "discardable");

    await assert.rejects(() => restoreMemoryBackup({ projectId: "project-a", backupDirectory: backupPath, databasePath, zvecRoot, serviceStopped: false, confirmProjectId: "project-a" }), /Stop the project/);
    await assert.rejects(() => restoreMemoryBackup({ projectId: "project-b", backupDirectory: backupPath, databasePath, zvecRoot, serviceStopped: true, confirmProjectId: "project-b" }), /belongs to project/);
    const restored = await restoreMemoryBackup({ projectId: "project-a", backupDirectory: backupPath, databasePath, zvecRoot, serviceStopped: true, confirmProjectId: "project-a" });
    assert.ok(restored.preservedDatabasePath);
    assert.ok(restored.quarantinedZvecPath);
    const repository = new SqliteMemoryRepository("project-a", databasePath);
    try {
      assert.equal(repository.list({ limit: 20 }).some(({ summary }) => summary.includes("before-backup")), true);
      assert.equal(repository.list({ limit: 20 }).some(({ summary }) => summary.includes("after-backup")), false);
    } finally { repository.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
