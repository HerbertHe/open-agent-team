import type { AgentRoleEnum } from "./enums";

export type ObservabilitySource = "orchestrator" | "opencode";

export interface ObservabilityEvent {
  ts: string;
  source: ObservabilitySource;
  type: string;
  agentId?: string;
  role?: AgentRoleEnum;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface ObservabilityGraphNode {
  id: string;
  role: AgentRoleEnum;
  label: string;
  port: number;
  teamName?: string;
  sessionId: string;
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
