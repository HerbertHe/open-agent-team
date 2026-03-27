import type { AgentInstanceSpec } from "../types";

export interface RuntimeHandle {
  agentId: string;
  port: number;
  pid?: number;
}

export interface RuntimeProvider {
  start(spec: AgentInstanceSpec): Promise<RuntimeHandle>;
  stop(agentId: string): Promise<void>;
  health(port: number): Promise<boolean>;
}

export interface WorkspaceResult {
  path: string;
  branch: string;
}

export interface WorkspaceProvider {
  ensureWorkspace(spec: AgentInstanceSpec, sparsePaths: string[]): Promise<WorkspaceResult>;
  removeWorkspace(spec: AgentInstanceSpec): Promise<void>;
}
