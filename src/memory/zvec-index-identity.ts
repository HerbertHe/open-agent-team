import { createHash } from "node:crypto";
import { z } from "zod";
import {
  embeddingIdentityRevision,
  embeddingProviderEndpoint,
  EmbeddingProfileRevisionSchema,
  type EmbeddingProfile,
  type GlobalModelProvider,
} from "../models/global-models";

export const ZVEC_MANIFEST_FORMAT_VERSION = 1 as const;
export const ZVEC_VECTOR_SCHEMA_VERSION = 1 as const;
export const ZVEC_INDEX_PROJECTION_VERSION = 1 as const;

export const RevisionSchema = z.string().regex(/^[a-f0-9]{16}$/, "Expected a 16-character lowercase hexadecimal revision.");
export const ZvecIndexStateSchema = z.enum(["building", "ready", "active", "retired", "failed"]);
export type ZvecIndexState = z.infer<typeof ZvecIndexStateSchema>;

export const EmbeddingSnapshotSchema = z.object({
  profile: z.string().trim().min(1),
  kind: z.enum(["openai-compatible", "deterministic-fake"]),
  provider: z.string().trim().min(1),
  endpoint: z.string().url().optional(),
  model: z.string().trim().min(1),
  dimensions: z.number().int().min(1).max(65_536),
  normalization: z.enum(["provider-default", "l2"]),
  revision: EmbeddingProfileRevisionSchema,
}).strict();
export type EmbeddingSnapshot = z.infer<typeof EmbeddingSnapshotSchema>;

export type CollectionIdentityInput = {
  embeddingRevision: string;
  metric: "cosine";
  index: "flat" | "hnsw";
  vectorSchemaVersion?: number;
  indexProjectionVersion?: number;
};

function shortRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function createEmbeddingSnapshot(
  profileName: string,
  profile: EmbeddingProfile,
  provider?: GlobalModelProvider,
): EmbeddingSnapshot {
  const endpoint = profile.kind === "openai-compatible" ? embeddingProviderEndpoint(provider) : undefined;
  if (profile.kind === "openai-compatible") {
    if (!provider || provider.compatible_type !== "openai" || !endpoint) {
      throw new Error(`Embedding profile '${profileName}' requires an OpenAI-compatible provider with a base URL.`);
    }
  }
  return EmbeddingSnapshotSchema.parse({
    profile: profileName,
    kind: profile.kind,
    provider: profile.kind === "openai-compatible" ? profile.provider : "deterministic-fake",
    endpoint,
    model: profile.model,
    dimensions: profile.dimensions,
    normalization: profile.normalization,
    revision: profile.revision,
  });
}

export function collectionIdentityRevision(input: CollectionIdentityInput): string {
  const embeddingRevision = RevisionSchema.parse(input.embeddingRevision);
  const vectorSchemaVersion = z.number().int().positive().parse(input.vectorSchemaVersion ?? ZVEC_VECTOR_SCHEMA_VERSION);
  const indexProjectionVersion = z.number().int().positive().parse(input.indexProjectionVersion ?? ZVEC_INDEX_PROJECTION_VERSION);
  return shortRevision({
    embeddingRevision,
    metric: input.metric,
    index: input.index,
    vectorSchemaVersion,
    indexProjectionVersion,
  });
}

const IsoDateSchema = z.string().datetime({ offset: true });

const ZvecIndexManifestBaseSchema = z.object({
  formatVersion: z.literal(ZVEC_MANIFEST_FORMAT_VERSION),
  projectId: z.string().trim().min(1),
  collectionRevision: RevisionSchema,
  embeddingRevision: RevisionSchema,
  embedding: EmbeddingSnapshotSchema,
  metric: z.literal("cosine"),
  index: z.enum(["flat", "hnsw"]),
  vectorSchemaVersion: z.number().int().positive(),
  indexProjectionVersion: z.number().int().positive(),
  state: ZvecIndexStateSchema,
  documentCount: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  readyAt: IsoDateSchema.nullable(),
  lastRebuildAt: IsoDateSchema.nullable(),
}).strict();

export const ZvecIndexManifestSchema = ZvecIndexManifestBaseSchema.superRefine((manifest, context) => {
  const expectedEmbedding = shortRevision({
    kind: manifest.embedding.kind,
    provider: manifest.embedding.provider,
    endpoint: manifest.embedding.endpoint,
    model: manifest.embedding.model,
    dimensions: manifest.embedding.dimensions,
    normalization: manifest.embedding.normalization,
    revision: manifest.embedding.revision,
  });
  if (manifest.embeddingRevision !== expectedEmbedding) {
    context.addIssue({ code: "custom", path: ["embeddingRevision"], message: "Embedding revision does not match the frozen embedding snapshot." });
  }
  const expectedCollection = collectionIdentityRevision({
    embeddingRevision: manifest.embeddingRevision,
    metric: manifest.metric,
    index: manifest.index,
    vectorSchemaVersion: manifest.vectorSchemaVersion,
    indexProjectionVersion: manifest.indexProjectionVersion,
  });
  if (manifest.collectionRevision !== expectedCollection) {
    context.addIssue({ code: "custom", path: ["collectionRevision"], message: "Collection revision does not match the manifest identity fields." });
  }
  if (manifest.state === "building" && manifest.readyAt !== null) {
    context.addIssue({ code: "custom", path: ["readyAt"], message: "A building manifest cannot have a ready timestamp." });
  }
  if ((manifest.state === "ready" || manifest.state === "active" || manifest.state === "retired") && manifest.readyAt === null) {
    context.addIssue({ code: "custom", path: ["readyAt"], message: `A ${manifest.state} manifest requires a ready timestamp.` });
  }
});
export type ZvecIndexManifest = z.infer<typeof ZvecIndexManifestSchema>;

export function createZvecIndexManifest(input: {
  projectId: string;
  profileName: string;
  profile: EmbeddingProfile;
  provider?: GlobalModelProvider;
  metric: "cosine";
  index: "flat" | "hnsw";
  vectorSchemaVersion?: number;
  indexProjectionVersion?: number;
  createdAt?: string;
}): ZvecIndexManifest {
  const embedding = createEmbeddingSnapshot(input.profileName, input.profile, input.provider);
  const embeddingRevision = embeddingIdentityRevision(input.profile, input.provider);
  const vectorSchemaVersion = input.vectorSchemaVersion ?? ZVEC_VECTOR_SCHEMA_VERSION;
  const indexProjectionVersion = input.indexProjectionVersion ?? ZVEC_INDEX_PROJECTION_VERSION;
  const collectionRevision = collectionIdentityRevision({
    embeddingRevision,
    metric: input.metric,
    index: input.index,
    vectorSchemaVersion,
    indexProjectionVersion,
  });
  const createdAt = input.createdAt ?? new Date().toISOString();
  return ZvecIndexManifestSchema.parse({
    formatVersion: ZVEC_MANIFEST_FORMAT_VERSION,
    projectId: input.projectId,
    collectionRevision,
    embeddingRevision,
    embedding,
    metric: input.metric,
    index: input.index,
    vectorSchemaVersion,
    indexProjectionVersion,
    state: "building",
    documentCount: 0,
    createdAt,
    readyAt: null,
    lastRebuildAt: null,
  });
}
