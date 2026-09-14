import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { MemoryConfig } from "../types/config";
import { loadGlobalModelCatalog } from "../models/global-models";
import { resolveEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
import type { AuthorizedMemoryInput, MemoryRepository } from "./memory-repository";
import type { MemoryIndex, MemoryIndexSearchInput } from "./memory-retriever";
import type { MemoryRecord } from "./types";
import type { MemoryActor } from "./types";
import { MEMORY_POLICY_VERSION, projectAgentActor } from "./memory-policy";
import { createZvecIndexLayout, readActiveIndexPointer, readZvecIndexManifest } from "./zvec-index-registry";
import { ZvecMemoryIndex, ZvecMemoryIndexWorkerHost } from "./zvec-memory-index";
import type { ZvecQueryHit } from "./zvec-memory-index-contract";

export type ZvecShadowMemoryIndexOptions = {
  projectId: string;
  repository: MemoryRepository;
  index: ZvecMemoryIndex;
  mode: "fts" | "hybrid";
  embeddingProvider?: EmbeddingProvider;
  maxResults?: number;
  minTrustLevel?: number;
  now?: () => Date;
  auditMode?: "shadow" | "active";
};

export const ZVEC_RETRIEVAL_TUNING = Object.freeze({
  denseMaxDistance: 0.45,
  routeRrfK: 60,
  exactRrfK: 50,
  maxPerKind: 3,
  recencyDecayDays: 30,
});

export type ConfiguredZvecShadowMemoryIndexOptions = {
  projectId: string;
  stateDir: string;
  repository: MemoryRepository;
  config: MemoryConfig;
  modelsFile?: string;
  now?: () => Date;
  auditMode?: "shadow" | "active";
};

function quoteFilterString(value: string): string {
  if (/\0|[\u0001-\u001f\u007f]/u.test(value)) throw new Error("Filter values cannot contain control characters.");
  // Zvec's filter parser currently has no documented string-literal escaping
  // mechanism. Reject quotes instead of guessing at SQL escaping and risking a
  // filter parse failure or predicate injection. Application-side authorization
  // remains the second, mandatory boundary after candidate hydration.
  if (value.includes("'")) throw new Error("Filter values cannot contain single quotes.");
  return `'${value}'`;
}

function teamFor(agentId: string): string | undefined {
  if (agentId === "admin") return undefined;
  const team = agentId.replace(/-(?:lead|leader)$/, "");
  return team === agentId ? undefined : team;
}

function authorizationValueError(projectId: string, actor: MemoryActor): string | undefined {
  try {
    quoteFilterString(projectId);
    quoteFilterString(actor.id);
    if (actor.teamId) quoteFilterString(actor.teamId);
    return undefined;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

export function buildZvecMemoryAuthorizationFilter(input: {
  projectId: string;
  actor?: MemoryActor;
  agentId?: string;
  globalScope?: boolean;
  nowMs: number;
  minTrustLevel?: number;
}): string {
  const legacyAgentId = input.agentId ?? "__missing_actor__";
  const actor = input.actor ?? projectAgentActor(input.projectId, legacyAgentId, legacyAgentId === "admin" && input.globalScope ? "admin" : undefined);
  const project = quoteFilterString(input.projectId);
  const agent = quoteFilterString(actor.id);
  const trust = Math.min(100, Math.max(0, Math.floor(input.minTrustLevel ?? 0)));
  const projectGranted = actor.projectId === input.projectId || actor.projectIds.includes(input.projectId);
  const team = actor.teamId ?? teamFor(actor.id);
  const visibility = !projectGranted || actor.employment === "external" || actor.role === "worker"
    ? `(scope = 'private' AND owner_agent_id = ${agent} AND level = 'L1')`
    : actor.role === "user" || actor.role === "system"
      ? `scope in ('private', 'team', 'project', 'global')`
      : actor.role === "resource_manager"
        ? `scope in ('project', 'global')`
        : actor.role === "admin"
          ? `(scope in ('project', 'team', 'global') OR (scope = 'private' AND owner_agent_id = ${agent}))`
          : `(scope = 'global' OR (scope = 'private' AND owner_agent_id = ${agent})${actor.projectIds.includes(input.projectId) ? " OR scope = 'project'" : ""}${team ? ` OR (scope = 'team' AND team_id = ${quoteFilterString(team)})` : ""})`;
  return [
    `project_id = ${project}`,
    `status = 'active'`,
    `level in ('L2', 'L3')`,
    `trust_level >= ${trust}`,
    `valid_from_ms <= ${Math.floor(input.nowMs)}`,
    `(valid_to_ms is null OR valid_to_ms > ${Math.floor(input.nowMs)})`,
    visibility,
  ].map((part) => `(${part})`).join(" AND ");
}

export function extractExactMemoryTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").slice(0, 1_000);
  const terms = normalized.match(/[\p{L}\p{N}_./:@-]{3,}/gu) ?? [];
  return [...new Set(terms.map((term) => term.toLowerCase()))].sort((left, right) => right.length - left.length).slice(0, 20);
}

export function reciprocalRankFusion(routes: ZvecQueryHit[][], exact: MemoryRecord[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const route of routes) route.forEach((hit, rank) => scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (ZVEC_RETRIEVAL_TUNING.routeRrfK + rank + 1)));
  exact.forEach((memory, rank) => scores.set(memory.id, (scores.get(memory.id) ?? 0) + 1 / (ZVEC_RETRIEVAL_TUNING.exactRrfK + rank + 1)));
  return scores;
}

export function governMemoryCandidates(memories: MemoryRecord[], routeScores: Map<string, number>, limit: number, nowMs: number): MemoryRecord[] {
  const superseded = new Set(memories.flatMap((memory) => memory.supersedesId ? [memory.supersedesId] : []));
  const ranked = memories.filter((memory) => !superseded.has(memory.id)).map((memory) => {
    const ageDays = Math.max(0, (nowMs - Date.parse(memory.updatedAt)) / 86_400_000);
    const recency = 0.02 * Math.exp(-ageDays / ZVEC_RETRIEVAL_TUNING.recencyDecayDays);
    const governance = memory.confidence * .01 + memory.salience * .01 + memory.trustLevel / 10_000 + recency;
    return { memory, score: (routeScores.get(memory.id) ?? 0) + governance };
  }).sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt) || left.memory.id.localeCompare(right.memory.id));

  const content = new Set<string>();
  const predicates = new Set<string>();
  const kinds = new Map<string, number>();
  const result: MemoryRecord[] = [];
  for (const { memory } of ranked) {
    const contentKey = `${memory.summary}\n${memory.content}`.toLowerCase().replace(/\s+/g, " ").trim();
    const predicateKey = memory.subject && memory.predicate ? `${memory.subject}\0${memory.predicate}` : undefined;
    if (content.has(contentKey) || (predicateKey && predicates.has(predicateKey))) continue;
    const kindCount = kinds.get(memory.kind) ?? 0;
    if (kindCount >= ZVEC_RETRIEVAL_TUNING.maxPerKind) continue;
    content.add(contentKey);
    if (predicateKey) predicates.add(predicateKey);
    kinds.set(memory.kind, kindCount + 1);
    result.push(memory);
    if (result.length >= limit) break;
  }
  return result;
}

