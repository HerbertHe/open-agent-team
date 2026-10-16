import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExecutionDatabase } from "./execution-database";

export const EXECUTION_SCHEMA_VERSION = 7;

const SCHEMA_V1_SQL = `
CREATE TABLE execution_schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE programs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'draft','planning','awaiting_approval','admitted','running','waiting','replanning',
    'interrupt_requested','quiescing','snapshotting','reconciling','suspended',
    'suspended_uncertain','closing_out','completed','incomplete','cancelled'
  )),
  execution_epoch INTEGER NOT NULL DEFAULT 0 CHECK(execution_epoch >= 0),
  active_plan_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(id, active_plan_version_id)
    REFERENCES plan_versions(program_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_programs_project_status ON programs(project_id, status, updated_at);

CREATE TABLE plan_versions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 0),
  scope_tier TEXT NOT NULL CHECK(scope_tier IN ('minimum','standard','stretch')),
  status TEXT NOT NULL CHECK(status IN ('draft','validated','awaiting_approval','active','superseded','rejected')),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE(program_id, version),
  UNIQUE(program_id, id)
);
CREATE INDEX idx_plan_versions_program_status ON plan_versions(program_id, status, version DESC);

CREATE TABLE work_packages (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'planned','blocked','runnable','leased','running','checkpointed','verifying',
    'completed','failed','cancelled','replanning_required'
  )),
  mandatory INTEGER NOT NULL DEFAULT 1 CHECK(mandatory IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 0,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plan_version_id, stable_key),
  UNIQUE(plan_version_id, id),
  FOREIGN KEY(program_id, plan_version_id)
    REFERENCES plan_versions(program_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_work_packages_runnable ON work_packages(program_id, status, priority DESC, created_at);

CREATE TABLE work_package_dependencies (
  plan_version_id TEXT NOT NULL,
  work_package_id TEXT NOT NULL,
  depends_on_work_package_id TEXT NOT NULL,
  PRIMARY KEY(work_package_id, depends_on_work_package_id),
  CHECK(work_package_id <> depends_on_work_package_id),
  FOREIGN KEY(plan_version_id, work_package_id)
    REFERENCES work_packages(plan_version_id, id) ON DELETE CASCADE,
  FOREIGN KEY(plan_version_id, depends_on_work_package_id)
    REFERENCES work_packages(plan_version_id, id) ON DELETE CASCADE
);

CREATE TABLE work_package_attempts (
  id TEXT PRIMARY KEY,
  work_package_id TEXT NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  status TEXT NOT NULL CHECK(status IN (
    'created','leased','running','checkpointed','verifying','completed','failed',
    'aborted','uncertain','expired'
  )),
  execution_epoch INTEGER NOT NULL CHECK(execution_epoch >= 0),
  fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
  failure_json TEXT CHECK(failure_json IS NULL OR json_valid(failure_json)),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(work_package_id, attempt_number),
  UNIQUE(work_package_id, fencing_token)
);
CREATE INDEX idx_attempts_work_status ON work_package_attempts(work_package_id, status, attempt_number DESC);

CREATE TABLE attempt_leases (
  attempt_id TEXT PRIMARY KEY REFERENCES work_package_attempts(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_attempt_leases_expiry ON attempt_leases(expires_at);

CREATE TABLE execution_outbox (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','publishing','published','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  CHECK(
    (state = 'publishing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (state <> 'publishing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK(
    (state = 'published' AND published_at IS NOT NULL) OR
    (state <> 'published' AND published_at IS NULL)
  )
);
CREATE INDEX idx_execution_outbox_pending ON execution_outbox(state, available_at, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  program_id TEXT REFERENCES programs(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES work_package_attempts(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  request_id TEXT,
  reason TEXT,
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_events_program ON audit_events(program_id, created_at, id);
CREATE INDEX idx_audit_events_attempt ON audit_events(attempt_id, created_at, id);
CREATE INDEX idx_audit_events_request ON audit_events(request_id) WHERE request_id IS NOT NULL;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
`;

