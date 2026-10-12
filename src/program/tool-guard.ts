import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";
import type { ExecutionRuntimeContext } from "./execution-runtime-context";
import { ExecutionBarrier } from "./execution-barrier";
import { EffectLedger, type Effect } from "./effect-ledger";

export class ToolGuardError extends Error {
  constructor(readonly code: "TOOL_PERMISSION_DENIED" | "TOOL_BUDGET_DENIED" | "STALE_EXECUTION" | "HIGH_IMPACT_UNCONTROLLED", message: string) { super(message); this.name = "ToolGuardError"; }
}
export class ToolGuard {
  private readonly database: Database.Database; private readonly barrier: ExecutionBarrier; private readonly effects: EffectLedger;
  constructor(handle: ExecutionDatabase) { this.database = handle.connection; this.barrier = new ExecutionBarrier(handle); this.effects = new EffectLedger(handle); }
  authorize(input: {
    context: ExecutionRuntimeContext; toolName: string; permittedTools: ReadonlySet<string>; budgetAllowed: boolean;
    mode: "shadow" | "soft" | "hard"; impact: "low" | "medium" | "high"; providerSupportsIdempotency: boolean;
    operationKey: string; request: Record<string, unknown>; effectId: string; now: string;
  }): Effect {
    if (!input.permittedTools.has(input.toolName)) throw new ToolGuardError("TOOL_PERMISSION_DENIED", `Tool ${input.toolName} is not permitted`);
    if (!input.budgetAllowed && input.mode !== "shadow") throw new ToolGuardError("TOOL_BUDGET_DENIED", "Tool budget is exhausted");
    try { this.barrier.assertAllowed(input.context.programId, input.context.executionEpoch); } catch (error) { throw new ToolGuardError("STALE_EXECUTION", error instanceof Error ? error.message : String(error)); }
    const attempt = this.database.prepare(`SELECT a.execution_epoch, a.fencing_token, l.expires_at FROM work_package_attempts a
      LEFT JOIN attempt_leases l ON l.attempt_id=a.id WHERE a.id=?`).get(input.context.attemptId) as { execution_epoch: number; fencing_token: number; expires_at: string | null } | undefined;
    if (!attempt || attempt.execution_epoch !== input.context.executionEpoch || attempt.fencing_token !== input.context.fencingToken || !attempt.expires_at || attempt.expires_at <= input.now) {
      throw new ToolGuardError("STALE_EXECUTION", "Attempt lease or fencing token is stale");
    }
    if (input.mode === "hard" && input.impact === "high" && !input.providerSupportsIdempotency) throw new ToolGuardError("HIGH_IMPACT_UNCONTROLLED", "Hard mode rejects high-impact tools without provider idempotency");
    return this.effects.prepare({ id: input.effectId, programId: input.context.programId, attemptId: input.context.attemptId,
      operationKey: input.operationKey, effectType: input.toolName, impact: input.impact, request: input.request,
      executionEpoch: input.context.executionEpoch, fencingToken: input.context.fencingToken, createdAt: input.now });
  }
}
