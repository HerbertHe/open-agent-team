import assert from "node:assert/strict";
import test from "node:test";
import {
  BudgetArithmeticError,
  addBudgetVectors,
  budgetVectorFits,
  isZeroBudgetVector,
  subtractBudgetVectors,
} from "./budget-types";

test("BLH-011 BudgetVector arithmetic is dimension-wise and canonical", () => {
  const total = addBudgetVectors(
    { moneyMicros: 10, inputTokens: 20, externalUnits: { search: 2 } },
    { moneyMicros: 3, outputTokens: 4, externalUnits: { search: 1, browser: 2 } },
  );
  assert.deepEqual(total, {
    moneyMicros: 13, inputTokens: 20, outputTokens: 4,
    externalUnits: { browser: 2, search: 3 },
  });
  assert.deepEqual(subtractBudgetVectors(total, {
    moneyMicros: 3, outputTokens: 4, externalUnits: { browser: 2 },
  }), { moneyMicros: 10, inputTokens: 20, externalUnits: { search: 3 } });
  assert.equal(budgetVectorFits({ inputTokens: 20 }, total), true);
  assert.equal(budgetVectorFits({ modelCalls: 1 }, total), false);
  assert.equal(isZeroBudgetVector({ moneyMicros: 0, externalUnits: { search: 0 } }), true);
});

test("BLH-011 BudgetVector arithmetic rejects underflow and safe-integer overflow", () => {
  assert.throws(() => subtractBudgetVectors({}, { toolCalls: 1 }), (error) =>
    error instanceof BudgetArithmeticError && error.code === "BUDGET_UNDERFLOW" && error.dimension === "toolCalls");
  assert.throws(() => addBudgetVectors({ moneyMicros: Number.MAX_SAFE_INTEGER }, { moneyMicros: 1 }), (error) =>
    error instanceof BudgetArithmeticError && error.code === "BUDGET_OVERFLOW");
});

test("BLH-011 deterministic property sweep preserves a + b - b = a", () => {
  for (let seed = 0; seed < 500; seed++) {
    const left = { moneyMicros: seed * 17, inputTokens: seed % 31, externalUnits: { search: seed % 7 } };
    const right = { moneyMicros: seed * 13, outputTokens: seed % 29, externalUnits: { search: seed % 5 } };
    assert.deepEqual(subtractBudgetVectors(addBudgetVectors(left, right), right), addBudgetVectors({}, left));
  }
});
