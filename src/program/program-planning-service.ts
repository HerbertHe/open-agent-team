import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Express, Request, Response } from "express";
import { BudgetAccountRepository } from "../budget/budget-ledger";
import { addBudgetVectors, budgetVectorFits, subtractBudgetVectors, sumBudgetVectors } from "../budget/budget-types";
import { AdmissionController, type AdmissionDecision } from "./admission-controller";
import { WorkPackageCostEstimator } from "./cost-estimator";
import { ExecutionAuditRepository } from "./execution-audit-repository";
import type { ExecutionDatabase } from "./execution-database";
import { ExecutionRepositoryError, PlanVersionRepository, ProgramRepository, WorkPackageRepository } from "./execution-repositories";
import { PlanActivationService } from "./plan-activation-service";
import { PlanValidator } from "./plan-validator";
import { PlanningArtifactRepository } from "./planning-artifact-repository";
import { ProgramFeatureDisabledError } from "./program-service";
import { OpaqueIdSchema, PlanVersionIdSchema, PlanVersionSchema, ProgramIdSchema, ScopeTierSchema, WorkPackageSchema, type ScopeTier, type WorkPackage } from "./program-types";
import { selectScopeTier } from "./scope-tier-selector";

const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const RANK: Record<ScopeTier, number> = { minimum: 0, standard: 1, stretch: 2 };
const TIERS = ["minimum", "standard", "stretch"] as const;

// State, ownership, versions and timestamps are assigned by the service.
const { programId: _programId, planVersionId: _planVersionId, status: _status, revision: _revision,
  createdAt: _createdAt, updatedAt: _updatedAt, ...workInputShape } = WorkPackageSchema.shape;
const WorkInput = z.object(workInputShape).strict();
export const CreatePlanSchema = z.object({
  id: PlanVersionIdSchema,
  expectedProgramRevision: Revision,
  createdBy: OpaqueIdSchema,
  workPackages: z.array(WorkInput).min(1).max(1_000),
}).strict();
export const EvaluatePlanSchema = z.object({
  expectedProgramRevision: Revision, expectedPlanRevision: Revision,
  targetProbability: z.number().positive().max(1).default(0.9),
  samples: z.number().int().min(100).max(20_000).default(1_000),
  seed: z.string().trim().min(1).max(256),
  deadlineSeconds: z.number().int().positive().max(31_536_000).optional(),
}).strict();
export const ApprovePlanSchema = z.object({
  expectedProgramRevision: Revision, expectedPlanRevision: Revision,
  selectedTier: ScopeTierSchema,
  confirmed: z.literal(true),
  acceptUncalibratedRisk: z.boolean().default(false),
  approvedBy: OpaqueIdSchema,
}).strict();

export const ProgramPlanningErrorCodeSchema = z.enum([
  "ENTITY_NOT_FOUND", "REVISION_CONFLICT", "PROGRAM_STATE_INVALID", "PLAN_INVALID", "BUDGET_ACCOUNT_MISSING",
  "MINIMUM_DELIVERY_MISSING", "ADMISSION_REQUIRED", "ADMISSION_REJECTED", "BUDGET_CHANGED",
]);
export class ProgramPlanningError extends Error {
  constructor(readonly code: z.infer<typeof ProgramPlanningErrorCodeSchema>, message: string, readonly details?: unknown) { super(message); }
}

export class ProgramPlanningService {
  private readonly programs: ProgramRepository;
  private readonly plans: PlanVersionRepository;
  private readonly work: WorkPackageRepository;
  private readonly artifacts: PlanningArtifactRepository;
  private readonly accounts: BudgetAccountRepository;
  private readonly audit: ExecutionAuditRepository;

  constructor(private readonly handle: ExecutionDatabase, private readonly enabled: boolean, private readonly projectId?: string) {
    this.programs = new ProgramRepository(handle);
    this.plans = new PlanVersionRepository(handle);
    this.work = new WorkPackageRepository(handle);
    this.artifacts = new PlanningArtifactRepository(handle);
    this.accounts = BudgetAccountRepository.from(handle);
    this.audit = new ExecutionAuditRepository(handle);
  }

