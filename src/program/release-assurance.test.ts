import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderCompatibleTypeEnum } from "../types";
import { evaluateBudgetExecutionPreflight } from "../budget/hard-mode-preflight";
import { applyProviderCapabilityEvidence, createConservativeProviderBudgetCapabilityProfile } from "../budget/provider-budget-capability";
import { fullyVerifiedProviderEvidence } from "../budget/fixtures/provider-budget-capability";
import { PI_RUNTIME_HOOK_COVERAGE } from "../sandbox/runtime-hook-capability";
import { openExecutionDatabase } from "./execution-database";
import { migrateExecutionDatabase } from "./execution-migrations";
import { LongHorizonSimulator, VirtualClock } from "./long-horizon-simulator";
import { HardModeCircuitBreaker, ReleaseGateEvaluator } from "./release-gates";
import { assertConfiguredReleaseMode, ReleaseModeBlockedError } from "./release-mode-enforcer";
import { persistThreatReview, reviewThreatModel, type ThreatFinding } from "./security-threat-model";

const NOW = "2026-10-10T00:00:00.000Z";
const mitigated: ThreatFinding[] = [
  { id: "prompt_injection", severity: "high", status: "mitigated", controlRefs: ["tool-guard"], note: "structured controls only" },
  { id: "budget_escalation", severity: "critical", status: "mitigated", controlRefs: ["budget-ledger"], note: "prompt cannot mutate limits" },
  { id: "snapshot_secret_leak", severity: "critical", status: "mitigated", controlRefs: ["snapshot-store"], note: "deny paths and digest" },
  { id: "stale_fencing_token", severity: "high", status: "mitigated", controlRefs: ["execution-barrier"], note: "epoch and fencing" },
  { id: "permission_bypass", severity: "high", status: "mitigated", controlRefs: ["tool-guard"], note: "permission check" },
];

function hardPreflight() {
  const base = createConservativeProviderBudgetCapabilityProfile("provider", { compatible_type: ProviderCompatibleTypeEnum.OpenAI }, NOW);
  const provider = applyProviderCapabilityEvidence(base, fullyVerifiedProviderEvidence, NOW);
  return evaluateBudgetExecutionPreflight({ config: { enabled: true, mode: "hard" }, selectedProviderIds: ["provider"], providerProfiles: { provider }, runtimeCapabilities: PI_RUNTIME_HOOK_COVERAGE.map((item) => ({ ...item, support: "supported" as const })) });
}

test("BLH-051 90-day virtual simulation is fast, reproducible and covers disruptions", () => {
  const simulator = new LongHorizonSimulator(); const first = simulator.run({ seed: "release-seed", days: 90, programs: 6 });
  const second = simulator.run({ seed: "release-seed", days: 90, programs: 6 }); const different = simulator.run({ seed: "other-seed", days: 90, programs: 6 });
  assert.deepEqual(first, second); assert.notEqual(first.traceDigest, different.traceDigest); assert.equal(first.passed, true);
  assert.ok(first.events.restarts > 0); assert.ok(first.events.clockRollbacks > 0); assert.ok(first.events.priceChanges > 0); assert.ok(first.events.approvalDelays > 0);
  assert.ok(first.events.workerDisappearances > 0); assert.ok(first.events.promptInjectionBlocked > 0); assert.ok(first.events.backupRestores > 0); assert.ok(first.events.migrationCrashes > 0);
  const clock = new VirtualClock(NOW); clock.advance(10_000); const logical = clock.logicalNow(); clock.rollback(20_000); assert.equal(clock.logicalNow(), logical);
});

test("BLH-052 open high-risk findings block soft and hard", () => {
  const findings = mitigated.map((item) => item.id === "prompt_injection" ? { ...item, status: "open" as const } : item);
  const review = reviewThreatModel({ id: "threat-open", reviewer: "security", findings, createdAt: NOW });
  assert.equal(review.passedSoft, false); assert.equal(review.passedHard, false);
  assert.throws(() => reviewThreatModel({ id: "missing", reviewer: "security", findings: findings.slice(1), createdAt: NOW }), /INCOMPLETE/);
});

