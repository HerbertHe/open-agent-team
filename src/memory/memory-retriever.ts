import type { MemoryActor, MemoryRecord, MemoryRetrievalRuntimeStatus } from "./types";
import type { MemoryRepository } from "./memory-repository";

export type MemoryRetrievalInput = {
  actor?: MemoryActor;
  agentId: string;
  query: string;
  globalScope: boolean;
  l2MaxResults: number;
  l3MaxPromptItems: number;
};

export type MemoryRetrievalResult = {
  l1: MemoryRecord[];
  l2: MemoryRecord[];
  l3: MemoryRecord[];
};

export type MemoryIndexSearchInput = Omit<MemoryRetrievalInput, "l2MaxResults" | "l3MaxPromptItems"> & { limit: number };

export interface MemoryIndex {
  readonly backend: string;
  search(input: MemoryIndexSearchInput): Promise<MemoryRecord[] | undefined>;
  lastFailureReason?(): string | undefined;
  close(): void;
}

export class NoopMemoryIndex implements MemoryIndex {
  readonly backend = "disabled";
  async search(_input: MemoryIndexSearchInput): Promise<undefined> { return undefined; }
  close(): void { /* no external index is active */ }
}

export interface MemoryRetriever {
  retrieve(input: MemoryRetrievalInput): Promise<MemoryRetrievalResult>;
}

export interface RuntimeStatusMemoryRetriever extends MemoryRetriever {
  getStatus(): MemoryRetrievalRuntimeStatus;
}

export type ActiveMemoryRetrieverOptions = {
  primary: MemoryRetriever;
  index: MemoryIndex;
  configuredBackend: "zvec_fts" | "zvec_hybrid";
  candidateLimit: number;
  maxPromptTokens: number;
  timeoutMs: number;
  failureThreshold: number;
  cooldownMs: number;
  now?: () => Date;
};

class RetrievalTimeoutError extends Error {
  constructor(milliseconds: number) {
    super(`Zvec retrieval exceeded the ${milliseconds}ms timeout.`);
    this.name = "RetrievalTimeoutError";
  }
}

export function estimateMemoryPromptTokens(memory: MemoryRecord): number {
  const text = memory.summary;
  const cjk = (text.match(/[\u3400-\u9fff]/gu) ?? []).length;
  return cjk + Math.ceil(Math.max(0, [...text].length - cjk) / 4) + 6;
}

export function applyMemoryPromptBudget(result: MemoryRetrievalResult, maxTokens: number): MemoryRetrievalResult {
  let remaining = Math.max(0, Math.floor(maxTokens) - 40);
  const selected: MemoryRetrievalResult = { l1: [], l2: [], l3: [] };
  // Current working memory is never replaced by the vector index and receives
  // budget first, followed by stable L3 and query-ranked L2 records.
  for (const [level, memories] of [["l1", result.l1], ["l3", result.l3], ["l2", result.l2]] as const) {
    for (const memory of memories) {
      const cost = estimateMemoryPromptTokens(memory);
      if (cost > remaining) continue;
      selected[level].push(memory);
      remaining -= cost;
    }
  }
  return selected;
}

export class ActiveMemoryRetriever implements RuntimeStatusMemoryRetriever {
  private readonly now: () => Date;
  private circuitState: MemoryRetrievalRuntimeStatus["circuitState"] = "closed";
  private consecutiveFailures = 0;
  private fallbackCount = 0;
  private lastFallbackReason?: string;
  private lastFallbackAt?: string;
  private lastSuccessAt?: string;
  private circuitOpenUntil?: number;
  private halfOpenInFlight = false;
  private effectiveBackend: MemoryRetrievalRuntimeStatus["effectiveBackend"] = "lexical";

