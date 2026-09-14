import assert from "node:assert/strict";
import test from "node:test";
import { isMemoryRetrievalRolloutEnabled } from "./oat-config";

test("M10 global retrieval rollout requires both the feature flag and an exact project allowlist match", () => {
  assert.equal(isMemoryRetrievalRolloutEnabled({}, "project-a"), false);
  assert.equal(isMemoryRetrievalRolloutEnabled({ memoryRetrieval: { enabled: false, projectAllowlist: ["project-a"] } }, "project-a"), false);
  assert.equal(isMemoryRetrievalRolloutEnabled({ memoryRetrieval: { enabled: true, projectAllowlist: ["project-a"] } }, "project-a"), true);
  assert.equal(isMemoryRetrievalRolloutEnabled({ memoryRetrieval: { enabled: true, projectAllowlist: ["*"] } }, "project-a"), false);
  assert.equal(isMemoryRetrievalRolloutEnabled({ memoryRetrieval: { enabled: true, projectAllowlist: ["Project-A"] } }, "project-a"), false);
});
