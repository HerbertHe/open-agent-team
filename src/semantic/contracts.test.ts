import assert from "node:assert/strict";
import test from "node:test";
import { canReadSemanticDocument, type SemanticDocument } from "./types";

const base: SemanticDocument = {
  id: "document", projectId: "project", resourceType: "memory", resourceId: "memory",
  ownerAgentId: "team-worker-0", visibility: "private", allowedAgentIds: [], content: "content",
  contentHash: "hash", status: "active", metadata: {}, indexState: "pending",
  createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
};

test("private semantic memory is visible only to its owner", () => {
  assert.equal(canReadSemanticDocument({ agentId: "team-worker-0", projectId: "project", teamId: "team" }, base), true);
  assert.equal(canReadSemanticDocument({ agentId: "team-lead", projectId: "project", teamId: "team" }, base), false);
  assert.equal(canReadSemanticDocument({ agentId: "admin", projectId: "project" }, base), false);
});

test("knowledge visibility is fail-closed and independent from memory ownership", () => {
  const knowledge: SemanticDocument = { ...base, resourceType: "knowledge", resourceId: "chunk", sourceId: "source", ownerAgentId: undefined, visibility: "team", teamId: "team" };
  assert.equal(canReadSemanticDocument({ agentId: "team-worker-0", projectId: "project", teamId: "team" }, knowledge), true);
  assert.equal(canReadSemanticDocument({ agentId: "other-worker-0", projectId: "project", teamId: "other" }, knowledge), false);
  assert.equal(canReadSemanticDocument({ agentId: "team-worker-0", projectId: "other", teamId: "team" }, knowledge), false);
});
