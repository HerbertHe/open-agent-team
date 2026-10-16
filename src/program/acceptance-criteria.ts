import { z } from "zod";

const CriterionIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const Common = { id: CriterionIdSchema };

export const AcceptanceCriterionSchema = z.discriminatedUnion("type", [
  z.object({ ...Common, type: z.literal("command_exit_zero"), command: z.string().trim().min(1).max(10_000), timeoutSeconds: z.number().int().positive().max(86_400) }).strict(),
  z.object({ ...Common, type: z.literal("file_exists"), path: z.string().trim().min(1).max(4_096), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ ...Common, type: z.literal("schema_valid"), artifact: z.string().trim().min(1), schemaRef: z.string().trim().min(1) }).strict(),
  z.object({ ...Common, type: z.literal("test_report"), path: z.string().trim().min(1), minimumPassed: z.number().int().nonnegative(), maximumFailed: z.number().int().nonnegative() }).strict(),
  z.object({ ...Common, type: z.literal("metric_threshold"), metric: z.string().trim().min(1), operator: z.enum([">=", "<="]), value: z.number().finite() }).strict(),
  z.object({ ...Common, type: z.literal("external_state"), adapter: z.string().trim().min(1), predicate: z.string().trim().min(1) }).strict(),
  z.object({ ...Common, type: z.literal("human_approval"), approvalPolicyId: CriterionIdSchema }).strict(),
  z.object({ ...Common, type: z.literal("llm_judge"), rubricId: CriterionIdSchema, minimumScore: z.number().min(0).max(1), requiresCorroboration: z.literal(true) }).strict(),
]);
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type AcceptanceCriterionType = AcceptanceCriterion["type"];

export const VerificationEvidenceSchema = z.object({
  passed: z.boolean(),
  validatorVersion: z.string().trim().min(1).max(128),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  gitSha: z.string().regex(/^[a-f0-9]{7,64}$/).optional(),
  evidencePath: z.string().trim().min(1).max(4_096).optional(),
  details: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

export type CriterionVerifier<T extends AcceptanceCriterion = AcceptanceCriterion> =
  (criterion: T, input: { workspacePath: string; signal?: AbortSignal }) => Promise<VerificationEvidence>;

export class AcceptanceValidatorRegistry {
  private readonly entries = new Map<AcceptanceCriterionType, { version: string; verifier: CriterionVerifier }>();
  versionFor(type: AcceptanceCriterionType): string | undefined { return this.entries.get(type)?.version; }

  register(type: AcceptanceCriterionType, version: string, verifier: CriterionVerifier): void {
    if (this.entries.has(type)) throw new Error(`Acceptance validator ${type} is already registered`);
    if (!version.trim()) throw new Error("Validator version is required");
    this.entries.set(type, { version, verifier });
  }

  async verify(criterionInput: AcceptanceCriterion, input: { workspacePath: string; signal?: AbortSignal }): Promise<VerificationEvidence> {
    const criterion = AcceptanceCriterionSchema.parse(criterionInput);
    const entry = this.entries.get(criterion.type);
    if (!entry) throw new Error(`No acceptance validator registered for ${criterion.type}`);
    const evidence = VerificationEvidenceSchema.parse(await entry.verifier(criterion, input));
    if (evidence.validatorVersion !== entry.version) throw new Error(`Validator ${criterion.type} returned an unexpected version`);
    return evidence;
  }
}

export function acceptanceCriteriaAreSufficient(criteriaInput: readonly AcceptanceCriterion[]): boolean {
  const criteria = criteriaInput.map((criterion) => AcceptanceCriterionSchema.parse(criterion));
  if (criteria.length === 0) return false;
  if (!criteria.some((criterion) => criterion.type === "llm_judge")) return true;
  return criteria.some((criterion) => criterion.type !== "llm_judge");
}
