import assert from "node:assert/strict";
import test from "node:test";
import { M09_G2_THRESHOLDS, runM09RetrievalEvaluation } from "./evaluation/zvec-retrieval-evaluation";

test("M09 compares all retrieval variants and enforces the deterministic G2 fixture gate", async (context) => {
  const report = await runM09RetrievalEvaluation();
  assert.equal(report.corpusSize, 10);
  assert.equal(report.queryCount, 9);
  assert.deepEqual(report.variants.map(({ variant }) => variant), ["lexical", "dense", "fts", "hybrid", "hybrid_governance"]);
  const lexical = report.variants[0]!.metrics;
  const candidate = report.variants[4]!.metrics;
  assert.ok(candidate.recallAt5 - lexical.recallAt5 >= M09_G2_THRESHOLDS.minRecallAt5Gain);
  assert.ok(candidate.chineseRecallAt5 - lexical.chineseRecallAt5 >= M09_G2_THRESHOLDS.minChineseRecallAt5Gain);
  assert.ok(candidate.paraphraseRecallAt5 - lexical.paraphraseRecallAt5 >= M09_G2_THRESHOLDS.minParaphraseRecallAt5Gain);
  assert.equal(candidate.unauthorizedHitCount, 0);
  assert.ok(candidate.errorInjectionQueryRate <= lexical.errorInjectionQueryRate);
  assert.ok(candidate.errorInjectionItemRate <= lexical.errorInjectionItemRate);
  assert.equal(report.gate.passed, true, report.gate.failures.join("; "));
  context.diagnostic(`m09-evaluation=${JSON.stringify(report)}`);
});
