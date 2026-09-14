import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { federatedMemorySearch } from "./memory-federation";
import { DefaultMemoryPolicy, projectAgentActor, projectResourceManagerActor, projectUserActor } from "./memory-policy";
import { SqliteMemoryRepository } from "./memory-repository";
import type { MemoryActor, MemoryRecord, MemoryScope } from "./types";
import type { GovernedMemoryCandidate, MemoryExtractionEvent } from "./memory-extractor";
import { buildZvecMemoryAuthorizationFilter } from "./zvec-shadow-memory-index";

const now = "2026-09-11T00:00:00.000Z";

function memory(id: string, projectId: string, agentId: string, scope: MemoryScope, teamId?: string): MemoryRecord {
  return {
    id, projectId, agentId, teamId, level: "L2", kind: "decision", content: id, summary: id,
    confidence: 1, salience: 1, evidenceCount: 1, independentEvidenceCount: 1, sourceEventIds: [], sources: [], status: "active",
    createdAt: now, updatedAt: now, lastConfirmedAt: now, schemaVersion: 3, scope, trustLevel: 100,
    contradictionIds: [], contentHash: createHash("sha256").update(id).digest("hex"), indexState: "not_applicable",
  };
}

function externalWorker(projectId = "project-a"): MemoryActor {
  return { id: "vendor-worker", role: "worker", employment: "external", projectId, teamId: "alpha", projectIds: [projectId] };
}

test("M13 policy separates Admin, Leader, Worker, external Worker, Resource Manager and projects", () => {
  const policy = new DefaultMemoryPolicy();
  const records = {
    project: memory("project", "project-a", "admin", "project"),
    global: memory("global", "project-a", "admin", "global"),
    alpha: memory("alpha", "project-a", "alpha-lead", "team", "alpha"),
    beta: memory("beta", "project-a", "beta-lead", "team", "beta"),
    privateAlpha: memory("private-alpha", "project-a", "alpha-lead", "private", "alpha"),
  };
  const visible = (actor: MemoryActor) => Object.values(records).filter((record) => policy.canRead(actor, record)).map(({ id }) => id).sort();
  assert.deepEqual(visible(projectAgentActor("project-a", "admin", "admin")), ["alpha", "beta", "global", "project"]);
  assert.deepEqual(visible(projectAgentActor("project-a", "alpha-lead", "leader", "internal", ["project-a"])), ["alpha", "global", "private-alpha", "project"]);
  assert.deepEqual(visible(projectAgentActor("project-a", "beta-lead", "leader")), ["beta", "global"]);
  assert.deepEqual(visible(projectAgentActor("project-a", "alpha-worker-0", "worker")), []);
  assert.deepEqual(visible(externalWorker()), []);
  assert.deepEqual(visible(projectResourceManagerActor(["project-a"])), ["global", "project"]);
  assert.deepEqual(visible(projectAgentActor("project-b", "admin", "admin")), []);
  assert.deepEqual(visible(projectUserActor("project-a")), Object.keys(records).map((key) => records[key as keyof typeof records].id).sort());
});

test("M13 external A2A workers may only submit private low-trust candidates and never canonical memory", () => {
  const policy = new DefaultMemoryPolicy();
  const actor = externalWorker();
  assert.equal(policy.candidateWriteDecision(actor, { projectId: "project-a", teamId: "alpha", scope: "private", trustLevel: 30 }).allowed, true);
  assert.equal(policy.candidateWriteDecision(actor, { projectId: "project-a", teamId: "alpha", scope: "team", trustLevel: 30 }).allowed, false);
  assert.equal(policy.candidateWriteDecision(actor, { projectId: "project-a", teamId: "alpha", scope: "private", trustLevel: 31 }).allowed, false);
  assert.equal(policy.canWriteCanonical(actor, memory("candidate", "project-a", actor.id, "private", "alpha")), false);
  assert.equal(policy.canWriteCanonical(projectResourceManagerActor(["project-a"]), memory("fact", "project-a", "admin", "project")), false);
  assert.equal(policy.canWriteCanonical(projectAgentActor("project-a", "alpha-lead", "leader", "internal", ["project-a"]), memory("team", "project-a", "alpha-lead", "team", "alpha")), true);
  assert.equal(policy.canWriteCanonical(projectAgentActor("project-a", "alpha-lead", "leader"), memory("other-team", "project-a", "beta-lead", "team", "beta")), false);
});

