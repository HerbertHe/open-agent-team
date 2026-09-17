import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { MemoryConfig } from "../../types/config";
import { ObservabilityHub } from "../../orchestrator/observability-hub";
import { MemoryService } from "../memory-service";
import { BASELINE_CORPUS, BASELINE_QUERIES } from "./baseline-fixtures";

export type BaselineCaseResult = {
  id: string;
  selectedKeys: string[];
  firstRelevantRank?: number;
  forbiddenSelected: string[];
  latencyMs: number;
};

export type LexicalBaselineResult = {
  corpusSize: number;
  queryCount: number;
  evaluatedRelevantQueries: number;
  recallAt5: number;
  meanReciprocalRank: number;
  errorInjectionQueryRate: number;
  errorInjectionItemRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  cases: BaselineCaseResult[];
};

const BASELINE_CONFIG: MemoryConfig = {
  enabled: true,
  roles: ["admin", "leader", "worker"],
  retrieval: { backend: "lexical", fallback: "lexical", shadow: false, productionEnabled: false, candidateLimit: 30, maxResults: 8, maxPromptTokens: 1800, timeoutMs: 3_000, circuitBreakerFailureThreshold: 3, circuitBreakerCooldownSeconds: 60 },
  zvec: { path: "memory/zvec", index: "flat", metric: "cosine", readOnlyFallback: true, batchSize: 64, maxAttempts: 8, optimizePendingThreshold: 100_000 },
  extraction: { enabled: false, version: "m11-v1", timeoutMs: 15_000, maxInputChars: 4_000, maxOutputTokens: 800, maxFactsPerEvent: 5, maxAttempts: 3 },
  l1: { maxItems: 5, completedTaskTtlHours: 720 },
  l2: { maxResults: 5, retentionDays: 3650 },
  // Keep the fixture in L2 so the benchmark isolates the current lexical ranker.
  l3: { maxPromptItems: 5, minEvidence: 20 },
  dream: { enabled: true, idleAfterSeconds: 30, pollSeconds: 30, maxEventsPerRun: 100, cancelOnNewTask: true },
};

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1)] ?? 0;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function l2Summaries(context: string): string[] {
  const marker = "L2 relevant long-term memory:\n";
  const start = context.indexOf(marker);
  if (start < 0) return [];
  const body = context.slice(start + marker.length).split("\n\n")[0] ?? "";
  return body.split("\n")
    .map((line) => line.replace(/^- \[[^\]]+\] /, "").trim())
    .filter(Boolean);
}

export async function runLexicalBaseline(): Promise<LexicalBaselineResult> {
  const root = mkdtempSync(path.join(tmpdir(), "oat-memory-baseline-"));
  const hub = new ObservabilityHub();
  const memory = new MemoryService("baseline-project", root, BASELINE_CONFIG, hub);
  memory.setIdleResolver(() => true);
  try {
    const now = Date.now();
    for (const item of BASELINE_CORPUS) {
      hub.emit({
        source: "orchestrator",
        type: "report_progress",
        agentId: item.agentId,
        role: item.role,
        ts: new Date(now - item.ageHours * 3_600_000).toISOString(),
        payload: { stage: "done", message: item.content },
      });
    }
    const dream = await memory.runDream("manual");
    if (dream.status !== "completed" || dream.processedEvents !== BASELINE_CORPUS.length) {
      throw new Error(`Unable to prepare lexical baseline corpus: ${dream.status}/${dream.processedEvents}`);
    }

    const keyByContent = new Map(BASELINE_CORPUS.map((item) => [item.content, item.key]));
    const cases: BaselineCaseResult[] = [];
    for (const query of BASELINE_QUERIES) {
      const startedAt = performance.now();
      const context = await memory.buildContext(query.agentId, query.query);
      const latencyMs = performance.now() - startedAt;
      const selectedKeys = l2Summaries(context)
        .map((summary) => keyByContent.get(summary))
        .filter((key): key is string => Boolean(key));
      const firstRelevantIndex = selectedKeys.findIndex((key) => query.relevantKeys.includes(key));
      cases.push({
        id: query.id,
        selectedKeys,
        firstRelevantRank: firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : undefined,
        forbiddenSelected: selectedKeys.filter((key) => query.forbiddenKeys?.includes(key)),
        latencyMs: round(latencyMs),
      });
    }

    const relevantCases = cases.filter((item) => BASELINE_QUERIES.find((query) => query.id === item.id)!.relevantKeys.length > 0);
    const selectedCount = cases.reduce((total, item) => total + item.selectedKeys.length, 0);
    const forbiddenCount = cases.reduce((total, item) => total + item.forbiddenSelected.length, 0);
    const latencies = cases.map((item) => item.latencyMs);
    return {
      corpusSize: BASELINE_CORPUS.length,
      queryCount: BASELINE_QUERIES.length,
      evaluatedRelevantQueries: relevantCases.length,
      recallAt5: round(relevantCases.filter((item) => item.firstRelevantRank !== undefined).length / relevantCases.length),
      meanReciprocalRank: round(relevantCases.reduce((total, item) => total + (item.firstRelevantRank ? 1 / item.firstRelevantRank : 0), 0) / relevantCases.length),
      errorInjectionQueryRate: round(cases.filter((item) => item.forbiddenSelected.length > 0).length / cases.length),
      errorInjectionItemRate: round(selectedCount ? forbiddenCount / selectedCount : 0),
      p50LatencyMs: round(percentile(latencies, .5)),
      p95LatencyMs: round(percentile(latencies, .95)),
      cases,
    };
  } finally {
    await memory.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
