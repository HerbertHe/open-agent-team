import type { AgentInstanceSpec } from "../types";

export interface RuntimeHandle {
  agentId: string;
}

export interface RuntimeProvider {
  start(spec: AgentInstanceSpec): Promise<RuntimeHandle>;
  stop(agentId: string): Promise<void>;
  /** 终止本 Provider 已启动的全部 Agent 会话（用于主进程退出时回收资源）。 */
  stopAll(): Promise<void>;
  health(agentId: string): Promise<boolean>;
}

export interface WorkspaceResult {
  path: string;
  branch: string;
}

export interface WorkspaceProvider {
  ensureWorkspace(spec: AgentInstanceSpec, sparsePaths: string[]): Promise<WorkspaceResult>;
  removeWorkspace(spec: AgentInstanceSpec): Promise<void>;
}
