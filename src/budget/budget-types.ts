import { z } from "zod";

export const NonNegativeBudgetIntegerSchema = z.number()
  .int("Budget values must be integers")
  .nonnegative("Budget values must be non-negative")
  .max(Number.MAX_SAFE_INTEGER, "Budget values must be safe integers");

export const ExternalBudgetDimensionSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Invalid external budget dimension");

/** All values are indivisible integer units; money is represented in micros. */
export const BudgetVectorSchema = z.object({
  moneyMicros: NonNegativeBudgetIntegerSchema.optional(),
  inputTokens: NonNegativeBudgetIntegerSchema.optional(),
  outputTokens: NonNegativeBudgetIntegerSchema.optional(),
  modelCalls: NonNegativeBudgetIntegerSchema.optional(),
  toolCalls: NonNegativeBudgetIntegerSchema.optional(),
  externalUnits: z.record(ExternalBudgetDimensionSchema, NonNegativeBudgetIntegerSchema).optional(),
}).strict();

export type BudgetVector = z.infer<typeof BudgetVectorSchema>;

export const BudgetAllocationSchema = z.object({
  planning: BudgetVectorSchema,
  minimumDelivery: BudgetVectorSchema,
  upgradePool: BudgetVectorSchema,
  validation: BudgetVectorSchema,
  contingency: BudgetVectorSchema,
  closeout: BudgetVectorSchema,
}).strict();

export type BudgetAllocation = z.infer<typeof BudgetAllocationSchema>;

export type BuiltinBudgetDimension = "moneyMicros" | "inputTokens" | "outputTokens" | "modelCalls" | "toolCalls";
const BUILTIN_DIMENSIONS: readonly BuiltinBudgetDimension[] = [
  "moneyMicros", "inputTokens", "outputTokens", "modelCalls", "toolCalls",
];

export type BudgetArithmeticErrorCode = "BUDGET_OVERFLOW" | "BUDGET_UNDERFLOW";

export class BudgetArithmeticError extends Error {
  constructor(readonly code: BudgetArithmeticErrorCode, readonly dimension: string) {
    super(`${code === "BUDGET_OVERFLOW" ? "Overflow" : "Underflow"} in budget dimension ${dimension}`);
    this.name = "BudgetArithmeticError";
  }
}

function checkedAdd(left: number, right: number, dimension: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new BudgetArithmeticError("BUDGET_OVERFLOW", dimension);
  return result;
}

function checkedSubtract(left: number, right: number, dimension: string): number {
  const result = left - right;
  if (result < 0) throw new BudgetArithmeticError("BUDGET_UNDERFLOW", dimension);
  return result;
}

function compact(vector: BudgetVector): BudgetVector {
  const output: BudgetVector = {};
  for (const dimension of BUILTIN_DIMENSIONS) {
    const value = vector[dimension];
    if (value !== undefined && value !== 0) output[dimension] = value;
  }
  const external = Object.fromEntries(
    Object.entries(vector.externalUnits ?? {}).filter(([, value]) => value !== 0).sort(([a], [b]) => a.localeCompare(b)),
  );
  if (Object.keys(external).length > 0) output.externalUnits = external;
  return BudgetVectorSchema.parse(output);
}

export function addBudgetVectors(leftInput: BudgetVector, rightInput: BudgetVector): BudgetVector {
  const left = BudgetVectorSchema.parse(leftInput);
  const right = BudgetVectorSchema.parse(rightInput);
  const result: BudgetVector = {};
  for (const dimension of BUILTIN_DIMENSIONS) {
    const value = checkedAdd(left[dimension] ?? 0, right[dimension] ?? 0, dimension);
    if (value !== 0) result[dimension] = value;
  }
  const externalUnits: Record<string, number> = {};
  for (const dimension of new Set([...Object.keys(left.externalUnits ?? {}), ...Object.keys(right.externalUnits ?? {})])) {
    const value = checkedAdd(left.externalUnits?.[dimension] ?? 0, right.externalUnits?.[dimension] ?? 0, `externalUnits.${dimension}`);
    if (value !== 0) externalUnits[dimension] = value;
  }
  if (Object.keys(externalUnits).length > 0) result.externalUnits = externalUnits;
  return compact(result);
}

export function subtractBudgetVectors(leftInput: BudgetVector, rightInput: BudgetVector): BudgetVector {
  const left = BudgetVectorSchema.parse(leftInput);
  const right = BudgetVectorSchema.parse(rightInput);
  const result: BudgetVector = {};
  for (const dimension of BUILTIN_DIMENSIONS) {
    const value = checkedSubtract(left[dimension] ?? 0, right[dimension] ?? 0, dimension);
    if (value !== 0) result[dimension] = value;
  }
  const externalUnits: Record<string, number> = {};
  for (const dimension of new Set([...Object.keys(left.externalUnits ?? {}), ...Object.keys(right.externalUnits ?? {})])) {
    const value = checkedSubtract(left.externalUnits?.[dimension] ?? 0, right.externalUnits?.[dimension] ?? 0, `externalUnits.${dimension}`);
    if (value !== 0) externalUnits[dimension] = value;
  }
  if (Object.keys(externalUnits).length > 0) result.externalUnits = externalUnits;
  return compact(result);
}

export function budgetVectorFits(requiredInput: BudgetVector, availableInput: BudgetVector): boolean {
  const required = BudgetVectorSchema.parse(requiredInput);
  const available = BudgetVectorSchema.parse(availableInput);
  for (const dimension of BUILTIN_DIMENSIONS) {
    if ((required[dimension] ?? 0) > (available[dimension] ?? 0)) return false;
  }
  return Object.entries(required.externalUnits ?? {}).every(
    ([dimension, value]) => value <= (available.externalUnits?.[dimension] ?? 0),
  );
}

export function isZeroBudgetVector(input: BudgetVector): boolean {
  return Object.keys(compact(BudgetVectorSchema.parse(input))).length === 0;
}

export function sumBudgetVectors(inputs: readonly BudgetVector[]): BudgetVector {
  return inputs.reduce<BudgetVector>((total, value) => addBudgetVectors(total, value), {});
}
