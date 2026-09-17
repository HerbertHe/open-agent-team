import type { AgentRoleEnum } from "./enums";

export type ObservabilitySource = "orchestrator" | "pi";

export type RunStreamKind =
  | "run.started"
  | "run.completed"
  | "message.started"
  | "message.completed"
  | "content.block.started"
  | "content.delta"
  | "content.block.completed"
  | "reasoning.block.started"
  | "reasoning.delta"
  | "reasoning.completed"
  | "tool.started"
  | "tool.updated"
  | "tool.completed";

export interface RunStreamMetadata {
  schemaVersion: 1;
  kind: RunStreamKind;
  taskId?: string;
  runId: string;
  turnId: string;
  messageId?: string;
  blockIndex?: number;
  /** Monotonic within a run, independent from the hub-wide delivery sequence. */
  seq: number;
}

export interface ObservabilityEvent {
  ts: string;
  /** Stable delivery cursor assigned by ObservabilityHub. */
  eventId?: string;
  /** Monotonic delivery order within the current orchestrator process. */
  seq?: number;
  source: ObservabilitySource;
  type: string;
  agentId?: string;
  role?: AgentRoleEnum;
  sessionId?: string;
  stream?: RunStreamMetadata;
  payload?: Record<string, unknown>;
}

export interface ObservabilityGraphNode {
  id: string;
  role: AgentRoleEnum;
  label: string;
  port?: number;
  teamName?: string;
  sessionId: string;
  /** Scheduler-derived runtime state; does not depend on an Agent-specific port. */
  status?: "running" | "waiting" | "idle" | "failed";
  /** 尚未 spawn 的配置槽位，与真实 worker 同 id 格式，spawn 后由运行时节点替换 */
  placeholder?: boolean;
}

export type ObservabilityEdgeKind = "admin_leader" | "leader_worker";

export interface ObservabilityGraphEdge {
  source: string;
  target: string;
  kind: ObservabilityEdgeKind;
}

export interface ObservabilityGraph {
  nodes: ObservabilityGraphNode[];
  edges: ObservabilityGraphEdge[];
}