const SCHEMA_V2_SQL = `
CREATE TABLE budget_accounts (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  parent_account_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN (
    'root','planning','execution','minimum','upgrade_pool','standard','stretch',
    'validation','contingency','closeout'
  )),
  limit_json TEXT NOT NULL CHECK(json_valid(limit_json)),
  spent_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(spent_json)),
  reserved_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(reserved_json)),
  protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(program_id, kind),
  UNIQUE(program_id, id),
  CHECK(kind NOT IN ('validation','closeout') OR protected = 1),
  FOREIGN KEY(program_id, parent_account_id)
    REFERENCES budget_accounts(program_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_budget_accounts_program_parent ON budget_accounts(program_id, parent_account_id);

CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  parent_reservation_id TEXT,
  operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN (
    'created','active','settled','released','uncertain','reconciled','rejected','expired'
  )),
  reserved_json TEXT NOT NULL CHECK(json_valid(reserved_json)),
  settled_json TEXT CHECK(settled_json IS NULL OR json_valid(settled_json)),
  remaining_json TEXT NOT NULL CHECK(json_valid(remaining_json)),
  provider_request_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(program_id, account_id, id),
  FOREIGN KEY(program_id, account_id) REFERENCES budget_accounts(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY(program_id, account_id, parent_reservation_id)
    REFERENCES budget_reservations(program_id, account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_budget_reservations_account_state ON budget_reservations(account_id, state, created_at);
CREATE INDEX idx_budget_reservations_provider_request ON budget_reservations(provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE TABLE pricing_snapshots (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  catalog_revision TEXT NOT NULL,
  prices_json TEXT NOT NULL CHECK(json_valid(prices_json)),
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(program_id, id)
);
CREATE INDEX idx_pricing_snapshots_program ON pricing_snapshots(program_id, created_at);

CREATE TABLE spend_events (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES budget_reservations(id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL UNIQUE,
  actual_json TEXT NOT NULL CHECK(json_valid(actual_json)),
  pricing_snapshot_id TEXT REFERENCES pricing_snapshots(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_spend_events_reservation ON spend_events(reservation_id, created_at);

CREATE TABLE estimation_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_class TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  tool_profile TEXT NOT NULL,
  usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  succeeded INTEGER NOT NULL CHECK(succeeded IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_estimation_observations_key ON estimation_observations(
  project_id, task_class, model, agent_role, tool_profile, created_at
);
`;

const SCHEMA_V3_SQL = `
CREATE TABLE acceptance_criteria (
  id TEXT NOT NULL,
  work_package_id TEXT NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  criterion_json TEXT NOT NULL CHECK(json_valid(criterion_json)),
  verifier_version TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(work_package_id, id)
);
CREATE INDEX idx_acceptance_criteria_work ON acceptance_criteria(work_package_id, type);

CREATE TABLE work_package_estimates (
  work_package_id TEXT PRIMARY KEY REFERENCES work_packages(id) ON DELETE CASCADE,
  estimate_json TEXT NOT NULL CHECK(json_valid(estimate_json)),
  estimator_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE admission_decisions (
  id TEXT PRIMARY KEY,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  scope_tier TEXT NOT NULL CHECK(scope_tier IN ('minimum','standard','stretch')),
  seed TEXT NOT NULL,
  decision_json TEXT NOT NULL CHECK(json_valid(decision_json)),
  created_at TEXT NOT NULL,
  UNIQUE(plan_version_id, scope_tier)
);

CREATE TABLE wakeups (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,
  wake_at TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatched','dead_letter')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  outbox_event_id TEXT REFERENCES execution_outbox(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dispatched_at TEXT
);
CREATE INDEX idx_wakeups_due ON wakeups(state, wake_at, priority DESC, id);

CREATE TABLE task_board_projections (
  event_id TEXT PRIMARY KEY REFERENCES execution_outbox(id) ON DELETE CASCADE,
  work_package_id TEXT NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','projected','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_task_board_projection_state ON task_board_projections(state, updated_at);
`;

