import { createHash } from "node:crypto";
import {
  embeddingIdentityRevision,
  type EmbeddingProfile,
  type GlobalModelCatalog,
  type GlobalModelProvider,
} from "../models/global-models";

export type EmbeddingIdentity = {
  provider: string;
  model: string;
  dimensions: number;
  normalization: "provider-default" | "l2";
  revision: string;
};

export type EmbeddingErrorCode =
  | "disabled"
  | "invalid_config"
  | "unauthorized"
  | "insufficient_balance"
  | "rate_limited"
  | "timeout"
  | "network"
  | "provider_error"
  | "invalid_response"
  | "dimension_mismatch";

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly code: EmbeddingErrorCode,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export interface EmbeddingProvider {
  readonly available: boolean;
  readonly identity: EmbeddingIdentity;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export type EmbeddingProviderResolution = {
  state: "ready" | "disabled" | "misconfigured";
  provider: EmbeddingProvider;
  reason?: string;
};

type ProviderDependencies = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  allowDeterministicFake?: boolean;
};

function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function assertInput(texts: string[]): void {
  if (!texts.length || texts.some((text) => typeof text !== "string" || !text.trim())) {
    throw new EmbeddingProviderError("Embedding input must contain non-empty text.", "invalid_config", false);
  }
}

export class DisabledEmbeddingProvider implements EmbeddingProvider {
  readonly available = false;
  readonly identity: EmbeddingIdentity = { provider: "disabled", model: "", dimensions: 0, normalization: "provider-default", revision: "disabled" };

  private unavailable(): never {
    throw new EmbeddingProviderError("Embedding is disabled because no valid global profile is selected.", "disabled", false);
  }

  async embedDocuments(_texts: string[]): Promise<number[][]> { return this.unavailable(); }
  async embedQuery(_text: string): Promise<number[]> { return this.unavailable(); }
}

export class DeterministicFakeEmbeddingProvider implements EmbeddingProvider {
  readonly available = true;
  readonly identity: EmbeddingIdentity;

  constructor(private readonly profile: Extract<EmbeddingProfile, { kind: "deterministic-fake" }>) {
    this.identity = {
      provider: "deterministic-fake",
      model: profile.model,
      dimensions: profile.dimensions,
      normalization: profile.normalization,
      revision: embeddingIdentityRevision(profile),
    };
  }

