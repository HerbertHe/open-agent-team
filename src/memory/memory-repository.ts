import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { DreamRun, MemoryAccessAction, MemoryAccessAuditRecord, MemoryAccessDecision, MemoryActor, MemoryCandidateMatch, MemoryGovernanceResult, MemoryKind, MemoryLevel, MemoryOverview, MemoryRecord, MemorySource } from "./types";
import type { GovernedMemoryCandidate, MemoryEventSourceType, MemoryExtractionEvent } from "./memory-extractor";
import { DefaultMemoryPolicy, type MemoryPolicy } from "./memory-policy";
import type { SemanticDocument } from "../semantic/types";
import type { MemoryMaintenanceRun } from "./maintenance-types";

type MemoryRow = {
  id: string;
  project_id: string;
  agent_id: string;
  team_id: string | null;
  level: MemoryLevel;
  kind: MemoryKind;
  content: string;
  summary: string;
  fingerprint: string;
  confidence: number;
  salience: number;
  evidence_count: number;
  independent_evidence_count: number;
  source_event_ids: string;
  status: MemoryRecord["status"];
  created_at: string;
  updated_at: string;
  last_confirmed_at: string;
  schema_version: number;
  scope: MemoryRecord["scope"];
  trust_level: number;
  subject: string | null;
  predicate: string | null;
  object_json: string | null;
  valid_from: string | null;
  valid_to: string | null;
  supersedes_id: string | null;
  contradiction_ids: string;
  content_hash: string;
  extraction_model: string | null;
  extraction_version: string | null;
  governance_version: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  index_state: MemoryRecord["indexState"];
};

type DreamRow = {
  id: string;
  status: DreamRun["status"];
  trigger: DreamRun["trigger"];
  started_at: string;
  completed_at: string | null;
  processed_events: number;
  created_l2: number;
  promoted_l3: number;
  error: string | null;
};

type PendingEventRow = {
  id: string;
  owner_agent_id: string;
  kind: MemoryKind;
  content: string;
  created_at: string;
  trust_level: number;
  source_agent_id: string | null;
  role: string;
  event_type: string;
  team_id: string | null;
  source_type: MemoryEventSourceType;
  extraction_attempts: number;
};

export type MemoryListOptions = {
  agentId?: string;
  level?: MemoryLevel;
  status?: MemoryRecord["status"];
  limit?: number;
};

export type CapturedMemoryEvent = {
  id: string;
  ownerAgentId: string;
  sourceAgentId: string;
  role: string;
  trustLevel: number;
  eventType: string;
  taskId?: string;
  kind: MemoryKind;
  content: string;
  metadataJson: string;
  createdAt: string;
  teamId?: string;
  fingerprint: string;
};

export type ConsolidateInput = {
  agentId?: string;
  maxEvents: number;
  minEvidence: number;
  retentionDays: number;
  l1MaxItems: number;
  l1TtlHours: number;
  isCancelled: () => boolean;
};

export type ConsolidateResult = {
  processedEvents: number;
  createdL2: number;
  promotedL3: number;
};

export type MemoryExtractionRunInput = {
  id: string;
  eventId: string;
  model: string;
  version: string;
  status: "success" | "rejected" | "failed";
  candidateCount: number;
  inputChars: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  error?: string;
  createdAt: string;
};

export type MemoryIndexRegistryState = "building" | "ready" | "active" | "retired" | "failed";
export type MemoryIndexMembershipState = "pending" | "indexed" | "failed" | "deleted";

export type MemoryIndexRegistryRecord = {
  collectionRevision: string;
  projectId: string;
  embeddingRevision: string;
  state: MemoryIndexRegistryState;
  path: string;
  snapshotWatermark?: string;
  documentCount: number;
  createdAt: string;
  readyAt?: string;
  activatedAt?: string;
  retiredAt?: string;
};

export type MemoryIndexMembership = {
  memoryId: string;
  collectionRevision: string;
  contentHash: string;
  embeddingRevision: string;
  status: MemoryIndexMembershipState;
  indexedAt?: string;
  error?: string;
};

export type MemoryIndexOutboxItem = {
  id: string;
  memoryId: string;
  operation: "upsert" | "delete";
  collectionRevision: string;
  contentHash: string;
  attempts: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  memory: MemoryRecord;
};

export type ClaimMemoryIndexOutboxOptions = {
  workerId: string;
  collectionRevision: string;
  limit: number;
  now: string;
  leaseMs: number;
};

export type MemoryIndexMigrationStatus = "backfilling" | "paused" | "validating" | "ready" | "active" | "failed" | "retired";
export type MemoryIndexMigrationRecord = {
  collectionRevision: string;
  sourceCollectionRevision?: string;
  status: MemoryIndexMigrationStatus;
  snapshotWatermark: string;
  totalItems: number;
  pauseReason?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type MemoryIndexValidationSnapshot = {
  collectionRevision: string;
  expectedCount: number;
  indexedCount: number;
  missingIds: string[];
  mismatchedIds: string[];
  staleIds: string[];
  pendingOutbox: number;
  processingOutbox: number;
  deadLetters: number;
  sample: Array<{ id: string; contentHash: string }>;
  errors: string[];
};

export type MemoryIndexRebuildWorkload = {
  itemCount: number;
  searchableCharacters: number;
  sqliteBytes: number;
};

export type AuthorizedMemoryInput = {
  actor: MemoryActor;
  now: string;
};

export type MemoryAccessAuditInput = {
  action: MemoryAccessAction;
  decision: MemoryAccessDecision;
  actor: MemoryActor;
  memoryIds?: string[];
  reason: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

export type MemoryRetrievalRunInput = {
  id: string;
  actor: MemoryActor;
  query: string;
  scopeJson: string;
  backend: string;
  embeddingIdentity?: string;
  candidateIds: string[];
  selectedIds: string[];
  latencyMs: number;
  fallbackReason?: string;
  createdAt: string;
  accessDecision?: MemoryAccessDecision;
  accessReason?: string;
};

export type MemoryRetrievalRunRecord = Omit<MemoryRetrievalRunInput, "actor"> & { agentId: string };

export type SemanticIndexOutboxItem = {
  id: string;
  semanticDocumentId: string;
  operation: "upsert" | "delete";
  collectionRevision: string;
  contentHash: string;
  attempts: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  document: SemanticDocument;
};

export type ClaimSemanticIndexOutboxOptions = ClaimMemoryIndexOutboxOptions;

export interface MemoryRepository {
  close(): void;
  get(id: string): MemoryRecord | undefined;
  latestEventCreatedAt(): string | undefined;
  removeUnsupportedStreamingFragments(): void;
  enforceL1Retention(ttlHours: number, maxItems: number): void;
  capture(input: CapturedMemoryEvent, l1MaxItems: number): void;
  list(options?: MemoryListOptions): MemoryRecord[];
  listAuthorized(input: AuthorizedMemoryInput, options?: MemoryListOptions): MemoryRecord[];
  recordInjection(agentId: string, query: string, memoryIds: string[], createdAt: string): void;
  forget(id: string, updatedAt: string): boolean;
  promote(id: string, updatedAt: string, confirmedBy?: string): MemoryRecord | undefined;
  currentDream(): DreamRun | undefined;
  insertDream(run: DreamRun): void;
  finishDream(run: DreamRun): void;
  insertMaintenanceRun(run: MemoryMaintenanceRun, createdAt: string): void;
  finishMaintenanceRun(run: MemoryMaintenanceRun, updatedAt: string): void;
  pendingMaintenanceAgentIds?(limit?: number): string[];
  consolidate(input: ConsolidateInput): ConsolidateResult;
  listPendingExtractionEvents(limit: number, maxAttempts: number, agentId?: string): MemoryExtractionEvent[];
  commitExtraction(event: MemoryExtractionEvent, candidates: GovernedMemoryCandidate[], run: MemoryExtractionRunInput): number;
  recordExtractionFailure(eventId: string, maxAttempts: number, run: MemoryExtractionRunInput): void;
  finishStructuredConsolidation(retentionDays: number, l1MaxItems: number, l1TtlHours: number, agentId?: string): void;
  listGovernanceMemories(limit: number, version: string, agentId?: string): MemoryRecord[];
  governCandidate(input: { candidateId: string; matches: MemoryCandidateMatch[]; version: string; now: string; autoActivateMinEvidence: number; autoPromoteMinEvidence: number; semanticIdentity?: string; semanticError?: string }): MemoryGovernanceResult | undefined;
  confirmCandidate(id: string, confirmedBy: string, confirmedAt: string): MemoryRecord | undefined;
  overview(enabled: boolean, agentId?: string): Omit<MemoryOverview, "retrieval">;
  registerIndexTarget(target: MemoryIndexRegistryRecord): void;
  listIndexTargets(): MemoryIndexRegistryRecord[];
  enqueueIndexBackfill(collectionRevision: string, now?: string): number;
  listIndexMemberships(memoryId?: string): MemoryIndexMembership[];
  claimIndexOutbox(options: ClaimMemoryIndexOutboxOptions): MemoryIndexOutboxItem[];
  completeIndexOutbox(id: string, workerId: string, completedAt: string): boolean;
  failIndexOutbox(id: string, workerId: string, failure: { error: string; retryable: boolean; retryAt: string; maxAttempts: number }, failedAt: string): "retry" | "dead_letter" | "lost_lease";
  prepareIndexMigration(collectionRevision: string, sourceCollectionRevision: string | undefined, now?: string): MemoryIndexMigrationRecord;
  reconcileIndexRevision(collectionRevision: string, now?: string): number;
  getIndexMigration(collectionRevision: string): MemoryIndexMigrationRecord | undefined;
  setIndexMigrationStatus(collectionRevision: string, status: MemoryIndexMigrationStatus, options?: { pauseReason?: string; error?: string; completedAt?: string; updatedAt?: string }): MemoryIndexMigrationRecord;
  retryIndexDeadLetters(collectionRevision: string, now?: string): number;
  indexRevisionValidation(collectionRevision: string, sampleSize?: number): MemoryIndexValidationSnapshot;
  indexRebuildWorkload(): MemoryIndexRebuildWorkload;
  updateIndexTargetState(collectionRevision: string, state: MemoryIndexRegistryState, options?: { documentCount?: number; readyAt?: string; activatedAt?: string; retiredAt?: string }): void;
  resetIndexRevisionData(collectionRevision: string): void;
  removeIndexTarget(collectionRevision: string): void;
  findAuthorizedMemories(input: AuthorizedMemoryInput, ids: string[]): MemoryRecord[];
  findExactAuthorizedMemories(input: AuthorizedMemoryInput, terms: string[], limit: number): MemoryRecord[];
  recordRetrievalRun(input: MemoryRetrievalRunInput): void;
  listRetrievalRuns(limit?: number): MemoryRetrievalRunRecord[];
  recordAccessAudit(input: MemoryAccessAuditInput): void;
  listAccessAudits(limit?: number): MemoryAccessAuditRecord[];
  reconcileSemanticIndexRevision(collectionRevision: string, now: string): number;
  claimSemanticIndexOutbox(options: ClaimSemanticIndexOutboxOptions): SemanticIndexOutboxItem[];
  completeSemanticIndexOutbox(id: string, workerId: string, indexedAt: string): boolean;
  failSemanticIndexOutbox(id: string, workerId: string, error: string, retryAt: string, deadLetter: boolean, updatedAt: string): boolean;
}

export class DreamCancelledError extends Error {
  constructor() { super("DREAM_CANCELLED"); }
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "{}"; }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizedObject(value: string | null): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalize(typeof parsed === "string" ? parsed : JSON.stringify(parsed));
  } catch { return normalize(value); }
}

function factIdentity(row: Pick<MemoryRow, "subject" | "predicate" | "object_json">): string {
  return `${normalize(row.subject ?? "")}\0${normalize(row.predicate ?? "")}\0${normalizedObject(row.object_json)}`;
}

function factPredicate(row: Pick<MemoryRow, "subject" | "predicate">): string {
  return `${normalize(row.subject ?? "")}\0${normalize(row.predicate ?? "")}`;
}

