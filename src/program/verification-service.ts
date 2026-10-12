import { createHash } from "node:crypto";
import type { ExecutionDatabase } from "./execution-database";
import { AcceptanceValidatorRegistry, acceptanceCriteriaAreSufficient, type AcceptanceCriterion, type VerificationEvidence } from "./acceptance-criteria";

export interface VerificationResult {
  passed: boolean;
  evidence: Array<VerificationEvidence & { criterionId: string; criterionType: AcceptanceCriterion["type"] }>;
}

export class VerificationService {
  constructor(private readonly handle: ExecutionDatabase, private readonly validators: AcceptanceValidatorRegistry) {}

  async verify(input: {
    programId: string;
    workPackageId: string;
    attemptId: string;
    criteria: readonly AcceptanceCriterion[];
    workspacePath: string;
    createdAt: string;
    signal?: AbortSignal;
  }): Promise<VerificationResult> {
    if (!acceptanceCriteriaAreSufficient(input.criteria)) throw new Error("INSUFFICIENT_ACCEPTANCE_CRITERIA");
    const evidence: VerificationResult["evidence"] = [];
    for (const criterion of input.criteria) {
      const result = await this.validators.verify(criterion, { workspacePath: input.workspacePath, signal: input.signal });
      if (!result.artifactDigest && !result.gitSha && criterion.type !== "human_approval" && criterion.type !== "external_state") {
        throw new Error(`EVIDENCE_NOT_BOUND:${criterion.id}`);
      }
      const item = { ...result, criterionId: criterion.id, criterionType: criterion.type };
      const insert = this.handle.connection.prepare(`INSERT INTO verification_evidence(
        id,program_id,work_package_id,attempt_id,criterion_id,criterion_type,passed,validator_version,
        artifact_digest,git_sha,evidence_path,details_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id,criterion_id) DO NOTHING`).run(
        `evidence:${createHash("sha256").update(`${input.attemptId}:${criterion.id}`).digest("hex")}`,
        input.programId, input.workPackageId, input.attemptId, criterion.id, criterion.type, Number(result.passed),
        result.validatorVersion, result.artifactDigest ?? null, result.gitSha ?? null, result.evidencePath ?? null,
        JSON.stringify(result.details), new Date(input.createdAt).toISOString(),
      );
      if (insert.changes === 0) {
        const stored = this.handle.connection.prepare(`SELECT criterion_type,passed,validator_version,artifact_digest,git_sha,evidence_path,details_json
          FROM verification_evidence WHERE attempt_id=? AND criterion_id=?`).get(input.attemptId, criterion.id) as { criterion_type: AcceptanceCriterion["type"]; passed: number; validator_version: string; artifact_digest: string | null; git_sha: string | null; evidence_path: string | null; details_json: string };
        const same = stored.criterion_type === criterion.type && Boolean(stored.passed) === result.passed && stored.validator_version === result.validatorVersion &&
          stored.artifact_digest === (result.artifactDigest ?? null) && stored.git_sha === (result.gitSha ?? null) && stored.evidence_path === (result.evidencePath ?? null) &&
          stored.details_json === JSON.stringify(result.details);
        if (!same) throw new Error(`EVIDENCE_CONFLICT:${criterion.id}`);
      }
      evidence.push(item);
    }
    const deterministicPassed = evidence.some((item) => item.criterionType !== "llm_judge" && item.passed);
    return { passed: evidence.every((item) => item.passed) && deterministicPassed, evidence };
  }
}
