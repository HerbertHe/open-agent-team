import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BudgetAccountRepository, buildProgramAccountTree } from "../budget/budget-ledger";
import { QueuedTaskStatusEnum, type QueuedTask, type ToolCreateTaskBody } from "../types";
import { openExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { PlanVersionRepository, ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { PlanVersionSchema, ProgramSchema, WorkPackageSchema } from "./program-types";
import { ProgramExecutionCoordinator, type ProgramTaskDispatcher } from "./program-execution-coordinator";
import { ExecutionAuditRepository } from "./execution-audit-repository";

const T0 = "2026-10-12T00:00:00.000Z";

test("program coordinator reserves, leases, dispatches and moves completed tasks to verification", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "program-coordinator-"));
  const handle = openExecutionDatabase(root);
  migrateExecutionDatabase(handle);
  try {
    new ProgramRepository(handle).create(ProgramSchema.parse({ id: "program-1", projectId: "project-1", goal: "ship", status: "admitted", executionEpoch: 0, revision: 0, createdAt: T0, updatedAt: T0 }));
    new PlanVersionRepository(handle).create(PlanVersionSchema.parse({ id: "plan-1", programId: "program-1", version: 1, reason: "initial", scopeTier: "minimum", status: "active", workPackageIds: ["work-1"], createdBy: "admin", revision: 0, createdAt: T0, activatedAt: T0 }));
    handle.connection.prepare("UPDATE programs SET active_plan_version_id='plan-1' WHERE id='program-1'").run();
    new WorkPackageRepository(handle).create(WorkPackageSchema.parse({
      id: "work-1", stableKey: "work-1", programId: "program-1", planVersionId: "plan-1", title: "Implement", prompt: "Implement safely",
      targetAgentRole: "worker", dependsOn: [], conflictKeys: ["repo"], scopeTier: "minimum", mandatory: true, priority: 10,
      hardEnvelope: { modelCalls: 1, toolCalls: 2 }, acceptanceCriteria: [], status: "runnable", revision: 0, createdAt: T0, updatedAt: T0,
    }));
    BudgetAccountRepository.from(handle).createBatch(buildProgramAccountTree("program-1", {
      planning: { modelCalls: 1 }, minimumDelivery: { modelCalls: 10, toolCalls: 20 }, upgradePool: { modelCalls: 2 },
      validation: { modelCalls: 2 }, contingency: { modelCalls: 2 }, closeout: { modelCalls: 2 },
    }, T0));
    const tasks = new Map<string, QueuedTask>();
    const dispatcher: ProgramTaskDispatcher = {
      resolveAgent: () => "team-worker-0",
      getTask: (id) => tasks.get(id),
      findTaskByConflictKey: (conflictKey) => [...tasks.values()].find((task) => task.conflictKey === conflictKey),
      createTask: async (body: ToolCreateTaskBody) => {
        const task: QueuedTask = { id: "task-1", targetAgentId: body.targetAgentId, createdBy: body.createdBy, prompt: body.prompt,
          conflictKey: body.conflictKey, executionContext: body.executionContext, status: QueuedTaskStatusEnum.Queued, createdAt: T0, updatedAt: T0 };
        tasks.set(task.id, task); return task;
      },
    };
    const coordinator = new ProgramExecutionCoordinator(handle, dispatcher, 1);
    const dispatched = await coordinator.tick("program-1", T0);
    assert.equal(dispatched.dispatched.length, 1);
    assert.equal(tasks.get("task-1")?.executionContext?.workPackageId, "work-1");
    assert.equal(handle.connection.prepare("SELECT state FROM budget_reservations").pluck().get(), "active");
    assert.equal(handle.connection.prepare("SELECT owner_id FROM attempt_leases").pluck().get(), "team-worker-0");
    const context = tasks.get("task-1")!.executionContext!;
    new ExecutionAuditRepository(handle).append({ id: "audit-start:recovery", programId: "program-1", actorType: "service", actorId: "test",
      eventType: "program.work_dispatch_started", requestId: "recovery-intent", metadata: { dispatchId: "recovery-intent", workPackageId: "work-1",
        agentId: "team-worker-0", reservationId: context.reservationId, attemptId: context.attemptId,
        conflictKey: "program:program-1:work:work-1", hasReservation: true }, createdAt: "2026-10-12T00:00:30.000Z" });
    await coordinator.tick("program-1", "2026-10-12T00:01:00.000Z");
    assert.equal(new ExecutionAuditRepository(handle).findByRequestId("recovery-intent").at(-1)?.metadata.recovered, true);
    assert.equal(tasks.size, 1);
    await coordinator.tick("program-1", "2026-10-12T00:10:00.000Z");
    assert.equal(handle.connection.prepare("SELECT expires_at FROM attempt_leases").pluck().get(), "2026-10-12T00:25:00.000Z");
    tasks.get("task-1")!.status = QueuedTaskStatusEnum.Completed;
    const reconciled = await coordinator.tick("program-1", "2026-10-12T00:11:00.000Z");
    assert.deepEqual(reconciled.reconciled, [{ workPackageId: "work-1", taskId: "task-1", status: "verifying" }]);
    assert.equal(new WorkPackageRepository(handle).get("work-1")?.status, "verifying");
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
