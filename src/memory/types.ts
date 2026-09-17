export type MemoryLevel = "L1" | "L2" | "L3";
export type MemoryKind = "working" | "semantic" | "episodic" | "decision" | "preference" | "failure-pattern" | "procedure";
export type MemoryStatus = "candidate" | "active" | "superseded" | "disputed" | "forgotten";
export type MemoryScope = "private" | "team" | "project" | "global";
export type MemoryIndexState = "pending" | "indexed" | "failed" | "not_applicable";
export type MemoryCandidateMatchType = "exact_duplicate" | "semantic_duplicate" | "conflict";
export type MemoryGovernanceAction = "retained" | "merged" | "activated" | "disputed" | "expired";
export type MemoryActorRole = "user" | "system" | "resource_manager" | "admin" | "leader" | "worker";
export type MemoryActorEmployment = "internal" | "external";

/**
 * Server-resolved principal used by every memory read and canonical mutation.
 * `projectIds` is an explicit grant list, not a caller-controlled global flag.
 */
export interface MemoryActor {
  id: string;
  role: MemoryActorRole;
  employment: MemoryActorEmployment;
  projectId?: string;
  teamId?: string;
  projectIds: string[];
}

export type MemoryAccessAction = "list" | "retrieve" | "inject" | "federated_search" | "candidate_write" | "confirm" | "promote" | "forget" | "govern";
export type MemoryAccessDecision = "allowed" | "denied";

export interface MemoryAccessAuditRecord {
  id: string;
  action: MemoryAccessAction;
  decision: MemoryAccessDecision;
  actorId: string;
  actorRole: MemoryActorRole;
  actorEmployment: MemoryActorEmployment;
  actorProjectId?: string;
  actorTeamId?: string;
  requestedProjectId: string;
  memoryIds: string[];
  reason: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MemorySource {
  eventId: string;
  agentId?: string;
  role: string;
  eventType: string;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  projectId: string;
  agentId: string;
  teamId?: string;
  level: MemoryLevel;
  kind: MemoryKind;
  content: string;
  summary: string;
  confidence: number;
  salience: number;
  evidenceCount: number;
  independentEvidenceCount?: number;
  sourceEventIds: string[];
  sources: MemorySource[];
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string;
  schemaVersion: number;
  scope: MemoryScope;
  trustLevel: number;
  subject?: string;
  predicate?: string;
  object?: unknown;
  validFrom?: string;
  validTo?: string;
  supersedesId?: string;
  contradictionIds: string[];
  contentHash: string;
  extractionModel?: string;
  extractionVersion?: string;
  governanceVersion?: string;
  confirmedAt?: string;
  confirmedBy?: string;
  indexState: MemoryIndexState;
}

export interface MemoryCandidateMatch {
  targetId: string;
  type: MemoryCandidateMatchType;
  score: number;
}

export interface MemoryGovernanceResult {
  candidateId: string;
  action: MemoryGovernanceAction;
  canonicalId?: string;
  independentEvidenceCount: number;
  autoPromotedL3: boolean;
}

export interface MemoryGovernanceSummary {
  processed: number;
  activated: number;
  merged: number;
  disputed: number;
  expired: number;
  autoPromotedL3: number;
  semanticAvailable: boolean;
  semanticError?: string;
}

export interface DreamRun {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled" | "skipped";
  trigger: "idle" | "manual";
  startedAt: string;
  completedAt?: string;
  processedEvents: number;
  createdL2: number;
  promotedL3: number;
  error?: string;
}

export interface MemoryOverview {
  enabled: boolean;
  counts: Record<MemoryLevel, number>;
  pendingEvents: number;
  lastDream?: DreamRun;
  runningDream?: DreamRun;
  lastMaintenance?: MemoryMaintenanceRun;
  runningMaintenance?: MemoryMaintenanceRun;
  lastActivityAt?: string;
  retrieval: MemoryRetrievalRuntimeStatus;
}

export interface MemoryRetrievalRuntimeStatus {
  mode: "lexical" | "shadow" | "active";
  configuredBackend: "lexical" | "zvec_fts" | "zvec_hybrid";
  effectiveBackend: "lexical" | "zvec_fts" | "zvec_hybrid";
  rolloutEnabled: boolean;
  circuitState: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  fallbackCount: number;
  maxPromptTokens: number;
  lastFallbackReason?: string;
  lastFallbackAt?: string;
  lastSuccessAt?: string;
  circuitOpenUntil?: string;
}
import type { MemoryMaintenanceRun } from "./maintenance-types";
