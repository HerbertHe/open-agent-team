import { createHash } from "node:crypto";
import type { LongHorizonSimulationResult } from "./long-horizon-simulator";

export function canonicalSimulationJson(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])) : item;
  return JSON.stringify(canonical(value));
}

export function integratedEvidenceDigest(result: LongHorizonSimulationResult): string {
  return createHash("sha256").update(canonicalSimulationJson({
    seed: result.seed, virtualDays: result.virtualDays, programs: result.programs, events: result.events, invariants: result.invariants,
    runnerVersion: result.integration?.runnerVersion, measurements: result.integration?.measurements, faults: result.integration?.faults,
  })).digest("hex");
}

/** Validates a trusted local runner report. A digest detects corruption; it is not Provider attestation. */
export function hasIntegratedSimulationEvidence(result: LongHorizonSimulationResult): boolean {
  const proof = result.integration; const m = proof?.measurements;
  if (!proof || !m || !Array.isArray(proof.faults) || !result.events || result.evidenceLevel !== "integrated" || proof.runnerVersion !== 1 || !result.passed || !Number.isInteger(result.virtualDays) || result.virtualDays < 90 || result.virtualDays > 366 ||
      !Number.isInteger(result.programs) || result.programs < 2 || result.programs > 16 || proof.digest !== integratedEvidenceDigest(result)) return false;
  const invariantNames = ["budgetOverrun", "duplicateExternalEffects", "staleFencingExternalEffects", "lateEventAdvancedState", "snapshotSecretLeak", "resumeWithoutPreflight", "unexplainedProgramsAfterRestart"];
  if (Object.values(result.invariants ?? {}).some((value) => value !== 0) || !invariantNames.every((key) => result.invariants?.[key as keyof typeof result.invariants] === 0)) return false;
  if (Object.values(m).some((value) => !Number.isSafeInteger(value) || value < 0)) return false;
  if (m.openAlerts !== 0 || m.unresolvedReservations !== 0 || m.programs !== result.programs || m.completedPrograms !== result.programs || m.closeouts !== result.programs ||
      !(m.evidence! >= result.programs * 4 && m.effects! >= result.programs * 4 && m.spendEvents! > 0 && m.wakeups! > 0 && m.snapshots! > 0 && m.resumes! > 0 && m.replans! > 0)) return false;
  const faults = ["reservation_after_account_update", "dispatch_after_provider_accept", "settlement_before_commit", "lease_after_acquire", "snapshot_after_manifest", "resume_after_epoch_increment"];
  return faults.every((point) => proof.faults.includes(point)) && ["restarts", "clockRollbacks", "priceChanges", "approvalDelays", "backupRestores", "staleFencingProbes", "effectReplayProbes", "snapshotSecretProbes", "provider429", "provider500", "provider402"].every((key) => Number.isSafeInteger(result.events[key]) && result.events[key]! > 0);
}
