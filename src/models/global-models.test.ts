import assert from "node:assert/strict";
import test from "node:test";
import { embeddingIdentityRevision, parseGlobalModelCatalog, resolveEmbeddingReference } from "./global-models";

test("global embedding profiles are validated separately from chat model aliases", () => {
  const catalog = parseGlobalModelCatalog({
    providers: { openai: { compatible_type: "openai", base_url: "https://api.example/v1", api_key: "secret-a" } },
    models: { coding: "gpt-test" },
    embeddingProfiles: { memory: { kind: "openai-compatible", provider: "openai", model: "embed-test", dimensions: 768 } },
  });
  assert.equal(catalog.models.coding, "gpt-test");
  assert.equal(catalog.embeddingProfiles.memory?.dimensions, 768);
  assert.throws(() => parseGlobalModelCatalog({ embeddingProfiles: { invalid: { kind: "openai-compatible", provider: "openai", model: "embed", dimensions: 0 } } }));
});

test("embedding identity revisions change with endpoint/model identity but never include API keys", () => {
  const first = parseGlobalModelCatalog({ providers: { p: { compatible_type: "openai", base_url: "https://one/v1", api_key: "secret-a" } }, embeddingProfiles: { e: { kind: "openai-compatible", provider: "p", model: "embed", dimensions: 3 } } });
  const second = parseGlobalModelCatalog({ providers: { p: { compatible_type: "openai", base_url: "https://one/v1", api_key: "secret-b" } }, embeddingProfiles: { e: { kind: "openai-compatible", provider: "p", model: "embed", dimensions: 3 } } });
  const third = parseGlobalModelCatalog({ providers: { p: { compatible_type: "openai", base_url: "https://two/v1", api_key: "secret-b" } }, embeddingProfiles: { e: { kind: "openai-compatible", provider: "p", model: "embed", dimensions: 3 } } });
  const revision = embeddingIdentityRevision(first.embeddingProfiles.e!, first.providers.p);
  assert.equal(revision, embeddingIdentityRevision(second.embeddingProfiles.e!, second.providers.p));
  assert.notEqual(revision, embeddingIdentityRevision(third.embeddingProfiles.e!, third.providers.p));
  assert.doesNotMatch(revision, /secret/);
});

test("project references override, inherit or explicitly disable the global default", () => {
  assert.equal(resolveEmbeddingReference("project", "global"), "project");
  assert.equal(resolveEmbeddingReference(undefined, "global"), "global");
  assert.equal(resolveEmbeddingReference(null, "global"), undefined);
});
