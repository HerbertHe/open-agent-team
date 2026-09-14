import assert from "node:assert/strict";
import test from "node:test";
import { parseGlobalModelCatalog } from "../models/global-models";
import { EmbeddingProviderError, resolveEffectiveRetrievalBackend, resolveEmbeddingProvider } from "./embedding-provider";

function catalog(overrides: Record<string, unknown> = {}) {
  return parseGlobalModelCatalog({
    providers: { local: { compatible_type: "openai", base_url: "http://embedding.local/v1", api_key: "sk-secret-value" } },
    models: {},
    embeddingProfiles: {
      memory: { kind: "openai-compatible", provider: "local", model: "embed-v1", dimensions: 3, normalization: "provider-default", timeoutMs: 1_000, batchSize: 2, maxAttempts: 3 },
      fake: { kind: "deterministic-fake", model: "fake-v1", dimensions: 8 },
    },
    ...overrides,
  });
}

test("missing or invalid global references resolve to a non-throwing disabled provider", async () => {
  const disabled = resolveEmbeddingProvider(catalog(), undefined);
  assert.equal(disabled.state, "disabled");
  await assert.rejects(() => disabled.provider.embedQuery("query"), (error: EmbeddingProviderError) => error.code === "disabled" && !error.retryable);
  const missing = resolveEmbeddingProvider(catalog(), "absent");
  assert.equal(missing.state, "misconfigured");
  assert.match(missing.reason ?? "", /does not exist/);
});

test("deterministic fake embeddings are stable, normalized and dimension checked by construction", async () => {
  assert.equal(resolveEmbeddingProvider(catalog(), "fake").state, "misconfigured");
  const resolution = resolveEmbeddingProvider(catalog(), "fake", { allowDeterministicFake: true });
  assert.equal(resolution.state, "ready");
  const first = await resolution.provider.embedQuery("same text");
  const second = await resolution.provider.embedQuery("same text");
  assert.deepEqual(first, second);
  assert.equal(first.length, 8);
  assert.ok(Math.abs(Math.sqrt(first.reduce((sum, value) => sum + value * value, 0)) - 1) < 1e-10);
});

test("hybrid retrieval falls back to lexical without embedding while Zvec FTS remains available", () => {
  const disabled = resolveEmbeddingProvider(catalog(), undefined);
  assert.deepEqual(resolveEffectiveRetrievalBackend("zvec_hybrid", disabled), { backend: "lexical", fallbackReason: "No embedding profile is selected." });
  assert.deepEqual(resolveEffectiveRetrievalBackend("zvec_fts", disabled), { backend: "zvec_fts" });
});

test("OpenAI-compatible provider batches requests and restores response index order", async () => {
  const batches: unknown[] = [];
  const fetchMock: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    batches.push(body.input);
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index: body.input.length - index - 1, embedding: [index + 1, 0, 0] })) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = resolveEmbeddingProvider(catalog(), "memory", { fetch: fetchMock }).provider;
  const vectors = await provider.embedDocuments(["a", "b", "c"]);
  assert.deepEqual(batches, [["a", "b"], ["c"]]);
  assert.deepEqual(vectors, [[2, 0, 0], [1, 0, 0], [1, 0, 0]]);
});

test("429 responses honor retry-after and retry within the configured attempt bound", async () => {
  let calls = 0;
  const delays: number[] = [];
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"message":"slow down"}', { status: 429, headers: { "retry-after": "0.01" } })
      : new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 });
  };
  const provider = resolveEmbeddingProvider(catalog(), "memory", { fetch: fetchMock, sleep: async (delay) => { delays.push(delay); } }).provider;
  assert.deepEqual(await provider.embedQuery("retry"), [1, 2, 3]);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [10]);
});

test("402 is non-retryable and provider errors redact API keys", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return new Response('{"message":"token=sk-secret-value Insufficient Balance"}', { status: 402 });
  };
  const provider = resolveEmbeddingProvider(catalog(), "memory", { fetch: fetchMock, sleep: async () => assert.fail("must not retry 402") }).provider;
  await assert.rejects(() => provider.embedQuery("query"), (error: EmbeddingProviderError) => {
    assert.equal(error.code, "insufficient_balance");
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /sk-secret-value/);
    return true;
  });
  assert.equal(calls, 1);
});

test("partial provider responses fail the whole batch without returning misaligned vectors", async () => {
  let calls = 0;
  const partial: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 });
  };
  const provider = resolveEmbeddingProvider(catalog(), "memory", { fetch: partial }).provider;
  await assert.rejects(() => provider.embedDocuments(["first", "second"]), (error: EmbeddingProviderError) => error.code === "invalid_response" && !error.retryable);
  assert.equal(calls, 1);
});

test("timeouts are classified and bounded, while dimension mismatches never retry", async () => {
  const timeoutCatalog = catalog({ embeddingProfiles: { memory: { kind: "openai-compatible", provider: "local", model: "embed-v1", dimensions: 3, timeoutMs: 100, batchSize: 2, maxAttempts: 1 } } });
  const hangingFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted sk-secret-value"), { name: "AbortError" })), { once: true });
  });
  const timed = resolveEmbeddingProvider(timeoutCatalog, "memory", { fetch: hangingFetch }).provider;
  await assert.rejects(() => timed.embedQuery("query"), (error: EmbeddingProviderError) => error.code === "timeout" && error.retryable);

  let calls = 0;
  const wrongDimension: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 });
  };
  const provider = resolveEmbeddingProvider(catalog(), "memory", { fetch: wrongDimension }).provider;
  await assert.rejects(() => provider.embedQuery("query"), (error: EmbeddingProviderError) => error.code === "dimension_mismatch" && !error.retryable);
  assert.equal(calls, 1);
});
