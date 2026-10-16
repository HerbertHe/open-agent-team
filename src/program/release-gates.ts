import { hasIntegratedSimulationEvidence } from "./simulation-evidence";
import { createHash } from "node:crypto";
import type { BudgetExecutionPreflightResult } from "../budget/hard-mode-preflight";
import type { ExecutionDatabase } from "./execution-database";
import type { LongHorizonSimulationResult } from "./long-horizon-simulator";
import type { ThreatModelReview } from "./security-threat-model";

export type ReleaseStage = "shadow" | "soft" | "hard";
export interface ReleaseGateDecision { id: string; stage: ReleaseStage; status: "passed" | "blocked"; blockers: string[]; digest: string; createdAt: string; evidence: Record<string, unknown> }

export class ReleaseGateEvaluator {
  evaluateShadow(input: { id: string; explicitProjects: number; observationDays: number; modelCalls: number; blockedCalls: number; attributableUsageRatio: number; empiricalP90Coverage: number; coverageTarget: number; threatReview: ThreatModelReview; createdAt: string }): ReleaseGateDecision {
    const blockers: string[] = [];
    if (input.explicitProjects < 1) blockers.push("NO_EXPLICIT_PROJECTS");
    if (input.observationDays < 7) blockers.push("SHADOW_OBSERVATION_TOO_SHORT");
    if (input.modelCalls < 1) blockers.push("NO_MODEL_CALL_EVIDENCE");
    if (input.blockedCalls !== 0) blockers.push("SHADOW_CHANGED_BEHAVIOR");
    if (input.attributableUsageRatio < 1) blockers.push("USAGE_NOT_FULLY_ATTRIBUTABLE");
    if (input.empiricalP90Coverage < input.coverageTarget) blockers.push("P90_COVERAGE_BELOW_TARGET");
    if (!input.threatReview.passedSoft) blockers.push("OPEN_HIGH_SECURITY_FINDING");
    return this.decision("shadow", input.id, blockers, input, input.createdAt);
  }

  evaluateSoft(input: { id: string; shadowGate: ReleaseGateDecision; observationDays: number; lowRiskPrograms: number; minimumCompletionRate: number; baselineCompletionRate: number; stopResumeDrills: number; stopResumeFailures: number; duplicateExternalEffects: number; simulation: LongHorizonSimulationResult; threatReview: ThreatModelReview; createdAt: string }): ReleaseGateDecision {
    const blockers: string[] = [];
    if (input.shadowGate.stage !== "shadow" || input.shadowGate.status !== "passed") blockers.push("SHADOW_GATE_NOT_PASSED");
    if (input.observationDays < 7) blockers.push("SOFT_OBSERVATION_TOO_SHORT");
    if (input.lowRiskPrograms < 1) blockers.push("NO_LOW_RISK_PROGRAMS");
    if (input.minimumCompletionRate <= input.baselineCompletionRate) blockers.push("MINIMUM_COMPLETION_NOT_BETTER_THAN_BASELINE");
    if (input.stopResumeDrills < 1 || input.stopResumeFailures !== 0) blockers.push("STOP_RESUME_DRILL_FAILED");
    if (input.duplicateExternalEffects !== 0) blockers.push("DUPLICATE_EXTERNAL_EFFECT");
    if (!hasIntegratedSimulationEvidence(input.simulation)) blockers.push("INTEGRATED_LONG_HORIZON_SIMULATION_REQUIRED");
    if (!input.threatReview.passedSoft) blockers.push("OPEN_HIGH_SECURITY_FINDING");
    return this.decision("soft", input.id, blockers, input, input.createdAt);
  }

  evaluateHard(input: { id: string; softGate: ReleaseGateDecision; preflight: BudgetExecutionPreflightResult; simulation: LongHorizonSimulationResult; threatReview: ThreatModelReview; invariantViolations: number; disasterRecoveryPassed: boolean; capabilityEvidenceFresh: boolean; createdAt: string }): ReleaseGateDecision {
    const blockers: string[] = [];
    if (input.softGate.stage !== "soft" || input.softGate.status !== "passed") blockers.push("SOFT_GATE_NOT_PASSED");
    if (input.preflight.status !== "ready" || input.preflight.effectiveMode !== "hard" || !input.preflight.hardGuaranteeActive) blockers.push("HARD_PREFLIGHT_REJECTED");
    if (!hasIntegratedSimulationEvidence(input.simulation)) blockers.push("INTEGRATED_LONG_HORIZON_SIMULATION_REQUIRED");
    if (!input.threatReview.passedHard) blockers.push("THREAT_REVIEW_NOT_CLOSED");
    if (input.invariantViolations !== 0) blockers.push("INVARIANT_VIOLATION");
    if (!input.disasterRecoveryPassed) blockers.push("DISASTER_RECOVERY_FAILED");
    if (!input.capabilityEvidenceFresh) blockers.push("CAPABILITY_EVIDENCE_STALE");
    return this.decision("hard", input.id, blockers, input, input.createdAt);
  }

  persist(handle: ExecutionDatabase, decision: ReleaseGateDecision): void {
    handle.connection.prepare("INSERT INTO release_gate_records(id,stage,status,evidence_json,blockers_json,digest,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(decision.id, decision.stage, decision.status, JSON.stringify(decision.evidence), JSON.stringify(decision.blockers), decision.digest, decision.createdAt);
  }

  private decision(stage: ReleaseStage, id: string, blockers: string[], evidenceInput: object, createdAtInput: string): ReleaseGateDecision {
    const createdAt = new Date(createdAtInput).toISOString();
    const evidence = JSON.parse(JSON.stringify(evidenceInput)) as Record<string, unknown>;
    const body = { id, stage, status: blockers.length ? "blocked" as const : "passed" as const, blockers, evidence, createdAt };
    return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  }
}

export class HardModeCircuitBreaker {
  private frozenReason?: string;
  evaluate(input: { hardGate: ReleaseGateDecision; preflight: BudgetExecutionPreflightResult; capabilityEvidenceFresh: boolean; invariantViolations: number }): { allowed: boolean; reason?: string } {
    if (this.frozenReason) return { allowed: false, reason: this.frozenReason };
    if (input.hardGate.stage !== "hard" || input.hardGate.status !== "passed") this.frozenReason = "HARD_GATE_NOT_PASSED";
    else if (input.preflight.status !== "ready" || input.preflight.effectiveMode !== "hard") this.frozenReason = "CAPABILITY_DEGRADED";
    else if (!input.capabilityEvidenceFresh) this.frozenReason = "CAPABILITY_EVIDENCE_STALE";
    else if (input.invariantViolations !== 0) this.frozenReason = "INVARIANT_VIOLATION";
    return this.frozenReason ? { allowed: false, reason: this.frozenReason } : { allowed: true };
  }
}
