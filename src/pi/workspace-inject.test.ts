import assert from "node:assert/strict";
import test from "node:test";
import { AgentRoleEnum } from "../types";
import { buildAgentSystemPrompt } from "./workspace-inject";

test("all agent roles receive the dated work-process archive rule", () => {
  for (const role of [AgentRoleEnum.Admin, AgentRoleEnum.Leader, AgentRoleEnum.Worker]) {
    const prompt = buildAgentSystemPrompt({
      agentName: `test-${role}`,
      description: "test agent",
      role,
      promptText: "Base prompt",
    });

    assert.match(prompt, /records\/\d{4}-\d{2}-\d{2}\//);
    assert.match(prompt, /Archive every work-process file/);
    assert.match(prompt, /Do NOT place work-process files at the workspace root/);
    assert.match(prompt, /full date-based path/);
  }
});
