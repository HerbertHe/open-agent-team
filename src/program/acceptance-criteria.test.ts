import assert from "node:assert/strict";
import test from "node:test";
import {
  AcceptanceCriterionSchema,
  AcceptanceValidatorRegistry,
  acceptanceCriteriaAreSufficient,
} from "./acceptance-criteria";

test("BLH-021 typed criteria are strict and LLM-only evidence is insufficient", async () => {
  const command = AcceptanceCriterionSchema.parse({
    id: "tests", type: "command_exit_zero", command: "pnpm test", timeoutSeconds: 60,
  });
  const judge = AcceptanceCriterionSchema.parse({
    id: "judge", type: "llm_judge", rubricId: "quality", minimumScore: 0.9, requiresCorroboration: true,
  });
  assert.equal(acceptanceCriteriaAreSufficient([judge]), false);
  assert.equal(acceptanceCriteriaAreSufficient([judge, command]), true);
  assert.throws(() => AcceptanceCriterionSchema.parse({ ...command, surprise: true }));

  const registry = new AcceptanceValidatorRegistry();
  registry.register("command_exit_zero", "command-v1", async () => ({
    passed: true, validatorVersion: "command-v1", details: { exitCode: 0 },
  }));
  assert.equal((await registry.verify(command, { workspacePath: "/tmp" })).passed, true);
  assert.rejects(() => registry.verify(judge, { workspacePath: "/tmp" }), /No acceptance validator/);
});
