export type MemoryLevel = "L1" | "L2" | "L3";
export type MemoryKind = "working" | "semantic" | "episodic" | "decision" | "preference" | "failure-pattern" | "procedure";
export type MemoryStatus = "active" | "superseded" | "disputed" | "forgotten";

export interface MemorySource {
  eventId: string;
  agentId?: string;
  role: string;
  eventType: string;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  projectId: string;
  agentId: string;
  teamId?: string;
  level: MemoryLevel;
  kind: MemoryKind;
  content: string;
  summary: string;
  confidence: number;
  salience: number;
  evidenceCount: number;
  sourceEventIds: string[];
  sources: MemorySource[];
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string;
}

export interface DreamRun {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled" | "skipped";
  trigger: "idle" | "manual";
  startedAt: string;
  completedAt?: string;
  processedEvents: number;
  createdL2: number;
  promotedL3: number;
  error?: string;
}

export interface MemoryOverview {
  enabled: boolean;
  counts: Record<MemoryLevel, number>;
  pendingEvents: number;
  lastDream?: DreamRun;
  runningDream?: DreamRun;
  lastActivityAt?: string;
}
