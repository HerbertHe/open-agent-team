import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Express, Request, Response } from "express";
import { parseGlobalModelCatalog } from "../models/global-models";
import { BudgetLedger } from "../budget/budget-ledger";
import { openExecutionDatabase, type ExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { PlanVersionRepository, ProgramRepository } from "./execution-repositories";
import { ProgramFeatureDisabledError, ProgramService } from "./program-service";
import { ProgramPlanningError, ProgramPlanningService, registerExperimentalPlanningRoutes } from "./program-planning-service";
import { ProgramExecutionCoordinator } from "./program-execution-coordinator";
import { QueuedTaskStatusEnum, type QueuedTask } from "../types";

const T0 = "2026-10-15T00:00:00.000Z";
const T1 = "2026-10-15T00:01:00.000Z";
const T2 = "2026-10-15T00:02:00.000Z";
const T3 = "2026-10-15T00:03:00.000Z";
const allocation = { planning: {}, minimumDelivery: { moneyMicros: 100 }, upgradePool: { moneyMicros: 20 }, validation: {}, contingency: {}, closeout: {} };

function withDb(run: (handle: ExecutionDatabase, service: ProgramPlanningService) => unknown) {
  const root = mkdtempSync(path.join(tmpdir(), "oat-planning-service-"));
  const handle = openExecutionDatabase(root);
  migrateExecutionDatabase(handle);
  new ProgramService(handle, true, parseGlobalModelCatalog({ pricingRevision: "r1", pricing: {} })).createDraft({
    id: "p", projectId: "project", goal: "ship", allocation, pricingSnapshotId: "price", createdAt: T0,
  });
  const cleanup = () => { handle.close(); rmSync(root, { recursive: true, force: true }); };
  try {
    const result = run(handle, new ProgramPlanningService(handle, true, "project"));
    if (result instanceof Promise) return result.finally(cleanup);
    cleanup();
  } catch (error) { cleanup(); throw error; }
}

function work(id: string, overrides = {}) {
  return { id, stableKey: id, title: id, prompt: `Implement ${id}`, targetAgentRole: "worker", dependsOn: [], scopeTier: "minimum",
    mandatory: true, priority: 1, hardEnvelope: { moneyMicros: 20 }, acceptanceCriteria: [{ id: `criterion:${id}`, type: "file_exists", path: "result.txt" }], ...overrides };
}
const proposal = () => ({ id: "plan", expectedProgramRevision: 0, createdBy: "admin", workPackages: [
  work("root"), work("child", { dependsOn: ["root"] }), work("extra", { scopeTier: "stretch", mandatory: false }),
] });
const evaluation = () => ({ expectedProgramRevision: 1, expectedPlanRevision: 0, seed: "test", samples: 100 });
const approval = () => ({ expectedProgramRevision: 2, expectedPlanRevision: 2, selectedTier: "minimum", confirmed: true, acceptUncalibratedRisk: true, approvedBy: "user" });
const code = (expected: string) => (error: unknown) => error instanceof ProgramPlanningError && error.code === expected;

test("planning workflow persists proposal, admission and explicit approval across service reconstruction", () => withDb((handle, service) => {
  const created = service.createPlan("p", proposal(), T1);
  assert.equal(created.program.status, "planning");
  assert.equal(created.plan.version, 1);
  const evaluated = service.evaluate("p", "plan", evaluation(), T2);
  assert.equal(evaluated.selection.status, "awaiting_approval");
  assert.equal(evaluated.selection.selectedTier, "minimum");
  assert.equal(evaluated.decisions.minimum.calibrated, false);
  assert.equal(evaluated.decisions.minimum.jointProbability, undefined);
  assert.equal(evaluated.plan.revision, 2);
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM execution_outbox").pluck().get(), 0);
  const restarted = new ProgramPlanningService(handle, true, "project");
  assert.deepEqual(restarted.get("p", "plan").decisions.minimum, evaluated.decisions.minimum);
  const result = restarted.approve("p", "plan", approval(), T3);
  assert.equal(result.program.status, "admitted");
  assert.equal(result.plan.scopeTier, "minimum");
  assert.equal(result.plan.status, "active");
  assert.deepEqual(result.workPackages.map((item) => [item.id, item.status]), [["child", "planned"], ["extra", "cancelled"], ["root", "runnable"]]);
  assert.equal(handle.connection.prepare("SELECT scope_tier FROM plan_versions WHERE id='plan'").pluck().get(), "minimum");
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM execution_outbox").pluck().get(), 3);
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM audit_events WHERE event_type='program.plan_approved'").pluck().get(), 1);
  assert.throws(() => restarted.approve("p", "plan", approval(), T3), code("REVISION_CONFLICT"));
}));

test("new workflow reaches existing production dispatch without direct database seeding", () => withDb(async (handle, service) => {
  service.createPlan("p", proposal(), T1);
  service.evaluate("p", "plan", evaluation(), T2);
  service.approve("p", "plan", approval(), T3);
  const calls: unknown[] = [];
  const coordinator = new ProgramExecutionCoordinator(handle, {
    resolveAgent: () => "worker-1", getTask: () => undefined, findTaskByConflictKey: () => undefined,
    createTask: async (body) => { calls.push(body); return { id: "task", status: QueuedTaskStatusEnum.Queued } as QueuedTask; },
  });
  const result = await coordinator.tick("p", T3);
  assert.equal(result.dispatched.length, 1);
  assert.equal(result.dispatched[0]!.workPackageId, "root");
  assert.equal(calls.length, 1);
}));

test("disabled planning registers no routes and rejects direct calls; project/plan ownership is enforced", () => withDb((handle, service) => {
  const disabled = new ProgramPlanningService(handle, false);
  assert.equal(registerExperimentalPlanningRoutes({} as Express, disabled, false), false);
  assert.throws(() => disabled.createPlan("p", proposal()), ProgramFeatureDisabledError);
  assert.throws(() => new ProgramPlanningService(handle, true, "other").createPlan("p", proposal()), code("ENTITY_NOT_FOUND"));
  service.createPlan("p", proposal(), T1);
  new ProgramService(handle, true, parseGlobalModelCatalog({ pricingRevision: "r1", pricing: {} })).createDraft({
    id: "other", projectId: "project", goal: "other", allocation, pricingSnapshotId: "other-price", createdAt: T0,
  });
  assert.throws(() => service.get("other", "plan"), code("ENTITY_NOT_FOUND"));
}));

test("invalid DAG, insufficient acceptance and forged state are rejected before writes", () => withDb((handle, service) => {
  for (const workPackages of [
    [work("a", { dependsOn: ["b"] }), work("b", { dependsOn: ["a"] })],
    [work("a", { acceptanceCriteria: [] })],
  ]) assert.throws(() => service.createPlan("p", { ...proposal(), workPackages }, T1), code("PLAN_INVALID"));
  assert.throws(() => service.createPlan("p", { ...proposal(), workPackages: [work("a", { status: "completed" })] }, T1));
  assert.throws(() => service.createPlan("p", { ...proposal(), workPackages: [] }, T1));
  assert.equal(new ProgramRepository(handle).get("p")!.status, "draft");
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM plan_versions").pluck().get(), 0);
}));

test("proposal persistence is atomic when a work package constraint fails", () => withDb((handle, service) => {
  handle.connection.exec(`CREATE TRIGGER fail_work BEFORE INSERT ON work_packages
    WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'work unavailable'); END`);
  assert.throws(() => service.createPlan("p", { ...proposal(), workPackages: [work("a"), work("b")] }, T1), /work unavailable/);
  assert.equal(new ProgramRepository(handle).get("p")!.revision, 0);
  for (const table of ["plan_versions", "work_packages", "audit_events"]) assert.equal(handle.connection.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0);
}));

test("uncalibrated approval needs risk acknowledgement and cannot select optional upgrades", () => withDb((handle, service) => {
  service.createPlan("p", proposal(), T1);
  assert.throws(() => service.approve("p", "plan", { ...approval(), expectedProgramRevision: 1, expectedPlanRevision: 0 }, T2), code("PROGRAM_STATE_INVALID"));
  service.evaluate("p", "plan", evaluation(), T2);
  assert.throws(() => service.approve("p", "plan", { ...approval(), acceptUncalibratedRisk: false }, T3), code("ADMISSION_REJECTED"));
  assert.throws(() => service.approve("p", "plan", { ...approval(), selectedTier: "stretch" }, T3), code("ADMISSION_REJECTED"));
  assert.throws(() => service.approve("p", "plan", { ...approval(), confirmed: false }, T3));
  assert.throws(() => service.approve("p", "plan", { ...approval(), expectedPlanRevision: 1 }, T3), code("REVISION_CONFLICT"));
  assert.equal(new PlanVersionRepository(handle).get("plan")!.status, "awaiting_approval");
}));

test("minimum envelope above partition budget is rejected even with uncalibrated estimates", () => withDb((handle, service) => {
  service.createPlan("p", { ...proposal(), workPackages: [work("expensive", { hardEnvelope: { moneyMicros: 101 } })] }, T1);
  const result = service.evaluate("p", "plan", evaluation(), T2);
  assert.equal(result.selection.status, "rejected");
  assert.equal(result.plan.status, "rejected");
  assert.equal(new ProgramRepository(handle).get("p")!.status, "planning");
  assert.throws(() => service.approve("p", "plan", { ...approval(), expectedProgramRevision: 1, expectedPlanRevision: 1 }, T3), code("PROGRAM_STATE_INVALID"));
}));

test("approval rechecks current partition availability instead of borrowing other accounts", () => withDb((handle, service) => {
  service.createPlan("p", proposal(), T1); service.evaluate("p", "plan", evaluation(), T2);
  BudgetLedger.from(handle).reserve({ id: "competing", programId: "p", accountId: "p:minimum", operationKey: "competing",
    amount: { moneyMicros: 70 }, consumerClass: "execution", createdAt: T2 });
  assert.throws(() => service.approve("p", "plan", approval(), T3), code("BUDGET_CHANGED"));
  assert.equal(new ProgramRepository(handle).get("p")!.status, "awaiting_approval");
}));

test("replacement proposals invalidate old approval even when callers refresh the Program revision", () => withDb((handle, service) => {
  service.createPlan("p", proposal(), T1); service.evaluate("p", "plan", evaluation(), T2);
  const created = service.createPlan("p", { id: "new-plan", expectedProgramRevision: 2, createdBy: "admin", workPackages: [work("new-root")] }, T3);
  assert.equal(created.plan.version, 2);
  service.evaluate("p", "new-plan", { ...evaluation(), expectedProgramRevision: 3 }, T3);
  assert.throws(() => service.approve("p", "plan", { ...approval(), expectedProgramRevision: 4 }, T3), code("REVISION_CONFLICT"));
  assert.equal(new PlanVersionRepository(handle).get("plan")!.status, "awaiting_approval");
}));

test("approval audit failure rolls back activation, selected tier and runnable outbox together", () => withDb((handle, service) => {
  service.createPlan("p", proposal(), T1); service.evaluate("p", "plan", evaluation(), T2);
  handle.connection.exec(`CREATE TRIGGER fail_approval BEFORE INSERT ON audit_events
    WHEN NEW.event_type='program.plan_approved' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
  assert.throws(() => service.approve("p", "plan", approval(), T3), /audit unavailable/);
  assert.equal(new ProgramRepository(handle).get("p")!.status, "awaiting_approval");
  assert.equal(new PlanVersionRepository(handle).get("plan")!.scopeTier, "stretch");
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM work_packages WHERE status <> 'planned'").pluck().get(), 0);
  assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM execution_outbox").pluck().get(), 0);
}));

test("planning routes expose workflow responses, structured conflicts and not-found errors", () => withDb((_handle, service) => {
  const routes = new Map<string, (req: Request, res: Response) => void>();
  const app = { post: (url: string, handler: (req: Request, res: Response) => void) => routes.set(`POST ${url}`, handler),
    get: (url: string, handler: (req: Request, res: Response) => void) => routes.set(`GET ${url}`, handler) } as unknown as Express;
  registerExperimentalPlanningRoutes(app, service, true);
  const invoke = (key: string, body: unknown, params = { id: "p", planId: "plan" }) => {
    let status = 200; let data: any;
    const response = { status: (value: number) => { status = value; return response; }, json: (value: unknown) => { data = value; } };
    routes.get(key)!({ params, body } as unknown as Request, response as Response);
    return { status, data };
  };
  const base = "/api/experimental/programs/:id/plans";
  assert.equal(invoke(`POST ${base}`, { ...proposal(), unknown: true }).status, 400);
  assert.equal(invoke(`POST ${base}`, proposal()).status, 201);
  assert.equal(invoke(`POST ${base}/:planId/admission`, evaluation()).status, 200);
  assert.equal(invoke(`POST ${base}/:planId/approve`, { ...approval(), expectedProgramRevision: 0 }).status, 409);
  assert.equal(invoke(`GET ${base}/:planId`, undefined, { id: "p", planId: "missing" }).status, 404);
  assert.equal(invoke(`POST ${base}/:planId/approve`, approval()).data.program.status, "admitted");
}));
