import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import {
  PlanVersionSchema,
  ProgramSchema,
  WorkPackageSchema,
  assertPlanVersionTransition,
  assertProgramTransition,
  assertWorkPackageTransition,
  type PlanVersion,
  type PlanVersionStatus,
  type Program,
  type ProgramStatus,
  type WorkPackage,
  type WorkPackageStatus,
} from "./program-types";
import {
  insertExecutionOutboxEvent,
  type ExecutionOutboxEvent,
} from "./execution-outbox";

export type ExecutionRepositoryErrorCode =
  | "ENTITY_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "CORRUPT_ENTITY"
  | "DUPLICATE_ENTITY";

export class ExecutionRepositoryError extends Error {
  constructor(
    readonly code: ExecutionRepositoryErrorCode,
    readonly entityType: "program" | "plan_version" | "work_package",
    readonly entityId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExecutionRepositoryError";
  }
}

export interface RepositoryMutationOptions {
  outboxEvents?: readonly ExecutionOutboxEvent[];
  faultInjector?: (point: "after_entity_write" | "after_outbox_write") => void;
}

function appendEvents(database: Database.Database, options: RepositoryMutationOptions): void {
  for (const event of options.outboxEvents ?? []) insertExecutionOutboxEvent(database, event);
  options.faultInjector?.("after_outbox_write");
}

function parseJson(value: string, entityType: ExecutionRepositoryError["entityType"], entityId: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ExecutionRepositoryError("CORRUPT_ENTITY", entityType, entityId, `${entityType} contains invalid JSON`, { cause: error });
  }
}

function requireRevision(
  entityType: ExecutionRepositoryError["entityType"],
  id: string,
  actual: number,
  expected: number,
): void {
  if (actual !== expected) {
    throw new ExecutionRepositoryError(
      "REVISION_CONFLICT",
      entityType,
      id,
      `Expected ${entityType} ${id} revision ${expected}, found ${actual}`,
    );
  }
}

function duplicate(
  entityType: ExecutionRepositoryError["entityType"],
  id: string,
  cause: unknown,
): ExecutionRepositoryError {
  return new ExecutionRepositoryError("DUPLICATE_ENTITY", entityType, id, `${entityType} ${id} already exists`, { cause });
}

export class ProgramRepository {
  private readonly database: Database.Database;

  constructor(handle: ExecutionDatabase) {
    this.database = handle.connection;
  }

