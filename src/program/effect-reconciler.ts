import type { ExecutionDatabase } from "./execution-database";
import { EffectLedger, type Effect } from "./effect-ledger";

export type ProviderEffectState =
  | { state: "confirmed"; receipt: Record<string, unknown> }
  | { state: "not_applied"; receipt?: Record<string, unknown> }
  | { state: "unknown"; reason: string }
  | { state: "non_recoverable"; reason: string };

export interface EffectStateAdapter {
  query(effect: Effect): Promise<ProviderEffectState>;
}

export class EffectReconciler {
  private readonly ledger: EffectLedger;
  constructor(private readonly handle: ExecutionDatabase, private readonly adapters: ReadonlyMap<string, EffectStateAdapter>) {
    this.ledger = new EffectLedger(handle);
  }

  async reconcile(programId: string, now: string): Promise<{ reconciled: number; unresolved: Effect[] }> {
    const rows = this.handle.connection.prepare(
      "SELECT operation_key FROM effects WHERE program_id=? AND state IN ('dispatched','uncertain') ORDER BY created_at, id",
    ).all(programId) as Array<{ operation_key: string }>;
    let reconciled = 0;
    const unresolved: Effect[] = [];
    for (const row of rows) {
      let effect = this.ledger.getByOperationKey(row.operation_key)!;
      const adapter = this.adapters.get(effect.effectType);
      if (!adapter) {
        if (effect.state === "dispatched") effect = this.ledger.transition(effect.operationKey, "uncertain", now);
        unresolved.push(effect);
        continue;
      }
      let result: ProviderEffectState;
      try {
        result = await adapter.query(effect);
      } catch {
        if (effect.state === "dispatched") effect = this.ledger.transition(effect.operationKey, "uncertain", now);
        unresolved.push(effect);
        continue;
      }
      if (result.state === "confirmed") {
        if (effect.state === "dispatched") this.ledger.transition(effect.operationKey, "confirmed", now, { receipt: result.receipt });
        else this.ledger.transition(effect.operationKey, "reconciled", now, { receipt: { outcome: "applied", ...result.receipt } });
        reconciled += 1;
      } else if (result.state === "not_applied") {
        if (effect.state === "dispatched") effect = this.ledger.transition(effect.operationKey, "uncertain", now);
        this.ledger.transition(effect.operationKey, "reconciled", now, { receipt: { outcome: "not_applied", ...(result.receipt ?? {}) } });
        reconciled += 1;
      } else {
        if (effect.state === "dispatched") effect = this.ledger.transition(effect.operationKey, "uncertain", now);
        // Unknown and non-recoverable effects remain uncertain. In particular, a high-impact
        // effect is never converted into a retry instruction by reconciliation.
        unresolved.push(effect);
      }
    }
    return { reconciled, unresolved };
  }
}