const SCHEMA_V4_SQL = `
CREATE TABLE execution_checkpoints (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES work_package_attempts(id) ON DELETE CASCADE,
  execution_epoch INTEGER NOT NULL CHECK(execution_epoch >= 0),
  fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(attempt_id, execution_epoch, fencing_token, digest)
);
CREATE INDEX idx_execution_checkpoints_attempt ON execution_checkpoints(attempt_id, created_at DESC);

CREATE TABLE execution_barriers (
  program_id TEXT PRIMARY KEY REFERENCES programs(id) ON DELETE CASCADE,
  execution_epoch INTEGER NOT NULL CHECK(execution_epoch >= 0),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE suspension_snapshots (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  execution_epoch INTEGER NOT NULL CHECK(execution_epoch >= 0),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(program_id, execution_epoch)
);

CREATE TABLE program_control_requests (
  request_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('graceful','immediate','cancel_closeout')),
  state TEXT NOT NULL CHECK(state IN ('requested','quiescing','snapshotting','reconciling','completed','failed')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_program_control_program ON program_control_requests(program_id, created_at);

CREATE TABLE effects (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES work_package_attempts(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL UNIQUE,
  effect_type TEXT NOT NULL,
  impact TEXT NOT NULL CHECK(impact IN ('low','medium','high')),
  state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','confirmed','uncertain','reconciled','cancelled')),
  request_digest TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  provider_request_id TEXT,
  receipt_digest TEXT,
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  execution_epoch INTEGER NOT NULL CHECK(execution_epoch >= 0),
  fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_effects_program_state ON effects(program_id, state, created_at);
CREATE INDEX idx_effects_attempt ON effects(attempt_id, created_at);
`;

const SCHEMA_V5_SQL = `
CREATE TABLE verification_evidence (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  work_package_id TEXT NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES work_package_attempts(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  criterion_type TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  validator_version TEXT NOT NULL,
  artifact_digest TEXT,
  git_sha TEXT,
  evidence_path TEXT,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL,
  UNIQUE(attempt_id, criterion_id)
);
CREATE INDEX idx_verification_evidence_work ON verification_evidence(work_package_id, created_at);

CREATE TABLE replan_failures (
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  failure_class TEXT NOT NULL,
  consecutive_count INTEGER NOT NULL CHECK(consecutive_count >= 0),
  last_failure_at TEXT NOT NULL,
  PRIMARY KEY(program_id, failure_class)
);

CREATE TABLE program_closeouts (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','incomplete')),
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  created_at TEXT NOT NULL,
  UNIQUE(program_id)
);

CREATE TABLE program_alerts (
  id TEXT PRIMARY KEY,
  program_id TEXT REFERENCES programs(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('warning','critical')),
  labels_json TEXT NOT NULL CHECK(json_valid(labels_json)),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_program_alerts_open ON program_alerts(program_id, code, created_at) WHERE resolved_at IS NULL;
`;

const SCHEMA_V6_SQL = `
CREATE TABLE simulation_runs (
  id TEXT PRIMARY KEY,
  seed TEXT NOT NULL,
  virtual_days INTEGER NOT NULL CHECK(virtual_days > 0),
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE threat_model_reviews (
  id TEXT PRIMARY KEY,
  reviewer TEXT NOT NULL,
  findings_json TEXT NOT NULL CHECK(json_valid(findings_json)),
  passed_soft INTEGER NOT NULL CHECK(passed_soft IN (0,1)),
  passed_hard INTEGER NOT NULL CHECK(passed_hard IN (0,1)),
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE release_gate_records (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK(stage IN ('shadow','soft','hard')),
  status TEXT NOT NULL CHECK(status IN ('passed','blocked')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  blockers_json TEXT NOT NULL CHECK(json_valid(blockers_json)),
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_release_gate_stage ON release_gate_records(stage, created_at DESC);

CREATE TRIGGER simulation_runs_no_update BEFORE UPDATE ON simulation_runs BEGIN SELECT RAISE(ABORT, 'simulation_runs is append-only'); END;
CREATE TRIGGER simulation_runs_no_delete BEFORE DELETE ON simulation_runs BEGIN SELECT RAISE(ABORT, 'simulation_runs is append-only'); END;
CREATE TRIGGER threat_model_reviews_no_update BEFORE UPDATE ON threat_model_reviews BEGIN SELECT RAISE(ABORT, 'threat_model_reviews is append-only'); END;
CREATE TRIGGER threat_model_reviews_no_delete BEFORE DELETE ON threat_model_reviews BEGIN SELECT RAISE(ABORT, 'threat_model_reviews is append-only'); END;
CREATE TRIGGER release_gate_records_no_update BEFORE UPDATE ON release_gate_records BEGIN SELECT RAISE(ABORT, 'release_gate_records is append-only'); END;
CREATE TRIGGER release_gate_records_no_delete BEFORE DELETE ON release_gate_records BEGIN SELECT RAISE(ABORT, 'release_gate_records is append-only'); END;
`;

