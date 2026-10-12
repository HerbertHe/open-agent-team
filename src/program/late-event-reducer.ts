import type { ExecutionDatabase } from "./execution-database";
import { ExecutionAuditRepository } from "./execution-audit-repository";

export class LateEventReducer {
  private readonly audit: ExecutionAuditRepository;
  constructor(private readonly handle: ExecutionDatabase) { this.audit = new ExecutionAuditRepository(handle); }
  apply(input: { id: string; programId: string; attemptId?: string; executionEpoch: number; fencingToken?: number; kind: "state" | "usage"; payload: Record<string, unknown>; now: string }): "applied_to_state" | "applied_to_ledger_only" | "ignored_for_state" {
    const duplicate = this.audit.get(input.id);
    if (duplicate) {
      const prior = duplicate.metadata.result;
      if (prior === "applied_to_state" || prior === "applied_to_ledger_only" || prior === "ignored_for_state") return prior;
      throw new Error(`Late event ${input.id} conflicts with another audit event`);
    }
    const program = this.handle.connection.prepare("SELECT execution_epoch FROM programs WHERE id=?").get(input.programId) as { execution_epoch: number } | undefined;
    const attempt = input.attemptId ? this.handle.connection.prepare("SELECT fencing_token FROM work_package_attempts WHERE id=?").get(input.attemptId) as { fencing_token: number } | undefined : undefined;
    const current = program?.execution_epoch === input.executionEpoch && (input.fencingToken === undefined || attempt?.fencing_token === input.fencingToken);
    const result = current ? "applied_to_state" : input.kind === "usage" ? "applied_to_ledger_only" : "ignored_for_state";
    this.audit.append({ id: input.id, programId: input.programId, ...(input.attemptId ? { attemptId: input.attemptId } : {}), actorType: "system",
      eventType: result === "applied_to_ledger_only" ? "late_event.applied_to_ledger" : result === "ignored_for_state" ? "late_event.ignored_for_state" : "runtime.event.applied",
      after: input.payload, metadata: { eventEpoch: input.executionEpoch, currentEpoch: program?.execution_epoch, result }, createdAt: input.now });
    return result;
  }
}
