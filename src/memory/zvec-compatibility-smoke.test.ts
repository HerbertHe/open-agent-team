import assert from "node:assert/strict";
import test from "node:test";
import { runZvecCompatibilitySmoke } from "./zvec-compatibility-smoke";

test("@zvec/zvec 0.7.0 passes the OAT Node compatibility contract", (context) => {
  const report = runZvecCompatibilitySmoke();
  assert.equal(report.packageVersion, "0.7.0");
  assert.equal(report.arch, process.arch);
  assert.ok(report.nativeBindingBytes > 0);
  assert.deepEqual(report.collection, {
    batchUpsert: true,
    fetch: true,
    scalarFilter: true,
    vectorQuery: true,
    fullTextSearch: true,
    denseFtsRrf: true,
    closeReopenRecovery: true,
    explicitFlushApi: false,
  });
  context.diagnostic(`zvec-compatibility=${JSON.stringify(report)}`);
});
