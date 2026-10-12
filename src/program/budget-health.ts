import { BudgetVectorSchema, subtractBudgetVectors, addBudgetVectors, type BudgetVector } from "../budget/budget-types";
import { BudgetAccountRepository } from "../budget/budget-ledger";
import type { ExecutionDatabase } from "./execution-database";
import type { BudgetMode } from "./plan-scheduler";

export interface BudgetHealthDecision {
  mode: BudgetMode;
  limitingDimension?: string;
  coverageRatio: number;
  reasons: string[];
  executionAvailable: BudgetVector;
}

function dimensions(vector: BudgetVector): Array<[string, number]> {
  const builtins = ["moneyMicros", "inputTokens", "outputTokens", "modelCalls", "toolCalls"] as const;
  return [
    ...builtins.map((key) => [key, vector[key] ?? 0] as [string, number]),
    ...Object.entries(vector.externalUnits ?? {}).map(([key, value]) => [`externalUnits.${key}`, value] as [string, number]),
  ];
}

export function decideBudgetMode(input: {
  executionAvailable: BudgetVector;
  projectedMandatoryRemaining: BudgetVector;
  uncertaintyReserve?: BudgetVector;
}): BudgetHealthDecision {
  const available = BudgetVectorSchema.parse(input.executionAvailable);
  const projected = BudgetVectorSchema.parse(input.projectedMandatoryRemaining);
  const uncertainty = BudgetVectorSchema.parse(input.uncertaintyReserve ?? {});
  const availableMap = new Map(dimensions(available));
  const uncertaintyMap = new Map(dimensions(uncertainty));
  const ratios = dimensions(projected).filter(([, required]) => required > 0).map(([dimension, required]) => ({
    dimension,
    ratio: Math.max(0, ((availableMap.get(dimension) ?? 0) - (uncertaintyMap.get(dimension) ?? 0)) / required),
  }));
  const limiting = ratios.sort((a, b) => a.ratio - b.ratio || a.dimension.localeCompare(b.dimension))[0];
  const ratio = limiting?.ratio ?? Number.POSITIVE_INFINITY;
  const mode: BudgetMode = ratio >= 1.5 ? "explore" : ratio >= 1.2 ? "balanced" : ratio >= 1 ? "commit" : "closeout";
  return {
    mode,
    ...(limiting ? { limitingDimension: limiting.dimension } : {}),
    coverageRatio: ratio,
    reasons: limiting ? [`${limiting.dimension} coverage=${ratio.toFixed(3)}`, `selected ${mode} threshold`] : ["no mandatory budget remains"],
    executionAvailable: available,
  };
}

/** Derives spendable execution budget from unprotected ledger partitions; callers cannot expose closeout/validation reserves. */
export function decideProgramBudgetMode(handle: ExecutionDatabase, input: {
  programId: string;
  projectedMandatoryRemaining: BudgetVector;
  uncertaintyReserve?: BudgetVector;
}): BudgetHealthDecision {
  const accounts = BudgetAccountRepository.from(handle).listByProgram(input.programId).filter((account) => !account.protected && ["minimum", "upgrade_pool", "standard", "stretch"].includes(account.kind));
  const executionAvailable = accounts.reduce<BudgetVector>((total, account) => {
    const committed = addBudgetVectors(account.spent, account.reserved);
    try { return addBudgetVectors(total, subtractBudgetVectors(account.limit, committed)); }
    catch { return total; }
  }, {});
  return decideBudgetMode({ executionAvailable, projectedMandatoryRemaining: input.projectedMandatoryRemaining, ...(input.uncertaintyReserve ? { uncertaintyReserve: input.uncertaintyReserve } : {}) });
}
