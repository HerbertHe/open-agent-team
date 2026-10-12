import type Database from "better-sqlite3";
import { z } from "zod";
import type { ExecutionDatabase } from "./execution-database";
import type { BudgetProgramTaskProjection, TaskManager } from "../orchestrator/task-manager";

export const TaskBoardProjectionSchema = z.object({
  workPackageId: z.string().min(1), programId: z.string().min(1), title: z.string().min(1),
  status: z.string().min(1), updatedAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
}).strict();

export interface TaskBoardProjectionAdapter { applyProjection(projection: BudgetProgramTaskProjection): void | Promise<void> }
export class TaskManagerProjectionAdapter implements TaskBoardProjectionAdapter {
  constructor(private readonly manager: TaskManager) {}
  applyProjection(projection: BudgetProgramTaskProjection): void { this.manager.applyBudgetProgramTaskProjection(projection); }
}

export class TaskBoardProjectionWorker {
  private readonly database: Database.Database;
  constructor(handle: ExecutionDatabase, private readonly adapter: TaskBoardProjectionAdapter) { this.database = handle.connection; }

  async projectPublished(input: { now: string; limit?: number }): Promise<{ projected: number; failed: number }> {
    const rows = this.database.prepare(`SELECT o.id, o.aggregate_id, o.payload_json
      FROM execution_outbox o LEFT JOIN task_board_projections p ON p.event_id = o.id
      WHERE o.state = 'published' AND o.aggregate_type = 'work_package' AND (p.event_id IS NULL OR p.state = 'failed')
      ORDER BY o.published_at, o.id LIMIT ?`).all(input.limit ?? 100) as Array<{ id: string; aggregate_id: string; payload_json: string }>;
    let projected = 0; let failed = 0;
    for (const row of rows) {
      try {
        const projection = TaskBoardProjectionSchema.parse(JSON.parse(row.payload_json) as unknown);
        if (projection.workPackageId !== row.aggregate_id) throw new Error("Projection aggregate mismatch");
        await this.adapter.applyProjection(projection);
        this.database.prepare(`INSERT INTO task_board_projections(event_id, work_package_id, state, attempts, updated_at)
          VALUES(?, ?, 'projected', 1, ?) ON CONFLICT(event_id) DO UPDATE SET state='projected', attempts=attempts+1, last_error=NULL, updated_at=excluded.updated_at`)
          .run(row.id, projection.workPackageId, input.now);
        projected += 1;
      } catch (error) {
        this.database.prepare(`INSERT INTO task_board_projections(event_id, work_package_id, state, attempts, last_error, updated_at)
          VALUES(?, ?, 'failed', 1, ?, ?) ON CONFLICT(event_id) DO UPDATE SET state='failed', attempts=attempts+1, last_error=excluded.last_error, updated_at=excluded.updated_at`)
          .run(row.id, row.aggregate_id, error instanceof Error ? error.message : String(error), input.now);
        failed += 1;
      }
    }
    return { projected, failed };
  }
}
