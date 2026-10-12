import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import { OpaqueIdSchema, PlanVersionIdSchema, ProgramIdSchema } from "./program-types";
import type { FaultPoint } from "./fault-injection-harness";

const Timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const SuspensionSnapshotManifestSchema = z.object({
  schemaVersion: z.literal(1), id: OpaqueIdSchema, programId: ProgramIdSchema, planVersionId: PlanVersionIdSchema,
  executionEpoch: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(10_000),
  mode: z.enum(["graceful", "immediate", "cancel_closeout"]), programRevision: z.number().int().nonnegative(),
  budgetStateDigest: Digest, activeReservations: z.array(OpaqueIdSchema), uncertainOperations: z.array(OpaqueIdSchema),
  workPackages: z.array(z.object({ id: OpaqueIdSchema, stableKey: OpaqueIdSchema, status: z.string().min(1),
    attemptId: OpaqueIdSchema.optional(), agentId: OpaqueIdSchema.optional(), fencingToken: z.number().int().positive().optional(), latestCheckpointId: OpaqueIdSchema.optional() }).strict()),
  artifacts: z.array(z.object({ path: z.string().min(1).max(4_096), digest: Digest, verified: z.boolean() }).strict()),
  workspaceStates: z.array(z.object({ agentId: OpaqueIdSchema, workspacePath: z.string().min(1).max(4_096), headSha: z.string().regex(/^[a-f0-9]{7,64}$/).optional(), dirty: z.boolean(), patchArtifactPath: z.string().max(4_096).optional() }).strict()),
  wakeups: z.array(OpaqueIdSchema), externalReceipts: z.array(OpaqueIdSchema), pendingApprovals: z.array(OpaqueIdSchema),
  resumePreconditions: z.array(z.string().max(2_000)), createdAt: Timestamp,
}).strict();
export type SuspensionSnapshotManifest = z.infer<typeof SuspensionSnapshotManifestSchema>;
export class SnapshotError extends Error { constructor(readonly code: "UNSAFE_ARTIFACT" | "SNAPSHOT_CORRUPT" | "SNAPSHOT_NOT_FOUND", message: string) { super(message); this.name = "SnapshotError"; } }
const SECRET = /(^|[._-])(env|secret|credential|token|private[-_]?key|id_rsa)([._-]|$)/i;
function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string { return JSON.stringify(value); }

export class SuspensionSnapshotStore {
  private readonly database: Database.Database;
  private readonly root: string;
  constructor(handle: ExecutionDatabase, stateDirectory: string, private readonly maxArtifactBytes = 10 * 1024 * 1024) {
    this.database = handle.connection; this.root = path.resolve(stateDirectory, "execution", "snapshots"); mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  create(manifestInput: SuspensionSnapshotManifest, sources: Array<{ workspaceRoot: string; relativePath: string }> = [], faultInjector?: (point: FaultPoint) => void): { manifest: SuspensionSnapshotManifest; digest: string } {
    const manifest = SuspensionSnapshotManifestSchema.parse(manifestInput);
    const existing = this.database.prepare("SELECT manifest_json,digest FROM suspension_snapshots WHERE id=?").get(manifest.id) as { manifest_json: string; digest: string } | undefined;
    if (existing) {
      if (existing.manifest_json !== canonical(manifest)) throw new SnapshotError("SNAPSHOT_CORRUPT", `Snapshot ${manifest.id} was reused with different content`);
      return this.get(manifest.id);
    }
    const sourceByPath = new Map(sources.map((source) => [source.relativePath.replaceAll("\\", "/"), source]));
    if (sourceByPath.size !== sources.length || manifest.artifacts.some((artifact) => !sourceByPath.has(artifact.path)) || sources.some((source) => !manifest.artifacts.some((artifact) => artifact.path === source.relativePath.replaceAll("\\", "/")))) {
      throw new SnapshotError("SNAPSHOT_CORRUPT", "Snapshot artifact manifest and sources must match exactly");
    }
    const validated: Array<{ input: string; relative: string }> = [];
    for (const source of sources) {
      const relative = source.relativePath.replaceAll("\\", "/");
      if (path.isAbsolute(relative) || relative.split("/").some((part) => part === "..") || relative.startsWith(".git/") || relative.includes("node_modules/") || SECRET.test(relative)) {
        throw new SnapshotError("UNSAFE_ARTIFACT", `Unsafe snapshot artifact: ${relative}`);
      }
      const root = path.resolve(source.workspaceRoot); const input = path.resolve(root, relative);
      if (!input.startsWith(`${root}${path.sep}`) || !existsSync(input) || lstatSync(input).isSymbolicLink() || !lstatSync(input).isFile()) throw new SnapshotError("UNSAFE_ARTIFACT", `Artifact leaves workspace or is not a regular file: ${relative}`);
      const bytes = readFileSync(input); if (bytes.length > this.maxArtifactBytes) throw new SnapshotError("UNSAFE_ARTIFACT", `Artifact exceeds size limit: ${relative}`);
      const declared = manifest.artifacts.find((item) => item.path === relative);
      if (!declared || sha(bytes) !== declared.digest) throw new SnapshotError("SNAPSHOT_CORRUPT", `Artifact digest mismatch: ${relative}`);
      validated.push({ input, relative });
    }
    const directory = path.join(this.root, manifest.id); const json = canonical(manifest); const digest = sha(json);
    if (existsSync(directory)) {
      const diskPath = path.join(directory, "manifest.json");
      if (!existsSync(diskPath) || readFileSync(diskPath, "utf8") !== json) throw new SnapshotError("SNAPSHOT_CORRUPT", `Partial snapshot ${manifest.id} does not match retry`);
    } else {
      mkdirSync(directory, { recursive: false, mode: 0o700 });
      for (const item of validated) {
        const output = path.join(directory, "artifacts", item.relative); mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); copyFileSync(item.input, output);
      }
      writeFileSync(path.join(directory, "manifest.json"), json, { mode: 0o600, flag: "wx" });
    }
    faultInjector?.("snapshot_after_manifest");
    this.database.prepare(`INSERT INTO suspension_snapshots(id, program_id, plan_version_id, execution_epoch, manifest_json, digest, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`)
      .run(manifest.id, manifest.programId, manifest.planVersionId, manifest.executionEpoch, json, digest, manifest.createdAt);
    return { manifest, digest };
  }
  get(idInput: string): { manifest: SuspensionSnapshotManifest; digest: string } {
    const id = OpaqueIdSchema.parse(idInput); const row = this.database.prepare("SELECT manifest_json, digest FROM suspension_snapshots WHERE id=?").get(id) as { manifest_json: string; digest: string } | undefined;
    if (!row) throw new SnapshotError("SNAPSHOT_NOT_FOUND", `Snapshot ${id} was not found`);
    const disk = readFileSync(path.join(this.root, id, "manifest.json"), "utf8");
    if (disk !== row.manifest_json || sha(disk) !== row.digest) throw new SnapshotError("SNAPSHOT_CORRUPT", `Snapshot ${id} was tampered with`);
    const manifest = SuspensionSnapshotManifestSchema.parse(JSON.parse(disk) as unknown);
    for (const artifact of manifest.artifacts) {
      const file = path.join(this.root, id, "artifacts", artifact.path);
      if (!existsSync(file) || sha(readFileSync(file)) !== artifact.digest) throw new SnapshotError("SNAPSHOT_CORRUPT", `Snapshot artifact ${artifact.path} was tampered with`);
    }
    return { manifest, digest: row.digest };
  }
}
