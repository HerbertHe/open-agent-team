import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "./loader";
import { TeamFileSchema } from "./schema";

function team(extraction?: Record<string, unknown>, access?: Record<string, unknown>) {
  return {
    model: "default",
    providers: { openai: { compatible_type: "openai", base_url: "https://api.example/v1", api_key: "secret" } },
    project: { name: "extraction-config", repo: ".", base_branch: "main" },
    models: { default: "openai/chat-model", extractor: "openai/fact-model" },
    memory: extraction || access ? { ...(extraction ? { extraction } : {}), ...(access ? { access } : {}) } : undefined,
    admin: { name: "admin", description: "Admin", prompt: "Admin prompt", skills: [] },
    teams: [{ name: "team", branch_prefix: "team", leader: { name: "team-lead", description: "Lead", prompt: "Lead prompt", skills: [], repos: [] }, worker: { total: 1, prompt: "Worker prompt", extra_skills: [], skill_sync: "inherit_and_inject_on_spawn" } }],
  };
}

test("M11 config resolves the dedicated extraction model alias and applies bounded defaults", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-extraction-config-"));
  const file = path.join(root, "team.json");
  writeFileSync(file, JSON.stringify(team({ enabled: true, model: "extractor" })), "utf8");
  try {
    const config = await loadConfig(file);
    assert.equal(config.memory.extraction.enabled, true);
    assert.equal(config.memory.extraction.model, "openai/fact-model");
    assert.equal(config.memory.extraction.version, "m11-v1");
    assert.equal(config.memory.extraction.timeoutMs, 15_000);
    assert.equal(config.memory.extraction.maxFactsPerEvent, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M13 config defaults Leader project grants to empty and deduplicates explicit team grants", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-access-config-"));
  const file = path.join(root, "team.json");
  writeFileSync(file, JSON.stringify(team(undefined, { leaderProjectScopeTeams: ["team", "team"] })), "utf8");
  try {
    const config = await loadConfig(file);
    assert.deepEqual(config.memory.access?.leaderProjectScopeTeams, ["team"]);
    assert.deepEqual(TeamFileSchema.parse(team(undefined, {})).memory?.access?.leaderProjectScopeTeams, []);
    assert.throws(() => TeamFileSchema.parse(team(undefined, { leaderProjectScopeTeams: [""] })));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M13 config rejects grants for unknown teams", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-access-unknown-"));
  const file = path.join(root, "team.json");
  writeFileSync(file, JSON.stringify(team(undefined, { leaderProjectScopeTeams: ["missing"] })), "utf8");
  try { await assert.rejects(() => loadConfig(file), /unknown teams: missing/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("M11 config defaults extraction off and rejects unbounded values", () => {
  const parsed = TeamFileSchema.parse(team());
  assert.equal(parsed.memory, undefined);
  assert.throws(() => TeamFileSchema.parse(team({ enabled: true, model: "extractor", maxFactsPerEvent: 21 })));
  assert.throws(() => TeamFileSchema.parse(team({ enabled: true, model: "extractor", timeoutMs: 99 })));
});