  private program(id: string, revision?: number) {
    if (!this.enabled) throw new ProgramFeatureDisabledError();
    const program = this.programs.get(ProgramIdSchema.parse(id));
    if (!program || (this.projectId !== undefined && program.projectId !== this.projectId)) {
      throw new ProgramPlanningError("ENTITY_NOT_FOUND", "Program not found");
    }
    if (revision !== undefined && revision !== program.revision) throw new ProgramPlanningError("REVISION_CONFLICT", "Program revision is stale");
    return program;
  }

  private plan(programId: string, planId: string, revision?: number) {
    this.program(programId);
    const plan = this.plans.get(PlanVersionIdSchema.parse(planId));
    if (!plan || plan.programId !== programId) throw new ProgramPlanningError("ENTITY_NOT_FOUND", "Plan not found for Program");
    if (revision !== undefined && revision !== plan.revision) throw new ProgramPlanningError("REVISION_CONFLICT", "Plan revision is stale");
    return plan;
  }

  private assertLatest(programId: string, planId: string): void {
    const latestId = this.handle.connection.prepare("SELECT id FROM plan_versions WHERE program_id=? ORDER BY version DESC LIMIT 1").pluck().get(programId);
    if (latestId !== planId) throw new ProgramPlanningError("REVISION_CONFLICT", "A newer plan supersedes this proposal");
  }

  createPlan(programId: string, input: unknown, now = new Date().toISOString()) {
    const parsed = CreatePlanSchema.parse(input);
    return this.handle.connection.transaction(() => {
      let program = this.program(programId, parsed.expectedProgramRevision);
      if (!["draft", "planning", "awaiting_approval"].includes(program.status)) throw new ProgramPlanningError("PROGRAM_STATE_INVALID", "Program cannot accept a new plan");
      const version = Number(this.handle.connection.prepare("SELECT COALESCE(MAX(version),0)+1 FROM plan_versions WHERE program_id=?").pluck().get(program.id));
      const packages = parsed.workPackages.map((item) => WorkPackageSchema.parse({ ...item, programId: program.id, planVersionId: parsed.id,
        status: "planned", revision: 0, createdAt: now, updatedAt: now }));
      const plan = PlanVersionSchema.parse({ id: parsed.id, programId: program.id, version, reason: version === 1 ? "initial" : "scope_change",
        scopeTier: "stretch", status: "draft", workPackageIds: packages.map((item) => item.id), createdBy: parsed.createdBy, revision: 0, createdAt: now });
      const validation = new PlanValidator().validate({ plan, workPackages: packages });
      if (!validation.valid) throw new ProgramPlanningError("PLAN_INVALID", "Plan validation failed", validation.issues);
      this.plans.create(plan);
      this.work.createBatch(packages);
      if (program.status !== "planning") program = this.programs.transitionStatus(program.id, program.revision, "planning", now);
      else {
        // Even while planning, a replacement proposal invalidates existing approvals.
        this.handle.connection.prepare("UPDATE programs SET revision=revision+1, updated_at=? WHERE id=? AND revision=?").run(now, program.id, program.revision);
        program = this.programs.get(program.id)!;
      }
      this.record(program.id, plan.id, "program.plan_created", parsed.createdBy, now);
      return { program, plan, workPackages: packages };
    }).immediate();
  }

  private budgets(programId: string) {
    const accounts = this.accounts.listByProgram(programId);
    const available = (kind: "minimum" | "upgrade_pool") => {
      const account = accounts.find((item) => item.kind === kind);
      if (!account) throw new ProgramPlanningError("BUDGET_ACCOUNT_MISSING", `Missing ${kind} account`);
      return subtractBudgetVectors(account.limit, addBudgetVectors(account.spent, account.reserved));
    };
    return { minimum: available("minimum"), upgrade: available("upgrade_pool") };
  }