  constructor(private readonly options: ActiveMemoryRetrieverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  getStatus(): MemoryRetrievalRuntimeStatus {
    return {
      mode: "active",
      configuredBackend: this.options.configuredBackend,
      effectiveBackend: this.effectiveBackend,
      rolloutEnabled: true,
      circuitState: this.circuitState,
      consecutiveFailures: this.consecutiveFailures,
      fallbackCount: this.fallbackCount,
      maxPromptTokens: this.options.maxPromptTokens,
      lastFallbackReason: this.lastFallbackReason,
      lastFallbackAt: this.lastFallbackAt,
      lastSuccessAt: this.lastSuccessAt,
      circuitOpenUntil: this.circuitOpenUntil === undefined ? undefined : new Date(this.circuitOpenUntil).toISOString(),
    };
  }

  async retrieve(input: MemoryRetrievalInput): Promise<MemoryRetrievalResult> {
    const lexical = await this.options.primary.retrieve(input);
    const now = this.now().getTime();
    if (this.circuitState === "open") {
      if (this.circuitOpenUntil !== undefined && now >= this.circuitOpenUntil) this.circuitState = "half_open";
      else return this.fallback(lexical, "Zvec circuit breaker is open.");
    }
    if (this.circuitState === "half_open" && this.halfOpenInFlight) return this.fallback(lexical, "Zvec circuit breaker probe is already running.");
    if (this.circuitState === "half_open") this.halfOpenInFlight = true;

    try {
      const indexed = await this.withTimeout(this.options.index.search({
        actor: input.actor,
        agentId: input.agentId,
        query: input.query,
        globalScope: input.globalScope,
        limit: this.options.candidateLimit,
      }));
      if (indexed === undefined) throw new Error(this.options.index.lastFailureReason?.() ?? "Zvec retrieval is unavailable.");
      this.circuitState = "closed";
      this.circuitOpenUntil = undefined;
      this.consecutiveFailures = 0;
      this.effectiveBackend = this.options.configuredBackend;
      this.lastSuccessAt = this.now().toISOString();
      const degradedReason = this.options.index.lastFailureReason?.();
      if (degradedReason) {
        this.fallbackCount += 1;
        this.lastFallbackReason = degradedReason.slice(0, 800);
        this.lastFallbackAt = this.now().toISOString();
      }
      return applyMemoryPromptBudget({
        l1: lexical.l1,
        l2: indexed.filter((memory) => memory.level === "L2").slice(0, input.l2MaxResults),
        l3: indexed.filter((memory) => memory.level === "L3").slice(0, input.l3MaxPromptItems),
      }, this.options.maxPromptTokens);
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.options.failureThreshold || this.circuitState === "half_open") {
        this.circuitState = "open";
        this.circuitOpenUntil = this.now().getTime() + this.options.cooldownMs;
      }
      return this.fallback(lexical, error instanceof Error ? error.message : String(error));
    } finally {
      this.halfOpenInFlight = false;
    }
  }

  private fallback(lexical: MemoryRetrievalResult, reason: string): MemoryRetrievalResult {
    this.fallbackCount += 1;
    this.effectiveBackend = "lexical";
    this.lastFallbackReason = reason.slice(0, 800);
    this.lastFallbackAt = this.now().toISOString();
    return applyMemoryPromptBudget(lexical, this.options.maxPromptTokens);
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new RetrievalTimeoutError(this.options.timeoutMs)), this.options.timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class ShadowMemoryRetriever implements MemoryRetriever {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly primary: MemoryRetriever,
    private readonly shadowIndex: MemoryIndex,
    private readonly candidateLimit: number,
  ) {}

  async retrieve(input: MemoryRetrievalInput): Promise<MemoryRetrievalResult> {
    const primary = await this.primary.retrieve(input);
    const shadow = this.shadowIndex.search({
      actor: input.actor,
      agentId: input.agentId,
      query: input.query,
      globalScope: input.globalScope,
      limit: this.candidateLimit,
    }).catch(() => undefined);
    this.pending.add(shadow);
    void shadow.finally(() => this.pending.delete(shadow));
    return primary;
  }

  async waitForShadow(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export class LexicalMemoryRetriever implements MemoryRetriever {
  constructor(private readonly repository: MemoryRepository) {}

  async retrieve(input: MemoryRetrievalInput): Promise<MemoryRetrievalResult> {
    const authorization = input.actor ? { actor: input.actor, now: new Date().toISOString() } : undefined;
    const l1 = authorization
      ? this.repository.listAuthorized(authorization, { agentId: input.agentId, level: "L1", limit: 8 })
      : this.repository.list({ agentId: input.agentId, level: "L1", limit: 8 });
    const l3 = authorization
      ? this.repository.listAuthorized(authorization, { level: "L3", limit: input.l3MaxPromptItems })
      : this.repository.list({ agentId: input.globalScope ? undefined : input.agentId, level: "L3", limit: input.l3MaxPromptItems });
    const candidates = authorization
      ? this.repository.listAuthorized(authorization, { level: "L2", limit: 500 })
      : this.repository.list({ agentId: input.globalScope ? undefined : input.agentId, level: "L2", limit: 100 });
    const words = new Set(normalize(input.query).split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1));
    const l2 = candidates.map((memory) => {
      const haystack = normalize(`${memory.summary} ${memory.content}`);
      const overlap = [...words].reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
      const ageDays = Math.max(0, (Date.now() - Date.parse(memory.updatedAt)) / 86_400_000);
      return { memory, score: overlap * 4 + memory.salience * 2 + memory.confidence - Math.min(2, ageDays / 30) };
    }).sort((left, right) => right.score - left.score).slice(0, input.l2MaxResults).map((item) => item.memory);
    const result = { l1, l2, l3 };
    if (input.actor) this.repository.recordAccessAudit({
      action: input.actor.role === "resource_manager" ? "federated_search" : "retrieve",
      decision: "allowed",
      actor: input.actor,
      memoryIds: [...l1, ...l2, ...l3].map(({ id }) => id),
      reason: "sqlite_policy_filtered_retrieval",
      metadata: { backend: "lexical", selectedCount: l1.length + l2.length + l3.length },
    });
    return result;
  }
}