const V1_TABLES = [
  "attempt_leases",
  "audit_events",
  "execution_outbox",
  "execution_schema_migrations",
  "plan_versions",
  "programs",
  "work_package_attempts",
  "work_package_dependencies",
  "work_packages",
] as const;

const V1_CHECKSUM = createHash("sha256").update(SCHEMA_V1_SQL).digest("hex");
const V1_TRIGGERS = ["audit_events_no_delete", "audit_events_no_update"] as const;
const V2_TABLES = [
  ...V1_TABLES,
  "budget_accounts",
  "budget_reservations",
  "estimation_observations",
  "pricing_snapshots",
  "spend_events",
].sort();
const V2_CHECKSUM = createHash("sha256").update(SCHEMA_V2_SQL).digest("hex");
const V3_TABLES = [
  ...V2_TABLES,
  "acceptance_criteria",
  "admission_decisions",
  "task_board_projections",
  "wakeups",
  "work_package_estimates",
].sort();
const V3_CHECKSUM = createHash("sha256").update(SCHEMA_V3_SQL).digest("hex");
const V4_TABLES = [
  ...V3_TABLES,
  "effects",
  "execution_barriers",
  "execution_checkpoints",
  "program_control_requests",
  "suspension_snapshots",
].sort();
const V4_CHECKSUM = createHash("sha256").update(SCHEMA_V4_SQL).digest("hex");
const V5_TABLES = [
  ...V4_TABLES,
  "program_alerts",
  "program_closeouts",
  "replan_failures",
  "verification_evidence",
].sort();
const V5_CHECKSUM = createHash("sha256").update(SCHEMA_V5_SQL).digest("hex");
const SCHEMA_V7_SQL = `
CREATE TABLE program_scheduler_leases (
  program_id TEXT PRIMARY KEY REFERENCES programs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
  expires_at TEXT NOT NULL,
  tick_id TEXT,
  tick_expires_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK((tick_id IS NULL) = (tick_expires_at IS NULL))
);
CREATE TABLE attempt_execution_owners (
  attempt_id TEXT PRIMARY KEY REFERENCES work_package_attempts(id) ON DELETE CASCADE,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  scheduler_fencing_token INTEGER NOT NULL CHECK(scheduler_fencing_token > 0)
);
CREATE TABLE execution_resource_claims (
  project_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES work_package_attempts(id) ON DELETE CASCADE,
  PRIMARY KEY(project_id, resource_key)
);
CREATE INDEX idx_execution_resource_attempt ON execution_resource_claims(attempt_id);
CREATE TRIGGER attempt_execution_owners_program_insert BEFORE INSERT ON attempt_execution_owners
WHEN NOT EXISTS (SELECT 1 FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id WHERE a.id=NEW.attempt_id AND w.program_id=NEW.program_id)
BEGIN SELECT RAISE(ABORT,'attempt scheduler Program mismatch'); END;
CREATE TRIGGER attempt_execution_owners_program_update BEFORE UPDATE ON attempt_execution_owners
WHEN NOT EXISTS (SELECT 1 FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id WHERE a.id=NEW.attempt_id AND w.program_id=NEW.program_id)
BEGIN SELECT RAISE(ABORT,'attempt scheduler Program mismatch'); END;
CREATE TRIGGER execution_resource_claims_project_insert BEFORE INSERT ON execution_resource_claims
WHEN NOT EXISTS (SELECT 1 FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id JOIN programs p ON p.id=w.program_id WHERE a.id=NEW.attempt_id AND p.project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'resource claim project mismatch'); END;
CREATE TRIGGER execution_resource_claims_project_update BEFORE UPDATE ON execution_resource_claims
WHEN NOT EXISTS (SELECT 1 FROM work_package_attempts a JOIN work_packages w ON w.id=a.work_package_id JOIN programs p ON p.id=w.program_id WHERE a.id=NEW.attempt_id AND p.project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'resource claim project mismatch'); END;
`;
const V7_CHECKSUM = createHash("sha256").update(SCHEMA_V7_SQL).digest("hex");
const V6_TABLES = [...V5_TABLES, "release_gate_records", "simulation_runs", "threat_model_reviews"].sort();
const V6_CHECKSUM = createHash("sha256").update(SCHEMA_V6_SQL).digest("hex");
const V6_TRIGGERS = [...V1_TRIGGERS,
  "release_gate_records_no_delete", "release_gate_records_no_update",
  "simulation_runs_no_delete", "simulation_runs_no_update",
  "threat_model_reviews_no_delete", "threat_model_reviews_no_update",
].sort();