test("BLH-053/054/055 release gates require evidence and persist immutable decisions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-gates-")); const handle = openExecutionDatabase(root); migrateExecutionDatabase(handle, { appliedAt: NOW });
  try {
    const simulation = { ...new LongHorizonSimulator().run({ seed: "gate", days: 90, programs: 4 }), evidenceLevel: "integrated" as const };
    new LongHorizonSimulator().persist(handle, "sim-1", simulation, NOW);
    const threat = reviewThreatModel({ id: "threat-1", reviewer: "security", findings: mitigated, createdAt: NOW }); persistThreatReview(handle, threat);
    const gates = new ReleaseGateEvaluator();
    const shadow = gates.evaluateShadow({ id: "gate-shadow", explicitProjects: 2, observationDays: 7, modelCalls: 1000, blockedCalls: 0, attributableUsageRatio: 1, empiricalP90Coverage: 0.93, coverageTarget: 0.9, threatReview: threat, createdAt: NOW });
    const synthetic = new LongHorizonSimulator().run({ seed: "synthetic", days: 90, programs: 4 });
    assert.equal(gates.evaluateSoft({ id: "synthetic-soft", shadowGate: shadow, observationDays: 7, lowRiskPrograms: 1, minimumCompletionRate: 1, baselineCompletionRate: 0, stopResumeDrills: 1, stopResumeFailures: 0, duplicateExternalEffects: 0, simulation: synthetic, threatReview: threat, createdAt: NOW }).status, "blocked");
    const soft = gates.evaluateSoft({ id: "gate-soft", shadowGate: shadow, observationDays: 7, lowRiskPrograms: 5, minimumCompletionRate: 0.9, baselineCompletionRate: 0.7, stopResumeDrills: 5, stopResumeFailures: 0, duplicateExternalEffects: 0, simulation, threatReview: threat, createdAt: NOW });
    const hard = gates.evaluateHard({ id: "gate-hard", softGate: soft, preflight: hardPreflight(), simulation, threatReview: threat, invariantViolations: 0, disasterRecoveryPassed: true, capabilityEvidenceFresh: true, createdAt: NOW });
    assert.equal(shadow.status, "passed"); assert.equal(soft.status, "passed"); assert.equal(hard.status, "passed");
    gates.persist(handle, shadow); gates.persist(handle, soft); gates.persist(handle, hard);
    assert.doesNotThrow(() => assertConfiguredReleaseMode({ mode: "soft", handle, preflight: hardPreflight() }));
    assert.equal(handle.connection.prepare("SELECT COUNT(*) FROM release_gate_records").pluck().get(), 3);
    assert.throws(() => handle.connection.prepare("UPDATE release_gate_records SET status='blocked' WHERE id='gate-hard'").run(), /append-only/);
    const blocked = gates.evaluateShadow({ id: "no-evidence", explicitProjects: 0, observationDays: 0, modelCalls: 0, blockedCalls: 0, attributableUsageRatio: 0, empiricalP90Coverage: 0, coverageTarget: 0.9, threatReview: threat, createdAt: NOW });
    assert.equal(blocked.status, "blocked"); assert.ok(blocked.blockers.includes("SHADOW_OBSERVATION_TOO_SHORT"));
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});

test("BLH-055 capability degradation immediately freezes new hard calls", () => {
  const simulation = { ...new LongHorizonSimulator().run({ seed: "breaker", days: 90, programs: 2 }), evidenceLevel: "integrated" as const }; const threat = reviewThreatModel({ id: "threat", reviewer: "security", findings: mitigated, createdAt: NOW });
  const gates = new ReleaseGateEvaluator(); const passedSoft = gates.evaluateSoft({ id: "soft", shadowGate: gates.evaluateShadow({ id: "shadow", explicitProjects: 1, observationDays: 7, modelCalls: 1, blockedCalls: 0, attributableUsageRatio: 1, empiricalP90Coverage: 1, coverageTarget: 0.9, threatReview: threat, createdAt: NOW }), observationDays: 7, lowRiskPrograms: 1, minimumCompletionRate: 1, baselineCompletionRate: 0, stopResumeDrills: 1, stopResumeFailures: 0, duplicateExternalEffects: 0, simulation, threatReview: threat, createdAt: NOW });
  const hard = gates.evaluateHard({ id: "hard", softGate: passedSoft, preflight: hardPreflight(), simulation, threatReview: threat, invariantViolations: 0, disasterRecoveryPassed: true, capabilityEvidenceFresh: true, createdAt: NOW });
  const breaker = new HardModeCircuitBreaker(); assert.equal(breaker.evaluate({ hardGate: hard, preflight: hardPreflight(), capabilityEvidenceFresh: true, invariantViolations: 0 }).allowed, true);
  const degraded = evaluateBudgetExecutionPreflight({ config: { enabled: true, mode: "hard" }, selectedProviderIds: [], providerProfiles: {} });
  assert.deepEqual(breaker.evaluate({ hardGate: hard, preflight: degraded, capabilityEvidenceFresh: true, invariantViolations: 0 }), { allowed: false, reason: "CAPABILITY_DEGRADED" });
  assert.equal(breaker.evaluate({ hardGate: hard, preflight: hardPreflight(), capabilityEvidenceFresh: true, invariantViolations: 0 }).allowed, false);
});

test("BLH-055 startup cannot bypass a missing hard release gate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hard-startup-")); const handle = openExecutionDatabase(root); migrateExecutionDatabase(handle, { appliedAt: NOW });
  try {
    assert.throws(() => assertConfiguredReleaseMode({ mode: "hard", handle, preflight: hardPreflight() }), ReleaseModeBlockedError);
    assert.throws(() => assertConfiguredReleaseMode({ mode: "soft", handle, preflight: hardPreflight() }), (error) => error instanceof ReleaseModeBlockedError && error.blockers.includes("SHADOW_RELEASE_GATE_NOT_PASSED"));
    handle.connection.prepare("INSERT INTO release_gate_records(id,stage,status,evidence_json,blockers_json,digest,created_at) VALUES('forged','hard','passed','{}','[]','forged',?)").run(NOW);
    assert.throws(() => assertConfiguredReleaseMode({ mode: "hard", handle, preflight: hardPreflight() }), (error) => error instanceof ReleaseModeBlockedError && error.blockers.includes("HARD_RELEASE_GATE_DIGEST_INVALID"));
    assert.doesNotThrow(() => assertConfiguredReleaseMode({ mode: "shadow", handle, preflight: hardPreflight() }));
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
});
