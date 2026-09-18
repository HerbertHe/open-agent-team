import assert from "node:assert/strict";
import test from "node:test";
import { resolveRunnerExec } from "./local-process";

test("development Agent runner uses one direct Node child without a tsx wrapper", () => {
  const resolved = resolveRunnerExec();
  assert.equal(resolved.execPath, process.execPath);
  assert.deepEqual(resolved.execArgv, ["--import", "tsx"]);
  assert.match(resolved.runnerPath, /agent-runner\.ts$/);
});
