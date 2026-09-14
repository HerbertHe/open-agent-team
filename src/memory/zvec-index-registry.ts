import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  RevisionSchema,
  ZVEC_MANIFEST_FORMAT_VERSION,
  ZvecIndexManifestSchema,
  ZvecIndexStateSchema,
  type ZvecIndexManifest,
} from "./zvec-index-identity";

const REGISTRY_FILE = "oat-index-registry.json";
const ACTIVE_POINTER_FILE = "active.json";
const MANIFEST_FILE = "oat-index-manifest.json";

const IsoDateSchema = z.string().datetime({ offset: true });
const RelativeCollectionPathSchema = z.string().regex(/^collections\/[a-f0-9]{16}$/, "Collection paths must be revision-addressed relative paths.");

export const ZvecIndexRegistryEntrySchema = z.object({
  collectionRevision: RevisionSchema,
  embeddingRevision: RevisionSchema,
  state: ZvecIndexStateSchema,
  path: RelativeCollectionPathSchema,
  snapshotWatermark: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  readyAt: IsoDateSchema.nullable(),
  activatedAt: IsoDateSchema.nullable(),
  retiredAt: IsoDateSchema.nullable(),
}).strict();
export type ZvecIndexRegistryEntry = z.infer<typeof ZvecIndexRegistryEntrySchema>;

const ZvecIndexRegistryBaseSchema = z.object({
  formatVersion: z.literal(ZVEC_MANIFEST_FORMAT_VERSION),
  projectId: z.string().trim().min(1),
  collections: z.record(RevisionSchema, ZvecIndexRegistryEntrySchema),
  updatedAt: IsoDateSchema,
}).strict();

export const ZvecIndexRegistrySchema = ZvecIndexRegistryBaseSchema.superRefine((registry, context) => {
  let active = 0;
  let building = 0;
  for (const [revision, entry] of Object.entries(registry.collections)) {
    if (revision !== entry.collectionRevision) {
      context.addIssue({ code: "custom", path: ["collections", revision, "collectionRevision"], message: "Registry key and collection revision must match." });
    }
    if (entry.path !== `collections/${revision}`) {
      context.addIssue({ code: "custom", path: ["collections", revision, "path"], message: "Registry path must be derived from the collection revision." });
    }
    if (entry.state === "active") active += 1;
    if (entry.state === "building") building += 1;
    if (entry.state === "building" && (entry.readyAt || entry.activatedAt || entry.retiredAt)) {
      context.addIssue({ code: "custom", path: ["collections", revision], message: "A building collection cannot have ready, active or retired timestamps." });
    }
    if ((entry.state === "ready" || entry.state === "active" || entry.state === "retired") && !entry.readyAt) {
      context.addIssue({ code: "custom", path: ["collections", revision, "readyAt"], message: `A ${entry.state} collection requires a ready timestamp.` });
    }
    if ((entry.state === "active" || entry.state === "retired") && !entry.activatedAt) {
      context.addIssue({ code: "custom", path: ["collections", revision, "activatedAt"], message: `A ${entry.state} collection requires an activation timestamp.` });
    }
    if (entry.state === "retired" && !entry.retiredAt) {
      context.addIssue({ code: "custom", path: ["collections", revision, "retiredAt"], message: "A retired collection requires a retirement timestamp." });
    }
    if (entry.state !== "retired" && entry.retiredAt) {
      context.addIssue({ code: "custom", path: ["collections", revision, "retiredAt"], message: "Only a retired collection may have a retirement timestamp." });
    }
  }
  if (active > 1) context.addIssue({ code: "custom", path: ["collections"], message: "A project registry may contain at most one active collection." });
  if (building > 1) context.addIssue({ code: "custom", path: ["collections"], message: "A project registry may contain at most one building collection." });
});
export type ZvecIndexRegistry = z.infer<typeof ZvecIndexRegistrySchema>;

export const ActiveIndexPointerSchema = z.object({
  formatVersion: z.literal(ZVEC_MANIFEST_FORMAT_VERSION),
  projectId: z.string().trim().min(1),
  collectionRevision: RevisionSchema,
  activatedAt: IsoDateSchema,
}).strict();
export type ActiveIndexPointer = z.infer<typeof ActiveIndexPointerSchema>;

