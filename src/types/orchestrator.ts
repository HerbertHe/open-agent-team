import type { AgentInstanceSpec } from "./agent";
import type { TeamConfig } from "./team";
import { AgentRoleEnum } from "./enums";

export interface OrchestratorCtorArgs {
  goal: string;
  port: number;
  /** 已构建的观测面板静态资源目录（通常为 <pkg>/dashboard/dist），存在则随 HTTP 一并托管 */
  dashboardDist?: string;
}

export interface ToolRequestWorkersBody {
  leaderId: string;
  tasks?: Array<{ index?: number; prompt: string }>;
}

/** 仅拉起并注册 Worker（不下发任务） */
export interface ToolRegisterWorkersBody {
  leaderId: string;
  count: number;
}

/** 向已注册的 Worker 下发任务 prompt（由 Leader 在注册完成后调用） */
export interface ToolDispatchWorkerTasksBody {
  leaderId: string;
  tasks: Array<{ index?: number; prompt: string }>;
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

