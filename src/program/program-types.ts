import { z } from "zod";
import { BudgetVectorSchema } from "../budget/budget-types";
import { AcceptanceCriterionSchema } from "./acceptance-criteria";

export const OpaqueIdSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Invalid opaque identifier");

export const ProjectIdSchema = OpaqueIdSchema.brand<"ProjectId">();
export const ProgramIdSchema = OpaqueIdSchema.brand<"ProgramId">();
export const PlanVersionIdSchema = OpaqueIdSchema.brand<"PlanVersionId">();
export const WorkPackageIdSchema = OpaqueIdSchema.brand<"WorkPackageId">();
export const AttemptIdSchema = OpaqueIdSchema.brand<"AttemptId">();
export const StableWorkKeySchema = OpaqueIdSchema.brand<"StableWorkKey">();

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type ProgramId = z.infer<typeof ProgramIdSchema>;
export type PlanVersionId = z.infer<typeof PlanVersionIdSchema>;
export type WorkPackageId = z.infer<typeof WorkPackageIdSchema>;
export type AttemptId = z.infer<typeof AttemptIdSchema>;
export type StableWorkKey = z.infer<typeof StableWorkKeySchema>;

const TimestampSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const ProgramStatusSchema = z.enum([
  "draft",
  "planning",
  "awaiting_approval",
  "admitted",
  "running",
  "waiting",
  "replanning",
  "interrupt_requested",
  "quiescing",
  "snapshotting",
  "reconciling",
  "suspended",
  "suspended_uncertain",
  "closing_out",
  "completed",
  "incomplete",
  "cancelled",
]);
export type ProgramStatus = z.infer<typeof ProgramStatusSchema>;

export const PlanVersionStatusSchema = z.enum([
  "draft",
  "validated",
  "awaiting_approval",
  "active",
  "superseded",
  "rejected",
]);
export type PlanVersionStatus = z.infer<typeof PlanVersionStatusSchema>;

export const WorkPackageStatusSchema = z.enum([
  "planned",
  "blocked",
  "runnable",
  "leased",
  "running",
  "checkpointed",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "replanning_required",
]);
export type WorkPackageStatus = z.infer<typeof WorkPackageStatusSchema>;

export const AttemptStatusSchema = z.enum([
  "created",
  "leased",
  "running",
  "checkpointed",
  "verifying",
  "completed",
  "failed",
  "aborted",
  "uncertain",
  "expired",
]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

export const ScopeTierSchema = z.enum(["minimum", "standard", "stretch"]);
export type ScopeTier = z.infer<typeof ScopeTierSchema>;

export const ProgramSchema = z.object({
  id: ProgramIdSchema,
  projectId: ProjectIdSchema,
  goal: z.string().trim().min(1).max(100_000),
  status: ProgramStatusSchema,
  executionEpoch: NonNegativeSafeIntegerSchema,
  activePlanVersionId: PlanVersionIdSchema.optional(),
  revision: NonNegativeSafeIntegerSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().refine((value) => Date.parse(value.updatedAt) >= Date.parse(value.createdAt), {
  path: ["updatedAt"],
  message: "updatedAt must not be earlier than createdAt",
});
export type Program = z.infer<typeof ProgramSchema>;

export const PlanVersionSchema = z.object({
  id: PlanVersionIdSchema,
  programId: ProgramIdSchema,
  version: PositiveSafeIntegerSchema,
  parentVersionId: PlanVersionIdSchema.optional(),
  reason: z.enum(["initial", "checkpoint", "failure", "scope_change", "deadline_change"]),
  scopeTier: ScopeTierSchema,
  status: PlanVersionStatusSchema,
  workPackageIds: z.array(WorkPackageIdSchema).max(10_000),
  createdBy: OpaqueIdSchema,
  revision: NonNegativeSafeIntegerSchema,
  createdAt: TimestampSchema,
  activatedAt: TimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.workPackageIds).size !== value.workPackageIds.length) {
    context.addIssue({ code: "custom", path: ["workPackageIds"], message: "workPackageIds must be unique" });
  }
  if (value.parentVersionId === value.id) {
    context.addIssue({ code: "custom", path: ["parentVersionId"], message: "A Plan Version cannot parent itself" });
  }
  if (value.activatedAt && Date.parse(value.activatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", path: ["activatedAt"], message: "activatedAt must not be earlier than createdAt" });
  }
  const isActivated = value.status === "active" || value.status === "superseded";
  if (isActivated && !value.activatedAt) {
    context.addIssue({ code: "custom", path: ["activatedAt"], message: "active and superseded plans require activatedAt" });
  }
  if (!isActivated && value.activatedAt) {
    context.addIssue({ code: "custom", path: ["activatedAt"], message: "Only active or superseded plans may have activatedAt" });
  }
});
export type PlanVersion = z.infer<typeof PlanVersionSchema>;

export const WorkPackageSchema = z.object({
  id: WorkPackageIdSchema,
  stableKey: StableWorkKeySchema,
  programId: ProgramIdSchema,
  planVersionId: PlanVersionIdSchema,
  title: z.string().trim().min(1).max(500),
  prompt: z.string().min(1).max(200_000),
  targetAgentRole: z.enum(["admin", "leader", "worker"]),
  targetTeam: OpaqueIdSchema.optional(),
  dependsOn: z.array(WorkPackageIdSchema).max(10_000).default([]),
  conflictKeys: z.array(OpaqueIdSchema).max(1_000).default([]),
  scopeTier: ScopeTierSchema,
  mandatory: z.boolean(),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  hardEnvelope: BudgetVectorSchema,
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(100).default([]),
  notBefore: TimestampSchema.optional(),
  deadlineAt: TimestampSchema.optional(),
  status: WorkPackageStatusSchema,
  revision: NonNegativeSafeIntegerSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.dependsOn.includes(value.id)) {
    context.addIssue({ code: "custom", path: ["dependsOn"], message: "A Work Package cannot depend on itself" });
  }
  if (new Set(value.dependsOn).size !== value.dependsOn.length) {
    context.addIssue({ code: "custom", path: ["dependsOn"], message: "dependsOn must be unique" });
  }
  if (new Set(value.conflictKeys).size !== value.conflictKeys.length) {
    context.addIssue({ code: "custom", path: ["conflictKeys"], message: "conflictKeys must be unique" });
  }
  if (value.notBefore && value.deadlineAt && Date.parse(value.deadlineAt) < Date.parse(value.notBefore)) {
    context.addIssue({ code: "custom", path: ["deadlineAt"], message: "deadlineAt must not be earlier than notBefore" });
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must not be earlier than createdAt" });
  }
});
export type WorkPackage = z.infer<typeof WorkPackageSchema>;

export const WorkPackageAttemptSchema = z.object({
  id: AttemptIdSchema,
  workPackageId: WorkPackageIdSchema,
  attemptNumber: PositiveSafeIntegerSchema,
  status: AttemptStatusSchema,
  executionEpoch: NonNegativeSafeIntegerSchema,
  fencingToken: PositiveSafeIntegerSchema,
  failure: z.record(z.string(), z.unknown()).optional(),
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.startedAt && value.completedAt && Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "completedAt must not be earlier than startedAt" });
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must not be earlier than createdAt" });
  }
});
export type WorkPackageAttempt = z.infer<typeof WorkPackageAttemptSchema>;