test("M13 Zvec filters mirror actor scope and fail closed for workers and ungranted projects", () => {
  const resource = buildZvecMemoryAuthorizationFilter({ projectId: "project-a", actor: projectResourceManagerActor(["project-a"]), nowMs: Date.parse(now) });
  assert.match(resource, /scope in \('project', 'global'\)/);
  assert.doesNotMatch(resource, /'team'/);
  const leader = buildZvecMemoryAuthorizationFilter({ projectId: "project-a", actor: projectAgentActor("project-a", "alpha-lead", "leader", "internal", ["project-a"]), nowMs: Date.parse(now) });
  assert.match(leader, /team_id = 'alpha'/);
  assert.match(leader, /scope = 'project'/);
  const external = buildZvecMemoryAuthorizationFilter({ projectId: "project-a", actor: externalWorker(), nowMs: Date.parse(now) });
  assert.match(external, /level = 'L1'/);
  const crossProject = buildZvecMemoryAuthorizationFilter({ projectId: "project-a", actor: projectAgentActor("project-b", "admin", "admin"), nowMs: Date.parse(now) });
  assert.match(crossProject, /level = 'L1'/);
});

test("M13 repository hydration yields zero unauthorized cross-team, external and cross-project hits", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-m13-policy-"));
  const file = path.join(root, "memory.db");
  const repository = new SqliteMemoryRepository("project-a", file);
  try {
    const definitions = [
      ["project", "admin", undefined, "project"], ["global", "admin", undefined, "global"],
      ["alpha", "alpha-lead", "alpha", "team"], ["beta", "beta-lead", "beta", "team"],
      ["private-alpha", "alpha-lead", "alpha", "private"],
    ] as const;
    for (const [id, owner, teamId] of definitions) repository.capture({
      id: `event-${id}`, ownerAgentId: owner, sourceAgentId: owner, role: owner === "admin" ? "admin" : "leader", trustLevel: 100,
      eventType: "report_progress", kind: "decision", content: id, metadataJson: "{}", createdAt: now, teamId,
      fingerprint: createHash("sha256").update(id).digest("hex"),
    }, 20);
    repository.consolidate({ maxEvents: 20, minEvidence: 99, retentionDays: 180, l1MaxItems: 20, l1TtlHours: 100_000, isCancelled: () => false });
    const raw = new Database(file);
    for (const [id, , teamId, scope] of definitions) raw.prepare("UPDATE memory_items SET scope=?, team_id=? WHERE content=? AND level='L2'").run(scope, teamId ?? null, id);
    raw.close();
    const ids = repository.list({ level: "L2", limit: 20 }).map(({ id }) => id);
    const find = (actor: MemoryActor) => repository.findAuthorizedMemories({ actor, now }, ids).map(({ content }) => content).sort();
    assert.deepEqual(find(projectAgentActor("project-a", "alpha-lead", "leader", "internal", ["project-a"])), ["alpha", "global", "private-alpha", "project"]);
    assert.deepEqual(find(projectAgentActor("project-a", "alpha-worker-0", "worker")), []);
    assert.deepEqual(find(externalWorker()), []);
    assert.deepEqual(find(projectAgentActor("project-b", "admin", "admin")), []);
    assert.deepEqual(find(projectResourceManagerActor(["project-a"])), ["global", "project"]);

    repository.recordAccessAudit({ action: "retrieve", decision: "denied", actor: externalWorker(), reason: "api_key=top-secret denied", metadata: { error: "token=very-secret" } });
    const audit = repository.listAccessAudits(1)[0]!;
    assert.equal(audit.decision, "denied");
    assert.doesNotMatch(audit.reason, /top-secret/);
    assert.doesNotMatch(String(audit.metadata.error), /very-secret/);
  } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
});

