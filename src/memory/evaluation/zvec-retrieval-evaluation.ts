import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseGlobalModelCatalog } from "../../models/global-models";
import { AgentRoleEnum } from "../../types/enums";
import { DeterministicFakeEmbeddingProvider, type EmbeddingProvider } from "../embedding-provider";
import { MemoryIndexWorker } from "../memory-index-worker";
import { projectAgentActor } from "../memory-policy";
import { SqliteMemoryRepository, type AuthorizedMemoryInput } from "../memory-repository";
import { LexicalMemoryRetriever } from "../memory-retriever";
import type { MemoryRecord } from "../types";
import { createZvecIndexManifest } from "../zvec-index-identity";
import { createZvecIndexLayout } from "../zvec-index-registry";
import { ZvecMemoryIndex, ZvecMemoryIndexWorkerHost } from "../zvec-memory-index";
import {
  buildZvecMemoryAuthorizationFilter,
  extractExactMemoryTerms,
  governMemoryCandidates,
  reciprocalRankFusion,
  ZVEC_RETRIEVAL_TUNING,
} from "../zvec-shadow-memory-index";
import { BASELINE_CORPUS, BASELINE_QUERIES, type BaselineQuery } from "./baseline-fixtures";

export type RetrievalEvaluationVariant = "lexical" | "dense" | "fts" | "hybrid" | "hybrid_governance";

export type RetrievalEvaluationCase = {
  id: string;
  selectedKeys: string[];
  firstRelevantRank?: number;
  forbiddenSelected: string[];
  unauthorizedSelected: string[];
  latencyMs: number;
  estimatedPromptTokens: number;
};

export type RetrievalEvaluationMetrics = {
  recallAt5: number;
  meanReciprocalRank: number;
  chineseRecallAt5: number;
  paraphraseRecallAt5: number;
  errorInjectionQueryRate: number;
  errorInjectionItemRate: number;
  unauthorizedHitCount: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  averagePromptTokens: number;
  totalPromptTokens: number;
};

export type RetrievalVariantResult = {
  variant: RetrievalEvaluationVariant;
  metrics: RetrievalEvaluationMetrics;
  cases: RetrievalEvaluationCase[];
};

export const M09_G2_THRESHOLDS = Object.freeze({
  minRecallAt5Gain: 0.2,
  minChineseRecallAt5Gain: 0.4,
  minParaphraseRecallAt5Gain: 0.5,
  maxP95LatencyMs: 100,
  maxPromptTokenRatio: 1.25,
  maxUnauthorizedHits: 0,
});

export type M09GateResult = {
  passed: boolean;
  candidate: "hybrid_governance";
  thresholds: typeof M09_G2_THRESHOLDS;
  failures: string[];
};

export type M09EvaluationReport = {
  corpusSize: number;
  queryCount: number;
  embeddingFixture: string;
  tuning: typeof ZVEC_RETRIEVAL_TUNING;
  variants: RetrievalVariantResult[];
  gate: M09GateResult;
};

const EVALUATION_NOW = new Date("2026-09-10T12:00:00.000Z");
const RESULT_LIMIT = 5;
const CANDIDATE_LIMIT = 30;

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function estimateTokens(memories: MemoryRecord[]): number {
  return memories.reduce((total, memory) => {
    const text = memory.summary;
    const cjk = (text.match(/[\u3400-\u9fff]/gu) ?? []).length;
    return total + cjk + Math.ceil(Math.max(0, [...text].length - cjk) / 4) + 6;
  }, 0);
}

const SEMANTIC_CONCEPTS: RegExp[] = [
  /402|insufficient|balance|credit|exhausted|模型额度|余额/iu,
  /微信|通道|资源主管|聊天账号|未绑定|没有分配|接收/iu,
  /数据库|迁移|advisory|schema|并发执行|获取锁/iu,
  /atlas|release\/atlas|发布分支|集成测试/iu,
  /pi 插件|docker|隔离环境|本地进程/iu,
  /蜂巢|工蜂|蓝灰|来回飞行/iu,
  /worker|leader|admin|汇报|报告/iu,
  /orion|beta|私有部署|部署凭据/iu,
  /日志|desktop|全局设置|子菜单/iu,
];