function redactAuditText(value: string, max = 500): string {
  const clean = value.replace(/(?:sk|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function rowToDream(row: DreamRow): DreamRun {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    processedEvents: row.processed_events,
    createdL2: row.created_l2,
    promotedL3: row.promoted_l3,
    error: row.error ?? undefined,
  };
}

function indexProjectionHash(row: Pick<MemoryRow, "project_id" | "agent_id" | "team_id" | "level" | "kind" | "content" | "summary" | "status" | "scope" | "trust_level" | "valid_from" | "valid_to" | "salience" | "confidence">): string {
  return createHash("sha256").update(JSON.stringify({
    projectId: row.project_id,
    ownerAgentId: row.agent_id,
    teamId: row.team_id,
    level: row.level,
    kind: row.kind,
    content: `${row.summary}\n${row.content}`,
    status: row.status,
    scope: row.scope,
    trustLevel: row.trust_level,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    salience: row.salience,
    confidence: row.confidence,
  })).digest("hex");
}

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly db: Database.Database;

  constructor(private readonly projectId: string, databasePath: string, private readonly policy: MemoryPolicy = new DefaultMemoryPolicy()) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL,
        source_agent_id TEXT,
        role TEXT NOT NULL,
        event_type TEXT NOT NULL,
        task_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        consolidated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memory_events_pending ON memory_events(consolidated, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_events_owner ON memory_events(owner_agent_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        team_id TEXT,
        level TEXT NOT NULL CHECK(level IN ('L1','L2','L3')),
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        confidence REAL NOT NULL,
        salience REAL NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        source_event_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_confirmed_at TEXT NOT NULL,
        UNIQUE(agent_id, level, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_items_lookup ON memory_items(agent_id, level, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS dream_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        processed_events INTEGER NOT NULL DEFAULT 0,
        created_l2 INTEGER NOT NULL DEFAULT 0,
        promoted_l3 INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_injections (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        query TEXT NOT NULL,
        memory_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const migrateV2 = this.db.transaction(() => {
      const previousSchemaVersion = Number(this.db.pragma("user_version", { simple: true }));
      const columns = new Set((this.db.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>).map((column) => column.name));
      const needsTrustBackfill = previousSchemaVersion < 2 || !columns.has("trust_level");
      const needsIndexStateBackfill = previousSchemaVersion < 2 || !columns.has("index_state");
      const additions: Array<[string, string]> = [
        ["schema_version", "INTEGER NOT NULL DEFAULT 2"],
        ["scope", "TEXT NOT NULL DEFAULT 'project'"],
        ["trust_level", "INTEGER NOT NULL DEFAULT 100"],
        ["subject", "TEXT"],
        ["predicate", "TEXT"],
        ["object_json", "TEXT"],
        ["valid_from", "TEXT"],
        ["valid_to", "TEXT"],
        ["supersedes_id", "TEXT"],
        ["contradiction_ids", "TEXT NOT NULL DEFAULT '[]'"],
        ["content_hash", "TEXT NOT NULL DEFAULT ''"],
        ["extraction_model", "TEXT"],
        ["extraction_version", "TEXT"],
        ["index_state", "TEXT NOT NULL DEFAULT 'not_applicable'"],
      ];
      for (const [name, definition] of additions) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE memory_items ADD COLUMN ${name} ${definition}`);
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_index_outbox (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
          target_index TEXT NOT NULL DEFAULT 'default',
          content_hash TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','dead_letter')),
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(memory_id, operation, content_hash, target_index),
          FOREIGN KEY(memory_id) REFERENCES memory_items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_outbox_claim ON memory_index_outbox(status, next_attempt_at, created_at);

        CREATE TABLE IF NOT EXISTS memory_retrieval_runs (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          query TEXT NOT NULL,
          scope_json TEXT NOT NULL DEFAULT '{}',
          backend TEXT NOT NULL,
          embedding_identity TEXT,
          candidate_ids TEXT NOT NULL DEFAULT '[]',
          selected_ids TEXT NOT NULL DEFAULT '[]',
          latency_ms REAL NOT NULL DEFAULT 0,
          fallback_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_retrieval_runs_created ON memory_retrieval_runs(created_at DESC);

        CREATE TABLE IF NOT EXISTS memory_feedback (
          id TEXT PRIMARY KEY,
          retrieval_run_id TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          signal TEXT NOT NULL CHECK(signal IN ('used','ignored','helpful','harmful','stale')),
          task_id TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(retrieval_run_id) REFERENCES memory_retrieval_runs(id),
          FOREIGN KEY(memory_id) REFERENCES memory_items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_feedback_run ON memory_feedback(retrieval_run_id, created_at);

        CREATE TABLE IF NOT EXISTS memory_relations (
          source_memory_id TEXT NOT NULL,
          relation TEXT NOT NULL CHECK(relation IN ('supersedes','contradicts','depends_on','applies_to','verified_by')),
          target_memory_id TEXT NOT NULL,
          valid_from TEXT,
          valid_to TEXT,
          confidence REAL NOT NULL DEFAULT 1,
          source_event_id TEXT,
          PRIMARY KEY(source_memory_id, relation, target_memory_id),
          FOREIGN KEY(source_memory_id) REFERENCES memory_items(id),
          FOREIGN KEY(target_memory_id) REFERENCES memory_items(id),
          FOREIGN KEY(source_event_id) REFERENCES memory_events(id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_memory_id, relation);
      `);

      if (needsTrustBackfill) {
        this.db.prepare(`UPDATE memory_items SET trust_level = CASE
          WHEN EXISTS (SELECT 1 FROM json_each(memory_items.source_event_ids) source JOIN memory_events event ON event.id=source.value WHERE event.role='worker' OR event.source_agent_id GLOB '*-worker-[0-9]*') THEN 80
          WHEN EXISTS (SELECT 1 FROM json_each(memory_items.source_event_ids) source JOIN memory_events event ON event.id=source.value WHERE event.role='leader') THEN 90
          ELSE 100 END`).run();
      }
      if (needsIndexStateBackfill) {
        this.db.prepare("UPDATE memory_items SET index_state=CASE WHEN level IN ('L2','L3') AND status='active' THEN 'pending' ELSE 'not_applicable' END").run();
      }

      const unhashed = this.db.prepare("SELECT * FROM memory_items WHERE content_hash='' OR content_hash IS NULL").all() as MemoryRow[];
      const setHash = this.db.prepare("UPDATE memory_items SET content_hash=? WHERE id=?");
      for (const row of unhashed) setHash.run(indexProjectionHash(row), row.id);

      this.db.pragma("user_version = 2");
    });
    migrateV2.immediate();

    const migrateV3 = this.db.transaction(() => {
      const outboxColumns = new Set((this.db.prepare("PRAGMA table_info(memory_index_outbox)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!outboxColumns.has("lease_owner")) this.db.exec("ALTER TABLE memory_index_outbox ADD COLUMN lease_owner TEXT");
      if (!outboxColumns.has("lease_expires_at")) this.db.exec("ALTER TABLE memory_index_outbox ADD COLUMN lease_expires_at TEXT");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_index_registry (
          collection_revision TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          embedding_revision TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('building','ready','active','retired','failed')),
          path TEXT NOT NULL,
          snapshot_watermark TEXT,
          document_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          ready_at TEXT,
          activated_at TEXT,
          retired_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_index_registry_project_state
          ON memory_index_registry(project_id, state, created_at);
        CREATE TABLE IF NOT EXISTS memory_index_memberships (
          memory_id TEXT NOT NULL,
          collection_revision TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          embedding_revision TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','indexed','failed','deleted')),
          indexed_at TEXT,
          error TEXT,
          PRIMARY KEY(memory_id, collection_revision),
          FOREIGN KEY(memory_id) REFERENCES memory_items(id),
          FOREIGN KEY(collection_revision) REFERENCES memory_index_registry(collection_revision)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_index_memberships_revision_status
          ON memory_index_memberships(collection_revision, status, memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_outbox_lease
          ON memory_index_outbox(target_index, status, next_attempt_at, lease_expires_at, created_at);
      `);
      /* v2's synthetic target has no embedding/schema identity and is unsafe to consume. */
      this.db.prepare("DELETE FROM memory_index_outbox WHERE target_index='default'").run();
      this.db.prepare("UPDATE memory_items SET index_state='not_applicable' WHERE level IN ('L2','L3') AND NOT EXISTS (SELECT 1 FROM memory_index_memberships membership WHERE membership.memory_id=memory_items.id)").run();
      this.db.pragma("user_version = 3");
    });
    migrateV3.immediate();

    const migrateV4 = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_index_migrations (
          collection_revision TEXT PRIMARY KEY,
          source_collection_revision TEXT,
          status TEXT NOT NULL CHECK(status IN ('backfilling','paused','validating','ready','active','failed','retired')),
          snapshot_watermark TEXT NOT NULL,
          total_items INTEGER NOT NULL DEFAULT 0,
          pause_reason TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(collection_revision) REFERENCES memory_index_registry(collection_revision)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_index_migrations_status
          ON memory_index_migrations(status, updated_at);
      `);
      this.db.pragma("user_version = 4");
    });
    migrateV4.immediate();

    const migrateV5 = this.db.transaction(() => {
      const eventColumns = new Set((this.db.prepare("PRAGMA table_info(memory_events)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!eventColumns.has("extraction_attempts")) this.db.exec("ALTER TABLE memory_events ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 0");
      if (!eventColumns.has("extraction_error")) this.db.exec("ALTER TABLE memory_events ADD COLUMN extraction_error TEXT");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_extraction_runs (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          model TEXT NOT NULL,
          extraction_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('success','rejected','failed')),
          candidate_count INTEGER NOT NULL DEFAULT 0,
          input_chars INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER,
          output_tokens INTEGER,
          latency_ms REAL NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(event_id) REFERENCES memory_events(id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_event ON memory_extraction_runs(event_id, created_at DESC);
      `);
      this.db.pragma("user_version = 5");
    });
    migrateV5.immediate();

    const migrateV6 = this.db.transaction(() => {
      const itemColumns = new Set((this.db.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>).map((column) => column.name));
      const needsEvidenceBackfill = !itemColumns.has("independent_evidence_count");
      const additions: Array<[string, string]> = [
        ["independent_evidence_count", "INTEGER NOT NULL DEFAULT 1"],
        ["governance_version", "TEXT"],
        ["confirmed_at", "TEXT"],
        ["confirmed_by", "TEXT"],
      ];
      for (const [name, definition] of additions) if (!itemColumns.has(name)) this.db.exec(`ALTER TABLE memory_items ADD COLUMN ${name} ${definition}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_candidate_matches (
          candidate_memory_id TEXT NOT NULL,
          target_memory_id TEXT NOT NULL,
          match_type TEXT NOT NULL CHECK(match_type IN ('exact_duplicate','semantic_duplicate','conflict')),
          score REAL NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('suggested','accepted','rejected')),
          governance_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(candidate_memory_id, target_memory_id, match_type),
          FOREIGN KEY(candidate_memory_id) REFERENCES memory_items(id),
          FOREIGN KEY(target_memory_id) REFERENCES memory_items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_candidate_matches_target
          ON memory_candidate_matches(target_memory_id, match_type, status);
        CREATE TABLE IF NOT EXISTS memory_governance_runs (
          id TEXT PRIMARY KEY,
          candidate_memory_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('retained','merged','activated','disputed','expired')),
          canonical_memory_id TEXT,
          independent_evidence_count INTEGER NOT NULL DEFAULT 1,
          auto_promoted_l3 INTEGER NOT NULL DEFAULT 0,
          semantic_identity TEXT,
          semantic_error TEXT,
          governance_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(candidate_memory_id) REFERENCES memory_items(id),
          FOREIGN KEY(canonical_memory_id) REFERENCES memory_items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_governance_runs_candidate
          ON memory_governance_runs(candidate_memory_id, created_at DESC);
      `);
      if (needsEvidenceBackfill) {
        const items = this.db.prepare("SELECT id, source_event_ids FROM memory_items").all() as Array<{ id: string; source_event_ids: string }>;
        const update = this.db.prepare("UPDATE memory_items SET independent_evidence_count=? WHERE id=?");
        for (const item of items) update.run(this.independentEvidenceCount(parseJsonArray(item.source_event_ids)), item.id);
      }
      this.db.pragma("user_version = 6");
    });
    migrateV6.immediate();

    const migrateV7 = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_access_audit (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL CHECK(action IN ('list','retrieve','inject','federated_search','candidate_write','confirm','promote','forget','govern')),
          decision TEXT NOT NULL CHECK(decision IN ('allowed','denied')),
          actor_id TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          actor_employment TEXT NOT NULL CHECK(actor_employment IN ('internal','external')),
          actor_project_id TEXT,
          actor_team_id TEXT,
          requested_project_id TEXT NOT NULL,
          memory_ids TEXT NOT NULL DEFAULT '[]',
          reason TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_access_audit_actor
          ON memory_access_audit(actor_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_access_audit_decision
          ON memory_access_audit(decision, action, created_at DESC);
      `);
      // Before M13, deterministic Leader consolidation always wrote `project`
      // even though ownership was team-scoped. Structured (schema v3) facts
      // retain their explicit model-governed scope.
      this.db.prepare("UPDATE memory_items SET scope='team' WHERE schema_version=2 AND level IN ('L2','L3') AND scope='project' AND team_id IS NOT NULL AND agent_id<>'admin'").run();
      this.db.pragma("user_version = 7");
    });
    migrateV7.immediate();

    const migrateV8 = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_collections (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          visibility TEXT NOT NULL CHECK(visibility IN ('team','project','restricted')),
          team_id TEXT,
          allowed_agent_ids TEXT NOT NULL DEFAULT '[]',
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, name)
        );
        CREATE TABLE IF NOT EXISTS knowledge_sources (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          collection_id TEXT NOT NULL,
          path TEXT NOT NULL,
          canonical_path TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          origin TEXT NOT NULL CHECK(origin IN ('agent_output','user_upload','workspace_file','migration')),
          created_by_agent_id TEXT,
          source_task_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending','parsing','indexing','ready','unsupported','failed','deleted')),
          version INTEGER NOT NULL DEFAULT 1,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          indexed_at TEXT,
          UNIQUE(project_id, canonical_path),
          FOREIGN KEY(collection_id) REFERENCES knowledge_collections(id)
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_sources_collection_status
          ON knowledge_sources(collection_id, status, updated_at DESC);
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          heading TEXT,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          token_count INTEGER NOT NULL DEFAULT 0,
          page_number INTEGER,
          line_start INTEGER,
          line_end INTEGER,
          index_state TEXT NOT NULL DEFAULT 'pending' CHECK(index_state IN ('pending','indexed','failed','not_applicable')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(source_id, ordinal),
          FOREIGN KEY(source_id) REFERENCES knowledge_sources(id)
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks(source_id, ordinal);
        CREATE TABLE IF NOT EXISTS semantic_documents (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          resource_type TEXT NOT NULL CHECK(resource_type IN ('memory','knowledge')),
          resource_id TEXT NOT NULL,
          source_id TEXT,
          owner_agent_id TEXT,
          visibility TEXT NOT NULL CHECK(visibility IN ('private','team','project','restricted')),
          team_id TEXT,
          allowed_agent_ids TEXT NOT NULL DEFAULT '[]',
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','superseded','deleted')),
          metadata_json TEXT NOT NULL DEFAULT '{}',
          index_state TEXT NOT NULL DEFAULT 'pending' CHECK(index_state IN ('pending','indexed','failed','not_applicable')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, resource_type, resource_id),
          CHECK((resource_type='memory' AND visibility='private' AND owner_agent_id IS NOT NULL)
             OR (resource_type='knowledge' AND source_id IS NOT NULL AND visibility<>'private'))
        );
        CREATE INDEX IF NOT EXISTS idx_semantic_documents_lookup
          ON semantic_documents(project_id, resource_type, owner_agent_id, visibility, team_id, status, updated_at DESC);
        CREATE TABLE IF NOT EXISTS semantic_index_outbox (
          id TEXT PRIMARY KEY,
          semantic_document_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
          collection_revision TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','dead_letter')),
          lease_owner TEXT,
          lease_expires_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(semantic_document_id, operation, content_hash, collection_revision),
          FOREIGN KEY(semantic_document_id) REFERENCES semantic_documents(id)
        );
        CREATE INDEX IF NOT EXISTS idx_semantic_outbox_claim
          ON semantic_index_outbox(collection_revision, status, next_attempt_at, lease_expires_at, created_at);
        CREATE TABLE IF NOT EXISTS maintenance_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK(trigger IN ('task_completed','session_ending','event_threshold','manual','task_resume')),
          status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
          pending_event_ids TEXT NOT NULL DEFAULT '[]',
          proposed_mutations INTEGER NOT NULL DEFAULT 0,
          applied_mutations INTEGER NOT NULL DEFAULT 0,
          rejected_mutations INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          completed_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_maintenance_runs_agent_status
          ON maintenance_runs(project_id, agent_id, status, created_at DESC);
        CREATE TABLE IF NOT EXISTS memory_ownership_quarantine (
          memory_id TEXT PRIMARY KEY,
          previous_owner_agent_id TEXT NOT NULL,
          proposed_owner_agent_id TEXT,
          reason TEXT NOT NULL,
          source_event_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          FOREIGN KEY(memory_id) REFERENCES memory_items(id)
        );
        CREATE TRIGGER IF NOT EXISTS trg_memory_semantic_insert
        AFTER INSERT ON memory_items BEGIN
          INSERT INTO semantic_documents
            (id, project_id, resource_type, resource_id, owner_agent_id, visibility, content, content_hash,
             status, metadata_json, index_state, created_at, updated_at)
          VALUES
            ('memory:' || NEW.id, NEW.project_id, 'memory', NEW.id, NEW.agent_id, 'private',
             NEW.summary || char(10) || NEW.content, NEW.content_hash,
             CASE WHEN NEW.status='active' THEN 'active' ELSE 'superseded' END,
             json_object('level', NEW.level, 'kind', NEW.kind, 'confidence', NEW.confidence, 'salience', NEW.salience),
             CASE WHEN NEW.level='L1' THEN 'not_applicable' ELSE NEW.index_state END, NEW.created_at, NEW.updated_at)
          ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET
            owner_agent_id=excluded.owner_agent_id, visibility='private', content=excluded.content,
            content_hash=excluded.content_hash, status=excluded.status, metadata_json=excluded.metadata_json,
            index_state=excluded.index_state, updated_at=excluded.updated_at;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_memory_semantic_update
        AFTER UPDATE ON memory_items BEGIN
          INSERT INTO semantic_documents
            (id, project_id, resource_type, resource_id, owner_agent_id, visibility, content, content_hash,
             status, metadata_json, index_state, created_at, updated_at)
          VALUES
            ('memory:' || NEW.id, NEW.project_id, 'memory', NEW.id, NEW.agent_id, 'private',
             NEW.summary || char(10) || NEW.content, NEW.content_hash,
             CASE WHEN NEW.status='active' THEN 'active' ELSE 'superseded' END,
             json_object('level', NEW.level, 'kind', NEW.kind, 'confidence', NEW.confidence, 'salience', NEW.salience),
             CASE WHEN NEW.level='L1' THEN 'not_applicable' ELSE NEW.index_state END, NEW.created_at, NEW.updated_at)
          ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET
            owner_agent_id=excluded.owner_agent_id, visibility='private', content=excluded.content,
            content_hash=excluded.content_hash, status=excluded.status, metadata_json=excluded.metadata_json,
            index_state=excluded.index_state, updated_at=excluded.updated_at;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_memory_semantic_delete
        AFTER DELETE ON memory_items BEGIN
          UPDATE semantic_documents SET status='deleted', index_state='pending', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE project_id=OLD.project_id AND resource_type='memory' AND resource_id=OLD.id;
        END;
      `);

      const now = new Date().toISOString();
      const rows = this.db.prepare("SELECT * FROM memory_items WHERE project_id=?").all(this.projectId) as MemoryRow[];
      const eventOwners = this.db.prepare(`SELECT source_agent_id, role FROM memory_events WHERE id IN (SELECT value FROM json_each(?))`) as Database.Statement<[string]>;
      const conflicting = this.db.prepare("SELECT id FROM memory_items WHERE project_id=? AND agent_id=? AND level=? AND fingerprint=? AND id<>?");
      const quarantine = this.db.prepare(`INSERT OR REPLACE INTO memory_ownership_quarantine
        (memory_id, previous_owner_agent_id, proposed_owner_agent_id, reason, source_event_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
      const reassign = this.db.prepare("UPDATE memory_items SET agent_id=?, team_id=?, scope='private', index_state=CASE WHEN level IN ('L2','L3') AND status='active' THEN 'pending' ELSE 'not_applicable' END, updated_at=? WHERE id=?");
      const makePrivate = this.db.prepare("UPDATE memory_items SET scope='private', index_state=CASE WHEN level IN ('L2','L3') AND status='active' THEN 'pending' ELSE 'not_applicable' END WHERE id=?");
      for (const row of rows) {
        const sources = parseJsonArray(row.source_event_ids);
        const owners = sources.length
          ? [...new Set((eventOwners.all(safeJson(sources)) as Array<{ source_agent_id: string | null; role: string }>)
              .filter((event) => event.role === 'worker' && event.source_agent_id)
              .map((event) => event.source_agent_id!))]
          : [];
        if (owners.length === 1 && owners[0] !== row.agent_id) {
          const owner = owners[0]!;
          const conflict = conflicting.get(this.projectId, owner, row.level, row.fingerprint, row.id) as { id: string } | undefined;
          if (conflict) quarantine.run(row.id, row.agent_id, owner, "target_owner_fingerprint_conflict", safeJson(sources), now);
          else reassign.run(owner, this.teamFor(owner), now, row.id);
        } else {
          if (owners.length > 1) quarantine.run(row.id, row.agent_id, null, "mixed_worker_sources", safeJson(sources), now);
          makePrivate.run(row.id);
        }
      }
      this.db.prepare("UPDATE memory_events SET owner_agent_id=source_agent_id WHERE role='worker' AND source_agent_id IS NOT NULL AND source_agent_id<>owner_agent_id").run();

      const refreshed = this.db.prepare("SELECT * FROM memory_items WHERE project_id=?").all(this.projectId) as MemoryRow[];
      const updateHash = this.db.prepare("UPDATE memory_items SET content_hash=? WHERE id=?");
      const upsertSemantic = this.db.prepare(`INSERT INTO semantic_documents
        (id, project_id, resource_type, resource_id, owner_agent_id, visibility, content, content_hash, status, metadata_json, index_state, created_at, updated_at)
        VALUES (?, ?, 'memory', ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET owner_agent_id=excluded.owner_agent_id,
          visibility='private', content=excluded.content, content_hash=excluded.content_hash, status=excluded.status,
          metadata_json=excluded.metadata_json, index_state=excluded.index_state, updated_at=excluded.updated_at`);
      for (const row of refreshed) {
        const hash = indexProjectionHash({ ...row, scope: "private" });
        updateHash.run(hash, row.id);
        upsertSemantic.run(`memory:${row.id}`, this.projectId, row.id, row.agent_id, `${row.summary}\n${row.content}`, hash,
          row.status === "active" ? "active" : "superseded", safeJson({ level: row.level, kind: row.kind, confidence: row.confidence, salience: row.salience }),
          row.level === "L1" ? "not_applicable" : row.index_state, row.created_at, row.updated_at);
      }
      this.db.pragma("user_version = 8");
    });
    migrateV8.immediate();
    const migrateV9 = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_index_memberships (
          semantic_document_id TEXT NOT NULL,
          collection_revision TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','indexed','failed','deleted')),
          indexed_at TEXT,
          error TEXT,
          PRIMARY KEY(semantic_document_id, collection_revision),
          FOREIGN KEY(semantic_document_id) REFERENCES semantic_documents(id),
          FOREIGN KEY(collection_revision) REFERENCES memory_index_registry(collection_revision)
        );
        CREATE INDEX IF NOT EXISTS idx_semantic_memberships_revision_status
          ON semantic_index_memberships(collection_revision, status, semantic_document_id);
      `);
      this.db.pragma("user_version = 9");
    });
    migrateV9.immediate();
    this.db.prepare("UPDATE dream_runs SET status='failed', completed_at=?, error=COALESCE(error, 'Interrupted by process restart') WHERE status='running'")
      .run(new Date().toISOString());
  }

  private rowToMemory(row: MemoryRow): MemoryRecord {
    const sourceEventIds = parseJsonArray(row.source_event_ids);
    const memory: MemoryRecord = {
      id: row.id,
      projectId: row.project_id,
      agentId: row.agent_id,
      teamId: row.team_id ?? undefined,
      level: row.level,
      kind: row.kind,
      content: row.content,
      summary: row.summary,
      confidence: row.confidence,
      salience: row.salience,
      evidenceCount: row.evidence_count,
      independentEvidenceCount: row.independent_evidence_count,
      sourceEventIds,
      sources: [],
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastConfirmedAt: row.last_confirmed_at,
      schemaVersion: row.schema_version,
      scope: row.scope,
      trustLevel: row.trust_level,
      subject: row.subject ?? undefined,
      predicate: row.predicate ?? undefined,
      object: row.object_json ? JSON.parse(row.object_json) as unknown : undefined,
      validFrom: row.valid_from ?? undefined,
      validTo: row.valid_to ?? undefined,
      supersedesId: row.supersedes_id ?? undefined,
      contradictionIds: parseJsonArray(row.contradiction_ids),
      contentHash: row.content_hash,
      extractionModel: row.extraction_model ?? undefined,
      extractionVersion: row.extraction_version ?? undefined,
      governanceVersion: row.governance_version ?? undefined,
      confirmedAt: row.confirmed_at ?? undefined,
      confirmedBy: row.confirmed_by ?? undefined,
      indexState: row.index_state,
    };
    if (!sourceEventIds.length) return memory;
    const placeholders = sourceEventIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id, source_agent_id, role, event_type, created_at FROM memory_events WHERE id IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...sourceEventIds) as Array<{ id: string; source_agent_id: string | null; role: string; event_type: string; created_at: string }>;
    const sources: MemorySource[] = rows.map((source) => ({
      eventId: source.id,
      agentId: source.source_agent_id ?? undefined,
      role: source.role,
      eventType: source.event_type,
      createdAt: source.created_at,
    }));
    return { ...memory, sources };
  }

  private independentEvidenceCount(sourceEventIds: string[]): number {
    const ids = [...new Set(sourceEventIds)];
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id, source_agent_id, task_id,
      CASE
        WHEN lower(COALESCE(json_extract(metadata_json, '$.sourceType'), '')) IN ('a2a','external_agent','external-agent') THEN 'a2a'
        WHEN lower(COALESCE(json_extract(metadata_json, '$.sourceType'), ''))='channel'
          OR json_extract(metadata_json, '$.channelId') IS NOT NULL THEN 'channel'
        ELSE 'internal' END AS source_type
      FROM memory_events WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string; source_agent_id: string | null; task_id: string | null; source_type: string }>;
    const keys = new Set(rows.map((row) => `${row.source_type}\0${row.source_agent_id ?? "unknown"}\0${row.task_id ?? "unscoped"}`));
    return Math.max(1, keys.size);
  }

  private hasOnlyInternalEvidence(sourceEventIds: string[]): boolean {
    const ids = [...new Set(sourceEventIds)];
    if (!ids.length) return false;
    const placeholders = ids.map(() => "?").join(",");
    const row = this.db.prepare(`SELECT COUNT(*) AS external FROM memory_events WHERE id IN (${placeholders}) AND (
      lower(COALESCE(json_extract(metadata_json, '$.sourceType'), '')) IN ('a2a','external_agent','external-agent','channel')
      OR json_extract(metadata_json, '$.channelId') IS NOT NULL
    )`).get(...ids) as { external: number };
    return row.external === 0;
  }

  private pruneL1(agentId: string, maxItems: number): void {
    this.db.prepare(`DELETE FROM memory_items WHERE id IN (
      SELECT id FROM memory_items WHERE project_id=? AND agent_id=? AND level='L1' ORDER BY updated_at DESC LIMIT -1 OFFSET ?
    )`).run(this.projectId, agentId, maxItems);
  }

  private refreshHash(row: MemoryRow): MemoryRow {
    const contentHash = indexProjectionHash(row);
    if (contentHash !== row.content_hash) this.db.prepare("UPDATE memory_items SET content_hash=? WHERE id=?").run(contentHash, row.id);
    return { ...row, content_hash: contentHash };
  }

  private enqueueIndexForTarget(row: MemoryRow, operation: "upsert" | "delete", target: Pick<MemoryIndexRegistryRecord, "collectionRevision" | "embeddingRevision">, now = new Date().toISOString()): void {
    const current = this.refreshHash(row);
    const outboxHash = operation === "delete"
      ? createHash("sha256").update(`${current.id}\0delete`).digest("hex")
      : current.content_hash;
    const existing = this.db.prepare("SELECT content_hash, status FROM memory_index_memberships WHERE memory_id=? AND collection_revision=?")
      .get(current.id, target.collectionRevision) as { content_hash: string; status: MemoryIndexMembershipState } | undefined;
    if (operation === "upsert" && existing?.content_hash === current.content_hash && (existing.status === "indexed" || existing.status === "failed")) {
      this.refreshIndexState(current.id);
      return;
    }
    if (operation === "delete" && existing?.status === "deleted") {
      this.refreshIndexState(current.id);
      return;
    }
    this.db.prepare(`INSERT INTO memory_index_memberships
      (memory_id, collection_revision, content_hash, embedding_revision, status, indexed_at, error)
      VALUES (?, ?, ?, ?, 'pending', NULL, NULL)
      ON CONFLICT(memory_id, collection_revision) DO UPDATE SET
        content_hash=excluded.content_hash, embedding_revision=excluded.embedding_revision, status='pending', indexed_at=NULL, error=NULL`)
      .run(current.id, target.collectionRevision, current.content_hash, target.embeddingRevision);
    this.db.prepare(`UPDATE memory_index_outbox SET status='completed', error='Superseded by a newer index mutation', updated_at=?
      WHERE memory_id=? AND target_index=? AND status='pending' AND (
        operation='upsert' AND (content_hash<>? OR ?='delete')
      )`).run(now, current.id, target.collectionRevision, outboxHash, operation);
    this.db.prepare(`INSERT OR IGNORE INTO memory_index_outbox
      (id, memory_id, operation, target_index, content_hash, attempts, next_attempt_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?)`)
      .run(randomUUID(), current.id, operation, target.collectionRevision, outboxHash, now, now, now);
    this.refreshIndexState(current.id);
  }

  private enqueueIndex(row: MemoryRow, operation: "upsert" | "delete"): void {
    const targets = this.db.prepare(`SELECT collection_revision, embedding_revision FROM memory_index_registry
      WHERE project_id=? AND state IN ('building','ready','active') ORDER BY created_at`)
      .all(this.projectId) as Array<{ collection_revision: string; embedding_revision: string }>;
    for (const target of targets) this.enqueueIndexForTarget(row, operation, {
      collectionRevision: target.collection_revision,
      embeddingRevision: target.embedding_revision,
    });
    if (!targets.length) this.db.prepare("UPDATE memory_items SET index_state='not_applicable' WHERE id=?").run(row.id);
  }

  private refreshIndexState(memoryId: string): void {
    const statuses = this.db.prepare("SELECT status FROM memory_index_memberships WHERE memory_id=?").all(memoryId) as Array<{ status: MemoryIndexMembershipState }>;
    const state: MemoryRecord["indexState"] = !statuses.length ? "not_applicable"
      : statuses.some(({ status }) => status === "failed") ? "failed"
        : statuses.some(({ status }) => status === "pending") ? "pending"
          : statuses.some(({ status }) => status === "indexed") ? "indexed" : "not_applicable";
    this.db.prepare("UPDATE memory_items SET index_state=? WHERE id=?").run(state, memoryId);
  }

  latestEventCreatedAt(): string | undefined {
    return (this.db.prepare("SELECT created_at FROM memory_events WHERE project_id=? ORDER BY created_at DESC LIMIT 1").get(this.projectId) as { created_at?: string } | undefined)?.created_at;
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory_items WHERE project_id=? AND id=?").get(this.projectId, id) as MemoryRow | undefined;
    return row ? this.rowToMemory(row) : undefined;
  }

  removeUnsupportedStreamingFragments(): void {
    const rows = this.db.prepare("SELECT id FROM memory_events WHERE project_id=? AND event_type='pi.message_update' AND consolidated=0")
      .all(this.projectId) as Array<{ id: string }>;
    const removeL1 = this.db.prepare("DELETE FROM memory_items WHERE project_id=? AND level='L1' AND source_event_ids=?");
    const removeEvent = this.db.prepare("DELETE FROM memory_events WHERE id=?");
    this.db.transaction(() => {
      for (const { id } of rows) {
        removeL1.run(this.projectId, safeJson([id]));
        removeEvent.run(id);
      }
    })();
  }

  enforceL1Retention(ttlHours: number, maxItems: number): void {
    const cutoff = new Date(Date.now() - ttlHours * 3_600_000).toISOString();
    this.db.prepare("DELETE FROM memory_items WHERE project_id=? AND level='L1' AND updated_at<?").run(this.projectId, cutoff);
    const agents = this.db.prepare("SELECT DISTINCT agent_id FROM memory_items WHERE project_id=? AND level='L1'").all(this.projectId) as Array<{ agent_id: string }>;
    for (const { agent_id } of agents) this.pruneL1(agent_id, maxItems);
  }

  capture(input: CapturedMemoryEvent, l1MaxItems: number): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO memory_events
        (id, project_id, owner_agent_id, source_agent_id, role, event_type, task_id, kind, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, this.projectId, input.ownerAgentId, input.sourceAgentId, input.role, input.eventType, input.taskId ?? null, input.kind, input.content, input.metadataJson, input.createdAt);
      this.db.prepare(`INSERT INTO memory_items
        (id, project_id, agent_id, team_id, level, kind, content, summary, fingerprint, confidence, salience, source_event_ids, created_at, updated_at, last_confirmed_at,
         schema_version, scope, trust_level, contradiction_ids, content_hash, index_state)
        VALUES (?, ?, ?, ?, 'L1', 'working', ?, ?, ?, 1, 1, ?, ?, ?, ?, 2, 'private', ?, '[]', '', 'not_applicable')
        ON CONFLICT(agent_id, level, fingerprint) DO UPDATE SET updated_at=excluded.updated_at, last_confirmed_at=excluded.last_confirmed_at`)
        .run(randomUUID(), this.projectId, input.ownerAgentId, input.teamId ?? null, input.content, input.content, input.fingerprint,
          safeJson([input.id]), input.createdAt, input.createdAt, input.createdAt, input.trustLevel);
      const l1 = this.db.prepare("SELECT * FROM memory_items WHERE project_id=? AND agent_id=? AND level='L1' AND fingerprint=?")
        .get(this.projectId, input.ownerAgentId, input.fingerprint) as MemoryRow;
      this.refreshHash(l1);
      this.pruneL1(input.ownerAgentId, l1MaxItems);
    })();
  }

  list(options: MemoryListOptions = {}): MemoryRecord[] {
    const clauses = ["project_id = ?"];
    const params: unknown[] = [this.projectId];
    if (options.agentId) { clauses.push("agent_id = ?"); params.push(options.agentId); }
    if (options.level) { clauses.push("level = ?"); params.push(options.level); }
    clauses.push("status = ?"); params.push(options.status ?? "active");
    params.push(Math.min(500, Math.max(1, options.limit ?? 100)));
    return (this.db.prepare(`SELECT * FROM memory_items WHERE ${clauses.join(" AND ")} ORDER BY level DESC, salience DESC, updated_at DESC LIMIT ?`).all(...params) as MemoryRow[])
      .map((row) => this.rowToMemory(row));
  }

  listAuthorized(input: AuthorizedMemoryInput, options: MemoryListOptions = {}): MemoryRecord[] {
    const clauses = ["project_id = ?"];
    const params: unknown[] = [this.projectId];
    if (options.agentId) { clauses.push("agent_id = ?"); params.push(options.agentId); }
    if (options.level) { clauses.push("level = ?"); params.push(options.level); }
    clauses.push("status = ?"); params.push(options.status ?? "active");
    const requested = Math.min(500, Math.max(1, options.limit ?? 100));
    const rows = this.db.prepare(`SELECT * FROM memory_items WHERE ${clauses.join(" AND ")} ORDER BY level DESC, salience DESC, updated_at DESC LIMIT 5000`)
      .all(...params) as MemoryRow[];
    return rows.filter((row) => this.isAuthorizedMemory(row, input)).slice(0, requested).map((row) => this.rowToMemory(row));
  }

  recordInjection(agentId: string, query: string, memoryIds: string[], createdAt: string): void {
    this.db.prepare("INSERT INTO memory_injections (id, agent_id, query, memory_ids, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), agentId, query, safeJson(memoryIds), createdAt);
  }

  forget(id: string, updatedAt: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM memory_items WHERE id=? AND project_id=?").get(id, this.projectId) as MemoryRow | undefined;
      if (!row) return false;
      const changes = this.db.prepare("UPDATE memory_items SET status='forgotten', index_state=CASE WHEN level IN ('L2','L3') THEN 'pending' ELSE 'not_applicable' END, updated_at=? WHERE id=?")
        .run(updatedAt, id).changes;
      if (changes && (row.level === "L2" || row.level === "L3")) {
        const updated = this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(id) as MemoryRow;
        this.enqueueIndex(updated, "delete");
      }
      if (changes) {
        const related = this.db.prepare(`SELECT source_memory_id, target_memory_id FROM memory_relations
          WHERE relation='contradicts' AND (source_memory_id=? OR target_memory_id=?)`).all(id, id) as Array<{ source_memory_id: string; target_memory_id: string }>;
        for (const relation of related) {
          const otherId = relation.source_memory_id === id ? relation.target_memory_id : relation.source_memory_id;
          const other = this.db.prepare("SELECT contradiction_ids FROM memory_items WHERE id=? AND project_id=?").get(otherId, this.projectId) as { contradiction_ids: string } | undefined;
          if (other) this.db.prepare("UPDATE memory_items SET contradiction_ids=?, updated_at=? WHERE id=?")
            .run(safeJson(parseJsonArray(other.contradiction_ids).filter((candidateId) => candidateId !== id)), updatedAt, otherId);
        }
        this.db.prepare("UPDATE memory_candidate_matches SET status='rejected' WHERE candidate_memory_id=? AND status='suggested'").run(id);
      }
      return changes > 0;
    })();
  }

  promote(id: string, updatedAt: string, confirmedBy?: string): MemoryRecord | undefined {
    return this.db.transaction(() => {
      let source = this.db.prepare("SELECT * FROM memory_items WHERE id=? AND project_id=? AND level='L2' AND status='active'").get(id, this.projectId) as MemoryRow | undefined;
      if (!source) return undefined;
      if (confirmedBy) {
        this.db.prepare("UPDATE memory_items SET confirmed_at=?, confirmed_by=?, governance_version='m12-v1', updated_at=? WHERE id=?")
          .run(updatedAt, confirmedBy.slice(0, 128), updatedAt, source.id);
        source = this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(source.id) as MemoryRow;
      }
      const fingerprint = createHash("sha256").update(`${source.agent_id}\0L3\0${normalize(source.summary)}`).digest("hex");
      this.db.prepare(`INSERT INTO memory_items
        (id, project_id, agent_id, team_id, level, kind, content, summary, fingerprint, confidence, salience, evidence_count, source_event_ids, status, created_at, updated_at, last_confirmed_at,
         schema_version, scope, trust_level, subject, predicate, object_json, valid_from, valid_to, supersedes_id, contradiction_ids, content_hash, extraction_model, extraction_version, index_state)
        VALUES (?, ?, ?, ?, 'L3', ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(agent_id, level, fingerprint) DO UPDATE SET evidence_count=MAX(evidence_count, excluded.evidence_count), updated_at=excluded.updated_at, index_state='pending'`)
        .run(randomUUID(), source.project_id, source.agent_id, source.team_id, source.kind === "failure-pattern" ? "procedure" : source.kind,
          source.content, source.summary, fingerprint, Math.max(.85, source.confidence), Math.max(.85, source.salience), source.evidence_count,
          source.source_event_ids, updatedAt, updatedAt, updatedAt, source.scope, source.trust_level, source.subject, source.predicate,
          source.object_json, source.valid_from, source.valid_to, source.supersedes_id, source.contradiction_ids, "", source.extraction_model, source.extraction_version);
      const promoted = this.db.prepare("SELECT * FROM memory_items WHERE project_id=? AND agent_id=? AND level='L3' AND fingerprint=?").get(this.projectId, source.agent_id, fingerprint) as MemoryRow;
      this.db.prepare(`UPDATE memory_items SET independent_evidence_count=MAX(independent_evidence_count, ?),
        governance_version=COALESCE(governance_version, ?), confirmed_at=COALESCE(confirmed_at, ?), confirmed_by=COALESCE(confirmed_by, ?)
        WHERE id=?`).run(source.independent_evidence_count, source.governance_version, source.confirmed_at, source.confirmed_by, promoted.id);
      const current = this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(promoted.id) as MemoryRow;
      this.enqueueIndex(current, "upsert");
      return this.rowToMemory(current);
    })();
  }

  currentDream(): DreamRun | undefined {
    const row = this.db.prepare("SELECT * FROM dream_runs WHERE status='running' ORDER BY started_at DESC LIMIT 1").get() as DreamRow | undefined;
    return row ? rowToDream(row) : undefined;
  }

  insertDream(run: DreamRun): void {
    this.db.prepare(`INSERT INTO dream_runs (id, status, trigger, started_at, completed_at, processed_events, created_l2, promoted_l3, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, run.status, run.trigger, run.startedAt, run.completedAt ?? null, run.processedEvents, run.createdL2, run.promotedL3, run.error ?? null);
  }

  finishDream(run: DreamRun): void {
    this.db.prepare("UPDATE dream_runs SET status=?, completed_at=?, processed_events=?, created_l2=?, promoted_l3=?, error=? WHERE id=?")
      .run(run.status, run.completedAt ?? null, run.processedEvents, run.createdL2, run.promotedL3, run.error ?? null, run.id);
  }

  insertMaintenanceRun(run: MemoryMaintenanceRun, createdAt: string): void {
    this.db.prepare(`INSERT INTO maintenance_runs
      (id, project_id, agent_id, trigger, status, pending_event_ids, proposed_mutations, applied_mutations,
       rejected_mutations, started_at, completed_at, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.id, run.projectId, run.agentId, run.trigger, run.status, safeJson(run.pendingEventIds),
      run.proposedMutations, run.appliedMutations, run.rejectedMutations, run.startedAt ?? null,
      run.completedAt ?? null, run.error ?? null, createdAt, createdAt,
    );
  }

  finishMaintenanceRun(run: MemoryMaintenanceRun, updatedAt: string): void {
    this.db.prepare(`UPDATE maintenance_runs SET status=?, pending_event_ids=?, proposed_mutations=?,
      applied_mutations=?, rejected_mutations=?, started_at=?, completed_at=?, error=?, updated_at=? WHERE id=?`).run(
      run.status, safeJson(run.pendingEventIds), run.proposedMutations, run.appliedMutations,
      run.rejectedMutations, run.startedAt ?? null, run.completedAt ?? null, run.error ?? null, updatedAt, run.id,
    );
  }

  pendingMaintenanceAgentIds(limit = 100): string[] {
    return (this.db.prepare(`SELECT owner_agent_id FROM memory_events
      WHERE project_id=? AND consolidated=0 GROUP BY owner_agent_id ORDER BY MIN(created_at) LIMIT ?`)
      .all(this.projectId, Math.min(500, Math.max(1, Math.floor(limit)))) as Array<{ owner_agent_id: string }>)
      .map(({ owner_agent_id }) => owner_agent_id);
  }

  consolidate(input: ConsolidateInput): ConsolidateResult {
    const result: ConsolidateResult = { processedEvents: 0, createdL2: 0, promotedL3: 0 };
    const ownerClause = input.agentId ? " AND owner_agent_id=?" : "";
    const events = this.db.prepare(`SELECT id, owner_agent_id, kind, content, created_at,
      COALESCE(CAST(json_extract(metadata_json, '$.trustLevel') AS INTEGER),
        CASE WHEN source_agent_id GLOB '*-worker-[0-9]*' THEN 80 WHEN role='leader' THEN 90 ELSE 100 END) AS trust_level
      FROM memory_events WHERE project_id=? AND consolidated=0${ownerClause} ORDER BY created_at LIMIT ?`)
      .all(...(input.agentId ? [this.projectId, input.agentId, input.maxEvents] : [this.projectId, input.maxEvents])) as PendingEventRow[];
    this.db.transaction(() => {
      for (const event of events) {
        if (input.isCancelled()) throw new DreamCancelledError();
        const fingerprint = createHash("sha256").update(`${event.owner_agent_id}\0L2\0${normalize(event.content)}`).digest("hex");
        const existing = this.db.prepare("SELECT * FROM memory_items WHERE project_id=? AND agent_id=? AND level='L2' AND fingerprint=?")
          .get(this.projectId, event.owner_agent_id, fingerprint) as MemoryRow | undefined;
        let canonicalId: string;
        if (existing) {
          canonicalId = existing.id;
          const sources = new Set(parseJsonArray(existing.source_event_ids));
          sources.add(event.id);
          this.db.prepare(`UPDATE memory_items SET evidence_count=evidence_count+1, confidence=MIN(1, confidence+0.05),
            salience=MIN(1, salience+0.03), source_event_ids=?, independent_evidence_count=?, updated_at=?, last_confirmed_at=?, index_state='pending' WHERE id=?`)
            .run(safeJson([...sources]), this.independentEvidenceCount([...sources]), event.created_at, event.created_at, existing.id);
          this.enqueueIndex(this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(existing.id) as MemoryRow, "upsert");
        } else {
          const id = randomUUID();
          canonicalId = id;
          this.db.prepare(`INSERT INTO memory_items
            (id, project_id, agent_id, team_id, level, kind, content, summary, fingerprint, confidence, salience, evidence_count, source_event_ids, status, created_at, updated_at, last_confirmed_at,
             schema_version, scope, trust_level, contradiction_ids, content_hash, index_state)
            VALUES (?, ?, ?, ?, 'L2', ?, ?, ?, ?, .65, .6, 1, ?, 'active', ?, ?, ?, 2, ?, ?, '[]', '', 'pending')`)
            .run(id, this.projectId, event.owner_agent_id, this.teamFor(event.owner_agent_id), event.kind, event.content, event.content,
              fingerprint, safeJson([event.id]), event.created_at, event.created_at, event.created_at,
              "private", event.trust_level);
          this.enqueueIndex(this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(id) as MemoryRow, "upsert");
          result.createdL2 += 1;
        }
        this.recordAccessAudit({
          action: "govern", decision: "allowed",
          actor: { id: "memory-governor", role: "system", employment: "internal", projectId: this.projectId, projectIds: [this.projectId] },
          memoryIds: [canonicalId], reason: "legacy_consolidation", createdAt: event.created_at,
        });
        this.db.prepare("UPDATE memory_events SET consolidated=1 WHERE id=?").run(event.id);
        result.processedEvents += 1;
      }

      const promotable = this.db.prepare(`SELECT * FROM memory_items WHERE project_id=?${input.agentId ? " AND agent_id=?" : ""} AND level='L2' AND status='active'
        AND independent_evidence_count>=? AND trust_level>=80 AND contradiction_ids='[]'
        AND (valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>?)`)
        .all(...(input.agentId
          ? [this.projectId, input.agentId, input.minEvidence, new Date().toISOString(), new Date().toISOString()]
          : [this.projectId, input.minEvidence, new Date().toISOString(), new Date().toISOString()])) as MemoryRow[];
      for (const memory of promotable) {
        if (input.isCancelled()) throw new DreamCancelledError();
        const before = (this.db.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE project_id=? AND agent_id=? AND level='L3'").get(this.projectId, memory.agent_id) as { count: number }).count;
        this.promote(memory.id, new Date().toISOString());
        const after = (this.db.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE project_id=? AND agent_id=? AND level='L3'").get(this.projectId, memory.agent_id) as { count: number }).count;
        if (after > before) result.promotedL3 += 1;
      }

      const cutoff = new Date(Date.now() - input.retentionDays * 86_400_000).toISOString();
      const expiryOwnerClause = input.agentId ? " AND agent_id=?" : "";
      const expiring = this.db.prepare(`SELECT * FROM memory_items WHERE project_id=?${expiryOwnerClause} AND level='L2' AND updated_at<? AND status='active'`)
        .all(...(input.agentId ? [this.projectId, input.agentId, cutoff] : [this.projectId, cutoff])) as MemoryRow[];
      this.db.prepare(`UPDATE memory_items SET status='superseded', index_state='pending', updated_at=? WHERE project_id=?${expiryOwnerClause} AND level='L2' AND updated_at<? AND status='active'`)
        .run(...(input.agentId ? [new Date().toISOString(), this.projectId, input.agentId, cutoff] : [new Date().toISOString(), this.projectId, cutoff]));
      for (const row of expiring) this.enqueueIndex(this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(row.id) as MemoryRow, "delete");
      this.enforceL1Retention(input.l1TtlHours, input.l1MaxItems);
    })();
    return result;
  }

  listPendingExtractionEvents(limit: number, maxAttempts: number, agentId?: string): MemoryExtractionEvent[] {
    const rows = this.db.prepare(`SELECT event.id, event.owner_agent_id, event.source_agent_id, event.role, event.event_type,
      event.kind, event.content, event.created_at, event.extraction_attempts,
      CASE
        WHEN lower(COALESCE(json_extract(event.metadata_json, '$.sourceType'), '')) IN ('a2a','external_agent','external-agent') THEN 'a2a'
        WHEN lower(COALESCE(json_extract(event.metadata_json, '$.sourceType'), ''))='channel'
          OR json_extract(event.metadata_json, '$.channelId') IS NOT NULL THEN 'channel'
        ELSE 'internal' END AS source_type,
      COALESCE(CAST(json_extract(event.metadata_json, '$.trustLevel') AS INTEGER),
        CASE WHEN event.source_agent_id GLOB '*-worker-[0-9]*' THEN 80 WHEN event.role='leader' THEN 90 ELSE 100 END) AS trust_level,
      memory.team_id
      FROM memory_events event
      LEFT JOIN memory_items memory ON memory.level='L1' AND memory.project_id=event.project_id
        AND memory.agent_id=event.owner_agent_id AND memory.source_event_ids=json_array(event.id)
      WHERE event.project_id=? AND event.consolidated=0 AND event.extraction_attempts<?${agentId ? " AND event.owner_agent_id=?" : ""}
      ORDER BY event.created_at, event.id LIMIT ?`)
      .all(...(agentId
        ? [this.projectId, Math.max(1, Math.floor(maxAttempts)), agentId, Math.min(5_000, Math.max(1, Math.floor(limit)))]
        : [this.projectId, Math.max(1, Math.floor(maxAttempts)), Math.min(5_000, Math.max(1, Math.floor(limit)))])) as PendingEventRow[];
    return rows.map((row) => ({
      id: row.id,
      ownerAgentId: row.owner_agent_id,
      sourceAgentId: row.source_agent_id ?? undefined,
      role: row.role,
      eventType: row.event_type,
      kind: row.kind,
      content: row.content,
      createdAt: row.created_at,
      teamId: row.team_id ?? this.teamFor(row.owner_agent_id) ?? undefined,
      trustLevel: row.source_type === "a2a" ? Math.min(row.trust_level, 30) : row.source_type === "channel" ? Math.min(row.trust_level, 40) : row.trust_level,
      sourceType: row.source_type,
      attempts: row.extraction_attempts,
    }));
  }

  commitExtraction(event: MemoryExtractionEvent, candidates: GovernedMemoryCandidate[], run: MemoryExtractionRunInput): number {
    return this.db.transaction(() => {
      const pending = this.db.prepare("SELECT consolidated FROM memory_events WHERE id=? AND project_id=?").get(event.id, this.projectId) as { consolidated: number } | undefined;
      if (!pending || pending.consolidated) return 0;
      let created = 0;
      const actorRole: MemoryActor["role"] = event.sourceType === "a2a" ? "worker"
        : event.role === "admin" || event.role === "leader" || event.role === "worker" ? event.role : "worker";
      const actor: MemoryActor = {
        id: event.sourceAgentId ?? event.ownerAgentId,
        role: actorRole,
        employment: event.sourceType === "a2a" ? "external" : "internal",
        projectId: this.projectId,
        teamId: event.teamId,
        projectIds: [this.projectId],
      };
      for (const [index, candidate] of candidates.entries()) {
        const decision = this.policy.candidateWriteDecision(actor, { projectId: this.projectId, teamId: event.teamId, scope: candidate.scope, trustLevel: candidate.trustLevel });
        if (!decision.allowed) {
          this.recordAccessAudit({ action: "candidate_write", decision: "denied", actor, reason: decision.reason, metadata: { extractionRunId: run.id } });
          continue;
        }
        const id = randomUUID();
        const fingerprint = createHash("sha256").update(`${event.id}\0${index}\0${normalize(candidate.subject)}\0${normalize(candidate.predicate)}\0${normalize(candidate.object)}`).digest("hex");
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO memory_items
          (id, project_id, agent_id, team_id, level, kind, content, summary, fingerprint, confidence, salience, evidence_count, source_event_ids, status,
           created_at, updated_at, last_confirmed_at, schema_version, scope, trust_level, subject, predicate, object_json, valid_from, valid_to,
           contradiction_ids, content_hash, extraction_model, extraction_version, index_state)
          VALUES (?, ?, ?, ?, 'L2', ?, ?, ?, ?, ?, ?, 1, ?, 'candidate', ?, ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, '[]', '', ?, ?, 'not_applicable')`)
          .run(id, this.projectId, event.ownerAgentId, event.teamId ?? null, candidate.kind, candidate.content, candidate.summary, fingerprint,
            candidate.confidence, candidate.salience, safeJson([event.id]), event.createdAt, event.createdAt, event.createdAt,
            candidate.scope, candidate.trustLevel, candidate.subject, candidate.predicate, safeJson(candidate.object),
            candidate.validFrom ?? null, candidate.validTo ?? null, run.model, run.version);
        if (inserted.changes) {
          this.refreshHash(this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(id) as MemoryRow);
          this.recordAccessAudit({ action: "candidate_write", decision: "allowed", actor, memoryIds: [id], reason: decision.reason, metadata: { extractionRunId: run.id } });
          created += 1;
        }
      }
      this.db.prepare("UPDATE memory_events SET consolidated=1, extraction_attempts=extraction_attempts+1, extraction_error=NULL WHERE id=? AND project_id=?")
        .run(event.id, this.projectId);
      this.insertExtractionRun({ ...run, status: candidates.length ? "success" : "rejected", candidateCount: created });
      return created;
    })();
  }

  recordExtractionFailure(eventId: string, maxAttempts: number, run: MemoryExtractionRunInput): void {
    this.db.transaction(() => {
      const error = redactAuditText(run.error ?? "Memory extraction failed.", 800);
      this.db.prepare(`UPDATE memory_events SET extraction_attempts=extraction_attempts+1, extraction_error=?,
        consolidated=CASE WHEN extraction_attempts+1>=? THEN 1 ELSE consolidated END
        WHERE id=? AND project_id=? AND consolidated=0`)
        .run(error, Math.max(1, Math.floor(maxAttempts)), eventId, this.projectId);
      this.insertExtractionRun({ ...run, status: "failed", candidateCount: 0, error });
    })();
  }

  finishStructuredConsolidation(retentionDays: number, l1MaxItems: number, l1TtlHours: number, agentId?: string): void {
    this.db.transaction(() => {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      const ownerClause = agentId ? " AND agent_id=?" : "";
      const expiring = this.db.prepare(`SELECT * FROM memory_items WHERE project_id=?${ownerClause} AND level='L2' AND updated_at<? AND status='active'`)
        .all(...(agentId ? [this.projectId, agentId, cutoff] : [this.projectId, cutoff])) as MemoryRow[];
      this.db.prepare(`UPDATE memory_items SET status='superseded', index_state='pending', updated_at=? WHERE project_id=?${ownerClause} AND level='L2' AND updated_at<? AND status='active'`)
        .run(...(agentId ? [new Date().toISOString(), this.projectId, agentId, cutoff] : [new Date().toISOString(), this.projectId, cutoff]));
      for (const row of expiring) this.enqueueIndex(this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(row.id) as MemoryRow, "delete");
      this.enforceL1Retention(l1TtlHours, l1MaxItems);
    })();
  }

  listGovernanceMemories(_limit: number, version: string, agentId?: string): MemoryRecord[] {
    const ownerClause = agentId ? " AND agent_id=?" : "";
    const candidates = this.db.prepare(`SELECT * FROM memory_items WHERE project_id=?${ownerClause} AND level='L2'
      AND status='candidate' AND subject IS NOT NULL AND predicate IS NOT NULL
      ORDER BY CASE WHEN governance_version IS NULL OR governance_version<>? THEN 0 ELSE 1 END, created_at, id LIMIT 5000`)
      .all(...(agentId ? [this.projectId, agentId, version] : [this.projectId, version])) as MemoryRow[];
    const peers = this.db.prepare(`SELECT * FROM memory_items WHERE project_id=?${ownerClause} AND level='L2'
      AND status IN ('active','disputed') AND subject IS NOT NULL AND predicate IS NOT NULL ORDER BY updated_at DESC, id LIMIT 5000`)
      .all(...(agentId ? [this.projectId, agentId] : [this.projectId])) as MemoryRow[];
    return [...candidates, ...peers].map((row) => this.rowToMemory(row));
  }

  governCandidate(input: { candidateId: string; matches: MemoryCandidateMatch[]; version: string; now: string; autoActivateMinEvidence: number; autoPromoteMinEvidence: number; semanticIdentity?: string; semanticError?: string }): MemoryGovernanceResult | undefined {
    let shouldAutoPromote = false;
    const result: MemoryGovernanceResult | undefined = this.db.transaction(() => {
      const candidate = this.db.prepare("SELECT * FROM memory_items WHERE id=? AND project_id=? AND level='L2' AND status='candidate'")
        .get(input.candidateId, this.projectId) as MemoryRow | undefined;
      if (!candidate) return undefined;
      const matchRows = input.matches.flatMap((match) => {
        const target = this.db.prepare("SELECT * FROM memory_items WHERE id=? AND project_id=? AND level='L2' AND agent_id=?")
          .get(match.targetId, this.projectId, candidate.agent_id) as MemoryRow | undefined;
        return target && target.id !== candidate.id && ["candidate", "active", "disputed"].includes(target.status) ? [{ match, target }] : [];
      });
      const saveMatch = this.db.prepare(`INSERT INTO memory_candidate_matches
        (candidate_memory_id, target_memory_id, match_type, score, status, governance_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_memory_id, target_memory_id, match_type) DO UPDATE SET
          score=excluded.score, status=excluded.status, governance_version=excluded.governance_version, created_at=excluded.created_at`);
      for (const { match, target } of matchRows) saveMatch.run(candidate.id, target.id, match.type, Math.max(0, Math.min(1, match.score)), "suggested", input.version, input.now);

      const from = candidate.valid_from ? Date.parse(candidate.valid_from) : undefined;
      const to = candidate.valid_to ? Date.parse(candidate.valid_to) : undefined;
      const now = Date.parse(input.now);
      if ((from !== undefined && to !== undefined && to <= from) || (to !== undefined && to <= now)) {
        const action = to !== undefined && to <= now && !(from !== undefined && to <= from) ? "expired" : "disputed";
        this.db.prepare("UPDATE memory_items SET status=?, governance_version=?, updated_at=? WHERE id=?")
          .run(action === "expired" ? "superseded" : "disputed", input.version, input.now, candidate.id);
        this.insertGovernanceRun(candidate.id, action, undefined, candidate.independent_evidence_count, false, input);
        return { candidateId: candidate.id, action, independentEvidenceCount: candidate.independent_evidence_count, autoPromotedL3: false } satisfies MemoryGovernanceResult;
      }

      const exact = matchRows.filter(({ match, target }) => match.type === "exact_duplicate" && factIdentity(target) === factIdentity(candidate))
        .sort((left, right) => Number(right.target.status === "active") - Number(left.target.status === "active") || left.target.created_at.localeCompare(right.target.created_at));
      const equivalent = [candidate, ...exact.map(({ target }) => target)]
        .sort((left, right) => Number(right.status === "active") - Number(left.status === "active") || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
      let canonical = equivalent[0]!;
      let action: MemoryGovernanceResult["action"] = "retained";
      const duplicates = equivalent.filter((memory) => memory.id !== canonical.id);
      if (duplicates.length) {
        const sources = [...new Set(equivalent.flatMap((memory) => parseJsonArray(memory.source_event_ids)))];
        const independent = this.independentEvidenceCount(sources);
        const confidence = Math.max(...equivalent.map((memory) => memory.confidence));
        const salience = Math.max(...equivalent.map((memory) => memory.salience));
        const trust = Math.max(...equivalent.map((memory) => memory.trust_level));
        this.db.prepare(`UPDATE memory_items SET source_event_ids=?, evidence_count=?, independent_evidence_count=?,
          confidence=MAX(confidence, ?), salience=MAX(salience, ?), trust_level=MAX(trust_level, ?),
          governance_version=?, updated_at=?, last_confirmed_at=? WHERE id=?`)
          .run(safeJson(sources), sources.length, independent, confidence, salience, trust,
            input.version, input.now, input.now, canonical.id);
        for (const duplicate of duplicates) {
          this.db.prepare("UPDATE memory_items SET status='superseded', index_state=CASE WHEN level IN ('L2','L3') THEN 'pending' ELSE index_state END, governance_version=?, updated_at=? WHERE id=?")
            .run(input.version, input.now, duplicate.id);
          this.db.prepare(`INSERT OR IGNORE INTO memory_relations
            (source_memory_id, relation, target_memory_id, confidence, source_event_id) VALUES (?, 'verified_by', ?, 1, ?)`)
            .run(duplicate.id, canonical.id, parseJsonArray(duplicate.source_event_ids)[0] ?? null);
          if (duplicate.status === "active") this.enqueueIndex(this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(duplicate.id) as MemoryRow, "delete");
        }
        for (const { match, target } of exact) saveMatch.run(candidate.id, target.id, match.type, match.score, "accepted", input.version, input.now);
        canonical = this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(canonical.id) as MemoryRow;
        action = "merged";
      }

      const conflicts = matchRows.filter(({ match, target }) => match.type === "conflict"
        && factPredicate(target) === factPredicate(canonical) && normalizedObject(target.object_json) !== normalizedObject(canonical.object_json));
      if (conflicts.length) {
        const canonicalContradictions = new Set(parseJsonArray(canonical.contradiction_ids));
        for (const { match, target } of conflicts) {
          canonicalContradictions.add(target.id);
          const targetContradictions = new Set(parseJsonArray(target.contradiction_ids));
          targetContradictions.add(canonical.id);
          this.db.prepare("UPDATE memory_items SET contradiction_ids=?, governance_version=?, updated_at=? WHERE id=?")
            .run(safeJson([...targetContradictions]), input.version, input.now, target.id);
          this.db.prepare(`INSERT OR IGNORE INTO memory_relations
            (source_memory_id, relation, target_memory_id, confidence, source_event_id) VALUES (?, 'contradicts', ?, ?, ?)`)
            .run(canonical.id, target.id, match.score, parseJsonArray(candidate.source_event_ids)[0] ?? null);
          this.db.prepare(`INSERT OR IGNORE INTO memory_relations
            (source_memory_id, relation, target_memory_id, confidence, source_event_id) VALUES (?, 'contradicts', ?, ?, ?)`)
            .run(target.id, canonical.id, match.score, parseJsonArray(candidate.source_event_ids)[0] ?? null);
          saveMatch.run(candidate.id, target.id, match.type, match.score, "accepted", input.version, input.now);
        }
        const canonicalStatus = canonical.status === "active" ? "active" : "disputed";
        this.db.prepare("UPDATE memory_items SET status=?, contradiction_ids=?, governance_version=?, updated_at=? WHERE id=?")
          .run(canonicalStatus, safeJson([...canonicalContradictions]), input.version, input.now, canonical.id);
        canonical = this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(canonical.id) as MemoryRow;
        action = canonical.id === candidate.id ? "disputed" : "merged";
      }

      const sources = parseJsonArray(canonical.source_event_ids);
      const independent = this.independentEvidenceCount(sources);
      const onlyInternal = this.hasOnlyInternalEvidence(sources);
      const canActivate = canonical.status === "candidate" && !conflicts.length && independent >= Math.max(1, input.autoActivateMinEvidence)
        && canonical.trust_level >= 80 && onlyInternal && (!canonical.valid_from || Date.parse(canonical.valid_from) <= now);
      if (canActivate) {
        this.db.prepare("UPDATE memory_items SET status='active', index_state='pending', independent_evidence_count=?, governance_version=?, updated_at=? WHERE id=?")
          .run(independent, input.version, input.now, canonical.id);
        canonical = this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(canonical.id) as MemoryRow;
        this.enqueueIndex(canonical, "upsert");
        action = canonical.id === candidate.id ? "activated" : "merged";
      }
      shouldAutoPromote = canonical.status === "active" && independent >= Math.max(2, input.autoPromoteMinEvidence)
        && canonical.trust_level >= 90 && onlyInternal && parseJsonArray(canonical.contradiction_ids).length === 0;
      this.db.prepare("UPDATE memory_items SET governance_version=?, independent_evidence_count=? WHERE id=?")
        .run(input.version, independent, canonical.id);
      this.insertGovernanceRun(candidate.id, action, canonical.id, independent, false, input);
      return { candidateId: candidate.id, action, canonicalId: canonical.id, independentEvidenceCount: independent, autoPromotedL3: false } satisfies MemoryGovernanceResult;
    })();
    if (!result) return undefined;
    if (shouldAutoPromote && result.canonicalId) {
      const promoted = this.promote(result.canonicalId, input.now);
      if (promoted) {
        result.autoPromotedL3 = true;
        this.db.prepare("UPDATE memory_governance_runs SET auto_promoted_l3=1 WHERE candidate_memory_id=? AND created_at=?")
          .run(input.candidateId, input.now);
      }
    }
    this.recordAccessAudit({
      action: "govern",
      decision: "allowed",
      actor: { id: "memory-governor", role: "system", employment: "internal", projectId: this.projectId, projectIds: [this.projectId] },
      memoryIds: [result.candidateId, ...(result.canonicalId && result.canonicalId !== result.candidateId ? [result.canonicalId] : [])],
      reason: result.action,
      metadata: { governanceVersion: input.version, autoPromotedL3: result.autoPromotedL3 },
      createdAt: input.now,
    });
    return result;
  }

  confirmCandidate(id: string, confirmedBy: string, confirmedAt: string): MemoryRecord | undefined {
    return this.db.transaction(() => {
      const candidate = this.db.prepare("SELECT * FROM memory_items WHERE id=? AND project_id=? AND level='L2' AND status IN ('candidate','disputed')")
        .get(id, this.projectId) as MemoryRow | undefined;
      if (!candidate) return undefined;
      const from = candidate.valid_from ? Date.parse(candidate.valid_from) : undefined;
      const to = candidate.valid_to ? Date.parse(candidate.valid_to) : undefined;
      const now = Date.parse(confirmedAt);
      if ((from !== undefined && to !== undefined && to <= from) || (to !== undefined && to <= now)) throw new Error("Cannot confirm a memory candidate with an invalid or expired validity interval.");
      const peers = this.db.prepare(`SELECT * FROM memory_items WHERE project_id=? AND agent_id=? AND level='L2' AND status='active' AND id<>?`)
        .all(this.projectId, candidate.agent_id, candidate.id) as MemoryRow[];
      const exact = peers.find((peer) => factIdentity(peer) === factIdentity(candidate));
      if (exact) {
        const sources = [...new Set([...parseJsonArray(exact.source_event_ids), ...parseJsonArray(candidate.source_event_ids)])];
        this.db.prepare(`UPDATE memory_items SET source_event_ids=?, evidence_count=?, independent_evidence_count=?,
          confidence=MAX(confidence, ?), salience=MAX(salience, ?), confirmed_at=?, confirmed_by=?, governance_version='m12-v1', updated_at=?, index_state='pending' WHERE id=?`)
          .run(safeJson(sources), sources.length, this.independentEvidenceCount(sources), candidate.confidence, candidate.salience,
            confirmedAt, confirmedBy.slice(0, 128), confirmedAt, exact.id);
        this.db.prepare("UPDATE memory_items SET status='superseded', governance_version='m12-v1', updated_at=? WHERE id=?").run(confirmedAt, candidate.id);
        this.db.prepare(`INSERT OR IGNORE INTO memory_relations
          (source_memory_id, relation, target_memory_id, confidence, source_event_id) VALUES (?, 'verified_by', ?, 1, ?)`)
          .run(candidate.id, exact.id, parseJsonArray(candidate.source_event_ids)[0] ?? null);
        const current = this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(exact.id) as MemoryRow;
        this.enqueueIndex(current, "upsert");
        return this.rowToMemory(current);
      }
      const conflicts = peers.filter((peer) => factPredicate(peer) === factPredicate(candidate) && normalizedObject(peer.object_json) !== normalizedObject(candidate.object_json));
      for (const conflict of conflicts) {
        this.db.prepare("UPDATE memory_items SET status='superseded', index_state='pending', updated_at=? WHERE id=?").run(confirmedAt, conflict.id);
        this.db.prepare(`INSERT OR IGNORE INTO memory_relations
          (source_memory_id, relation, target_memory_id, valid_from, confidence, source_event_id) VALUES (?, 'supersedes', ?, ?, 1, ?)`)
          .run(candidate.id, conflict.id, confirmedAt, parseJsonArray(candidate.source_event_ids)[0] ?? null);
        this.enqueueIndex(this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(conflict.id) as MemoryRow, "delete");
      }
      this.db.prepare(`UPDATE memory_items SET status='active', contradiction_ids='[]', supersedes_id=?, index_state='pending',
        independent_evidence_count=?, confirmed_at=?, confirmed_by=?, governance_version='m12-v1', updated_at=?, last_confirmed_at=? WHERE id=?`)
        .run(conflicts[0]?.id ?? null, this.independentEvidenceCount(parseJsonArray(candidate.source_event_ids)), confirmedAt,
          confirmedBy.slice(0, 128), confirmedAt, confirmedAt, candidate.id);
      const active = this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(candidate.id) as MemoryRow;
      this.enqueueIndex(active, "upsert");
      return this.rowToMemory(active);
    })();
  }

  private insertGovernanceRun(candidateId: string, action: MemoryGovernanceResult["action"], canonicalId: string | undefined, independentEvidenceCount: number,
    autoPromotedL3: boolean, input: { version: string; now: string; semanticIdentity?: string; semanticError?: string }): void {
    this.db.prepare(`INSERT INTO memory_governance_runs
      (id, candidate_memory_id, action, canonical_memory_id, independent_evidence_count, auto_promoted_l3,
       semantic_identity, semantic_error, governance_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), candidateId, action, canonicalId ?? null, independentEvidenceCount, autoPromotedL3 ? 1 : 0,
        input.semanticIdentity ?? null, input.semanticError ? redactAuditText(input.semanticError, 800) : null, input.version, input.now);
  }

  private insertExtractionRun(run: MemoryExtractionRunInput): void {
    this.db.prepare(`INSERT INTO memory_extraction_runs
      (id, event_id, model, extraction_version, status, candidate_count, input_chars, input_tokens, output_tokens, latency_ms, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, run.eventId, run.model, run.version, run.status, run.candidateCount, run.inputChars,
        run.inputTokens ?? null, run.outputTokens ?? null, Math.max(0, run.latencyMs), run.error ? redactAuditText(run.error, 800) : null, run.createdAt);
  }

  registerIndexTarget(target: MemoryIndexRegistryRecord): void {
    if (target.projectId !== this.projectId) throw new Error(`Index target belongs to project '${target.projectId}', not '${this.projectId}'.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.collectionRevision)) throw new Error("Invalid collection revision.");
    this.db.prepare(`INSERT INTO memory_index_registry
      (collection_revision, project_id, embedding_revision, state, path, snapshot_watermark, document_count, created_at, ready_at, activated_at, retired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection_revision) DO UPDATE SET
        state=excluded.state, snapshot_watermark=excluded.snapshot_watermark,
        document_count=excluded.document_count, ready_at=excluded.ready_at, activated_at=excluded.activated_at, retired_at=excluded.retired_at
      WHERE memory_index_registry.project_id=excluded.project_id
        AND memory_index_registry.embedding_revision=excluded.embedding_revision
        AND memory_index_registry.path=excluded.path
        AND memory_index_registry.created_at=excluded.created_at`)
      .run(target.collectionRevision, target.projectId, target.embeddingRevision, target.state, target.path,
        target.snapshotWatermark ?? null, target.documentCount, target.createdAt, target.readyAt ?? null,
        target.activatedAt ?? null, target.retiredAt ?? null);
    const persisted = this.db.prepare("SELECT project_id, embedding_revision, path, created_at FROM memory_index_registry WHERE collection_revision=?")
      .get(target.collectionRevision) as { project_id: string; embedding_revision: string; path: string; created_at: string };
    if (persisted.project_id !== target.projectId || persisted.embedding_revision !== target.embeddingRevision || persisted.path !== target.path || persisted.created_at !== target.createdAt) {
      throw new Error(`Collection revision '${target.collectionRevision}' is already bound to a different identity.`);
    }
  }

  listIndexTargets(): MemoryIndexRegistryRecord[] {
    return (this.db.prepare("SELECT * FROM memory_index_registry WHERE project_id=? ORDER BY created_at, collection_revision").all(this.projectId) as Array<Record<string, unknown>>)
      .map((row) => ({
        collectionRevision: String(row.collection_revision),
        projectId: String(row.project_id),
        embeddingRevision: String(row.embedding_revision),
        state: row.state as MemoryIndexRegistryState,
        path: String(row.path),
        snapshotWatermark: row.snapshot_watermark ? String(row.snapshot_watermark) : undefined,
        documentCount: Number(row.document_count),
        createdAt: String(row.created_at),
        readyAt: row.ready_at ? String(row.ready_at) : undefined,
        activatedAt: row.activated_at ? String(row.activated_at) : undefined,
        retiredAt: row.retired_at ? String(row.retired_at) : undefined,
      }));
  }

  enqueueIndexBackfill(collectionRevision: string, now = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const target = this.db.prepare("SELECT collection_revision, embedding_revision, state FROM memory_index_registry WHERE collection_revision=? AND project_id=?")
        .get(collectionRevision, this.projectId) as { collection_revision: string; embedding_revision: string; state: MemoryIndexRegistryState } | undefined;
      if (!target) throw new Error(`Unknown collection revision '${collectionRevision}'.`);
      if (target.state !== "building" && target.state !== "active") throw new Error(`Cannot backfill a ${target.state} collection.`);
      const rows = this.db.prepare("SELECT * FROM memory_items WHERE project_id=? AND level IN ('L2','L3') AND status='active' ORDER BY created_at, id")
        .all(this.projectId) as MemoryRow[];
      for (const row of rows) this.enqueueIndexForTarget(row, "upsert", {
        collectionRevision: target.collection_revision,
        embeddingRevision: target.embedding_revision,
      }, now);
      return rows.length;
    })();
  }

  listIndexMemberships(memoryId?: string): MemoryIndexMembership[] {
    const rows = memoryId
      ? this.db.prepare("SELECT * FROM memory_index_memberships WHERE memory_id=? ORDER BY collection_revision").all(memoryId)
      : this.db.prepare(`SELECT membership.* FROM memory_index_memberships membership
          JOIN memory_items item ON item.id=membership.memory_id WHERE item.project_id=? ORDER BY membership.memory_id, membership.collection_revision`).all(this.projectId);
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      memoryId: String(row.memory_id),
      collectionRevision: String(row.collection_revision),
      contentHash: String(row.content_hash),
      embeddingRevision: String(row.embedding_revision),
      status: row.status as MemoryIndexMembershipState,
      indexedAt: row.indexed_at ? String(row.indexed_at) : undefined,
      error: row.error ? String(row.error) : undefined,
    }));
  }

  claimIndexOutbox(options: ClaimMemoryIndexOutboxOptions): MemoryIndexOutboxItem[] {
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit)));
    const leaseExpiresAt = new Date(Date.parse(options.now) + Math.max(1_000, options.leaseMs)).toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE memory_index_outbox SET status='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
        WHERE target_index=? AND status='processing' AND lease_expires_at<=?`)
        .run(options.now, options.collectionRevision, options.now);
      const candidates = this.db.prepare(`SELECT outbox.id FROM memory_index_outbox outbox
        JOIN memory_index_registry registry ON registry.collection_revision=outbox.target_index
        LEFT JOIN memory_index_migrations migration ON migration.collection_revision=outbox.target_index
        WHERE registry.project_id=? AND registry.state IN ('building','ready','active')
          AND (migration.status IS NULL OR migration.status IN ('backfilling','validating','ready','active'))
          AND outbox.target_index=? AND outbox.status='pending' AND outbox.next_attempt_at<=?
        ORDER BY outbox.created_at, CASE outbox.operation WHEN 'upsert' THEN 0 ELSE 1 END, outbox.id LIMIT ?`)
        .all(this.projectId, options.collectionRevision, options.now, limit) as Array<{ id: string }>;
      if (!candidates.length) return [];
      const claim = this.db.prepare(`UPDATE memory_index_outbox SET status='processing', attempts=attempts+1,
        lease_owner=?, lease_expires_at=?, updated_at=? WHERE id=? AND status='pending'`);
      const claimed: string[] = [];
      for (const candidate of candidates) {
        if (claim.run(options.workerId, leaseExpiresAt, options.now, candidate.id).changes) claimed.push(candidate.id);
      }
      const read = this.db.prepare(`SELECT item.*, outbox.operation, outbox.target_index, outbox.lease_owner, outbox.lease_expires_at,
        outbox.id AS outbox_id, outbox.memory_id AS outbox_memory_id, outbox.content_hash AS outbox_content_hash,
        outbox.attempts AS outbox_attempts FROM memory_index_outbox outbox
        JOIN memory_items item ON item.id=outbox.memory_id WHERE outbox.id=?`);
      return claimed.map((id) => {
        const row = read.get(id) as MemoryRow & Record<string, unknown>;
        return {
          id: String(row.outbox_id),
          memoryId: String(row.outbox_memory_id),
          operation: row.operation as "upsert" | "delete",
          collectionRevision: String(row.target_index),
          contentHash: String(row.outbox_content_hash),
          attempts: Number(row.outbox_attempts),
          leaseOwner: options.workerId,
          leaseExpiresAt,
          memory: this.rowToMemory(row),
        };
      });
    })();
  }

  completeIndexOutbox(id: string, workerId: string, completedAt: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT memory_id, target_index, operation, content_hash FROM memory_index_outbox WHERE id=? AND status='processing' AND lease_owner=? AND lease_expires_at>?")
        .get(id, workerId, completedAt) as { memory_id: string; target_index: string; operation: "upsert" | "delete"; content_hash: string } | undefined;
      if (!row) return false;
      this.db.prepare("UPDATE memory_index_outbox SET status='completed', error=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?")
        .run(completedAt, id);
      this.db.prepare(`UPDATE memory_index_memberships SET status=?, content_hash=CASE WHEN ?='upsert' THEN ? ELSE content_hash END, indexed_at=?, error=NULL
        WHERE memory_id=? AND collection_revision=?`)
        .run(row.operation === "delete" ? "deleted" : "indexed", row.operation, row.content_hash, completedAt, row.memory_id, row.target_index);
      this.refreshIndexState(row.memory_id);
      return true;
    })();
  }

  failIndexOutbox(id: string, workerId: string, failure: { error: string; retryable: boolean; retryAt: string; maxAttempts: number }, failedAt: string): "retry" | "dead_letter" | "lost_lease" {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT memory_id, target_index, attempts FROM memory_index_outbox WHERE id=? AND status='processing' AND lease_owner=? AND lease_expires_at>?")
        .get(id, workerId, failedAt) as { memory_id: string; target_index: string; attempts: number } | undefined;
      if (!row) return "lost_lease";
      const dead = !failure.retryable || row.attempts >= failure.maxAttempts;
      this.db.prepare(`UPDATE memory_index_outbox SET status=?, error=?, next_attempt_at=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`)
        .run(dead ? "dead_letter" : "pending", failure.error.slice(0, 800), dead ? failedAt : failure.retryAt, failedAt, id);
      this.db.prepare("UPDATE memory_index_memberships SET status=?, error=? WHERE memory_id=? AND collection_revision=?")
        .run(dead ? "failed" : "pending", failure.error.slice(0, 800), row.memory_id, row.target_index);
      this.refreshIndexState(row.memory_id);
      return dead ? "dead_letter" : "retry";
    })();
  }

  prepareIndexMigration(collectionRevision: string, sourceCollectionRevision: string | undefined, now = new Date().toISOString()): MemoryIndexMigrationRecord {
    return this.db.transaction(() => {
      const target = this.db.prepare("SELECT state FROM memory_index_registry WHERE project_id=? AND collection_revision=?")
        .get(this.projectId, collectionRevision) as { state: MemoryIndexRegistryState } | undefined;
      if (!target) throw new Error(`Unknown collection revision '${collectionRevision}'.`);
      if (target.state !== "building") throw new Error(`Index migration target must be building, received '${target.state}'.`);
      const competing = this.db.prepare("SELECT collection_revision FROM memory_index_registry WHERE project_id=? AND state='building' AND collection_revision<>?")
        .get(this.projectId, collectionRevision) as { collection_revision: string } | undefined;
      if (competing) throw new Error(`Project already has building collection '${competing.collection_revision}'.`);
      const summary = this.db.prepare(`SELECT COUNT(*) AS total, MAX(updated_at) AS watermark FROM memory_items
        WHERE project_id=? AND level IN ('L2','L3') AND status='active'`).get(this.projectId) as { total: number; watermark: string | null };
      this.db.prepare(`INSERT OR IGNORE INTO memory_index_migrations
        (collection_revision, source_collection_revision, status, snapshot_watermark, total_items, started_at, updated_at)
        VALUES (?, ?, 'backfilling', ?, ?, ?, ?)`)
        .run(collectionRevision, sourceCollectionRevision ?? null, summary.watermark ?? now, summary.total, now, now);
      this.db.prepare(`UPDATE memory_index_migrations SET source_collection_revision=?, status='backfilling', snapshot_watermark=?,
        total_items=?, pause_reason=NULL, error=NULL, started_at=?, updated_at=?, completed_at=NULL
        WHERE collection_revision=? AND status IN ('active','retired','failed')`)
        .run(sourceCollectionRevision ?? null, summary.watermark ?? now, summary.total, now, now, collectionRevision);
      this.reconcileIndexRevision(collectionRevision, now);
      return this.getIndexMigration(collectionRevision)!;
    })();
  }

  reconcileIndexRevision(collectionRevision: string, now = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const target = this.db.prepare("SELECT collection_revision, embedding_revision, state FROM memory_index_registry WHERE project_id=? AND collection_revision=?")
        .get(this.projectId, collectionRevision) as { collection_revision: string; embedding_revision: string; state: MemoryIndexRegistryState } | undefined;
      if (!target || (target.state !== "building" && target.state !== "ready" && target.state !== "active")) throw new Error(`Collection '${collectionRevision}' is not writable.`);
      const before = (this.db.prepare("SELECT COUNT(*) AS count FROM memory_index_outbox WHERE target_index=?").get(collectionRevision) as { count: number }).count;
      const active = this.db.prepare("SELECT * FROM memory_items WHERE project_id=? AND level IN ('L2','L3') AND status='active' ORDER BY created_at, id")
        .all(this.projectId) as MemoryRow[];
      for (const row of active) this.enqueueIndexForTarget(row, "upsert", { collectionRevision, embeddingRevision: target.embedding_revision }, now);
      const stale = this.db.prepare(`SELECT item.* FROM memory_items item JOIN memory_index_memberships membership ON membership.memory_id=item.id
        WHERE item.project_id=? AND membership.collection_revision=? AND item.level IN ('L2','L3') AND item.status<>'active' AND membership.status<>'deleted'`)
        .all(this.projectId, collectionRevision) as MemoryRow[];
      for (const row of stale) this.enqueueIndexForTarget(row, "delete", { collectionRevision, embeddingRevision: target.embedding_revision }, now);
      // A canonical write can be enqueued with the wall clock while a rebuild
      // uses an injected clock. Reconciliation is an explicit catch-up barrier,
      // so make already-pending work available at that barrier instead of
      // leaving an idempotent outbox row scheduled in the apparent future.
      this.db.prepare(`UPDATE memory_index_outbox SET next_attempt_at=?, updated_at=?
        WHERE target_index=? AND status='pending' AND next_attempt_at>?`)
        .run(now, now, collectionRevision, now);
      const after = (this.db.prepare("SELECT COUNT(*) AS count FROM memory_index_outbox WHERE target_index=?").get(collectionRevision) as { count: number }).count;
      return after - before;
    })();
  }

  reconcileSemanticIndexRevision(collectionRevision: string, now: string): number {
    return this.db.transaction(() => {
      const target = this.db.prepare("SELECT state FROM memory_index_registry WHERE project_id=? AND collection_revision=?")
        .get(this.projectId, collectionRevision) as { state: MemoryIndexRegistryState } | undefined;
      if (!target || !["building", "ready", "active"].includes(target.state)) throw new Error(`Collection '${collectionRevision}' is not writable.`);
      let scheduled = 0;
      // During the compatibility window canonical memories continue through
      // memory_index_outbox. Knowledge joins the same collection here without
      // duplicating memory vectors under semantic IDs.
      const documents = this.db.prepare("SELECT * FROM semantic_documents WHERE project_id=? AND resource_type='knowledge'").all(this.projectId) as Array<Record<string, unknown>>;
      const readMembership = this.db.prepare(`SELECT content_hash, status FROM semantic_index_memberships
        WHERE semantic_document_id=? AND collection_revision=?`);
      const membership = this.db.prepare(`INSERT INTO semantic_index_memberships
        (semantic_document_id, collection_revision, content_hash, status)
        VALUES (?, ?, ?, 'pending') ON CONFLICT(semantic_document_id, collection_revision) DO UPDATE SET
          content_hash=excluded.content_hash, status='pending', indexed_at=NULL, error=NULL`);
      const enqueue = this.db.prepare(`INSERT INTO semantic_index_outbox
        (id, semantic_document_id, operation, collection_revision, content_hash, next_attempt_at, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(semantic_document_id, operation, content_hash, collection_revision) DO UPDATE SET
          attempts=0, next_attempt_at=excluded.next_attempt_at, status='pending', lease_owner=NULL,
          lease_expires_at=NULL, error=NULL, updated_at=excluded.updated_at`);
      for (const document of documents) {
        const operation = document.status === "active" ? "upsert" : "delete";
        const current = readMembership.get(document.id, collectionRevision) as { content_hash: string; status: MemoryIndexMembershipState } | undefined;
        const desiredStatus = operation === "upsert" ? "indexed" : "deleted";
        const shouldEnqueue = !current || current.content_hash !== document.content_hash
          || (current.status !== "pending" && current.status !== "failed" && current.status !== desiredStatus);
        if (!shouldEnqueue) continue;
        membership.run(document.id, collectionRevision, document.content_hash);
        enqueue.run(randomUUID(), document.id, operation, collectionRevision, document.content_hash, now, now, now);
        scheduled += 1;
      }
      this.db.prepare("UPDATE semantic_index_outbox SET next_attempt_at=?, updated_at=? WHERE collection_revision=? AND status='pending' AND next_attempt_at>?")
        .run(now, now, collectionRevision, now);
      return scheduled;
    })();
  }

  claimSemanticIndexOutbox(options: ClaimSemanticIndexOutboxOptions): SemanticIndexOutboxItem[] {
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit)));
    const leaseExpiresAt = new Date(Date.parse(options.now) + Math.max(1_000, options.leaseMs)).toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE semantic_index_outbox SET status='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
        WHERE collection_revision=? AND status='processing' AND lease_expires_at<=?`).run(options.now, options.collectionRevision, options.now);
      const rows = this.db.prepare(`SELECT id FROM semantic_index_outbox WHERE collection_revision=? AND status='pending' AND next_attempt_at<=?
        ORDER BY created_at, id LIMIT ?`).all(options.collectionRevision, options.now, limit) as Array<{ id: string }>;
      const claim = this.db.prepare(`UPDATE semantic_index_outbox SET status='processing', attempts=attempts+1, lease_owner=?, lease_expires_at=?, updated_at=?
        WHERE id=? AND status='pending'`);
      const read = this.db.prepare(`SELECT outbox.*,
        outbox.id AS outbox_id, outbox.content_hash AS outbox_content_hash, outbox.attempts AS outbox_attempts,
        document.id AS document_id, document.project_id AS document_project_id,
        document.resource_type AS document_resource_type, document.resource_id AS document_resource_id,
        document.source_id AS document_source_id, document.owner_agent_id AS document_owner_agent_id,
        document.visibility AS document_visibility, document.team_id AS document_team_id,
        document.allowed_agent_ids AS document_allowed_agent_ids, document.content AS document_content,
        document.content_hash AS document_content_hash, document.status AS document_status,
        document.metadata_json AS document_metadata_json, document.index_state AS document_index_state,
        document.created_at AS document_created_at, document.updated_at AS document_updated_at
        FROM semantic_index_outbox outbox JOIN semantic_documents document ON document.id=outbox.semantic_document_id WHERE outbox.id=?`);
      const claimed = rows.filter((row) => claim.run(options.workerId, leaseExpiresAt, options.now, row.id).changes > 0);
      return claimed.map(({ id }) => {
        const row = read.get(id) as Record<string, unknown>;
        const document: SemanticDocument = {
          id: String(row.document_id), projectId: String(row.document_project_id), resourceType: row.document_resource_type as SemanticDocument["resourceType"],
          resourceId: String(row.document_resource_id), sourceId: row.document_source_id ? String(row.document_source_id) : undefined,
          ownerAgentId: row.document_owner_agent_id ? String(row.document_owner_agent_id) : undefined, visibility: row.document_visibility as SemanticDocument["visibility"],
          teamId: row.document_team_id ? String(row.document_team_id) : undefined, allowedAgentIds: parseJsonArray(String(row.document_allowed_agent_ids)),
          content: String(row.document_content), contentHash: String(row.document_content_hash), status: row.document_status as SemanticDocument["status"],
          metadata: parseJsonObject(String(row.document_metadata_json)), indexState: row.document_index_state as SemanticDocument["indexState"],
          createdAt: String(row.document_created_at), updatedAt: String(row.document_updated_at),
        };
        return { id: String(row.outbox_id), semanticDocumentId: document.id, operation: row.operation as "upsert" | "delete",
          collectionRevision: String(row.collection_revision), contentHash: String(row.outbox_content_hash), attempts: Number(row.outbox_attempts),
          leaseOwner: options.workerId, leaseExpiresAt, document };
      });
    })();
  }

  completeSemanticIndexOutbox(id: string, workerId: string, indexedAt: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT semantic_document_id, collection_revision, operation, content_hash FROM semantic_index_outbox WHERE id=? AND status='processing' AND lease_owner=? AND lease_expires_at>?")
        .get(id, workerId, indexedAt) as { semantic_document_id: string; collection_revision: string; operation: "upsert" | "delete"; content_hash: string } | undefined;
      if (!row) return false;
      this.db.prepare("UPDATE semantic_index_outbox SET status='completed', error=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?").run(indexedAt, id);
      this.db.prepare("UPDATE semantic_index_memberships SET status=?, content_hash=?, indexed_at=?, error=NULL WHERE semantic_document_id=? AND collection_revision=?")
        .run(row.operation === "delete" ? "deleted" : "indexed", row.content_hash, indexedAt, row.semantic_document_id, row.collection_revision);
      this.db.prepare("UPDATE semantic_documents SET index_state=? WHERE id=?").run(row.operation === "delete" ? "not_applicable" : "indexed", row.semantic_document_id);
      return true;
    })();
  }

  failSemanticIndexOutbox(id: string, workerId: string, error: string, retryAt: string, deadLetter: boolean, updatedAt: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT semantic_document_id, collection_revision FROM semantic_index_outbox WHERE id=? AND status='processing' AND lease_owner=? AND lease_expires_at>?")
        .get(id, workerId, updatedAt) as { semantic_document_id: string; collection_revision: string } | undefined;
      if (!row) return false;
      this.db.prepare("UPDATE semantic_index_outbox SET status=?, error=?, next_attempt_at=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?")
        .run(deadLetter ? "dead_letter" : "pending", error.slice(0, 800), retryAt, updatedAt, id);
      this.db.prepare("UPDATE semantic_index_memberships SET status=?, error=? WHERE semantic_document_id=? AND collection_revision=?")
        .run(deadLetter ? "failed" : "pending", error.slice(0, 800), row.semantic_document_id, row.collection_revision);
      this.db.prepare("UPDATE semantic_documents SET index_state=? WHERE id=?").run(deadLetter ? "failed" : "pending", row.semantic_document_id);
      return true;
    })();
  }

  getIndexMigration(collectionRevision: string): MemoryIndexMigrationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory_index_migrations WHERE collection_revision=?").get(collectionRevision) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      collectionRevision: String(row.collection_revision),
      sourceCollectionRevision: row.source_collection_revision ? String(row.source_collection_revision) : undefined,
      status: row.status as MemoryIndexMigrationStatus,
      snapshotWatermark: String(row.snapshot_watermark),
      totalItems: Number(row.total_items),
      pauseReason: row.pause_reason ? String(row.pause_reason) : undefined,
      error: row.error ? String(row.error) : undefined,
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
    };
  }

  setIndexMigrationStatus(collectionRevision: string, status: MemoryIndexMigrationStatus, options: { pauseReason?: string; error?: string; completedAt?: string; updatedAt?: string } = {}): MemoryIndexMigrationRecord {
    const updatedAt = options.updatedAt ?? new Date().toISOString();
    const changes = this.db.prepare(`UPDATE memory_index_migrations SET status=?, pause_reason=?, error=?, updated_at=?, completed_at=?
      WHERE collection_revision=?`).run(status, options.pauseReason ?? null, options.error ?? null, updatedAt, options.completedAt ?? null, collectionRevision).changes;
    if (!changes) throw new Error(`Unknown index migration '${collectionRevision}'.`);
    return this.getIndexMigration(collectionRevision)!;
  }

  retryIndexDeadLetters(collectionRevision: string, now = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT memory_id FROM memory_index_outbox WHERE target_index=? AND status='dead_letter'").all(collectionRevision) as Array<{ memory_id: string }>;
      const changes = this.db.prepare(`UPDATE memory_index_outbox SET status='pending', attempts=0, next_attempt_at=?, error=NULL,
        lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE target_index=? AND status='dead_letter'`)
        .run(now, now, collectionRevision).changes;
      const reset = this.db.prepare("UPDATE memory_index_memberships SET status='pending', error=NULL WHERE memory_id=? AND collection_revision=?");
      for (const row of rows) { reset.run(row.memory_id, collectionRevision); this.refreshIndexState(row.memory_id); }
      return changes;
    })();
  }

  indexRevisionValidation(collectionRevision: string, sampleSize = 20): MemoryIndexValidationSnapshot {
    const expected = this.db.prepare(`SELECT id, content_hash FROM memory_items WHERE project_id=? AND level IN ('L2','L3') AND status='active' ORDER BY id`)
      .all(this.projectId) as Array<{ id: string; content_hash: string }>;
    const memberships = this.db.prepare(`SELECT membership.memory_id, membership.content_hash, membership.status, membership.error, item.status AS item_status
      FROM memory_index_memberships membership JOIN memory_items item ON item.id=membership.memory_id
      WHERE membership.collection_revision=? AND item.project_id=?`).all(collectionRevision, this.projectId) as Array<{
        memory_id: string; content_hash: string; status: MemoryIndexMembershipState; error: string | null; item_status: MemoryRecord["status"];
      }>;
    const byId = new Map(memberships.map((row) => [row.memory_id, row]));
    const missingIds = expected.filter((row) => byId.get(row.id)?.status !== "indexed").map((row) => row.id);
    const mismatchedIds = expected.filter((row) => {
      const membership = byId.get(row.id);
      return membership?.status === "indexed" && membership.content_hash !== row.content_hash;
    }).map((row) => row.id);
    const staleIds = memberships.filter((row) => row.item_status !== "active" && row.status !== "deleted").map((row) => row.memory_id);
    const outbox = this.db.prepare(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) AS dead
      FROM memory_index_outbox WHERE target_index=?`).get(collectionRevision) as { pending: number | null; processing: number | null; dead: number | null };
    return {
      collectionRevision,
      expectedCount: expected.length,
      indexedCount: memberships.filter((row) => row.item_status === "active" && row.status === "indexed").length,
      missingIds,
      mismatchedIds,
      staleIds,
      pendingOutbox: outbox.pending ?? 0,
      processingOutbox: outbox.processing ?? 0,
      deadLetters: outbox.dead ?? 0,
      sample: expected.slice(0, Math.min(100, Math.max(0, Math.floor(sampleSize)))).map(({ id, content_hash }) => ({ id, contentHash: content_hash })),
      errors: [...new Set(memberships.flatMap((row) => row.error ? [row.error] : []))],
    };
  }

  indexRebuildWorkload(): MemoryIndexRebuildWorkload {
    const row = this.db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(content) + CASE WHEN summary=content THEN 0 ELSE length(summary)+1 END), 0) AS characters
      FROM memory_items WHERE project_id=? AND level IN ('L2','L3') AND status='active'`).get(this.projectId) as { count: number; characters: number };
    const pageCount = Number(this.db.pragma("page_count", { simple: true }));
    const pageSize = Number(this.db.pragma("page_size", { simple: true }));
    return { itemCount: row.count, searchableCharacters: row.characters, sqliteBytes: pageCount * pageSize };
  }

  updateIndexTargetState(collectionRevision: string, state: MemoryIndexRegistryState, options: { documentCount?: number; readyAt?: string; activatedAt?: string; retiredAt?: string } = {}): void {
    const current = this.db.prepare("SELECT * FROM memory_index_registry WHERE project_id=? AND collection_revision=?")
      .get(this.projectId, collectionRevision) as Record<string, unknown> | undefined;
    if (!current) throw new Error(`Unknown collection revision '${collectionRevision}'.`);
    const readyAt = state === "building" || state === "failed" ? null : options.readyAt ?? current.ready_at;
    const activatedAt = state === "building" || state === "ready" || state === "failed" ? null : options.activatedAt ?? current.activated_at;
    const retiredAt = state === "retired" ? options.retiredAt ?? current.retired_at : null;
    this.db.prepare(`UPDATE memory_index_registry SET state=?, document_count=?, ready_at=?, activated_at=?, retired_at=?
      WHERE project_id=? AND collection_revision=?`)
      .run(state, options.documentCount ?? current.document_count, readyAt, activatedAt, retiredAt, this.projectId, collectionRevision);
  }

  resetIndexRevisionData(collectionRevision: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_index_outbox WHERE target_index=?").run(collectionRevision);
      const ids = this.db.prepare("SELECT memory_id FROM memory_index_memberships WHERE collection_revision=?").all(collectionRevision) as Array<{ memory_id: string }>;
      this.db.prepare("DELETE FROM memory_index_memberships WHERE collection_revision=?").run(collectionRevision);
      for (const { memory_id } of ids) this.refreshIndexState(memory_id);
    })();
  }

  removeIndexTarget(collectionRevision: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_index_outbox WHERE target_index=?").run(collectionRevision);
      const memoryIds = this.db.prepare("SELECT memory_id FROM memory_index_memberships WHERE collection_revision=?").all(collectionRevision) as Array<{ memory_id: string }>;
      this.db.prepare("DELETE FROM memory_index_memberships WHERE collection_revision=?").run(collectionRevision);
      this.db.prepare("DELETE FROM memory_index_migrations WHERE collection_revision=?").run(collectionRevision);
      this.db.prepare("DELETE FROM memory_index_registry WHERE project_id=? AND collection_revision=?").run(this.projectId, collectionRevision);
      for (const { memory_id } of memoryIds) this.refreshIndexState(memory_id);
    })();
  }

  findAuthorizedMemories(input: AuthorizedMemoryInput, ids: string[]): MemoryRecord[] {
    const uniqueIds = [...new Set(ids)].slice(0, 500);
    if (!uniqueIds.length) return [];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM memory_items WHERE project_id=? AND status='active' AND level IN ('L2','L3') AND id IN (${placeholders})`)
      .all(this.projectId, ...uniqueIds) as MemoryRow[];
    const byId = new Map(rows.filter((row) => this.isAuthorizedMemory(row, input)).map((row) => [row.id, row]));
    return uniqueIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [this.rowToMemory(row)] : [];
    });
  }

  findExactAuthorizedMemories(input: AuthorizedMemoryInput, terms: string[], limit: number): MemoryRecord[] {
    const normalized = [...new Set(terms.map((term) => normalize(term)).filter((term) => term.length >= 2))].slice(0, 20);
    if (!normalized.length) return [];
    const conditions = normalized.map(() => "(instr(lower(content), ?) > 0 OR instr(lower(summary), ?) > 0)").join(" OR ");
    const params = normalized.flatMap((term) => [term, term]);
    const rows = this.db.prepare(`SELECT * FROM memory_items WHERE project_id=? AND status='active' AND level IN ('L2','L3')
      AND (${conditions}) ORDER BY updated_at DESC LIMIT 1000`).all(this.projectId, ...params) as MemoryRow[];
    return rows.filter((row) => this.isAuthorizedMemory(row, input))
      .map((row) => ({ row, exact: normalized.reduce((score, term) => score + (normalize(`${row.summary}\n${row.content}`).includes(term) ? term.length : 0), 0) }))
      .sort((left, right) => right.exact - left.exact || right.row.updated_at.localeCompare(left.row.updated_at))
      .slice(0, Math.min(500, Math.max(1, Math.floor(limit))))
      .map(({ row }) => this.rowToMemory(row));
  }

  recordRetrievalRun(input: MemoryRetrievalRunInput): void {
    this.db.prepare(`INSERT INTO memory_retrieval_runs
      (id, agent_id, query, scope_json, backend, embedding_identity, candidate_ids, selected_ids, latency_ms, fallback_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.actor.id, redactAuditText(input.query), input.scopeJson, input.backend,
        input.embeddingIdentity ?? null, safeJson(input.candidateIds), safeJson(input.selectedIds),
        Math.max(0, input.latencyMs), input.fallbackReason ? redactAuditText(input.fallbackReason, 800) : null, input.createdAt);
    this.recordAccessAudit({
      action: input.actor.role === "resource_manager" ? "federated_search" : "retrieve",
      decision: input.accessDecision ?? "allowed",
      actor: input.actor,
      memoryIds: input.selectedIds,
      reason: input.accessReason ?? (input.fallbackReason && !input.selectedIds.length ? "retrieval_degraded" : "policy_filtered_retrieval"),
      metadata: { backend: input.backend, candidateCount: input.candidateIds.length, selectedCount: input.selectedIds.length, degraded: Boolean(input.fallbackReason) },
      createdAt: input.createdAt,
    });
  }

  listRetrievalRuns(limit = 100): MemoryRetrievalRunRecord[] {
    const rows = this.db.prepare("SELECT * FROM memory_retrieval_runs ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(Math.min(500, Math.max(1, Math.floor(limit)))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      agentId: String(row.agent_id),
      query: String(row.query),
      scopeJson: String(row.scope_json),
      backend: String(row.backend),
      embeddingIdentity: row.embedding_identity ? String(row.embedding_identity) : undefined,
      candidateIds: parseJsonArray(String(row.candidate_ids)),
      selectedIds: parseJsonArray(String(row.selected_ids)),
      latencyMs: Number(row.latency_ms),
      fallbackReason: row.fallback_reason ? String(row.fallback_reason) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  recordAccessAudit(input: MemoryAccessAuditInput): void {
    const metadata = input.metadata ?? {};
    const sanitizedMetadata = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, typeof value === "string" ? redactAuditText(value, 300) : value]));
    this.db.prepare(`INSERT INTO memory_access_audit
      (id, action, decision, actor_id, actor_role, actor_employment, actor_project_id, actor_team_id, requested_project_id, memory_ids, reason, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), input.action, input.decision, input.actor.id, input.actor.role, input.actor.employment,
        input.actor.projectId ?? null, input.actor.teamId ?? null, this.projectId,
        safeJson([...(input.memoryIds ?? [])].slice(0, 500)), redactAuditText(input.reason, 300), safeJson(sanitizedMetadata), input.createdAt ?? new Date().toISOString());
  }

  listAccessAudits(limit = 100): MemoryAccessAuditRecord[] {
    const rows = this.db.prepare("SELECT * FROM memory_access_audit ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(Math.min(500, Math.max(1, Math.floor(limit)))) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let metadata: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(row.metadata_json)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      } catch { /* malformed legacy audit metadata remains empty */ }
      return {
        id: String(row.id), action: row.action as MemoryAccessAction, decision: row.decision as MemoryAccessDecision,
        actorId: String(row.actor_id), actorRole: row.actor_role as MemoryActor["role"], actorEmployment: row.actor_employment as MemoryActor["employment"],
        actorProjectId: row.actor_project_id ? String(row.actor_project_id) : undefined,
        actorTeamId: row.actor_team_id ? String(row.actor_team_id) : undefined,
        requestedProjectId: String(row.requested_project_id), memoryIds: parseJsonArray(String(row.memory_ids)),
        reason: String(row.reason), metadata, createdAt: String(row.created_at),
      };
    });
  }

  private isAuthorizedMemory(row: MemoryRow, input: AuthorizedMemoryInput): boolean {
    const now = Date.parse(input.now);
    if (row.valid_from && Date.parse(row.valid_from) > now) return false;
    if (row.valid_to && Date.parse(row.valid_to) <= now) return false;
    return this.policy.canRead(input.actor, this.rowToMemory(row));
  }

  overview(enabled: boolean, agentId?: string): Omit<MemoryOverview, "retrieval"> {
    const agentClause = agentId ? " AND agent_id=?" : "";
    const params = agentId ? [this.projectId, agentId] : [this.projectId];
    const countRows = this.db.prepare(`SELECT level, COUNT(*) AS count FROM memory_items WHERE project_id=?${agentClause} AND status='active' GROUP BY level`)
      .all(...params) as Array<{ level: MemoryLevel; count: number }>;
    const counts: Record<MemoryLevel, number> = { L1: 0, L2: 0, L3: 0 };
    for (const row of countRows) counts[row.level] = row.count;
    const ownerClause = agentId ? " AND owner_agent_id=?" : "";
    const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM memory_events WHERE project_id=?${ownerClause} AND consolidated=0`).get(...params) as { count: number };
    const latest = this.db.prepare(`SELECT created_at FROM memory_events WHERE project_id=?${ownerClause} ORDER BY created_at DESC LIMIT 1`).get(...params) as { created_at?: string } | undefined;
    const last = this.db.prepare("SELECT * FROM dream_runs ORDER BY started_at DESC LIMIT 1").get() as DreamRow | undefined;
    const maintenanceParams = agentId ? [this.projectId, agentId] : [this.projectId];
    const maintenanceClause = agentId ? " AND agent_id=?" : "";
    const maintenance = this.db.prepare(`SELECT * FROM maintenance_runs WHERE project_id=?${maintenanceClause} ORDER BY created_at DESC LIMIT 1`)
      .get(...maintenanceParams) as Record<string, unknown> | undefined;
    const runningMaintenance = this.db.prepare(`SELECT * FROM maintenance_runs WHERE project_id=?${maintenanceClause} AND status='running' ORDER BY created_at DESC LIMIT 1`)
      .get(...maintenanceParams) as Record<string, unknown> | undefined;
    const rowToMaintenance = (row: Record<string, unknown>): MemoryMaintenanceRun => ({
      id: String(row.id), projectId: String(row.project_id), agentId: String(row.agent_id),
      trigger: row.trigger as MemoryMaintenanceRun["trigger"], status: row.status as MemoryMaintenanceRun["status"],
      pendingEventIds: parseJsonArray(String(row.pending_event_ids)), proposedMutations: Number(row.proposed_mutations),
      appliedMutations: Number(row.applied_mutations), rejectedMutations: Number(row.rejected_mutations),
      startedAt: row.started_at ? String(row.started_at) : undefined, completedAt: row.completed_at ? String(row.completed_at) : undefined,
      error: row.error ? String(row.error) : undefined,
    });
    return {
      enabled,
      counts,
      pendingEvents: pending.count,
      lastDream: last ? rowToDream(last) : undefined,
      runningDream: this.currentDream(),
      lastMaintenance: maintenance ? rowToMaintenance(maintenance) : undefined,
      runningMaintenance: runningMaintenance ? rowToMaintenance(runningMaintenance) : undefined,
      lastActivityAt: latest?.created_at,
    };
  }

  private teamFor(agentId: string): string | null {
    if (agentId === "admin") return null;
    const leader = agentId.match(/^(.+)-(?:lead|leader)$/u);
    if (leader?.[1]) return leader[1];
    return agentId.match(/^(.+)-worker-\d+$/u)?.[1] ?? null;
  }
}