const V7_TABLES = [...V6_TABLES, "program_scheduler_leases", "attempt_execution_owners", "execution_resource_claims"].sort();
const V7_TRIGGERS = [...V6_TRIGGERS, "attempt_execution_owners_program_insert", "attempt_execution_owners_program_update",
  "execution_resource_claims_project_insert", "execution_resource_claims_project_update"].sort();

export type ExecutionMigrationErrorCode =
  | "SCHEMA_TOO_NEW"
  | "UNMANAGED_SCHEMA"
  | "SCHEMA_DRIFT"
  | "MIGRATION_FAILED";

export class ExecutionMigrationError extends Error {
  constructor(readonly code: ExecutionMigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExecutionMigrationError";
  }
}

export interface ExecutionMigrationOptions {
  appliedAt?: string;
  faultInjector?: (point: "v1_after_schema" | "v2_after_schema" | "v3_after_schema" | "v4_after_schema" | "v5_after_schema" | "v6_after_schema" | "v7_after_schema") => void;
}

export interface ExecutionMigrationResult {
  fromVersion: number;
  toVersion: number;
  appliedVersions: number[];
}

function userTables(database: Database.Database): string[] {
  return database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).pluck().all() as string[];
}

function validateSchemaV1(database: Database.Database): void {
  const actualTables = userTables(database);
  if (actualTables.length !== V1_TABLES.length || actualTables.some((name, index) => name !== V1_TABLES[index])) {
    throw new ExecutionMigrationError(
      "SCHEMA_DRIFT",
      `Execution schema tables do not match v1: ${actualTables.join(",")}`,
    );
  }
  const migration = database.prepare(
    "SELECT name, checksum FROM execution_schema_migrations WHERE version = 1",
  ).get() as { name: string; checksum: string } | undefined;
  if (!migration || migration.name !== "initial_program_schema" || migration.checksum !== V1_CHECKSUM) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", "Execution schema v1 migration history is missing or has an invalid checksum");
  }
  const actualTriggers = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).pluck().all() as string[];
  if (actualTriggers.length !== V1_TRIGGERS.length || actualTriggers.some((name, index) => name !== V1_TRIGGERS[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema triggers do not match v1: ${actualTriggers.join(",")}`);
  }
  const foreignKeyErrors = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", "Execution schema contains foreign key violations");
  }
}

function validateSchemaV2(database: Database.Database): void {
  const actualTables = userTables(database);
  if (actualTables.length !== V2_TABLES.length || actualTables.some((name, index) => name !== V2_TABLES[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema tables do not match v2: ${actualTables.join(",")}`);
  }
  for (const expected of [
    { version: 1, name: "initial_program_schema", checksum: V1_CHECKSUM },
    { version: 2, name: "budget_ledger_schema", checksum: V2_CHECKSUM },
  ]) {
    const migration = database.prepare(
      "SELECT name, checksum FROM execution_schema_migrations WHERE version = ?",
    ).get(expected.version) as { name: string; checksum: string } | undefined;
    if (!migration || migration.name !== expected.name || migration.checksum !== expected.checksum) {
      throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema v${expected.version} migration history is invalid`);
    }
  }
  const actualTriggers = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).pluck().all() as string[];
  if (actualTriggers.length !== V1_TRIGGERS.length || actualTriggers.some((name, index) => name !== V1_TRIGGERS[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema triggers do not match v2: ${actualTriggers.join(",")}`);
  }
  if ((database.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", "Execution schema contains foreign key violations");
  }
}

function validateSchemaV3(database: Database.Database): void {
  const actualTables = userTables(database);
  if (actualTables.length !== V3_TABLES.length || actualTables.some((name, index) => name !== V3_TABLES[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema tables do not match v3: ${actualTables.join(",")}`);
  }
  for (const expected of [
    { version: 1, name: "initial_program_schema", checksum: V1_CHECKSUM },
    { version: 2, name: "budget_ledger_schema", checksum: V2_CHECKSUM },
    { version: 3, name: "planning_runtime_schema", checksum: V3_CHECKSUM },
  ]) {
    const migration = database.prepare(
      "SELECT name, checksum FROM execution_schema_migrations WHERE version = ?",
    ).get(expected.version) as { name: string; checksum: string } | undefined;
    if (!migration || migration.name !== expected.name || migration.checksum !== expected.checksum) {
      throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema v${expected.version} migration history is invalid`);
    }
  }
  const actualTriggers = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).pluck().all() as string[];
  if (actualTriggers.length !== V1_TRIGGERS.length || actualTriggers.some((name, index) => name !== V1_TRIGGERS[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema triggers do not match v3: ${actualTriggers.join(",")}`);
  }
  if ((database.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", "Execution schema contains foreign key violations");
  }
}

function validateSchemaV4(database: Database.Database): void {
  const actualTables = userTables(database);
  if (actualTables.length !== V4_TABLES.length || actualTables.some((name, index) => name !== V4_TABLES[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema tables do not match v4: ${actualTables.join(",")}`);
  }
  for (const expected of [
    { version: 1, name: "initial_program_schema", checksum: V1_CHECKSUM },
    { version: 2, name: "budget_ledger_schema", checksum: V2_CHECKSUM },
    { version: 3, name: "planning_runtime_schema", checksum: V3_CHECKSUM },
    { version: 4, name: "control_effects_schema", checksum: V4_CHECKSUM },
  ]) {
    const migration = database.prepare("SELECT name, checksum FROM execution_schema_migrations WHERE version = ?").get(expected.version) as { name: string; checksum: string } | undefined;
    if (!migration || migration.name !== expected.name || migration.checksum !== expected.checksum) {
      throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema v${expected.version} migration history is invalid`);
    }
  }
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").pluck().all() as string[];
  if (triggers.length !== V1_TRIGGERS.length || triggers.some((name, index) => name !== V1_TRIGGERS[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema triggers do not match v4: ${triggers.join(",")}`);
  }
  if ((database.pragma("foreign_key_check") as unknown[]).length) throw new ExecutionMigrationError("SCHEMA_DRIFT", "Execution schema contains foreign key violations");
}

function validateSchemaV5(database: Database.Database): void {
  const actualTables = userTables(database);
  if (actualTables.length !== V5_TABLES.length || actualTables.some((name, index) => name !== V5_TABLES[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema tables do not match v5: ${actualTables.join(",")}`);
  }
  for (const expected of [
    { version: 1, name: "initial_program_schema", checksum: V1_CHECKSUM },
    { version: 2, name: "budget_ledger_schema", checksum: V2_CHECKSUM },
    { version: 3, name: "planning_runtime_schema", checksum: V3_CHECKSUM },
    { version: 4, name: "control_effects_schema", checksum: V4_CHECKSUM },
    { version: 5, name: "operations_closeout_schema", checksum: V5_CHECKSUM },
  ]) {
    const migration = database.prepare("SELECT name, checksum FROM execution_schema_migrations WHERE version = ?").get(expected.version) as { name: string; checksum: string } | undefined;
    if (!migration || migration.name !== expected.name || migration.checksum !== expected.checksum) {
      throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema v${expected.version} migration history is invalid`);
    }
  }
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").pluck().all() as string[];
  if (triggers.length !== V1_TRIGGERS.length || triggers.some((name, index) => name !== V1_TRIGGERS[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema triggers do not match v5: ${triggers.join(",")}`);
  }
  if ((database.pragma("foreign_key_check") as unknown[]).length) throw new ExecutionMigrationError("SCHEMA_DRIFT", "Execution schema contains foreign key violations");
}

function validateSchemaV6(database: Database.Database): void {
  const actualTables = userTables(database);
  if (actualTables.length !== V6_TABLES.length || actualTables.some((name, index) => name !== V6_TABLES[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema tables do not match v6: ${actualTables.join(",")}`);
  }
  for (const expected of [
    { version: 1, name: "initial_program_schema", checksum: V1_CHECKSUM },
    { version: 2, name: "budget_ledger_schema", checksum: V2_CHECKSUM },
    { version: 3, name: "planning_runtime_schema", checksum: V3_CHECKSUM },
    { version: 4, name: "control_effects_schema", checksum: V4_CHECKSUM },
    { version: 5, name: "operations_closeout_schema", checksum: V5_CHECKSUM },
    { version: 6, name: "release_assurance_schema", checksum: V6_CHECKSUM },
  ]) {
    const migration = database.prepare("SELECT name,checksum FROM execution_schema_migrations WHERE version=?").get(expected.version) as { name: string; checksum: string } | undefined;
    if (!migration || migration.name !== expected.name || migration.checksum !== expected.checksum) throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema v${expected.version} migration history is invalid`);
  }
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").pluck().all() as string[];
  if (triggers.length !== V6_TRIGGERS.length || triggers.some((name, index) => name !== V6_TRIGGERS[index])) throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema triggers do not match v6: ${triggers.join(",")}`);
  if ((database.pragma("foreign_key_check") as unknown[]).length) throw new ExecutionMigrationError("SCHEMA_DRIFT", "Execution schema contains foreign key violations");
}

function validateSchemaV7(database: Database.Database): void {
  const actualTables = userTables(database);
  if (actualTables.length !== V7_TABLES.length || actualTables.some((name, index) => name !== V7_TABLES[index])) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema tables do not match v7: ${actualTables.join(",")}`);
  }
  for (const expected of [
    { version: 1, name: "initial_program_schema", checksum: V1_CHECKSUM },
    { version: 2, name: "budget_ledger_schema", checksum: V2_CHECKSUM },
    { version: 3, name: "planning_runtime_schema", checksum: V3_CHECKSUM },
    { version: 4, name: "control_effects_schema", checksum: V4_CHECKSUM },
    { version: 5, name: "operations_closeout_schema", checksum: V5_CHECKSUM },
    { version: 6, name: "release_assurance_schema", checksum: V6_CHECKSUM },
    { version: 7, name: "scheduler_ownership_schema", checksum: V7_CHECKSUM },
  ]) {
    const migration = database.prepare("SELECT name,checksum FROM execution_schema_migrations WHERE version=?").get(expected.version) as { name: string; checksum: string } | undefined;
    if (!migration || migration.name !== expected.name || migration.checksum !== expected.checksum) throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema v${expected.version} migration history is invalid`);
  }
  const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").pluck().all() as string[];
  if (triggers.length !== V7_TRIGGERS.length || triggers.some((name, index) => name !== V7_TRIGGERS[index])) throw new ExecutionMigrationError("SCHEMA_DRIFT", `Execution schema triggers do not match v7: ${triggers.join(",")}`);
  if ((database.pragma("foreign_key_check") as unknown[]).length) throw new ExecutionMigrationError("SCHEMA_DRIFT", "Execution schema contains foreign key violations");
}

