import assert from "node:assert/strict";
import test from "node:test";
import { runLexicalBaseline } from "./evaluation/lexical-baseline";

test("records the deterministic lexical retrieval baseline", async (context) => {
  const baseline = await runLexicalBaseline();
  assert.equal(baseline.corpusSize, 10);
  assert.equal(baseline.queryCount, 9);
  assert.equal(baseline.evaluatedRelevantQueries, 7);
  assert.ok(Number.isFinite(baseline.p50LatencyMs));
  assert.ok(Number.isFinite(baseline.p95LatencyMs));
  assert.deepEqual(
    baseline.cases.map(({ id, selectedKeys, firstRelevantRank, forbiddenSelected }) => ({ id, selectedKeys, firstRelevantRank, forbiddenSelected })),
    // This snapshot intentionally freezes the current production lexical ranker.
    // M09 will compare alternative retrievers against it rather than weakening it.
    [
      { id: "english-exact-failure", selectedKeys: ["balance-process-retained", "migration-current", "unrelated-ui-setting", "beta-private-deployment", "worker-report-chain"], firstRelevantRank: 1, forbiddenSelected: [] },
      { id: "english-paraphrase-failure", selectedKeys: ["migration-current", "unrelated-ui-setting", "beta-private-deployment", "worker-report-chain", "hive-brand"], firstRelevantRank: undefined, forbiddenSelected: [] },
      { id: "chinese-exact-channel", selectedKeys: ["channel-default-route", "migration-current", "unrelated-ui-setting", "beta-private-deployment", "worker-report-chain"], firstRelevantRank: 1, forbiddenSelected: [] },
      { id: "chinese-paraphrase-channel", selectedKeys: ["migration-current", "unrelated-ui-setting", "beta-private-deployment", "worker-report-chain", "hive-brand"], firstRelevantRank: undefined, forbiddenSelected: [] },
      { id: "entity-release-branch", selectedKeys: ["atlas-release", "migration-current", "unrelated-ui-setting", "beta-private-deployment", "worker-report-chain"], firstRelevantRank: 1, forbiddenSelected: [] },
      { id: "failure-pattern-migration", selectedKeys: ["migration-current", "migration-obsolete", "unrelated-ui-setting", "beta-private-deployment", "worker-report-chain"], firstRelevantRank: 1, forbiddenSelected: ["migration-obsolete"] },
      { id: "temporal-conflict", selectedKeys: ["migration-current", "unrelated-ui-setting", "beta-private-deployment", "worker-report-chain", "hive-brand"], firstRelevantRank: 1, forbiddenSelected: [] },
      { id: "leader-scope-isolation", selectedKeys: ["worker-report-chain"], firstRelevantRank: undefined, forbiddenSelected: [] },
      { id: "no-result", selectedKeys: ["migration-current", "unrelated-ui-setting", "beta-private-deployment", "worker-report-chain", "hive-brand"], firstRelevantRank: undefined, forbiddenSelected: ["migration-current", "unrelated-ui-setting", "beta-private-deployment", "worker-report-chain", "hive-brand"] },
    ],
  );
  assert.equal(baseline.recallAt5, .7143);
  assert.equal(baseline.meanReciprocalRank, .7143);
  assert.equal(baseline.errorInjectionQueryRate, .2222);
  assert.equal(baseline.errorInjectionItemRate, .1463);
  context.diagnostic(`lexical-baseline=${JSON.stringify(baseline)}`);
});