export type ZvecIndexLayout = {
  projectId: string;
  rootDirectory: string;
  projectDirectory: string;
  collectionsDirectory: string;
  registryFile: string;
  activePointerFile: string;
  collectionDirectory(revision: string): string;
  manifestFile(revision: string): string;
};

function projectDirectoryName(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) throw new Error("Project id is required for a Zvec index layout.");
  const slug = normalized.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${slug}-${suffix}`;
}

export function createZvecIndexLayout(rootDirectory: string, projectId: string): ZvecIndexLayout {
  const root = path.resolve(rootDirectory);
  const projectDirectory = path.join(root, projectDirectoryName(projectId));
  const collectionsDirectory = path.join(projectDirectory, "collections");
  const collectionDirectory = (revision: string): string => path.join(collectionsDirectory, RevisionSchema.parse(revision));
  return {
    projectId,
    rootDirectory: root,
    projectDirectory,
    collectionsDirectory,
    registryFile: path.join(projectDirectory, REGISTRY_FILE),
    activePointerFile: path.join(projectDirectory, ACTIVE_POINTER_FILE),
    collectionDirectory,
    manifestFile: (revision: string) => path.join(collectionDirectory(revision), MANIFEST_FILE),
  };
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

async function readJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertProject(expected: string, actual: string, source: string): void {
  if (expected !== actual) throw new Error(`${source} belongs to project '${actual}', not '${expected}'.`);
}

function assertLayoutProject(layout: ZvecIndexLayout, projectId: string): void {
  assertProject(projectId, layout.projectId, "Index layout");
}

export function emptyZvecIndexRegistry(projectId: string, updatedAt = new Date().toISOString()): ZvecIndexRegistry {
  return ZvecIndexRegistrySchema.parse({ formatVersion: ZVEC_MANIFEST_FORMAT_VERSION, projectId, collections: {}, updatedAt });
}

export function registerZvecIndexManifest(
  registry: ZvecIndexRegistry,
  manifest: ZvecIndexManifest,
  updatedAt = new Date().toISOString(),
): ZvecIndexRegistry {
  const validatedRegistry = ZvecIndexRegistrySchema.parse(registry);
  const validatedManifest = ZvecIndexManifestSchema.parse(manifest);
  if (validatedRegistry.projectId !== validatedManifest.projectId) throw new Error("Cannot register a manifest owned by a different project.");
  if (validatedRegistry.collections[validatedManifest.collectionRevision]) return validatedRegistry;
  const entry: ZvecIndexRegistryEntry = {
    collectionRevision: validatedManifest.collectionRevision,
    embeddingRevision: validatedManifest.embeddingRevision,
    state: validatedManifest.state,
    path: `collections/${validatedManifest.collectionRevision}`,
    snapshotWatermark: null,
    documentCount: validatedManifest.documentCount,
    createdAt: validatedManifest.createdAt,
    readyAt: validatedManifest.readyAt,
    activatedAt: null,
    retiredAt: null,
  };
  return ZvecIndexRegistrySchema.parse({
    ...validatedRegistry,
    collections: { ...validatedRegistry.collections, [validatedManifest.collectionRevision]: entry },
    updatedAt,
  });
}

export function replaceZvecIndexRegistryEntry(
  registry: ZvecIndexRegistry,
  entry: ZvecIndexRegistryEntry,
  updatedAt = new Date().toISOString(),
): ZvecIndexRegistry {
  const validated = ZvecIndexRegistrySchema.parse(registry);
  const nextEntry = ZvecIndexRegistryEntrySchema.parse(entry);
  const current = validated.collections[nextEntry.collectionRevision];
  if (!current) throw new Error(`Cannot replace unknown collection '${nextEntry.collectionRevision}'.`);
  if (current.embeddingRevision !== nextEntry.embeddingRevision || current.path !== nextEntry.path || current.createdAt !== nextEntry.createdAt) {
    throw new Error("Collection identity fields are immutable.");
  }
  return ZvecIndexRegistrySchema.parse({
    ...validated,
    collections: { ...validated.collections, [nextEntry.collectionRevision]: nextEntry },
    updatedAt,
  });
}

export function removeZvecIndexRegistryEntry(
  registry: ZvecIndexRegistry,
  collectionRevision: string,
  updatedAt = new Date().toISOString(),
): ZvecIndexRegistry {
  const validated = ZvecIndexRegistrySchema.parse(registry);
  const current = validated.collections[RevisionSchema.parse(collectionRevision)];
  if (!current) return validated;
  if (current.state !== "retired" && current.state !== "failed") throw new Error(`Cannot remove ${current.state} collection '${collectionRevision}'.`);
  const collections = { ...validated.collections };
  delete collections[collectionRevision];
  return ZvecIndexRegistrySchema.parse({ ...validated, collections, updatedAt });
}

export async function readZvecIndexRegistry(layout: ZvecIndexLayout, projectId: string): Promise<ZvecIndexRegistry> {
  assertLayoutProject(layout, projectId);
  const raw = await readJson(layout.registryFile);
  if (raw === undefined) return emptyZvecIndexRegistry(projectId);
  const registry = ZvecIndexRegistrySchema.parse(raw);
  assertProject(projectId, registry.projectId, "Index registry");
  return registry;
}

export async function writeZvecIndexRegistry(layout: ZvecIndexLayout, projectId: string, registry: ZvecIndexRegistry): Promise<void> {
  assertLayoutProject(layout, projectId);
  const validated = ZvecIndexRegistrySchema.parse(registry);
  assertProject(projectId, validated.projectId, "Index registry");
  await writeJsonAtomically(layout.registryFile, validated);
}

export async function readActiveIndexPointer(layout: ZvecIndexLayout, projectId: string): Promise<ActiveIndexPointer | undefined> {
  assertLayoutProject(layout, projectId);
  const raw = await readJson(layout.activePointerFile);
  if (raw === undefined) return undefined;
  const pointer = ActiveIndexPointerSchema.parse(raw);
  assertProject(projectId, pointer.projectId, "Active index pointer");
  return pointer;
}

export async function writeActiveIndexPointer(
  layout: ZvecIndexLayout,
  projectId: string,
  pointer: ActiveIndexPointer,
): Promise<void> {
  assertLayoutProject(layout, projectId);
  const registry = await readZvecIndexRegistry(layout, projectId);
  const validated = ActiveIndexPointerSchema.parse(pointer);
  assertProject(projectId, validated.projectId, "Active index pointer");
  const entry = resolveActiveRegistryEntry(registry, validated);
  const manifest = await readZvecIndexManifest(layout, projectId, validated.collectionRevision);
  if (!manifest) throw new Error("Active index pointer references a collection without a manifest.");
  if (manifest.state !== "ready" && manifest.state !== "active") {
    throw new Error(`Active index pointer references a manifest in '${manifest.state}' state.`);
  }
  if (manifest.embeddingRevision !== entry.embeddingRevision) {
    throw new Error("Active index registry and manifest embedding revisions do not match.");
  }
  await writeJsonAtomically(layout.activePointerFile, validated);
}

export function resolveActiveRegistryEntry(
  registry: ZvecIndexRegistry,
  pointer: ActiveIndexPointer,
): ZvecIndexRegistryEntry {
  const validatedRegistry = ZvecIndexRegistrySchema.parse(registry);
  const validatedPointer = ActiveIndexPointerSchema.parse(pointer);
  assertProject(validatedRegistry.projectId, validatedPointer.projectId, "Active index pointer");
  const entry = validatedRegistry.collections[validatedPointer.collectionRevision];
  if (!entry) throw new Error("Active index pointer references a collection missing from the registry.");
  if (entry.state !== "ready" && entry.state !== "active") {
    throw new Error(`Active index pointer references a collection in '${entry.state}' state.`);
  }
  return entry;
}

export async function readZvecIndexManifest(layout: ZvecIndexLayout, projectId: string, revision: string): Promise<ZvecIndexManifest | undefined> {
  assertLayoutProject(layout, projectId);
  const raw = await readJson(layout.manifestFile(revision));
  if (raw === undefined) return undefined;
  const manifest = ZvecIndexManifestSchema.parse(raw);
  assertProject(projectId, manifest.projectId, "Index manifest");
  if (revision !== manifest.collectionRevision) throw new Error("Index manifest path does not match its collection revision.");
  return manifest;
}

export async function writeZvecIndexManifest(layout: ZvecIndexLayout, projectId: string, manifest: ZvecIndexManifest): Promise<void> {
  assertLayoutProject(layout, projectId);
  const validated = ZvecIndexManifestSchema.parse(manifest);
  assertProject(projectId, validated.projectId, "Index manifest");
  await writeJsonAtomically(layout.manifestFile(validated.collectionRevision), validated);
}