function semanticVector(text: string): number[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const vector = Array<number>(SEMANTIC_CONCEPTS.length + 1).fill(0);
  SEMANTIC_CONCEPTS.forEach((pattern, index) => { if (pattern.test(normalized)) vector[index] = 1; });
  if (!vector.some(Boolean)) vector[vector.length - 1] = 1;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

function evaluationProvider(): { provider: EmbeddingProvider; profile: ReturnType<typeof parseGlobalModelCatalog>["embeddingProfiles"][string] } {
  const catalog = parseGlobalModelCatalog({
    embeddingProfiles: {
      evaluation: {
        kind: "deterministic-fake",
        model: "m09-semantic-fixture-v1",
        dimensions: SEMANTIC_CONCEPTS.length + 1,
        normalization: "l2",
        revision: "1",
      },
    },
  });
  const profile = catalog.embeddingProfiles.evaluation!;
  if (profile.kind !== "deterministic-fake") throw new Error("M09 fixture profile must be deterministic.");
  const identity = new DeterministicFakeEmbeddingProvider(profile).identity;
  const provider: EmbeddingProvider = {
    available: true,
    identity,
    embedDocuments: async (texts) => texts.map(semanticVector),
    embedQuery: async (text) => semanticVector(text),
  };
  return { provider, profile };
}

function ownerFor(item: (typeof BASELINE_CORPUS)[number]): { owner: string; role: AgentRoleEnum; trust: number; teamId?: string } {
  if (item.role === AgentRoleEnum.Worker) return { owner: item.agentId.replace(/-worker-\d+$/, "-lead"), role: AgentRoleEnum.Leader, trust: 80, teamId: item.agentId.replace(/-worker-\d+$/, "") };
  if (item.role === AgentRoleEnum.Leader) return { owner: item.agentId, role: AgentRoleEnum.Leader, trust: 90, teamId: item.agentId.replace(/-(?:lead|leader)$/, "") };
  return { owner: item.agentId, role: AgentRoleEnum.Admin, trust: 100 };
}

function prepareCorpus(repository: SqliteMemoryRepository): Map<string, string> {
  for (const item of BASELINE_CORPUS) {
    const owner = ownerFor(item);
    const createdAt = new Date(EVALUATION_NOW.getTime() - item.ageHours * 3_600_000).toISOString();
    repository.capture({
      id: `m09-event-${item.key}`,
      ownerAgentId: owner.owner,
      sourceAgentId: item.agentId,
      role: owner.role,
      trustLevel: owner.trust,
      eventType: "report_progress",
      kind: "decision",
      content: item.content,
      metadataJson: "{}",
      createdAt,
      teamId: owner.teamId,
      fingerprint: createHash("sha256").update(item.content).digest("hex"),
    }, 50);
  }
  repository.consolidate({ maxEvents: 100, minEvidence: 100, retentionDays: 3650, l1MaxItems: 50, l1TtlHours: 100_000, isCancelled: () => false });
  const keyByContent = new Map(BASELINE_CORPUS.map((item) => [item.content, item.key]));
  return new Map(repository.list({ level: "L2", limit: 100 }).map((memory) => [memory.id, keyByContent.get(memory.content)!]));
}

function caseResult(query: BaselineQuery, memories: MemoryRecord[], keyById: Map<string, string>, latencyMs: number): RetrievalEvaluationCase {
  const selectedKeys = memories.map((memory) => keyById.get(memory.id)).filter((key): key is string => Boolean(key));
  const relevantIndex = selectedKeys.findIndex((key) => query.relevantKeys.includes(key));
  return {
    id: query.id,
    selectedKeys,
    firstRelevantRank: relevantIndex >= 0 ? relevantIndex + 1 : undefined,
    forbiddenSelected: selectedKeys.filter((key) => query.forbiddenKeys?.includes(key)),
    unauthorizedSelected: selectedKeys.filter((key) => query.unauthorizedKeys?.includes(key)),
    latencyMs: round(latencyMs),
    estimatedPromptTokens: estimateTokens(memories),
  };
}

function metrics(cases: RetrievalEvaluationCase[]): RetrievalEvaluationMetrics {
  const queryById = new Map(BASELINE_QUERIES.map((query) => [query.id, query]));
  const relevant = cases.filter((item) => queryById.get(item.id)!.relevantKeys.length > 0);
  const chinese = relevant.filter((item) => item.id.startsWith("chinese-"));
  const paraphrase = relevant.filter((item) => item.id.includes("paraphrase"));
  const selected = cases.reduce((sum, item) => sum + item.selectedKeys.length, 0);
  const forbidden = cases.reduce((sum, item) => sum + item.forbiddenSelected.length, 0);
  const promptTokens = cases.reduce((sum, item) => sum + item.estimatedPromptTokens, 0);
  const recall = (items: RetrievalEvaluationCase[]) => items.length ? items.filter((item) => item.firstRelevantRank !== undefined).length / items.length : 0;
  return {
    recallAt5: round(recall(relevant)),
    meanReciprocalRank: round(relevant.reduce((sum, item) => sum + (item.firstRelevantRank ? 1 / item.firstRelevantRank : 0), 0) / relevant.length),
    chineseRecallAt5: round(recall(chinese)),
    paraphraseRecallAt5: round(recall(paraphrase)),
    errorInjectionQueryRate: round(cases.filter((item) => item.forbiddenSelected.length > 0).length / cases.length),
    errorInjectionItemRate: round(selected ? forbidden / selected : 0),
    unauthorizedHitCount: cases.reduce((sum, item) => sum + item.unauthorizedSelected.length, 0),
    p50LatencyMs: round(percentile(cases.map((item) => item.latencyMs), 0.5)),
    p95LatencyMs: round(percentile(cases.map((item) => item.latencyMs), 0.95)),
    averagePromptTokens: round(promptTokens / cases.length, 2),
    totalPromptTokens: promptTokens,
  };
}

function evaluateGate(lexical: RetrievalEvaluationMetrics, candidate: RetrievalEvaluationMetrics): M09GateResult {
  const failures: string[] = [];
  if (candidate.recallAt5 - lexical.recallAt5 < M09_G2_THRESHOLDS.minRecallAt5Gain) failures.push("Recall@5 gain is below threshold.");
  if (candidate.chineseRecallAt5 - lexical.chineseRecallAt5 < M09_G2_THRESHOLDS.minChineseRecallAt5Gain) failures.push("Chinese Recall@5 gain is below threshold.");
  if (candidate.paraphraseRecallAt5 - lexical.paraphraseRecallAt5 < M09_G2_THRESHOLDS.minParaphraseRecallAt5Gain) failures.push("Paraphrase Recall@5 gain is below threshold.");
  if (candidate.errorInjectionQueryRate > lexical.errorInjectionQueryRate || candidate.errorInjectionItemRate > lexical.errorInjectionItemRate) failures.push("Error injection rate regressed.");
  if (candidate.unauthorizedHitCount > M09_G2_THRESHOLDS.maxUnauthorizedHits) failures.push("Unauthorized retrieval was observed.");
  if (candidate.p95LatencyMs > M09_G2_THRESHOLDS.maxP95LatencyMs) failures.push("P95 latency exceeds the fixture budget.");
  if (candidate.averagePromptTokens > lexical.averagePromptTokens * M09_G2_THRESHOLDS.maxPromptTokenRatio) failures.push("Prompt token overhead exceeds the fixture budget.");
  return { passed: failures.length === 0, candidate: "hybrid_governance", thresholds: M09_G2_THRESHOLDS, failures };
}

export async function runM09RetrievalEvaluation(): Promise<M09EvaluationReport> {
  const root = mkdtempSync(path.join(tmpdir(), "oat-m09-evaluation-"));
  const databaseFile = path.join(root, "memory", "memory.db");
  mkdirSync(path.dirname(databaseFile), { recursive: true });
  const projectId = "m09-evaluation-project";
  const repository = new SqliteMemoryRepository(projectId, databaseFile);
  const keyById = prepareCorpus(repository);
  const { provider, profile } = evaluationProvider();
  const manifest = createZvecIndexManifest({ projectId, profileName: "evaluation", profile, metric: "cosine", index: "flat", createdAt: EVALUATION_NOW.toISOString() });
  const layout = createZvecIndexLayout(path.join(root, "zvec"), projectId);
  const host = new ZvecMemoryIndexWorkerHost();
  let index: ZvecMemoryIndex | undefined;
  try {
    index = await ZvecMemoryIndex.create({ layout, manifest, workerHost: host });
    repository.registerIndexTarget({ collectionRevision: manifest.collectionRevision, projectId, embeddingRevision: manifest.embeddingRevision, state: "building", path: `collections/${manifest.collectionRevision}`, documentCount: 0, createdAt: manifest.createdAt });
    repository.enqueueIndexBackfill(manifest.collectionRevision, EVALUATION_NOW.toISOString());
    const writer = new MemoryIndexWorker({ repository, index, embeddingProvider: provider, batchSize: 64, workerId: "m09-evaluation", now: () => EVALUATION_NOW });
    const indexed = await writer.runOnce();
    if (indexed.indexed !== BASELINE_CORPUS.length) throw new Error(`M09 fixture indexed ${indexed.indexed}/${BASELINE_CORPUS.length} memories.`);

    const lexicalRetriever = new LexicalMemoryRetriever(repository);
    const variants: RetrievalVariantResult[] = [];
    for (const variant of ["lexical", "dense", "fts", "hybrid", "hybrid_governance"] as const) {
      const cases: RetrievalEvaluationCase[] = [];
      for (const query of BASELINE_QUERIES) {
        const started = performance.now();
        let selected: MemoryRecord[];
        if (variant === "lexical") {
          selected = (await lexicalRetriever.retrieve({ agentId: query.agentId, query: query.query, globalScope: query.agentId === "admin", l2MaxResults: RESULT_LIMIT, l3MaxPromptItems: RESULT_LIMIT })).l2;
        } else {
          const globalScope = query.agentId === "admin";
          const authorization: AuthorizedMemoryInput = {
            actor: projectAgentActor(projectId, query.agentId, query.agentId === "admin" && globalScope ? "admin" : undefined),
            now: EVALUATION_NOW.toISOString(),
          };
          const includeDense = variant !== "fts";
          const includeFts = variant !== "dense";
          const routes = await index.queryRoutes({
            filter: buildZvecMemoryAuthorizationFilter({ projectId, agentId: query.agentId, globalScope, nowMs: EVALUATION_NOW.getTime() }),
            matchString: includeFts ? query.query : "",
            ...(includeDense ? { denseVector: await provider.embedQuery(query.query) } : {}),
            topK: CANDIDATE_LIMIT,
          });
          if (routes.errors.length) throw new Error(`M09 ${variant}/${query.id} query failed: ${JSON.stringify(routes.errors)}`);
          const dense = includeDense ? routes.dense.filter((hit) => hit.score <= ZVEC_RETRIEVAL_TUNING.denseMaxDistance) : [];
          const fts = includeFts ? routes.fts : [];
          const exact = variant === "hybrid" || variant === "hybrid_governance"
            ? repository.findExactAuthorizedMemories(authorization, extractExactMemoryTerms(query.query), CANDIDATE_LIMIT)
            : [];
          const scores = reciprocalRankFusion([dense, fts], exact);
          const ids = [...scores].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([id]) => id);
          const authorized = repository.findAuthorizedMemories(authorization, ids);
          selected = variant === "hybrid_governance"
            ? governMemoryCandidates(authorized, scores, RESULT_LIMIT, EVALUATION_NOW.getTime())
            : authorized.slice(0, RESULT_LIMIT);
        }
        cases.push(caseResult(query, selected, keyById, performance.now() - started));
      }
      variants.push({ variant, metrics: metrics(cases), cases });
    }
    const lexical = variants.find(({ variant }) => variant === "lexical")!.metrics;
    const candidate = variants.find(({ variant }) => variant === "hybrid_governance")!.metrics;
    return {
      corpusSize: BASELINE_CORPUS.length,
      queryCount: BASELINE_QUERIES.length,
      embeddingFixture: "m09-semantic-fixture-v1 (deterministic CI fixture; not a production model claim)",
      tuning: ZVEC_RETRIEVAL_TUNING,
      variants,
      gate: evaluateGate(lexical, candidate),
    };
  } finally {
    await index?.close();
    await host.dispose();
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
}