  private fits(packages: readonly WorkPackage[], tier: ScopeTier, budgets: ReturnType<ProgramPlanningService["budgets"]>) {
    const selected = packages.filter((item) => RANK[item.scopeTier] <= RANK[tier]);
    return budgetVectorFits(sumBudgetVectors(selected.filter((item) => item.scopeTier === "minimum").map((item) => item.hardEnvelope)), budgets.minimum)
      && budgetVectorFits(sumBudgetVectors(selected.filter((item) => item.scopeTier !== "minimum").map((item) => item.hardEnvelope)), budgets.upgrade);
  }

  evaluate(programId: string, planId: string, input: unknown, now = new Date().toISOString()) {
    const parsed = EvaluatePlanSchema.parse(input);
    return this.handle.connection.transaction(() => {
      let program = this.program(programId, parsed.expectedProgramRevision);
      let plan = this.plan(programId, planId, parsed.expectedPlanRevision);
      this.assertLatest(program.id, plan.id);
      if (program.status !== "planning" || plan.status !== "draft") throw new ProgramPlanningError("PROGRAM_STATE_INVALID", "Admission requires a draft plan in a planning Program");
      const packages = this.work.listByPlan(plan.id);
      if (!packages.some((item) => item.scopeTier === "minimum" && item.mandatory)) throw new ProgramPlanningError("MINIMUM_DELIVERY_MISSING", "Plan requires mandatory minimum delivery");
      const budgets = this.budgets(program.id);
      const estimates = packages.map((item) => new WorkPackageCostEstimator().estimate({ workPackage: item }));
      const byId = new Map(estimates.map((estimate) => [estimate.workPackageId, estimate]));
      for (const estimate of estimates) this.artifacts.saveEstimate(estimate, now);
      const decisions = {} as Record<ScopeTier, AdmissionDecision>;
      for (const tier of TIERS) {
        const decision = new AdmissionController().evaluate({
          workItems: packages.filter((item) => RANK[item.scopeTier] <= RANK[tier]).map((item) => ({ id: item.id, dependsOn: item.dependsOn,
            estimate: byId.get(item.id)! })),
          budgetLimit: tier === "minimum" ? budgets.minimum : addBudgetVectors(budgets.minimum, budgets.upgrade),
          targetProbability: parsed.targetProbability, samples: parsed.samples, seed: parsed.seed, deadlineSeconds: parsed.deadlineSeconds,
        });
        decisions[tier] = this.artifacts.saveAdmissionDecision({ planVersionId: plan.id, scopeTier: tier,
          decision: this.fits(packages, tier, budgets) ? decision : { ...decision, feasible: false }, createdAt: now });
      }
      const selection = this.fits(packages, "minimum", budgets) ? selectScopeTier(decisions)
        : { status: "rejected" as const, reason: "minimum_envelope_exceeds_available_budget" };
      if (selection.status === "rejected") plan = this.plans.transitionStatus(plan.id, plan.revision, "rejected");
      else {
        plan = this.plans.transitionStatus(plan.id, plan.revision, "validated");
        plan = this.plans.transitionStatus(plan.id, plan.revision, "awaiting_approval");
        program = this.programs.transitionStatus(program.id, program.revision, "awaiting_approval", now);
      }
      this.record(program.id, plan.id, "program.plan_evaluated", "program-planning-service", now, { selection, decisions });
      return { program, plan, estimates, decisions, selection };
    }).immediate();
  }

  get(programId: string, planId: string) {
    const program = this.program(programId);
    const plan = this.plan(programId, planId);
    const workPackages = this.work.listByPlan(plan.id);
    return { program, plan, workPackages, estimates: workPackages.map((item) => this.artifacts.getEstimate(item.id)),
      decisions: Object.fromEntries(TIERS.map((tier) => [tier, this.artifacts.getAdmissionDecision(plan.id, tier)])) };
  }

