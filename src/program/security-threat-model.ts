import { createHash } from "node:crypto";
import type { ExecutionDatabase } from "./execution-database";

export type ThreatId = "prompt_injection" | "budget_escalation" | "snapshot_secret_leak" | "stale_fencing_token" | "permission_bypass";
export interface ThreatFinding { id: ThreatId; severity: "medium" | "high" | "critical"; status: "open" | "mitigated" | "accepted"; controlRefs: string[]; note: string }
export interface ThreatModelReview { id: string; reviewer: string; findings: ThreatFinding[]; passedSoft: boolean; passedHard: boolean; digest: string; createdAt: string }
const REQUIRED: ThreatId[] = ["prompt_injection", "budget_escalation", "snapshot_secret_leak", "stale_fencing_token", "permission_bypass"];

export function reviewThreatModel(input: { id: string; reviewer: string; findings: ThreatFinding[]; createdAt: string }): ThreatModelReview {
  if (!input.reviewer.trim()) throw new Error("THREAT_REVIEWER_REQUIRED");
  const byId = new Map(input.findings.map((finding) => [finding.id, finding]));
  if (byId.size !== input.findings.length || REQUIRED.some((id) => !byId.has(id))) throw new Error("THREAT_REVIEW_INCOMPLETE");
  for (const finding of input.findings) if (finding.status === "mitigated" && finding.controlRefs.length === 0) throw new Error(`THREAT_CONTROL_EVIDENCE_REQUIRED:${finding.id}`);
  const openHigh = input.findings.some((finding) => finding.status !== "mitigated" && (finding.severity === "high" || finding.severity === "critical"));
  const acceptedHigh = input.findings.some((finding) => finding.status === "accepted" && (finding.severity === "high" || finding.severity === "critical"));
  const body = { ...input, createdAt: new Date(input.createdAt).toISOString(), passedSoft: !openHigh, passedHard: !openHigh && !acceptedHigh && input.findings.every((finding) => finding.status === "mitigated") };
  return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

export function persistThreatReview(handle: ExecutionDatabase, review: ThreatModelReview): void {
  handle.connection.prepare("INSERT INTO threat_model_reviews(id,reviewer,findings_json,passed_soft,passed_hard,digest,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(review.id, review.reviewer, JSON.stringify(review.findings), Number(review.passedSoft), Number(review.passedHard), review.digest, review.createdAt);
}
