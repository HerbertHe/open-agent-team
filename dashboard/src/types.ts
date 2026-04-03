export type ObservabilitySource = 'orchestrator' | 'opencode';

export interface ObservabilityEvent {
  ts: string;
  source: ObservabilitySource;
  type: string;
  agentId?: string;
  role?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface ObservabilityGraphNode {
  id: string;
  role: string;
  label: string;
  port: number;
  teamName?: string;
  sessionId: string;
  placeholder?: boolean;
}

export interface ObservabilityGraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface ObservabilityGraph {
  nodes: ObservabilityGraphNode[];
  edges: ObservabilityGraphEdge[];
}

/** 拓扑节点描边语义：待命灰 / 已收指令浅蓝 / 处理中深蓝；error、done 单独配色 */
export type AgentStatus =
  | 'idle'
  | 'standby'
  | 'instructed'
  | 'busy'
  | 'tool'
  | 'error'
  | 'done';
