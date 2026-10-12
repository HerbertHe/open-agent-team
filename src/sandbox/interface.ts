import type { AgentInstanceSpec } from "../types";
import type { ExecutionRuntimeContext } from "../program/execution-runtime-context";
import type { ContinuationState } from "../program/checkpoint-store";

export type RuntimeExecutionAuthorization = {
  phase: "prompt" | "tool";
  agentId: string;
  context: ExecutionRuntimeContext;
  toolName?: string;
};

export type RuntimeExecutionAuthorizer = (input: RuntimeExecutionAuthorization) => void | Promise<void>;

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

export interface InterruptibleRuntimeProvider {
  requestCheckpoint(agentId: string, attemptId: string, deadlineAt: string): Promise<{ acknowledged: boolean; state?: ContinuationState }>;
  abortAttempt(agentId: string, attemptId: string, reason: string): Promise<{ acknowledged: boolean; providerRequests: string[]; toolCalls: string[] }>;
  terminateSession(agentId: string, reason: string): Promise<void>;
  resetSession(agentId: string, executionContext?: ExecutionRuntimeContext): Promise<void>;
  describeSession(agentId: string): { agentId: string; workspacePath: string } | undefined;
  setExecutionAuthorizer?(authorizer?: RuntimeExecutionAuthorizer): void;
}

export interface WorkspaceResult {
  path: string;
  branch: string;
}

export interface WorkspaceProvider {
  ensureWorkspace(spec: AgentInstanceSpec, sparsePaths: string[]): Promise<WorkspaceResult>;
}