export function migrateExecutionDatabase(
  handle: ExecutionDatabase,
  options: ExecutionMigrationOptions = {},
): ExecutionMigrationResult {
  for (let attempt = 0; ; attempt++) {
    const before = Number(handle.connection.pragma("user_version", { simple: true }));
    try { return migrateExecutionDatabaseOnce(handle, options); }
    catch (error) {
      const after = Number(handle.connection.pragma("user_version", { simple: true }));
      // Another process may have committed the same migration between our
      // version read and DDL. Re-read and validate instead of accepting drift.
      if (attempt >= EXECUTION_SCHEMA_VERSION || options.faultInjector || after <= before || after > EXECUTION_SCHEMA_VERSION) throw error;
    }
  }
}

function migrateExecutionDatabaseOnce(
  handle: ExecutionDatabase,
  options: ExecutionMigrationOptions = {},
): ExecutionMigrationResult {
  const database = handle.connection;
  const fromVersion = Number(database.pragma("user_version", { simple: true }));
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 0) {
    throw new ExecutionMigrationError("SCHEMA_DRIFT", `Invalid execution schema version: ${fromVersion}`);
  }
  if (fromVersion > EXECUTION_SCHEMA_VERSION) {
    throw new ExecutionMigrationError(
      "SCHEMA_TOO_NEW",
      `Execution schema version ${fromVersion} is newer than supported version ${EXECUTION_SCHEMA_VERSION}`,
    );
  }
  if (fromVersion === EXECUTION_SCHEMA_VERSION) {
    validateSchemaV7(database);
    return { fromVersion, toVersion: fromVersion, appliedVersions: [] };
  }
  if (fromVersion === 0 && userTables(database).length > 0) {
    throw new ExecutionMigrationError("UNMANAGED_SCHEMA", "Version 0 execution database contains unmanaged tables");
  }

  const appliedAt = options.appliedAt ?? new Date().toISOString();
  const appliedVersions: number[] = [];
  try {
    if (fromVersion < 1) {
      database.transaction(() => {
        database.exec(SCHEMA_V1_SQL);
        options.faultInjector?.("v1_after_schema");
        database.prepare(
          "INSERT INTO execution_schema_migrations(version, name, checksum, applied_at) VALUES(1, ?, ?, ?)",
        ).run("initial_program_schema", V1_CHECKSUM, appliedAt);
        database.pragma("user_version = 1");
      }).immediate();
      appliedVersions.push(1);
    } else if (fromVersion === 1) {
      validateSchemaV1(database);
    }
    if (fromVersion < 2) {
      database.transaction(() => {
        database.exec(SCHEMA_V2_SQL);
        options.faultInjector?.("v2_after_schema");
        database.prepare(
          "INSERT INTO execution_schema_migrations(version, name, checksum, applied_at) VALUES(2, ?, ?, ?)",
        ).run("budget_ledger_schema", V2_CHECKSUM, appliedAt);
        database.pragma("user_version = 2");
      }).immediate();
      appliedVersions.push(2);
    } else if (fromVersion === 2) {
      validateSchemaV2(database);
    }
    if (fromVersion < 3) {
      database.transaction(() => {
        database.exec(SCHEMA_V3_SQL);
        options.faultInjector?.("v3_after_schema");
        database.prepare(
          "INSERT INTO execution_schema_migrations(version, name, checksum, applied_at) VALUES(3, ?, ?, ?)",
        ).run("planning_runtime_schema", V3_CHECKSUM, appliedAt);
        database.pragma("user_version = 3");
      }).immediate();
      appliedVersions.push(3);
    } else if (fromVersion === 3) {
      validateSchemaV3(database);
    }
    if (fromVersion < 4) {
      database.transaction(() => {
        database.exec(SCHEMA_V4_SQL);
        options.faultInjector?.("v4_after_schema");
        database.prepare(
          "INSERT INTO execution_schema_migrations(version, name, checksum, applied_at) VALUES(4, ?, ?, ?)",
        ).run("control_effects_schema", V4_CHECKSUM, appliedAt);
        database.pragma("user_version = 4");
      }).immediate();
      appliedVersions.push(4);
    } else if (fromVersion === 4) {
      validateSchemaV4(database);
    }
    if (fromVersion < 5) {
      database.transaction(() => {
        database.exec(SCHEMA_V5_SQL);
        options.faultInjector?.("v5_after_schema");
        database.prepare(
          "INSERT INTO execution_schema_migrations(version, name, checksum, applied_at) VALUES(5, ?, ?, ?)",
        ).run("operations_closeout_schema", V5_CHECKSUM, appliedAt);
        database.pragma("user_version = 5");
      }).immediate();
      appliedVersions.push(5);
    } else if (fromVersion === 5) {
      validateSchemaV5(database);
    }
    if (fromVersion < 6) {
      database.transaction(() => {
        database.exec(SCHEMA_V6_SQL);
        options.faultInjector?.("v6_after_schema");
        database.prepare("INSERT INTO execution_schema_migrations(version,name,checksum,applied_at) VALUES(6,?,?,?)")
          .run("release_assurance_schema", V6_CHECKSUM, appliedAt);
        database.pragma("user_version = 6");
      }).immediate();
      appliedVersions.push(6);
    } else if (fromVersion === 6) validateSchemaV6(database);
    database.transaction(() => {
      database.exec(SCHEMA_V7_SQL);
      options.faultInjector?.("v7_after_schema");
      database.prepare("INSERT INTO execution_schema_migrations(version,name,checksum,applied_at) VALUES(7,?,?,?)")
        .run("scheduler_ownership_schema", V7_CHECKSUM, appliedAt);
      database.pragma("user_version = 7");
    }).immediate();
    appliedVersions.push(7);
    validateSchemaV7(database);
    return { fromVersion, toVersion: 7, appliedVersions };
  } catch (error) {
    if (error instanceof ExecutionMigrationError) throw error;
    throw new ExecutionMigrationError("MIGRATION_FAILED", "Execution schema migration failed", { cause: error });
  }
}
