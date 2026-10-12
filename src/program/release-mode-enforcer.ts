import type { BudgetExecutionPreflightResult } from "../budget/hard-mode-preflight";
import type { ExecutionDatabase } from "./execution-database";
import { createHash } from "node:crypto";

export class ReleaseModeBlockedError extends Error {
  readonly code = "RELEASE_MODE_BLOCKED";
  constructor(readonly blockers: string[]) { super(`Budget execution release mode is blocked: ${blockers.join(",")}`); this.name = "ReleaseModeBlockedError"; }
}

function latestGate(input: { stage: "shadow" | "hard"; handle: ExecutionDatabase }): string[] {
  const blockers: string[] = [];
  const gate = input.handle.connection.prepare("SELECT id,stage,status,evidence_json,blockers_json,digest,created_at FROM release_gate_records WHERE stage=? ORDER BY created_at DESC,id DESC LIMIT 1").get(input.stage) as { id: string; stage: "shadow" | "hard"; status: "passed" | "blocked"; evidence_json: string; blockers_json: string; digest: string; created_at: string } | undefined;
  if (gate?.status !== "passed") blockers.push(`${input.stage.toUpperCase()}_RELEASE_GATE_NOT_PASSED`);
  if (gate) {
    const body = { id: gate.id, stage: gate.stage, status: gate.status, blockers: JSON.parse(gate.blockers_json), evidence: JSON.parse(gate.evidence_json), createdAt: gate.created_at };
    if (createHash("sha256").update(JSON.stringify(body)).digest("hex") !== gate.digest) blockers.push(`${input.stage.toUpperCase()}_RELEASE_GATE_DIGEST_INVALID`);
  }
  return blockers;
}

/** Shadow collects evidence; Soft requires a passed Shadow gate; Hard requires its final gate and live preflight. */
export function assertConfiguredReleaseMode(input: {
  mode: "shadow" | "soft" | "hard";
  handle: ExecutionDatabase;
  preflight: BudgetExecutionPreflightResult;
}): void {
  if (input.mode === "shadow") return;
  const blockers = latestGate({ stage: input.mode === "soft" ? "shadow" : "hard", handle: input.handle });
  if (input.mode === "soft") { if (blockers.length) throw new ReleaseModeBlockedError(blockers); return; }
  if (input.preflight.status !== "ready" || input.preflight.effectiveMode !== "hard" || !input.preflight.hardGuaranteeActive) blockers.push("HARD_PREFLIGHT_REJECTED");
  if (blockers.length) throw new ReleaseModeBlockedError(blockers);
}
