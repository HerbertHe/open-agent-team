import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import { PlanVersionRepository, ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { PlanVersionSchema, ProgramSchema, WorkPackageSchema } from "./program-types";

const T0 = "2026-10-10T00:00:00.000Z";

test("BLH-010 audit events are redacted, append-only and queryable by every correlation key", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-audit-"));
  const handle = openExecutionDatabase(root);
  try {
    migrateExecutionDatabase(handle);
    new ProgramRepository(handle).create(ProgramSchema.parse({
      id: "program-1", projectId: "project-1", goal: "goal", status: "draft", executionEpoch: 0,
      revision: 0, createdAt: T0, updatedAt: T0,
    }));
    new PlanVersionRepository(handle).create(PlanVersionSchema.parse({
      id: "plan-1", programId: "program-1", version: 1, reason: "initial", scopeTier: "minimum",
      status: "draft", workPackageIds: ["work-1"], createdBy: "admin-1", revision: 0, createdAt: T0,
    }));
    new WorkPackageRepository(handle).create(WorkPackageSchema.parse({
      id: "work-1", stableKey: "work-1", programId: "program-1", planVersionId: "plan-1",
      title: "work", prompt: "work", targetAgentRole: "worker", dependsOn: [], conflictKeys: [],
      scopeTier: "minimum", mandatory: true, priority: 1, hardEnvelope: {}, status: "planned",
      revision: 0, createdAt: T0, updatedAt: T0,
    }));
    handle.connection.prepare(`
      INSERT INTO work_package_attempts(
        id, work_package_id, attempt_number, status, execution_epoch, fencing_token, created_at, updated_at
      ) VALUES('attempt-1', 'work-1', 1, 'created', 0, 1, ?, ?)
    `).run(T0, T0);

    const repository = new ExecutionAuditRepository(handle);
    const event = repository.append({
      id: "audit-1", programId: "program-1", attemptId: "attempt-1", actorType: "admin",
      actorId: "admin-1", eventType: "program.changed", requestId: "request-1", reason: "approved",
      before: { authorization: "Bearer secret", inputTokens: 12 },
      after: { nested: { api_key: "secret", outputTokens: 4 } },
      metadata: { password: "secret", tokenUsage: 16 }, createdAt: T0,
    });
    assert.deepEqual(event.before, { authorization: "[REDACTED]", inputTokens: 12 });
    assert.deepEqual(event.after, { nested: { api_key: "[REDACTED]", outputTokens: 4 } });
    assert.deepEqual(event.metadata, { password: "[REDACTED]", tokenUsage: 16 });
    assert.equal(repository.findByProgram("program-1")[0]?.id, "audit-1");
    assert.equal(repository.findByAttempt("attempt-1")[0]?.id, "audit-1");
    assert.equal(repository.findByRequestId("request-1")[0]?.id, "audit-1");

    assert.throws(() => handle.connection.prepare("UPDATE audit_events SET reason = 'changed' WHERE id = 'audit-1'").run());
    assert.throws(() => handle.connection.prepare("DELETE FROM audit_events WHERE id = 'audit-1'").run());
    assert.equal(repository.get("audit-1")?.reason, "approved");
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
