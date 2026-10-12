import { z } from "zod";
import type { Express, Request, Response } from "express";
import type { GlobalModelCatalog } from "../models/global-models";
import { BudgetAllocationSchema } from "../budget/budget-types";
import { BudgetAccountRepository, buildProgramAccountTree } from "../budget/budget-ledger";
import { insertPricingSnapshot, pricingSnapshotFromCatalog } from "../budget/pricing-service";
import type { ExecutionDatabase } from "./execution-database";
import { ProgramRepository } from "./execution-repositories";
import { OpaqueIdSchema, ProgramIdSchema, ProgramSchema, ProjectIdSchema, type Program } from "./program-types";

const TimestampSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());

export const CreateProgramDraftSchema = z.object({
  id: ProgramIdSchema,
  projectId: ProjectIdSchema,
  goal: z.string().trim().min(1).max(100_000),
  allocation: BudgetAllocationSchema,
  pricingSnapshotId: OpaqueIdSchema,
  createdAt: TimestampSchema,
}).strict();

export const UpdateProgramDraftSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  goal: z.string().trim().min(1).max(100_000),
  updatedAt: TimestampSchema,
}).strict();

export class ProgramFeatureDisabledError extends Error {
  readonly code = "BUDGET_EXECUTION_DISABLED";
  constructor() { super("Experimental budget execution is disabled"); this.name = "ProgramFeatureDisabledError"; }
}

export class ProgramService {
  private readonly programs: ProgramRepository;
  private readonly accounts: BudgetAccountRepository;

  constructor(
    private readonly handle: ExecutionDatabase,
    private readonly enabled: boolean,
    private readonly catalog: GlobalModelCatalog,
  ) {
    this.programs = new ProgramRepository(handle);
    this.accounts = BudgetAccountRepository.from(handle);
  }

  createDraft(input: z.input<typeof CreateProgramDraftSchema>, options: {
    faultInjector?: (point: "after_program" | "after_accounts" | "after_pricing") => void;
  } = {}): Program {
    this.assertEnabled();
    const parsed = CreateProgramDraftSchema.parse(input);
    return this.handle.connection.transaction(() => {
      const program = this.programs.create(ProgramSchema.parse({
        id: parsed.id, projectId: parsed.projectId, goal: parsed.goal, status: "draft",
        executionEpoch: 0, revision: 0, createdAt: parsed.createdAt, updatedAt: parsed.createdAt,
      }));
      options.faultInjector?.("after_program");
      this.accounts.createBatch(buildProgramAccountTree(program.id, parsed.allocation, parsed.createdAt));
      options.faultInjector?.("after_accounts");
      insertPricingSnapshot(
        this.handle.connection,
        pricingSnapshotFromCatalog(parsed.pricingSnapshotId, program.id, this.catalog, parsed.createdAt),
      );
      options.faultInjector?.("after_pricing");
      return program;
    }).immediate();
  }

  getDraft(id: string): Program | undefined {
    this.assertEnabled();
    const program = this.programs.get(ProgramIdSchema.parse(id));
    return program?.status === "draft" ? program : undefined;
  }

  listDrafts(projectId: string): Program[] {
    this.assertEnabled();
    return this.programs.listByProject(ProjectIdSchema.parse(projectId)).filter((program) => program.status === "draft");
  }

  updateDraft(id: string, input: z.input<typeof UpdateProgramDraftSchema>): Program {
    this.assertEnabled();
    const parsed = UpdateProgramDraftSchema.parse(input);
    return this.programs.updateDraftGoal(ProgramIdSchema.parse(id), parsed.expectedRevision, parsed.goal, parsed.updatedAt);
  }

  deleteDraft(id: string, expectedRevision: number): void {
    this.assertEnabled();
    this.programs.deleteDraft(ProgramIdSchema.parse(id), expectedRevision);
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ProgramFeatureDisabledError();
  }
}

export function registerExperimentalProgramRoutes(app: Express, service: ProgramService, enabled: boolean): boolean {
  if (!enabled) return false;
  const fail = (response: Response, error: unknown) => response.status(400).json({
    error: error instanceof Error ? error.message : String(error),
  });
  app.post("/api/experimental/programs", (request: Request, response: Response) => {
    try { response.status(201).json(service.createDraft(request.body)); } catch (error) { fail(response, error); }
  });
  app.get("/api/experimental/programs/:id", (request: Request, response: Response) => {
    try {
      const result = service.getDraft(String(request.params.id));
      if (!result) { response.status(404).json({ error: "Program draft not found" }); return; }
      response.json(result);
    } catch (error) { fail(response, error); }
  });
  app.patch("/api/experimental/programs/:id", (request: Request, response: Response) => {
    try { response.json(service.updateDraft(String(request.params.id), request.body)); } catch (error) { fail(response, error); }
  });
  app.delete("/api/experimental/programs/:id", (request: Request, response: Response) => {
    try {
      const expectedRevision = Number(request.query.revision);
      service.deleteDraft(String(request.params.id), expectedRevision);
      response.status(204).end();
    } catch (error) { fail(response, error); }
  });
  return true;
}