export class ZvecShadowMemoryIndex implements MemoryIndex {
  readonly backend: string;
  private readonly maxResults: number;
  private readonly now: () => Date;
  private lastError?: string;

  constructor(private readonly options: ZvecShadowMemoryIndexOptions) {
    this.backend = `zvec_${options.auditMode ?? "shadow"}_${options.mode}`;
    this.maxResults = Math.min(50, Math.max(1, options.maxResults ?? 8));
    this.now = options.now ?? (() => new Date());
    if (options.index.collectionRevision === "" || options.index.path === "") throw new Error("Shadow index must reference an open collection.");
    if (options.mode === "hybrid" && (!options.embeddingProvider?.available || options.embeddingProvider.identity.revision !== options.index.embeddingRevision)) {
      throw new Error("Hybrid shadow retrieval requires an embedding provider matching the active collection.");
    }
  }

  async search(input: MemoryIndexSearchInput): Promise<MemoryRecord[] | undefined> {
    const started = performance.now();
    const createdAt = this.now();
    const actor = input.actor ?? projectAgentActor(this.options.projectId, input.agentId);
    const authorization: AuthorizedMemoryInput = { actor, now: createdAt.toISOString() };
    const scopeJson = JSON.stringify({ projectId: this.options.projectId, actorId: actor.id, role: actor.role, employment: actor.employment, teamId: actor.teamId, policyVersion: MEMORY_POLICY_VERSION });
    const projectGranted = actor.projectId === this.options.projectId || actor.projectIds.includes(this.options.projectId);
    const valueError = authorizationValueError(this.options.projectId, actor);
    if (valueError || !projectGranted || actor.role === "worker" || actor.employment === "external") {
      const reason = valueError ?? (!projectGranted ? "project_not_granted" : "actor_has_no_long_term_read");
      this.options.repository.recordRetrievalRun({
        id: randomUUID(), actor, query: input.query, scopeJson, backend: this.backend,
        candidateIds: [], selectedIds: [], latencyMs: performance.now() - started,
        fallbackReason: `authorization: ${reason}`, accessDecision: "denied", accessReason: reason, createdAt: createdAt.toISOString(),
      });
      this.lastError = reason;
      return [];
    }
    const terms = extractExactMemoryTerms(input.query);
    let candidateIds: string[] = [];
    let selected: MemoryRecord[] = [];
    const fallback: string[] = [];
    try {
      let denseVector: number[] | undefined;
      if (this.options.mode === "hybrid") {
        try { denseVector = await this.options.embeddingProvider!.embedQuery(input.query.slice(0, 4_000)); }
        catch (error) { fallback.push(`dense: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const routes = await this.options.index.queryRoutes({
        filter: buildZvecMemoryAuthorizationFilter({
          projectId: this.options.projectId,
          actor,
          nowMs: createdAt.getTime(),
          minTrustLevel: this.options.minTrustLevel,
        }),
        matchString: input.query.slice(0, 1_000),
        ...(denseVector ? { denseVector } : {}),
        topK: Math.min(500, Math.max(1, input.limit)),
      });
      fallback.push(...routes.errors.map((error) => `${error.route}: ${error.message}`));
      const exact = this.options.repository.findExactAuthorizedMemories(authorization, terms, input.limit);
      const dense = routes.dense.filter((hit) => hit.score <= ZVEC_RETRIEVAL_TUNING.denseMaxDistance);
      const routeScores = reciprocalRankFusion([dense, routes.fts], exact);
      const orderedIds = [...routeScores.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
      const hydrated = this.options.repository.findAuthorizedMemories(authorization, orderedIds);
      const hydratedById = new Map(hydrated.map((memory) => [memory.id, memory]));
      const all = orderedIds.flatMap((id) => hydratedById.get(id) ? [hydratedById.get(id)!] : []);
      candidateIds = all.map(({ id }) => id);
      selected = governMemoryCandidates(all, routeScores, this.maxResults, createdAt.getTime());
    } catch (error) {
      fallback.push(`zvec: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.options.repository.recordRetrievalRun({
      id: randomUUID(),
      actor,
      query: input.query,
      scopeJson,
      backend: this.backend,
      embeddingIdentity: this.options.mode === "hybrid" ? this.options.embeddingProvider?.identity.revision : undefined,
      candidateIds,
      selectedIds: selected.map(({ id }) => id),
      latencyMs: performance.now() - started,
      fallbackReason: fallback.length ? fallback.join("; ") : undefined,
      createdAt: createdAt.toISOString(),
    });
    this.lastError = fallback.length ? fallback.join("; ").slice(0, 800) : undefined;
    return fallback.some((reason) => reason.startsWith("zvec:")) && !selected.length ? undefined : selected;
  }

  lastFailureReason(): string | undefined {
    return this.lastError;
  }

  close(): void {
    void this.options.index.close();
  }
}

/**
 * Production-facing, read-only adapter for shadow mode. It resolves the active
 * collection and global embedding profile lazily so MemoryService construction
 * remains synchronous and a missing/corrupt index can never block startup.
 */
export class ConfiguredZvecShadowMemoryIndex implements MemoryIndex {
  readonly backend: string;
  private readonly now: () => Date;
  private readonly workerHost = new ZvecMemoryIndexWorkerHost();
  private closed = false;
  private lastError?: string;

  constructor(private readonly options: ConfiguredZvecShadowMemoryIndexOptions) {
    this.backend = `zvec_${options.auditMode ?? "shadow"}_${options.config.retrieval.backend === "zvec_hybrid" ? "hybrid" : "fts"}`;
    this.now = options.now ?? (() => new Date());
  }

  async search(input: MemoryIndexSearchInput): Promise<MemoryRecord[] | undefined> {
    const started = performance.now();
    const createdAt = this.now();
    let embeddingIdentity: string | undefined;
    const actor = input.actor ?? projectAgentActor(this.options.projectId, input.agentId);
    const projectGranted = actor.projectId === this.options.projectId || actor.projectIds.includes(this.options.projectId);
    const valueError = authorizationValueError(this.options.projectId, actor);
    if (valueError || !projectGranted || actor.role === "worker" || actor.employment === "external") {
      const reason = valueError ?? (!projectGranted ? "project_not_granted" : "actor_has_no_long_term_read");
      this.lastError = reason;
      this.options.repository.recordRetrievalRun({
        id: randomUUID(), actor, query: input.query,
        scopeJson: JSON.stringify({ projectId: this.options.projectId, actorId: actor.id, role: actor.role, employment: actor.employment, teamId: actor.teamId, policyVersion: MEMORY_POLICY_VERSION }),
        backend: this.backend, candidateIds: [], selectedIds: [], latencyMs: performance.now() - started,
        fallbackReason: `authorization: ${reason}`, accessDecision: "denied", accessReason: reason, createdAt: createdAt.toISOString(),
      });
      return [];
    }
    try {
      if (this.closed) throw new Error("Shadow index is closed.");
      const root = path.isAbsolute(this.options.config.zvec.path)
        ? this.options.config.zvec.path
        : path.resolve(this.options.stateDir, this.options.config.zvec.path);
      const layout = createZvecIndexLayout(root, this.options.projectId);
      const pointer = await readActiveIndexPointer(layout, this.options.projectId);
      if (!pointer) throw new Error("No active Zvec collection is available.");
      const manifest = await readZvecIndexManifest(layout, this.options.projectId, pointer.collectionRevision);
      if (!manifest) throw new Error("The active Zvec collection has no manifest.");

      let embeddingProvider: EmbeddingProvider | undefined;
      if (this.options.config.retrieval.backend === "zvec_hybrid") {
        const catalog = await loadGlobalModelCatalog(this.options.modelsFile);
        const embedding = resolveEmbeddingProvider(catalog, this.options.config.embeddingRef);
        if (embedding.state !== "ready") throw new Error(embedding.reason ?? "Embedding is unavailable.");
        embeddingProvider = embedding.provider;
        embeddingIdentity = embeddingProvider.identity.revision;
        if (embeddingIdentity !== manifest.embeddingRevision) {
          throw new Error("The active Zvec collection does not match the configured embedding revision.");
        }
      }

      const index = await ZvecMemoryIndex.open({ layout, manifest, readOnly: true, workerHost: this.workerHost });
      try {
        const delegate = new ZvecShadowMemoryIndex({
          projectId: this.options.projectId,
          repository: this.options.repository,
          index,
          mode: this.options.config.retrieval.backend === "zvec_hybrid" ? "hybrid" : "fts",
          embeddingProvider,
          maxResults: this.options.config.retrieval.maxResults,
          now: this.now,
          auditMode: this.options.auditMode,
        });
        const result = await delegate.search(input);
        this.lastError = delegate.lastFailureReason();
        return result;
      } finally {
        await index.close();
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.repository.recordRetrievalRun({
        id: randomUUID(),
        actor,
        query: input.query,
        scopeJson: JSON.stringify({
          projectId: this.options.projectId,
          actorId: actor.id,
          role: actor.role,
          employment: actor.employment,
          teamId: actor.teamId,
          policyVersion: MEMORY_POLICY_VERSION,
        }),
        backend: this.backend,
        embeddingIdentity,
        candidateIds: [],
        selectedIds: [],
        latencyMs: performance.now() - started,
        fallbackReason: `zvec: ${this.lastError}`,
        createdAt: createdAt.toISOString(),
      });
      return undefined;
    }
  }

  lastFailureReason(): string | undefined {
    return this.lastError;
  }

  close(): void {
    this.closed = true;
    void this.workerHost.dispose();
  }
}
