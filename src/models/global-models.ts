import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const EmbeddingProfileRevisionSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const EmbeddingProfileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("openai-compatible"),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    dimensions: z.number().int().min(1).max(65_536),
    normalization: z.enum(["provider-default", "l2"]).default("provider-default"),
    revision: EmbeddingProfileRevisionSchema.default("1"),
    timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    batchSize: z.number().int().min(1).max(2_048).default(32),
    maxAttempts: z.number().int().min(1).max(8).default(3),
  }),
  z.object({
    kind: z.literal("deterministic-fake"),
    model: z.string().trim().min(1).default("test-hash-v1"),
    dimensions: z.number().int().min(1).max(4_096),
    normalization: z.literal("l2").default("l2"),
    revision: EmbeddingProfileRevisionSchema.default("1"),
    timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    batchSize: z.number().int().min(1).max(2_048).default(32),
    maxAttempts: z.literal(1).default(1),
  }),
]);

export type EmbeddingProfile = z.infer<typeof EmbeddingProfileSchema>;

const ProviderSchema = z.object({
  compatible_type: z.string().trim().min(1).default("openai"),
  base_url: z.string().trim().min(1).optional(),
  api_key: z.string().optional(),
}).passthrough();

const GlobalModelCatalogBaseSchema = z.object({
  providers: z.record(z.string(), ProviderSchema).default({}),
  models: z.record(z.string(), z.string()).default({}),
  embeddingProfiles: z.record(z.string(), EmbeddingProfileSchema).default({}),
});

export const GlobalModelCatalogSchema = GlobalModelCatalogBaseSchema.superRefine((catalog, context) => {
  for (const [name, profile] of Object.entries(catalog.embeddingProfiles)) {
    if (profile.kind !== "openai-compatible") continue;
    const provider = catalog.providers[profile.provider];
    if (!provider) {
      context.addIssue({ code: "custom", path: ["embeddingProfiles", name, "provider"], message: `Provider '${profile.provider}' does not exist.` });
    } else if (provider.compatible_type !== "openai") {
      context.addIssue({ code: "custom", path: ["embeddingProfiles", name, "provider"], message: "Embedding profiles require an OpenAI-compatible provider." });
    }
  }
});

export type GlobalModelProvider = z.infer<typeof ProviderSchema>;
export type GlobalModelCatalog = z.infer<typeof GlobalModelCatalogSchema>;

export function parseGlobalModelCatalog(value: unknown): GlobalModelCatalog {
  return GlobalModelCatalogSchema.parse(value && typeof value === "object" ? value : {});
}

export async function loadGlobalModelCatalog(file = path.join(os.homedir(), ".oat", "models.json")): Promise<GlobalModelCatalog> {
  try { return parseGlobalModelCatalog(JSON.parse(await fs.readFile(file, "utf8")) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseGlobalModelCatalog({});
    throw error;
  }
}

export function embeddingProviderEndpoint(provider?: GlobalModelProvider): string | undefined {
  if (!provider?.base_url) return undefined;
  const endpoint = new URL(provider.base_url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Embedding provider base URL cannot contain credentials, query parameters or fragments.");
  }
  return endpoint.toString().replace(/\/+$/, "");
}

export function embeddingIdentityRevision(profile: EmbeddingProfile, provider?: GlobalModelProvider): string {
  return createHash("sha256").update(JSON.stringify({
    kind: profile.kind,
    provider: profile.kind === "openai-compatible" ? profile.provider : "deterministic-fake",
    endpoint: profile.kind === "openai-compatible" ? embeddingProviderEndpoint(provider) : undefined,
    model: profile.model,
    dimensions: profile.dimensions,
    normalization: profile.normalization,
    revision: profile.revision,
  })).digest("hex").slice(0, 16);
}

export function resolveEmbeddingReference(projectReference: string | null | undefined, globalDefault: string | undefined): string | undefined {
  return projectReference === null ? undefined : projectReference ?? globalDefault;
}