  approve(programId: string, planId: string, input: unknown, now = new Date().toISOString()) {
    const parsed = ApprovePlanSchema.parse(input);
    return this.handle.connection.transaction(() => {
      const program = this.program(programId, parsed.expectedProgramRevision);
      const plan = this.plan(programId, planId, parsed.expectedPlanRevision);
      if (program.status !== "awaiting_approval" || plan.status !== "awaiting_approval") throw new ProgramPlanningError("PROGRAM_STATE_INVALID", "Plan is not awaiting approval");
      this.assertLatest(program.id, plan.id);
      const decisions = Object.fromEntries(TIERS.map((tier) => [tier, this.artifacts.getAdmissionDecision(plan.id, tier)]));
      if (TIERS.some((tier) => !decisions[tier])) throw new ProgramPlanningError("ADMISSION_REQUIRED", "Admission must be evaluated before approval");
      const selection = selectScopeTier(decisions as Record<ScopeTier, AdmissionDecision>);
      const decision = decisions[parsed.selectedTier]!;
      if (!selection.selectedTier || RANK[parsed.selectedTier] > RANK[selection.selectedTier]) throw new ProgramPlanningError("ADMISSION_REJECTED", "Selected tier exceeds admission decision");
      if (decision.calibrated ? !decision.feasible : parsed.selectedTier !== "minimum" || !parsed.acceptUncalibratedRisk) {
        throw new ProgramPlanningError("ADMISSION_REJECTED", "Uncalibrated minimum delivery requires explicit risk acknowledgement; infeasible tiers cannot be approved");
      }
      const packages = this.work.listByPlan(plan.id);
      if (!this.fits(packages, parsed.selectedTier, this.budgets(program.id))) throw new ProgramPlanningError("BUDGET_CHANGED", "Selected tier no longer fits available execution partitions");
      const result = new PlanActivationService(this.handle).activate({ programId: program.id, planVersionId: plan.id,
        expectedProgramRevision: program.revision, expectedPlanRevision: plan.revision, selectedTier: parsed.selectedTier, approvedAt: now });
      this.record(program.id, plan.id, "program.plan_approved", parsed.approvedBy, now, { selectedTier: parsed.selectedTier,
        acceptUncalibratedRisk: parsed.acceptUncalibratedRisk, programRevision: program.revision, planRevision: plan.revision });
      return { ...result, plan: this.plans.get(plan.id)! };
    }).immediate();
  }

  private record(programId: string, planId: string, eventType: string, actorId: string, now: string, metadata = {}) {
    this.audit.append({ id: `audit:${randomUUID()}`, programId, actorType: "service", actorId, eventType, metadata: { planId, ...metadata }, createdAt: now });
  }
}

export function registerExperimentalPlanningRoutes(app: Express, service: ProgramPlanningService, enabled: boolean): boolean {
  if (!enabled) return false;
  const route = (handler: (request: Request) => unknown, status = 200) => (request: Request, response: Response) => {
    try { response.status(status).json(handler(request)); }
    catch (error) {
      const code = error instanceof ProgramPlanningError || error instanceof ExecutionRepositoryError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "PLANNING_FAILED";
      response.status(code === "ENTITY_NOT_FOUND" ? 404 : code === "INVALID_INPUT" ? 400 : code === "PLANNING_FAILED" ? 500 : 409).json({ code,
        error: code === "PLANNING_FAILED" ? "Planning operation failed" : error instanceof Error ? error.message : String(error),
        ...(error instanceof ProgramPlanningError ? { details: error.details } : {}) });
    }
  };
  const base = "/api/experimental/programs/:id/plans";
  app.post(base, route((req) => service.createPlan(String(req.params.id), req.body), 201));
  app.get(`${base}/:planId`, route((req) => service.get(String(req.params.id), String(req.params.planId))));
  app.post(`${base}/:planId/admission`, route((req) => service.evaluate(String(req.params.id), String(req.params.planId), req.body)));
  app.post(`${base}/:planId/approve`, route((req) => service.approve(String(req.params.id), String(req.params.planId), req.body)));
  return true;
}
