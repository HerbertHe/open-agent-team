export enum ResourceAgentRoleEnum {
  ResourceManager = 'resource_manager',
}

export enum ConversationMessageRoleEnum {
  User = 'user',
  Assistant = 'assistant',
}

export enum AgentRuntimeStatusEnum {
  Idle = 'idle',
  Running = 'running',
  Failed = 'failed',
  Offline = 'offline',
}

export enum ProjectRuntimeModeEnum {
  LocalProcess = 'local_process',
  Docker = 'docker',
}

export enum ResourceOperationStatusEnum {
  Planning = 'planning',
  CollectingResources = 'collecting_resources',
  Drafting = 'drafting',
  WaitingConfirmation = 'waiting_confirmation',
  Applying = 'applying',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum ResourceProposalStatusEnum {
  WaitingConfirmation = 'waiting_confirmation',
  Confirmed = 'confirmed',
  Applied = 'applied',
  Rejected = 'rejected',
  Expired = 'expired',
  Failed = 'failed',
}

export enum ResourceRequiredActionEnum {
  None = 'none',
  ManualProjectStart = 'manual_project_start',
  ManualProjectRestart = 'manual_project_restart',
  ManualDockerStart = 'manual_docker_start',
  ResolveConfigConflict = 'resolve_config_conflict',
}

export enum ProjectRestartAvailabilityEnum {
  Ready = 'ready',
  ProjectStopped = 'project_stopped',
  ActiveTasks = 'active_tasks',
  AlreadyRestarting = 'already_restarting',
  StartupCommandMissing = 'startup_command_missing',
  DockerEngineUnavailable = 'docker_engine_unavailable',
  StaleProcessState = 'stale_process_state',
  PortConflict = 'port_conflict',
  Unavailable = 'unavailable',
}

export enum ProjectRestartPhaseEnum {
  Idle = 'idle',
  Validating = 'validating',
  Stopping = 'stopping',
  WaitingForRelease = 'waiting_for_release',
  Starting = 'starting',
  WaitingForReady = 'waiting_for_ready',
  Completed = 'completed',
  Failed = 'failed',
}

export enum ProjectRestartTriggerEnum {
  HumanUi = 'human_ui',
}

export interface ProjectRestartStatus {
  availability: ProjectRestartAvailabilityEnum;
  phase: ProjectRestartPhaseEnum;
  activeTaskCount: number;
  projectAlive: boolean;
  runtimeMode?: ProjectRuntimeModeEnum;
  message?: string;
}

export interface ResourceAgentReply {
  text: string;
  status: ResourceOperationStatusEnum;
  requiredAction: ResourceRequiredActionEnum;
  proposalId?: string;
}

export interface ResourceHistoryMessage {
  id: string;
  role: ConversationMessageRoleEnum;
  text: string;
  createdAt: string;
}
