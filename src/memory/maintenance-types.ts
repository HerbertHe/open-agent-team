import type { MemoryKind, MemoryLevel } from "./types";

export type MemoryMaintenanceTrigger = "task_completed" | "session_ending" | "event_threshold" | "manual" | "task_resume";
export type MemoryMaintenanceStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type MemoryMutation =
  | { action: "create"; kind: MemoryKind; level: Exclude<MemoryLevel, "L1">; summary: string; evidenceEventIds: string[]; confidence: number }
  | { action: "merge"; targetMemoryId: string; summary: string; evidenceEventIds: string[] }
  | { action: "supersede"; targetMemoryId: string; reason: string }
  | { action: "forget"; targetMemoryId: string; reason: string };

export interface MemoryMaintenanceRun {
  id: string;
  projectId: string;
  agentId: string;
  trigger: MemoryMaintenanceTrigger;
  status: MemoryMaintenanceStatus;
  pendingEventIds: string[];
  proposedMutations: number;
  appliedMutations: number;
  rejectedMutations: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface MemoryMaintenanceResult {
  mutations: MemoryMutation[];
}

