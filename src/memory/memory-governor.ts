import { loadGlobalModelCatalog } from "../models/global-models";
import { resolveEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
import type { MemoryRepository } from "./memory-repository";
import type { MemoryCandidateMatch, MemoryGovernanceSummary, MemoryRecord } from "./types";

export const MEMORY_GOVERNANCE_VERSION = "m12-v1";
export const MEMORY_SEMANTIC_DUPLICATE_THRESHOLD = 0.92;

export interface MemoryCandidateGovernor {
  govern(limit: number, minL3Evidence: number, agentId?: string): Promise<MemoryGovernanceSummary>;
}

function normalize(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function predicateKey(memory: MemoryRecord): string {
  return `${normalize(memory.subject)}\0${normalize(memory.predicate)}`;
}

function factKey(memory: MemoryRecord): string {
  return `${predicateKey(memory)}\0${normalize(memory.object)}`;
}

function searchableText(memory: MemoryRecord): string {
  return `${memory.subject ?? ""} ${memory.predicate ?? ""} ${normalize(memory.object)}\n${memory.summary}`.trim().slice(0, 2_000);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return -1;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

export class GovernedMemoryCandidates implements MemoryCandidateGovernor {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly embeddingProvider?: EmbeddingProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async govern(limit: number, minL3Evidence: number, agentId?: string): Promise<MemoryGovernanceSummary> {
    const bounded = Math.min(500, Math.max(1, Math.floor(limit)));
    const memories = this.repository.listGovernanceMemories(bounded, MEMORY_GOVERNANCE_VERSION, agentId);
    const candidates = memories.filter((memory) => memory.status === "candidate" && memory.governanceVersion !== MEMORY_GOVERNANCE_VERSION).slice(0, bounded);
    const candidateIds = new Set(candidates.map(({ id }) => id));
    const comparison = [...candidates, ...memories.filter((memory) => !candidateIds.has(memory.id))].slice(0, 500);
    const vectors = new Map<string, number[]>();
    let semanticError: string | undefined;
    if (this.embeddingProvider?.available && candidates.length && comparison.length > 1) {
      try {
        const embedded = await this.embeddingProvider.embedDocuments(comparison.map(searchableText));
        comparison.forEach((memory, index) => vectors.set(memory.id, embedded[index]!));
      } catch (error) {
        semanticError = error instanceof Error ? error.message : String(error);
      }
    }
    const summary: MemoryGovernanceSummary = {
      processed: 0, activated: 0, merged: 0, disputed: 0, expired: 0, autoPromotedL3: 0,
      semanticAvailable: Boolean(this.embeddingProvider?.available && !semanticError),
      ...(semanticError ? { semanticError } : {}),
    };
    for (const candidate of candidates) {
      const matches: MemoryCandidateMatch[] = [];
      for (const peer of memories) {
        if (peer.id === candidate.id || peer.agentId !== candidate.agentId || peer.level !== "L2") continue;
        if (factKey(peer) === factKey(candidate)) {
          matches.push({ targetId: peer.id, type: "exact_duplicate", score: 1 });
          continue;
        }
        if (predicateKey(peer) === predicateKey(candidate)) {
          matches.push({ targetId: peer.id, type: "conflict", score: 1 });
          continue;
        }
        const left = vectors.get(candidate.id); const right = vectors.get(peer.id);
        if (left && right && peer.kind === candidate.kind) {
          const score = cosineSimilarity(left, right);
          if (score >= MEMORY_SEMANTIC_DUPLICATE_THRESHOLD) matches.push({ targetId: peer.id, type: "semantic_duplicate", score });
        }
      }
      const peersById = new Map(memories.map((memory) => [memory.id, memory]));
      const orderedMatches = matches.sort((left, right) => {
        const semantic = Number(left.type === "semantic_duplicate") - Number(right.type === "semantic_duplicate");
        if (semantic) return semantic;
        const active = Number(peersById.get(right.targetId)?.status === "active") - Number(peersById.get(left.targetId)?.status === "active");
        return active || right.score - left.score || left.targetId.localeCompare(right.targetId);
      }).slice(0, 20);
      const result = this.repository.governCandidate({
        candidateId: candidate.id,
        matches: orderedMatches,
        version: MEMORY_GOVERNANCE_VERSION,
        now: this.now().toISOString(),
        autoActivateMinEvidence: 2,
        autoPromoteMinEvidence: Math.max(2, minL3Evidence),
        semanticIdentity: this.embeddingProvider?.available ? this.embeddingProvider.identity.revision : undefined,
        semanticError,
      });
      if (!result) continue;
      summary.processed += 1;
      if (result.action === "activated") summary.activated += 1;
      else if (result.action === "merged") summary.merged += 1;
      else if (result.action === "disputed") summary.disputed += 1;
      else if (result.action === "expired") summary.expired += 1;
      if (result.autoPromotedL3) summary.autoPromotedL3 += 1;
    }
    return summary;
  }
}

export class ConfiguredMemoryCandidateGovernor implements MemoryCandidateGovernor {
  private resolved?: Promise<GovernedMemoryCandidates>;
  constructor(
    private readonly repository: MemoryRepository,
    private readonly embeddingRef?: string,
    private readonly options: { modelsFile?: string; embeddingProvider?: EmbeddingProvider; now?: () => Date } = {},
  ) {}

  private resolve(): Promise<GovernedMemoryCandidates> {
    if (this.resolved) return this.resolved;
    this.resolved = (async () => {
      if (this.options.embeddingProvider) return new GovernedMemoryCandidates(this.repository, this.options.embeddingProvider, this.options.now);
      const catalog = await loadGlobalModelCatalog(this.options.modelsFile);
      const embedding = resolveEmbeddingProvider(catalog, this.embeddingRef);
      return new GovernedMemoryCandidates(this.repository, embedding.state === "ready" ? embedding.provider : undefined, this.options.now);
    })();
    return this.resolved;
  }

  async govern(limit: number, minL3Evidence: number, agentId?: string): Promise<MemoryGovernanceSummary> {
    return (await this.resolve()).govern(limit, minL3Evidence, agentId);
  }
}
