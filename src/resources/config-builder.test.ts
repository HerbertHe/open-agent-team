import assert from "node:assert/strict";
import test from "node:test";
import { BaseBranchEnum, RuntimeModeEnum } from "../types";
import { buildResourceProjectConfig, validateResourceProjectConfig } from "./config-builder";

test("resource config builder emits the complete canonical schema shape", () => {
  const config = buildResourceProjectConfig({
    projectName: "payments",
    modelAlias: "default",
    modelId: "openai/gpt-5",
    baseBranch: BaseBranchEnum.Main,
    runtimeMode: RuntimeModeEnum.LocalProcess,
    teams: [{ name: "platform", responsibility: "Own the payment platform.", workers: 2 }],
  });
  assert.equal(config.model, "default");
  assert.deepEqual(config.models, { default: "openai/gpt-5" });
  assert.equal(config.teams[0].worker.total, 2);
  assert.doesNotThrow(() => validateResourceProjectConfig(config));
});

test("resource config builder rejects duplicate teams", () => {
  assert.throws(() => buildResourceProjectConfig({
    projectName: "payments",
    modelAlias: "default",
    modelId: "openai/gpt-5",
    teams: [
      { name: "platform", responsibility: "A", workers: 1 },
      { name: "platform", responsibility: "B", workers: 1 },
    ],
  }), /unique/);
});
