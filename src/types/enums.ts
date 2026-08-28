/**
 * 类型枚举集中定义：避免在代码里到处写死字符串常量。
 */

/**
 * Agent 角色枚举（Admin/Leader/Worker）。
 */
export enum AgentRoleEnum {
  /** Admin：统筹全局、负责最终交付与汇总 */
  Admin = "admin",
  /** Leader：拆解任务、调度 Worker，并汇总团队结果 */
  Leader = "leader",
  /** Worker：执行具体实现任务、提交变更与生成 CHANGELOG */
  Worker = "worker",
}

/** Global control-plane Agent. It is deliberately outside project scheduling. */
export enum ResourceAgentRoleEnum {
  ResourceManager = "resource_manager",
}

export enum ResourceConversationStatusEnum {
  Idle = "idle",
  Running = "running",
  WaitingConfirmation = "waiting_confirmation",
  Failed = "failed",
}

export enum ResourceOperationTypeEnum {
  ResourceReport = "resource_report",
  CreateProject = "create_project",
  UpdateProject = "update_project",
  AddTeam = "add_team",
  AdjustWorkerCapacity = "adjust_worker_capacity",
}

export enum ResourceOperationStatusEnum {
  Planning = "planning",
  CollectingResources = "collecting_resources",
  Drafting = "drafting",
  WaitingConfirmation = "waiting_confirmation",
  Applying = "applying",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

export enum ResourceProposalStatusEnum {
  Draft = "draft",
  WaitingConfirmation = "waiting_confirmation",
  Confirmed = "confirmed",
  Applied = "applied",
  Rejected = "rejected",
  Expired = "expired",
  Conflict = "conflict",
  Failed = "failed",
}

export enum ResourceRequiredActionEnum {
  None = "none",
  ManualProjectStart = "manual_project_start",
  ManualProjectRestart = "manual_project_restart",
  ManualDockerStart = "manual_docker_start",
  ResolveConfigConflict = "resolve_config_conflict",
}

export enum ProjectChangeKindEnum {
  CreateProject = "create_project",
  UpdateProject = "update_project",
  AddTeam = "add_team",
  AdjustWorkerCapacity = "adjust_worker_capacity",
}

export enum ProjectRestartAvailabilityEnum {
  Ready = "ready",
  ProjectStopped = "project_stopped",
  ActiveTasks = "active_tasks",
  AlreadyRestarting = "already_restarting",
  StartupCommandMissing = "startup_command_missing",
  DockerEngineUnavailable = "docker_engine_unavailable",
  StaleProcessState = "stale_process_state",
  PortConflict = "port_conflict",
  Unavailable = "unavailable",
}

export enum ProjectRestartPhaseEnum {
  Idle = "idle",
  Validating = "validating",
  Stopping = "stopping",
  WaitingForRelease = "waiting_for_release",
  Starting = "starting",
  WaitingForReady = "waiting_for_ready",
  Completed = "completed",
  Failed = "failed",
}

export enum ProjectRestartTriggerEnum {
  HumanUi = "human_ui",
}

/** Scheduler task lifecycle. */
export enum QueuedTaskStatusEnum {
  Queued = "queued",
  /** Explicitly parked work. Paused tasks are durable and never scheduled. */
  Paused = "paused",
  Running = "running",
  Waiting = "waiting",
  ReviewPending = "review_pending",
  Completed = "completed",
  Cancelled = "cancelled",
  Failed = "failed",
}

/** Persisted Worker review lifecycle. */
export enum ReviewStatusEnum {
  Pending = "pending",
  Approved = "approved",
  ChangesRequested = "changes_requested",
  Merged = "merged",
  Rejected = "rejected",
}

/** Admin release-decision lifecycle. */
export enum ReleaseStatusEnum {
  Pending = "pending",
  Approved = "approved",
  Merged = "merged",
  Rejected = "rejected",
}

/** Durable Leader inbox event kind. */
export enum LeaderInboxEventTypeEnum {
  WorkerReviewReady = "worker_review_ready",
}

/** Durable Leader inbox delivery lifecycle. */
export enum LeaderInboxEventStatusEnum {
  Pending = "pending",
  Leased = "leased",
  Acknowledged = "acknowledged",
  Failed = "failed",
  /** Read-only compatibility with scheduler snapshots written before leases. */
  LegacyDelivered = "delivered",
}

/** Test evidence recorded with a Worker review. */
export enum ReviewTestStatusEnum {
  Passed = "passed",
  Failed = "failed",
  Unknown = "unknown",
}

/**
 * workspace 提供方策略（文件系统/目录隔离实现）。
 */
export enum WorkspaceProviderTypeEnum {
  /** Worktree：基于 git worktree 做独立 workspace（磁盘高效、支持 sparse-checkout） */
  Worktree = "worktree",
  /** SharedClone：各 Agent 使用独立目录但共享 git 对象库（待扩展） */
  SharedClone = "shared_clone",
  /** FullClone：每个 Agent 完整 clone（磁盘更大、最简单但成本高） */
  FullClone = "full_clone",
}

/**
 * 运行时模式（进程运行或 Flue sandbox 运行）。
 */
export enum RuntimeModeEnum {
  /** local_process：在本机以进程内 pi AgentSession SDK 运行（单机方案） */
  LocalProcess = "local_process",
  /** docker：每个 Agent 会话运行于独立 Docker 容器，宿主仅保留编排和工具执行。 */
  Docker = "docker",
}

/** Upstream API protocol implemented by a model provider. */
export enum ProviderCompatibleTypeEnum {
  OpenAI = "openai",
  Anthropic = "anthropic",
}

export enum BaseBranchEnum {
  Main = "main",
  Master = "master",
}

export enum DockerNetworkModeEnum {
  None = "none",
  Bridge = "bridge",
  Host = "host",
}



/**
 * Worker 技能注入策略：
 * - InheritAndInjectOnSpawn：按 Leader skills 继承，并在生成时注入到新 Worker
 * - Manual：由外部手动配置/注入（非默认）
 */
export enum WorkerSkillSyncEnum {
  /** Worker skills 继承 Leader，并在 spawn 时注入 Worker workspace */
  InheritAndInjectOnSpawn = "inherit_and_inject_on_spawn",
  /** 手动同步：不自动注入，由外部逻辑决定 */
  Manual = "manual",
}