  private embed(text: string): number[] {
    assertInput([text]);
    const vector: number[] = [];
    for (let counter = 0; vector.length < this.profile.dimensions; counter += 1) {
      const digest = createHash("sha256").update(`${this.profile.model}\0${counter}\0${text}`).digest();
      for (const byte of digest) {
        vector.push((byte - 127.5) / 127.5);
        if (vector.length === this.profile.dimensions) break;
      }
    }
    return l2Normalize(vector);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    assertInput(texts);
    return texts.map((text) => this.embed(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }
}

function sanitizeMessage(value: string, secrets: string[]): string {
  let output = value;
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[REDACTED]");
  return output
    .replace(/(?:sk|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .slice(0, 800);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function httpError(status: number, body: string, retryAfter: number | undefined, secrets: string[]): EmbeddingProviderError {
  const suffix = sanitizeMessage(body, secrets);
  if (status === 401 || status === 403) return new EmbeddingProviderError(`Embedding authentication failed (${status}). ${suffix}`, "unauthorized", false, status);
  if (status === 402) return new EmbeddingProviderError(`Embedding balance is insufficient (402). ${suffix}`, "insufficient_balance", false, status);
  if (status === 429) return new EmbeddingProviderError(`Embedding provider rate limit exceeded (429). ${suffix}`, "rate_limited", true, status, retryAfter);
  const retryable = status === 408 || status === 409 || status >= 500;
  return new EmbeddingProviderError(`Embedding provider returned HTTP ${status}. ${suffix}`, "provider_error", retryable, status, retryAfter);
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly available = true;
  readonly identity: EmbeddingIdentity;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly endpoint: string;

  constructor(
    private readonly profile: Extract<EmbeddingProfile, { kind: "openai-compatible" }>,
    private readonly providerConfig: GlobalModelProvider,
    dependencies: ProviderDependencies = {},
  ) {
    const baseUrl = providerConfig.base_url?.replace(/\/+$/, "");
    if (!baseUrl) throw new EmbeddingProviderError("Embedding provider base URL is required.", "invalid_config", false);
    if (providerConfig.compatible_type !== "openai") throw new EmbeddingProviderError("Embedding profiles require an OpenAI-compatible provider.", "invalid_config", false);
    this.endpoint = `${baseUrl}/embeddings`;
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.identity = {
      provider: profile.provider,
      model: profile.model,
      dimensions: profile.dimensions,
      normalization: profile.normalization,
      revision: embeddingIdentityRevision(profile, providerConfig),
    };
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    assertInput(texts);
    const result: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.profile.batchSize) {
      result.push(...await this.requestBatch(texts.slice(offset, offset + this.profile.batchSize)));
    }
    return result;
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embedDocuments([text]))[0]!;
  }

  private async requestBatch(input: string[]): Promise<number[][]> {
    let latest: EmbeddingProviderError | undefined;
    for (let attempt = 1; attempt <= this.profile.maxAttempts; attempt += 1) {
      try { return await this.requestOnce(input); }
      catch (error) {
        latest = error instanceof EmbeddingProviderError
          ? error
          : new EmbeddingProviderError(sanitizeMessage(error instanceof Error ? error.message : String(error), [this.providerConfig.api_key ?? ""]), "network", true);
        if (!latest.retryable || attempt === this.profile.maxAttempts) throw latest;
        const delay = latest.retryAfterMs ?? Math.min(5_000, 100 * 2 ** (attempt - 1));
        await this.sleep(delay);
      }
    }
    throw latest ?? new EmbeddingProviderError("Embedding request failed.", "provider_error", false);
  }

  private async requestOnce(input: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.profile.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.providerConfig.api_key ? { authorization: `Bearer ${this.providerConfig.api_key}` } : {}),
        },
        body: JSON.stringify({ model: this.profile.model, input }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new EmbeddingProviderError("Embedding request timed out.", "timeout", true);
      }
      throw new EmbeddingProviderError(
        sanitizeMessage(error instanceof Error ? error.message : String(error), [this.providerConfig.api_key ?? ""]),
        "network",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw httpError(response.status, await response.text(), retryAfterMs(response), [this.providerConfig.api_key ?? ""]);

    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new EmbeddingProviderError("Embedding response was not valid JSON.", "invalid_response", false); }
    const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data : undefined;
    if (!data || data.length !== input.length) throw new EmbeddingProviderError("Embedding response item count did not match the request.", "invalid_response", false);
    const ordered = data.map((item, fallbackIndex) => {
      if (!item || typeof item !== "object") throw new EmbeddingProviderError("Embedding response contained an invalid item.", "invalid_response", false);
      const embedding = (item as { embedding?: unknown }).embedding;
      const index = (item as { index?: unknown }).index;
      if (!Array.isArray(embedding) || !embedding.every((value): value is number => typeof value === "number" && Number.isFinite(value))) {
        throw new EmbeddingProviderError("Embedding response contained non-numeric vector data.", "invalid_response", false);
      }
      if (embedding.length !== this.profile.dimensions) {
        throw new EmbeddingProviderError(`Embedding dimension mismatch: expected ${this.profile.dimensions}, received ${embedding.length}.`, "dimension_mismatch", false);
      }
      return { index: Number.isInteger(index) ? Number(index) : fallbackIndex, embedding };
    }).sort((left, right) => left.index - right.index);
    if (new Set(ordered.map((item) => item.index)).size !== input.length || ordered.some((item, index) => item.index !== index)) {
      throw new EmbeddingProviderError("Embedding response indices were incomplete or duplicated.", "invalid_response", false);
    }
    return ordered.map(({ embedding }) => this.profile.normalization === "l2" ? l2Normalize(embedding) : embedding);
  }
}

export function resolveEmbeddingProvider(
  catalog: GlobalModelCatalog,
  reference: string | undefined,
  dependencies: ProviderDependencies = {},
): EmbeddingProviderResolution {
  if (!reference) return { state: "disabled", provider: new DisabledEmbeddingProvider(), reason: "No embedding profile is selected." };
  const profile = catalog.embeddingProfiles[reference];
  if (!profile) return { state: "misconfigured", provider: new DisabledEmbeddingProvider(), reason: `Embedding profile '${reference}' does not exist.` };
  if (profile.kind === "deterministic-fake") {
    return dependencies.allowDeterministicFake
      ? { state: "ready", provider: new DeterministicFakeEmbeddingProvider(profile) }
      : { state: "misconfigured", provider: new DisabledEmbeddingProvider(), reason: "Deterministic fake embeddings are restricted to tests." };
  }
  const providerConfig = catalog.providers[profile.provider];
  if (!providerConfig) return { state: "misconfigured", provider: new DisabledEmbeddingProvider(), reason: `Embedding provider '${profile.provider}' does not exist.` };
  try { return { state: "ready", provider: new OpenAICompatibleEmbeddingProvider(profile, providerConfig, dependencies) }; }
  catch (error) { return { state: "misconfigured", provider: new DisabledEmbeddingProvider(), reason: error instanceof Error ? error.message : String(error) }; }
}

export function resolveEffectiveRetrievalBackend(
  requested: "lexical" | "zvec_fts" | "zvec_hybrid",
  embedding: EmbeddingProviderResolution,
): { backend: "lexical" | "zvec_fts" | "zvec_hybrid"; fallbackReason?: string } {
  if (requested !== "zvec_hybrid" || embedding.state === "ready") return { backend: requested };
  return { backend: "lexical", fallbackReason: embedding.reason ?? "Hybrid retrieval requires a valid embedding profile." };
}