  create(input: Program, options: RepositoryMutationOptions = {}): Program {
    const program = ProgramSchema.parse(input);
    try {
      return this.database.transaction(() => {
        this.database.prepare(`
          INSERT INTO programs(
            id, project_id, goal, status, execution_epoch, active_plan_version_id,
            revision, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          program.id, program.projectId, program.goal, program.status, program.executionEpoch,
          program.activePlanVersionId ?? null, program.revision, program.createdAt, program.updatedAt,
        );
        options.faultInjector?.("after_entity_write");
        appendEvents(this.database, options);
        return program;
      }).immediate();
    } catch (error) {
      if (error instanceof ExecutionRepositoryError) throw error;
      if (String(error).includes("UNIQUE constraint failed")) throw duplicate("program", program.id, error);
      throw error;
    }
  }

  get(id: string): Program | undefined {
    const row = this.database.prepare("SELECT * FROM programs WHERE id = ?").get(id) as {
      id: string; project_id: string; goal: string; status: string; execution_epoch: number;
      active_plan_version_id: string | null; revision: number; created_at: string; updated_at: string;
    } | undefined;
    if (!row) return undefined;
    try {
      return ProgramSchema.parse({
        id: row.id,
        projectId: row.project_id,
        goal: row.goal,
        status: row.status,
        executionEpoch: row.execution_epoch,
        ...(row.active_plan_version_id ? { activePlanVersionId: row.active_plan_version_id } : {}),
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } catch (error) {
      throw new ExecutionRepositoryError("CORRUPT_ENTITY", "program", row.id, `Program ${row.id} is corrupt`, { cause: error });
    }
  }

  listByProject(projectId: string): Program[] {
    const ids = this.database.prepare(
      "SELECT id FROM programs WHERE project_id = ? ORDER BY created_at, id",
    ).pluck().all(projectId) as string[];
    return ids.map((id) => this.get(id)!);
  }

  updateDraftGoal(
    id: string,
    expectedRevision: number,
    goal: string,
    updatedAt: string,
    options: RepositoryMutationOptions = {},
  ): Program {
    return this.database.transaction(() => {
      const current = this.get(id);
      if (!current) throw new ExecutionRepositoryError("ENTITY_NOT_FOUND", "program", id, `Program ${id} was not found`);
      requireRevision("program", id, current.revision, expectedRevision);
      if (current.status !== "draft") throw new ExecutionRepositoryError("REVISION_CONFLICT", "program", id, "Only draft Programs are editable");
      const next = ProgramSchema.parse({ ...current, goal, revision: current.revision + 1, updatedAt });
      const result = this.database.prepare(`
        UPDATE programs SET goal = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ? AND status = 'draft'
      `).run(next.goal, next.revision, next.updatedAt, id, expectedRevision);
      if (result.changes !== 1) throw new ExecutionRepositoryError("REVISION_CONFLICT", "program", id, `Program ${id} changed concurrently`);
      options.faultInjector?.("after_entity_write");
      appendEvents(this.database, options);
      return next;
    }).immediate();
  }

  deleteDraft(id: string, expectedRevision: number): void {
    this.database.transaction(() => {
      const current = this.get(id);
      if (!current) throw new ExecutionRepositoryError("ENTITY_NOT_FOUND", "program", id, `Program ${id} was not found`);
      requireRevision("program", id, current.revision, expectedRevision);
      if (current.status !== "draft") throw new ExecutionRepositoryError("REVISION_CONFLICT", "program", id, "Only draft Programs are deletable");
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt))).toISOString();
      const result = this.database.prepare(
        "UPDATE programs SET status = 'cancelled', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'draft'",
      ).run(updatedAt, id, expectedRevision);
      if (result.changes !== 1) throw new ExecutionRepositoryError("REVISION_CONFLICT", "program", id, `Program ${id} changed concurrently`);
    }).immediate();
  }

  transitionStatus(
    id: string,
    expectedRevision: number,
    status: ProgramStatus,
    updatedAt: string,
    options: RepositoryMutationOptions = {},
  ): Program {
    return this.database.transaction(() => {
      const current = this.get(id);
      if (!current) throw new ExecutionRepositoryError("ENTITY_NOT_FOUND", "program", id, `Program ${id} was not found`);
      requireRevision("program", id, current.revision, expectedRevision);
      assertProgramTransition(current.status, status);
      const next = ProgramSchema.parse({ ...current, status, revision: current.revision + 1, updatedAt });
      const result = this.database.prepare(`
        UPDATE programs SET status = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?
      `).run(next.status, next.revision, next.updatedAt, id, expectedRevision);
      if (result.changes !== 1) throw new ExecutionRepositoryError("REVISION_CONFLICT", "program", id, `Program ${id} changed concurrently`);
      options.faultInjector?.("after_entity_write");
      appendEvents(this.database, options);
      return next;
    }).immediate();
  }
}

interface PlanRow {
  id: string; program_id: string; version: number; scope_tier: string; status: string;
  plan_json: string; revision: number; created_at: string; activated_at: string | null;
}

function planFromRow(row: PlanRow): PlanVersion {
  try {
    const plan = PlanVersionSchema.parse(parseJson(row.plan_json, "plan_version", row.id));
    if (plan.id !== row.id || plan.programId !== row.program_id || plan.version !== row.version ||
        plan.scopeTier !== row.scope_tier || plan.status !== row.status || plan.revision !== row.revision ||
        plan.createdAt !== row.created_at || (plan.activatedAt ?? null) !== row.activated_at) {
      throw new Error("indexed columns disagree with plan_json");
    }
    return plan;
  } catch (error) {
    if (error instanceof ExecutionRepositoryError) throw error;
    throw new ExecutionRepositoryError("CORRUPT_ENTITY", "plan_version", row.id, `Plan Version ${row.id} is corrupt`, { cause: error });
  }
}

export class PlanVersionRepository {
  private readonly database: Database.Database;

  constructor(handle: ExecutionDatabase) { this.database = handle.connection; }

  create(input: PlanVersion, options: RepositoryMutationOptions = {}): PlanVersion {
    const plan = PlanVersionSchema.parse(input);
    try {
      return this.database.transaction(() => {
        this.database.prepare(`
          INSERT INTO plan_versions(
            id, program_id, version, scope_tier, status, plan_json, revision, created_at, activated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          plan.id, plan.programId, plan.version, plan.scopeTier, plan.status, JSON.stringify(plan),
          plan.revision, plan.createdAt, plan.activatedAt ?? null,
        );
        options.faultInjector?.("after_entity_write");
        appendEvents(this.database, options);
        return plan;
      }).immediate();
    } catch (error) {
      if (error instanceof ExecutionRepositoryError) throw error;
      if (String(error).includes("UNIQUE constraint failed")) throw duplicate("plan_version", plan.id, error);
      throw error;
    }
  }

  get(id: string): PlanVersion | undefined {
    const row = this.database.prepare("SELECT * FROM plan_versions WHERE id = ?").get(id) as PlanRow | undefined;
    return row ? planFromRow(row) : undefined;
  }

  transitionStatus(
    id: string,
    expectedRevision: number,
    status: PlanVersionStatus,
    activatedAt?: string,
    options: RepositoryMutationOptions = {},
  ): PlanVersion {
    return this.database.transaction(() => {
      const current = this.get(id);
      if (!current) throw new ExecutionRepositoryError("ENTITY_NOT_FOUND", "plan_version", id, `Plan Version ${id} was not found`);
      requireRevision("plan_version", id, current.revision, expectedRevision);
      assertPlanVersionTransition(current.status, status);
      const next = PlanVersionSchema.parse({
        ...current,
        status,
        revision: current.revision + 1,
        ...(activatedAt ? { activatedAt } : {}),
      });
      const result = this.database.prepare(`
        UPDATE plan_versions
        SET status = ?, revision = ?, activated_at = ?, plan_json = ?
        WHERE id = ? AND revision = ?
      `).run(next.status, next.revision, next.activatedAt ?? null, JSON.stringify(next), id, expectedRevision);
      if (result.changes !== 1) throw new ExecutionRepositoryError("REVISION_CONFLICT", "plan_version", id, `Plan Version ${id} changed concurrently`);
      options.faultInjector?.("after_entity_write");
      appendEvents(this.database, options);
      return next;
    }).immediate();
  }
}

interface WorkPackageRow {
  id: string; program_id: string; plan_version_id: string; stable_key: string; status: string;
  mandatory: number; priority: number; definition_json: string; revision: number;
  created_at: string; updated_at: string;
}

function workPackageFromRow(row: WorkPackageRow): WorkPackage {
  try {
    const workPackage = WorkPackageSchema.parse(parseJson(row.definition_json, "work_package", row.id));
    if (workPackage.id !== row.id || workPackage.programId !== row.program_id ||
        workPackage.planVersionId !== row.plan_version_id || workPackage.stableKey !== row.stable_key ||
        workPackage.status !== row.status || Number(workPackage.mandatory) !== row.mandatory ||
        workPackage.priority !== row.priority || workPackage.revision !== row.revision ||
        workPackage.createdAt !== row.created_at || workPackage.updatedAt !== row.updated_at) {
      throw new Error("indexed columns disagree with definition_json");
    }
    return workPackage;
  } catch (error) {
    if (error instanceof ExecutionRepositoryError) throw error;
    throw new ExecutionRepositoryError("CORRUPT_ENTITY", "work_package", row.id, `Work Package ${row.id} is corrupt`, { cause: error });
  }
}

export class WorkPackageRepository {
  private readonly database: Database.Database;