test("M13 repository rejects an external candidate that bypasses extractor scope governance", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-m13-a2a-"));
  const repository = new SqliteMemoryRepository("project-a", path.join(root, "memory.db"));
  const candidate = (scope: MemoryScope): GovernedMemoryCandidate => ({
    kind: "decision", content: "external decision", summary: "external decision", subject: "deployment", predicate: "uses", object: "vendor",
    scope, confidence: .8, salience: .8, validFrom: null, validTo: null, trustLevel: 30,
  });
  const event = (id: string): MemoryExtractionEvent => ({
    id, ownerAgentId: "alpha-lead", sourceAgentId: "vendor-worker", role: "leader", eventType: "a2a.completed", kind: "decision",
    content: "external decision", createdAt: now, teamId: "alpha", trustLevel: 30, sourceType: "a2a", attempts: 0,
  });
  try {
    for (const id of ["external-ok", "external-denied"]) repository.capture({
      id, ownerAgentId: "alpha-lead", sourceAgentId: "vendor-worker", role: "leader", trustLevel: 30,
      eventType: "a2a.completed", taskId: id, kind: "decision", content: id, metadataJson: JSON.stringify({ sourceType: "a2a" }),
      createdAt: now, teamId: "alpha", fingerprint: id,
    }, 10);
    assert.equal(repository.commitExtraction(event("external-ok"), [candidate("private")], {
      id: "extract-ok", eventId: "external-ok", model: "test", version: "m11-v1", status: "success", candidateCount: 1, inputChars: 10, latencyMs: 1, createdAt: now,
    }), 1);
    assert.equal(repository.commitExtraction(event("external-denied"), [candidate("project")], {
      id: "extract-denied", eventId: "external-denied", model: "test", version: "m11-v1", status: "success", candidateCount: 1, inputChars: 10, latencyMs: 1, createdAt: now,
    }), 0);
    const audits = repository.listAccessAudits(10).filter(({ action }) => action === "candidate_write");
    assert.deepEqual(audits.map(({ decision }) => decision).sort(), ["allowed", "denied"]);
    assert.equal(repository.list({ status: "candidate", level: "L2" }).length, 1);
    assert.equal(repository.list({ status: "candidate", level: "L2" })[0]?.scope, "private");
  } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
});

test("M13 Resource Manager federation searches only granted online project services", async () => {
  const calls: string[] = [];
  const actor = projectResourceManagerActor(["project-a", "project-b"]);
  const result = await federatedMemorySearch({
    actor, query: "deployment", limit: 10,
    shards: [
      { projectId: "project-a", online: true, search: async (shardActor) => { calls.push(`a:${shardActor.projectId}`); return [memory("a", "project-a", "admin", "project")]; } },
      { projectId: "project-b", online: false, search: async () => { calls.push("b"); return []; } },
      { projectId: "project-c", online: true, search: async () => { calls.push("c"); return []; } },
    ],
  });
  assert.deepEqual(calls, ["a:project-a"]);
  assert.deepEqual(result.memories.map(({ id }) => id), ["a"]);
  assert.deepEqual(result.searchedProjectIds, ["project-a"]);
  assert.deepEqual(result.unavailableProjectIds, ["project-b"]);
  assert.deepEqual(result.deniedProjectIds, ["project-c"]);

  const denied = await federatedMemorySearch({ actor: externalWorker(), query: "anything", shards: [{ projectId: "project-a", online: true, search: async () => [memory("leak", "project-a", "admin", "project")] }] });
  assert.equal(denied.memories.length, 0);
  assert.deepEqual(denied.deniedProjectIds, ["project-a"]);
});
