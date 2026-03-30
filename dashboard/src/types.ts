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

export type AgentStatus = 'idle' | 'busy' | 'tool' | 'error' | 'done';