const PROGRAM_TRANSITIONS: Record<ProgramStatus, readonly ProgramStatus[]> = {
  draft: ["planning", "cancelled"],
  planning: ["awaiting_approval", "admitted", "incomplete", "cancelled"],
  awaiting_approval: ["planning", "admitted", "cancelled"],
  admitted: ["running", "closing_out", "cancelled"],
  running: ["waiting", "replanning", "interrupt_requested", "closing_out", "completed", "incomplete"],
  waiting: ["running", "replanning", "interrupt_requested", "closing_out"],
  replanning: ["awaiting_approval", "admitted", "running", "interrupt_requested", "closing_out", "incomplete"],
  interrupt_requested: ["quiescing", "closing_out"],
  quiescing: ["snapshotting", "closing_out"],
  snapshotting: ["reconciling", "closing_out"],
  reconciling: ["suspended", "suspended_uncertain", "running", "closing_out"],
  suspended: ["running", "reconciling", "replanning", "closing_out", "cancelled"],
  suspended_uncertain: ["reconciling", "suspended", "closing_out"],
  closing_out: ["completed", "incomplete", "cancelled"],
  completed: [],
  incomplete: [],
  cancelled: [],
};

const PLAN_TRANSITIONS: Record<PlanVersionStatus, readonly PlanVersionStatus[]> = {
  draft: ["validated", "rejected"],
  validated: ["awaiting_approval", "active", "rejected"],
  awaiting_approval: ["active", "rejected"],
  active: ["superseded"],
  superseded: [],
  rejected: [],
};

const WORK_PACKAGE_TRANSITIONS: Record<WorkPackageStatus, readonly WorkPackageStatus[]> = {
  planned: ["blocked", "runnable", "cancelled"],
  blocked: ["runnable", "cancelled", "replanning_required"],
  runnable: ["leased", "cancelled", "replanning_required"],
  leased: ["running", "runnable", "cancelled"],
  running: ["checkpointed", "verifying", "failed", "cancelled", "replanning_required"],
  checkpointed: ["running", "verifying", "failed", "cancelled", "replanning_required"],
  verifying: ["completed", "failed", "replanning_required"],
  completed: [],
  failed: ["runnable", "cancelled", "replanning_required"],
  cancelled: [],
  replanning_required: ["planned", "blocked", "runnable", "cancelled"],
};

const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  created: ["leased", "aborted"],
  leased: ["running", "expired", "aborted"],
  running: ["checkpointed", "verifying", "completed", "failed", "aborted", "uncertain", "expired"],
  checkpointed: ["running", "verifying", "failed", "aborted", "uncertain", "expired"],
  verifying: ["completed", "failed", "uncertain"],
  completed: [],
  failed: [],
  aborted: [],
  uncertain: ["completed", "failed", "aborted"],
  expired: [],
};

export type DomainEntityKind = "program" | "plan_version" | "work_package" | "attempt";

export class InvalidDomainTransitionError extends Error {
  readonly code = "INVALID_DOMAIN_TRANSITION";

  constructor(readonly entity: DomainEntityKind, readonly from: string, readonly to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidDomainTransitionError";
  }
}

export function assertProgramTransition(from: ProgramStatus, to: ProgramStatus): void {
  if (!PROGRAM_TRANSITIONS[from].includes(to)) throw new InvalidDomainTransitionError("program", from, to);
}

export function assertPlanVersionTransition(from: PlanVersionStatus, to: PlanVersionStatus): void {
  if (!PLAN_TRANSITIONS[from].includes(to)) throw new InvalidDomainTransitionError("plan_version", from, to);
}

export function assertWorkPackageTransition(from: WorkPackageStatus, to: WorkPackageStatus): void {
  if (!WORK_PACKAGE_TRANSITIONS[from].includes(to)) throw new InvalidDomainTransitionError("work_package", from, to);
}

export function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (!ATTEMPT_TRANSITIONS[from].includes(to)) throw new InvalidDomainTransitionError("attempt", from, to);
}
