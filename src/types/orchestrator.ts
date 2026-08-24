import type { AgentInstanceSpec } from "./agent";
import type { TeamConfig } from "./team";
import {
  AgentRoleEnum,
  QueuedTaskStatusEnum,
  ReleaseStatusEnum,
  ReviewStatusEnum,
  ReviewTestStatusEnum,
} from "./enums";

export interface OrchestratorCtorArgs {
  goal: string;
  port: number;
  /** team.json 的绝对路径，用于读写配置和记录项目根目录 */
  configPath: string;
}


/** 仅拉起并注册 Worker（不下发任务） */
export interface ToolRegisterWorkersBody {
  leaderId: string;
  count: number;
}

/** 向已注册的 Worker 下发任务 prompt（由 Leader 在注册完成后调用） */
export interface ToolDispatchWorkerTasksBody {
  leaderId: string;
  tasks: Array<{
    index?: number;
    prompt: string;
    /** Required for a multi-task dispatch: the leader explicitly asserts no shared implementation or test dependency. */
    independent?: boolean;
    /** A shared key is mutually exclusive across queued/running tasks. */
    conflictKey?: string;
  }>;
}

/** `waiting` is a workflow wait for a child/review event, not an occupied Agent prompt. */
export type QueuedTaskStatus = QueuedTaskStatusEnum;

export interface QueuedTask {
  id: string;
  targetAgentId: string;
  createdBy: string;
  /** Parent task when this work was delegated from Admin to Leader or Leader to Worker. */
  parentTaskId?: string;
  prompt: string;
  conflictKey?: string;
  status: QueuedTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  lastProgress?: { stage?: string; message: string; at: string };
  git?: GitTaskArtifact;
}

export type ReviewStatus = ReviewStatusEnum;
export type ReleaseStatus = ReleaseStatusEnum;

/** Worker 可审计交付物；所有向上汇报只传递该清单的路径和 Git 引用。 */
export interface GitTaskArtifact {
  taskId: string;
  attempt: number;
  baseSha: string;
  branch: string;
  workspacePath: string;
  artifactPath: string;
  headSha?: string;
  changedFiles?: string[];
  tests?: Array<{ command: string; status: ReviewTestStatusEnum; evidencePath?: string }>;
}

export interface ReviewRequest {
  id: string;
  taskId: string;
  workerId: string;
  leaderId: string;
  teamName: string;
  branch: string;
  baseSha: string;
  headSha: string;
  artifactPath: string;
  changedFiles: string[];
  tests: Array<{ command: string; status: ReviewTestStatusEnum; evidencePath?: string }>;
  status: ReviewStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewer?: string;
  reviewNote?: string;
  integrationBranch?: string;
  mergeCommit?: string;
}

export interface ReleaseProposal {
  id: string;
  leaderId: string;
  teamName: string;
  integrationBranch: string;
  headSha: string;
  artifactPaths: string[];
  status: ReleaseStatus;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  mergedAt?: string;
  mergeCommit?: string;
  pushedAt?: string;
  pushedBy?: string;
  pushedRemote?: string;
  pushedCommit?: string;
  note?: string;
}

export interface AgentGitStatus {
  agentId: string;
  role: AgentRoleEnum;
  workspacePath: string;
  branch?: string;
  headCommit?: string;
  headSubject?: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  mergedIntoBase: boolean;
  error?: string;
}

export interface GitManagementStatus {
  repository: {
    path: string;
    baseBranch: string;
    headCommit?: string;
    remote?: string;
    remoteUrl?: string;
    pushEnabled: boolean;
    userName?: string;
    userEmail?: string;
    identityValid: boolean;
  };
  agents: AgentGitStatus[];
  reviews: ReviewRequest[];
  releases: ReleaseProposal[];
}

export interface GitConfigurationUpdate {
  remote?: string;
  remoteUrl?: string;
  userName?: string;
  userEmail?: string;
  pushEnabled: boolean;
}

export interface ToolCreateTaskBody {
  targetAgentId: string;
  createdBy: string;
  parentTaskId?: string;
  prompt: string;
  conflictKey?: string;
}

export interface ToolUpdateTaskBody {
  id: string;
  prompt?: string;
  conflictKey?: string;
  status?: QueuedTaskStatusEnum.Queued | QueuedTaskStatusEnum.Cancelled;
}

export interface ToolAssignLeaderTaskBody {
  leaderId: string;
  prompt: string;
}

export interface NotifyCompleteBody {
  agentRole: AgentRoleEnum;
  agentId: string;
  changelog?: string;
}

export interface SpawnWorkersResult {
  workerIds: string[];
}

export interface AgentRuntimeState {
  spec: AgentInstanceSpec;
  sessionId: string;
  workers: string[];
  leaderTeam?: TeamConfig;
}
