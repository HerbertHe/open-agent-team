import { z } from "zod";
import { RevisionSchema, ZvecIndexManifestSchema, type ZvecIndexManifest } from "./zvec-index-identity";

export const ZvecScalarFieldDescriptorSchema = z.object({
  name: z.string(),
  dataType: z.enum(["string", "int32", "int64", "float"]),
  nullable: z.boolean(),
  index: z.enum(["none", "invert", "fts"]),
  rangeOptimization: z.boolean().optional(),
  tokenizer: z.string().optional(),
  filters: z.array(z.string()).optional(),
}).strict();

export const ZvecVectorFieldDescriptorSchema = z.object({
  name: z.literal("dense_embedding"),
  dataType: z.literal("vector_fp32"),
  dimensions: z.number().int().positive(),
  index: z.enum(["flat", "hnsw"]),
  metric: z.literal("cosine"),
}).strict();

export const ZvecMemorySchemaDescriptorSchema = z.object({
  name: z.string(),
  fields: z.array(ZvecScalarFieldDescriptorSchema),
  vector: ZvecVectorFieldDescriptorSchema,
}).strict();
export type ZvecMemorySchemaDescriptor = z.infer<typeof ZvecMemorySchemaDescriptorSchema>;

export const ZvecMemoryIndexStatsSchema = z.object({
  documentCount: z.number().int().nonnegative(),
  indexCompleteness: z.record(z.string(), z.number().min(0).max(1)),
  readOnly: z.boolean(),
  path: z.string(),
  collectionRevision: RevisionSchema,
}).strict();
export type ZvecMemoryIndexStats = z.infer<typeof ZvecMemoryIndexStatsSchema>;

export const ZvecMemoryDocumentSchema = z.object({
  id: z.string().min(1),
  vector: z.array(z.number().finite()).min(1),
  fields: z.object({
    content: z.string(),
    project_id: z.string(),
    owner_agent_id: z.string(),
    team_id: z.string().nullable(),
    scope: z.string(),
    level: z.string(),
    kind: z.string(),
    status: z.string(),
    trust_level: z.number().int(),
    valid_from_ms: z.number().int(),
    valid_to_ms: z.number().int().nullable(),
    updated_at_ms: z.number().int(),
    salience: z.number().finite(),
    confidence: z.number().finite(),
    content_hash: z.string(),
  }).strict(),
}).strict();
export type ZvecMemoryDocument = z.infer<typeof ZvecMemoryDocumentSchema>;

export const ZvecWriteStatusSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
}).strict();
export type ZvecWriteStatus = z.infer<typeof ZvecWriteStatusSchema>;

export const ZvecDocumentMetadataSchema = z.object({
  id: z.string(),
  contentHash: z.string(),
  vectorDimensions: z.number().int().positive(),
}).strict();
export type ZvecDocumentMetadata = z.infer<typeof ZvecDocumentMetadataSchema>;

export const ZvecQueryHitSchema = z.object({
  id: z.string(),
  score: z.number().finite(),
}).strict();
export type ZvecQueryHit = z.infer<typeof ZvecQueryHitSchema>;

export const ZvecQueryRoutesResultSchema = z.object({
  dense: z.array(ZvecQueryHitSchema),
  fts: z.array(ZvecQueryHitSchema),
  errors: z.array(z.object({ route: z.enum(["dense", "fts"]), message: z.string() }).strict()),
}).strict();
export type ZvecQueryRoutesResult = z.infer<typeof ZvecQueryRoutesResultSchema>;

export const ZVEC_MEMORY_SCALAR_FIELDS: ZvecMemorySchemaDescriptor["fields"] = [
  { name: "content", dataType: "string", nullable: false, index: "fts", tokenizer: "jieba", filters: ["lowercase"] },
  { name: "project_id", dataType: "string", nullable: false, index: "invert" },
  { name: "owner_agent_id", dataType: "string", nullable: false, index: "invert" },
  { name: "team_id", dataType: "string", nullable: true, index: "invert" },
  { name: "scope", dataType: "string", nullable: false, index: "invert" },
  { name: "level", dataType: "string", nullable: false, index: "invert" },
  { name: "kind", dataType: "string", nullable: false, index: "invert" },
  { name: "status", dataType: "string", nullable: false, index: "invert" },
  { name: "trust_level", dataType: "int32", nullable: false, index: "invert" },
  { name: "valid_from_ms", dataType: "int64", nullable: false, index: "invert", rangeOptimization: true },
  { name: "valid_to_ms", dataType: "int64", nullable: true, index: "invert", rangeOptimization: true },
  { name: "updated_at_ms", dataType: "int64", nullable: false, index: "invert", rangeOptimization: true },
  { name: "salience", dataType: "float", nullable: false, index: "none" },
  { name: "confidence", dataType: "float", nullable: false, index: "none" },
  { name: "content_hash", dataType: "string", nullable: false, index: "invert" },
];

export function expectedZvecMemorySchema(manifestInput: ZvecIndexManifest): ZvecMemorySchemaDescriptor {
  const manifest = ZvecIndexManifestSchema.parse(manifestInput);
  return ZvecMemorySchemaDescriptorSchema.parse({
    name: `oat_memory_${manifest.collectionRevision}`,
    fields: ZVEC_MEMORY_SCALAR_FIELDS,
    vector: {
      name: "dense_embedding",
      dataType: "vector_fp32",
      dimensions: manifest.embedding.dimensions,
      index: manifest.index,
      metric: manifest.metric,
    },
  });
}

export type ZvecWorkerCommand =
  | { operation: "create" | "open"; handleId: string; path: string; manifest: ZvecIndexManifest; readOnly: boolean; enableMMAP: boolean }
  | { operation: "stats" | "close"; handleId: string }
  | { operation: "upsert"; handleId: string; documents: ZvecMemoryDocument[] }
  | { operation: "delete"; handleId: string; ids: string[] }
  | { operation: "durability"; handleId: string; ids: string[] }
  | { operation: "fetch-metadata"; handleId: string; ids: string[] }
  | { operation: "query-routes"; handleId: string; filter: string; matchString: string; denseVector?: number[]; topK: number }
  | { operation: "optimize"; handleId: string }
  | { operation: "destroy"; path: string; manifest: ZvecIndexManifest; enableMMAP: boolean }
  | { operation: "dispose" };

export type ZvecWorkerRequest = ZvecWorkerCommand extends infer Command
  ? Command extends ZvecWorkerCommand ? Command & { id: string } : never
  : never;

export type ZvecWorkerResponse = {
  id: string;
  ok: true;
  value?: unknown;
} | {
  id: string;
  ok: false;
  error: { message: string; code?: string };
};
