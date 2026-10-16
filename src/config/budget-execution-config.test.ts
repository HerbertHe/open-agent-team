import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "./loader";
import { TeamFileSchema } from "./schema";

function minimalTeam(budgetExecution?: unknown) {
  return {
    model: "default",
    ...(budgetExecution === undefined ? {} : { budgetExecution }),
    project: { name: "budget-config", repo: ".", base_branch: "main" },
    models: { default: "openai/test-model" },
    admin: { name: "admin", description: "Admin", prompt: "Admin prompt", skills: [] },
    teams: [{
      name: "team",
      branch_prefix: "team",
      leader: { name: "lead", description: "Lead", prompt: "Lead prompt", skills: [], repos: [] },
      worker: { total: 1, prompt: "Worker prompt", extra_skills: [] },
    }],
  };
}

test("BLH-001 schema defaults budget execution to disabled shadow mode", () => {
  const parsed = TeamFileSchema.parse(minimalTeam());
  assert.deepEqual(parsed.budgetExecution, { enabled: false, mode: "shadow" });
});

test("BLH-001 schema accepts explicit experimental modes and rejects invalid fields", () => {
  assert.deepEqual(
    TeamFileSchema.parse(minimalTeam({ enabled: true, mode: "soft" })).budgetExecution,
    { enabled: true, mode: "soft" },
  );
  assert.throws(() => TeamFileSchema.parse(minimalTeam({ enabled: true, mode: "enforced" })));
  assert.throws(() => TeamFileSchema.parse(minimalTeam({ enabled: false, mode: "shadow", surprise: true })));
});

test("BLH-001 loader resolves an omitted budget configuration without enabling services", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-budget-config-"));
  const file = path.join(root, "team.json");
  writeFileSync(file, JSON.stringify(minimalTeam()), "utf8");
  try {
    const config = await loadConfig(file);
    assert.deepEqual(config.budgetExecution, { enabled: false, mode: "shadow" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model routing requires explicit capabilities/risk and loader preserves resolved candidate aliases", async () => {
  const policy = { candidates: [{ modelRef: "default", capabilities: ["code"], maximumRisk: "high", qualityTier: 1 }], requiredCapabilities: ["code"], risk: "medium" };
  const parsed = TeamFileSchema.parse(minimalTeam({ enabled: true, modelRouting: policy }));
  assert.deepEqual(parsed.budgetExecution.modelRouting, policy);
  assert.throws(() => TeamFileSchema.parse(minimalTeam({ modelRouting: { ...policy, candidates: [{ ...policy.candidates[0], qualityTier: -1 }] } })));
  assert.throws(() => TeamFileSchema.parse(minimalTeam({ modelRouting: { ...policy, risk: undefined } })));
  const root = mkdtempSync(path.join(tmpdir(), "oat-model-routing-config-"));
  const file = path.join(root, "team.json");
  writeFileSync(file, JSON.stringify(minimalTeam({ enabled: true, modelRouting: policy })), "utf8");
  try {
    const config = await loadConfig(file);
    assert.equal(config.budgetExecution.modelRouting?.candidates[0]?.modelRef, "openai/test-model");
    assert.equal(config.budgetExecution.modelRouting?.risk, "medium");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