  constructor(handle: ExecutionDatabase) { this.database = handle.connection; }

  create(input: WorkPackage, options: RepositoryMutationOptions = {}): WorkPackage {
    return this.createBatch([input], options)[0]!;
  }

  createBatch(inputs: readonly WorkPackage[], options: RepositoryMutationOptions = {}): WorkPackage[] {
    const packages = inputs.map((input) => WorkPackageSchema.parse(input));
    if (new Set(packages.map((item) => item.id)).size !== packages.length) {
      throw duplicate("work_package", "<batch>", new Error("Duplicate Work Package ID in batch"));
    }
    try {
      return this.database.transaction(() => {
        const insertPackage = this.database.prepare(`
          INSERT INTO work_packages(
            id, program_id, plan_version_id, stable_key, status, mandatory, priority,
            definition_json, revision, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of packages) {
          insertPackage.run(
            item.id, item.programId, item.planVersionId, item.stableKey, item.status,
            Number(item.mandatory), item.priority, JSON.stringify(item), item.revision, item.createdAt, item.updatedAt,
          );
        }
        const insertDependency = this.database.prepare(`
          INSERT INTO work_package_dependencies(plan_version_id, work_package_id, depends_on_work_package_id)
          VALUES(?, ?, ?)
        `);
        for (const item of packages) {
          for (const dependency of item.dependsOn) insertDependency.run(item.planVersionId, item.id, dependency);
        }
        const insertCriterion = this.database.prepare(`
          INSERT INTO acceptance_criteria(id, work_package_id, type, criterion_json, created_at)
          VALUES(?, ?, ?, ?, ?)
        `);
        for (const item of packages) for (const criterion of item.acceptanceCriteria) {
          insertCriterion.run(criterion.id, item.id, criterion.type, JSON.stringify(criterion), item.createdAt);
        }
        options.faultInjector?.("after_entity_write");
        appendEvents(this.database, options);
        return packages;
      }).immediate();
    } catch (error) {
      if (error instanceof ExecutionRepositoryError) throw error;
      if (String(error).includes("UNIQUE constraint failed")) throw duplicate("work_package", "<batch>", error);
      throw error;
    }
  }

  get(id: string): WorkPackage | undefined {
    const row = this.database.prepare("SELECT * FROM work_packages WHERE id = ?").get(id) as WorkPackageRow | undefined;
    return row ? workPackageFromRow(row) : undefined;
  }

  listByPlan(planVersionId: string): WorkPackage[] {
    const ids = this.database.prepare(
      "SELECT id FROM work_packages WHERE plan_version_id = ? ORDER BY created_at, id",
    ).pluck().all(planVersionId) as string[];
    return ids.map((id) => this.get(id)!);
  }

  listByProgram(programId: string): WorkPackage[] {
    const ids = this.database.prepare(
      "SELECT id FROM work_packages WHERE program_id = ? ORDER BY created_at, id",
    ).pluck().all(programId) as string[];
    return ids.map((id) => this.get(id)!);
  }

  transitionStatus(
    id: string,
    expectedRevision: number,
    status: WorkPackageStatus,
    updatedAt: string,
    options: RepositoryMutationOptions = {},
  ): WorkPackage {
    return this.database.transaction(() => {
      const current = this.get(id);
      if (!current) throw new ExecutionRepositoryError("ENTITY_NOT_FOUND", "work_package", id, `Work Package ${id} was not found`);
      requireRevision("work_package", id, current.revision, expectedRevision);
      assertWorkPackageTransition(current.status, status);
      const next = WorkPackageSchema.parse({ ...current, status, revision: current.revision + 1, updatedAt });
      const result = this.database.prepare(`
        UPDATE work_packages SET status = ?, revision = ?, updated_at = ?, definition_json = ?
        WHERE id = ? AND revision = ?
      `).run(next.status, next.revision, next.updatedAt, JSON.stringify(next), id, expectedRevision);
      if (result.changes !== 1) throw new ExecutionRepositoryError("REVISION_CONFLICT", "work_package", id, `Work Package ${id} changed concurrently`);
      options.faultInjector?.("after_entity_write");
      appendEvents(this.database, options);
      return next;
    }).immediate();
  }
}
