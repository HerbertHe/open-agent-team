import type { AgentInstanceSpec } from "./agent";
import type { TeamConfig } from "./team";
import { AgentRoleEnum } from "./enums";

export interface OrchestratorCtorArgs {
  goal: string;
  port: number;
}

export interface ToolRequestWorkersBody {
  leaderId: string;
  tasks?: Array<{ index?: number; prompt: string }>;
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

