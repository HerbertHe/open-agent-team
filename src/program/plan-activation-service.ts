import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import { insertExecutionOutboxEvent } from "./execution-outbox";
import { PlanVersionRepository, ProgramRepository, WorkPackageRepository, ExecutionRepositoryError } from "./execution-repositories";
import { PlanValidator } from "./plan-validator";
import type { Program, ScopeTier, WorkPackage } from "./program-types";

const RANK: Record<ScopeTier, number> = { minimum: 0, standard: 1, stretch: 2 };

export class PlanActivationError extends Error {
  constructor(readonly code: "PLAN_INVALID" | "PROGRAM_STATE_INVALID", message: string) {
    super(message);
    this.name = "PlanActivationError";
  }
}

function eventId(value: string): string {
  return `evt:${createHash("sha256").update(value).digest("hex")}`;
}
function dedupeKey(value: string): string { return `activation:${createHash("sha256").update(value).digest("hex")}`; }

export class PlanActivationService {
  private readonly database: Database.Database;
  private readonly programs: ProgramRepository;
  private readonly plans: PlanVersionRepository;
  private readonly work: WorkPackageRepository;

  constructor(handle: ExecutionDatabase, private readonly validator = new PlanValidator()) {
    this.database = handle.connection;
    this.programs = new ProgramRepository(handle);
    this.plans = new PlanVersionRepository(handle);
    this.work = new WorkPackageRepository(handle);
  }

  activate(input: {
    programId: string;
    planVersionId: string;
    expectedProgramRevision: number;
    expectedPlanRevision: number;
    selectedTier: ScopeTier;
    approvedAt: string;
    faultInjector?: (point: "after_plan" | "after_program" | "after_work" | "after_outbox") => void;
  }): { program: Program; workPackages: WorkPackage[] } {
    return this.database.transaction(() => {
      const program = this.programs.get(input.programId);
      const plan = this.plans.get(input.planVersionId);
      if (!program || !plan) {
        throw new ExecutionRepositoryError("ENTITY_NOT_FOUND", !program ? "program" : "plan_version", !program ? input.programId : input.planVersionId, "Activation target was not found");
      }
      if (program.revision !== input.expectedProgramRevision || plan.revision !== input.expectedPlanRevision) {
        throw new ExecutionRepositoryError("REVISION_CONFLICT", program.revision !== input.expectedProgramRevision ? "program" : "plan_version", program.revision !== input.expectedProgramRevision ? program.id : plan.id, "Approval is stale");
      }
      if (plan.programId !== program.id || !["validated", "awaiting_approval"].includes(plan.status)) {
        throw new PlanActivationError("PROGRAM_STATE_INVALID", "Plan is not activatable for this Program");
      }
      if (!["planning", "awaiting_approval", "replanning"].includes(program.status)) {
        throw new PlanActivationError("PROGRAM_STATE_INVALID", `Program ${program.id} is ${program.status}`);
      }
      const packages = this.work.listByPlan(plan.id);
      const validation = this.validator.validate({ plan, workPackages: packages });
      if (!validation.valid) throw new PlanActivationError("PLAN_INVALID", validation.issues.map((issue) => issue.code).join(","));

      if (program.activePlanVersionId && program.activePlanVersionId !== plan.id) {
        const previous = this.plans.get(program.activePlanVersionId);
        if (previous?.status === "active") this.plans.transitionStatus(previous.id, previous.revision, "superseded", previous.activatedAt);
      }
      this.plans.transitionStatus(plan.id, plan.revision, "active", input.approvedAt, { scopeTier: input.selectedTier });
      input.faultInjector?.("after_plan");
      const programResult = this.database.prepare(`
        UPDATE programs SET status = ?, active_plan_version_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status IN ('planning','awaiting_approval','replanning')
      `).run(program.status === "replanning" ? "running" : "admitted", plan.id, input.approvedAt, program.id, input.expectedProgramRevision);
      if (programResult.changes !== 1) throw new ExecutionRepositoryError("REVISION_CONFLICT", "program", program.id, "Program changed during activation");
      input.faultInjector?.("after_program");

      const selected = packages.filter((item) => RANK[item.scopeTier] <= RANK[input.selectedTier]);
      const selectedIds = new Set(selected.map((item) => item.id));
      const completedIds = new Set(selected.filter((item) => item.status === "completed").map((item) => item.id));
      const updated: WorkPackage[] = [];
      for (const item of packages) {
        const nextStatus = ["completed", "cancelled"].includes(item.status) ? item.status : !selectedIds.has(item.id) ? "cancelled"
          : item.dependsOn.every((id) => completedIds.has(id)) ? "runnable" : item.status;
        const next = nextStatus === item.status ? item : this.work.transitionStatus(item.id, item.revision, nextStatus, input.approvedAt);
        updated.push(next);
      }
      input.faultInjector?.("after_work");
      for (const item of updated) {
        const key = `plan-activation:${plan.id}:${item.id}:${item.status}`;
        insertExecutionOutboxEvent(this.database, {
          id: eventId(key), dedupeKey: dedupeKey(key), aggregateType: "work_package", aggregateId: item.id,
          eventType: "work_package.projected", payload: {
            workPackageId: item.id, programId: item.programId, title: item.title, status: item.status, updatedAt: item.updatedAt,
          }, availableAt: input.approvedAt, createdAt: input.approvedAt,
        });
      }
      input.faultInjector?.("after_outbox");
      return { program: this.programs.get(program.id)!, workPackages: updated };
    }).immediate();
  }
}
