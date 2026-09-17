import type { MemoryActor, MemoryRecord, MemoryScope } from "./types";

export const MEMORY_POLICY_VERSION = 2;

export type MemoryPolicyDecision = { allowed: boolean; reason: string };
export type CanonicalMemoryWrite = Pick<MemoryRecord, "projectId" | "agentId" | "teamId" | "level" | "scope" | "trustLevel">;

export interface MemoryPolicy {
  readDecision(actor: MemoryActor, memory: MemoryRecord): MemoryPolicyDecision;
  canRead(actor: MemoryActor, memory: MemoryRecord): boolean;
  canonicalWriteDecision(actor: MemoryActor, memory: CanonicalMemoryWrite): MemoryPolicyDecision;
  canWriteCanonical(actor: MemoryActor, memory: CanonicalMemoryWrite): boolean;
  candidateWriteDecision(actor: MemoryActor, input: { projectId: string; teamId?: string; scope: MemoryScope; trustLevel: number }): MemoryPolicyDecision;
  canManage(actor: MemoryActor, memory: MemoryRecord): boolean;
}

export function teamIdFromAgentId(agentId: string): string | undefined {
  if (agentId === "admin") return undefined;
  const leader = agentId.match(/^(.+)-(?:lead|leader)$/u);
  if (leader?.[1]) return leader[1];
  const worker = agentId.match(/^(.+)-worker-\d+$/u);
  return worker?.[1];
}

export function projectUserActor(projectId: string): MemoryActor {
  return { id: "user", role: "user", employment: "internal", projectId, projectIds: [projectId] };
}

export function projectAgentActor(projectId: string, agentId: string, role?: MemoryActor["role"], employment: MemoryActor["employment"] = "internal", explicitProjectIds?: string[]): MemoryActor {
  const resolvedRole = role ?? (agentId === "admin" ? "admin" : /-(?:lead|leader)$/u.test(agentId) ? "leader" : "worker");
  return {
    id: agentId,
    role: resolvedRole,
    employment,
    projectId,
    teamId: teamIdFromAgentId(agentId),
    projectIds: explicitProjectIds ?? (resolvedRole === "admin" ? [projectId] : []),
  };
}

export function projectResourceManagerActor(projectIds: string[]): MemoryActor {
  return { id: "resource-manager", role: "resource_manager", employment: "internal", projectIds: [...new Set(projectIds)] };
}

function grantedProject(actor: MemoryActor, projectId: string): boolean {
  if (actor.role === "system") return actor.projectId === projectId;
  if (actor.role === "user") return actor.projectId === projectId || actor.projectIds.includes(projectId);
  return actor.projectId === projectId || actor.projectIds.includes(projectId);
}

export class DefaultMemoryPolicy implements MemoryPolicy {
  readDecision(actor: MemoryActor, memory: MemoryRecord): MemoryPolicyDecision {
    if (!grantedProject(actor, memory.projectId)) return { allowed: false, reason: "project_not_granted" };
    if (actor.role === "user") return { allowed: true, reason: "trusted_local_principal" };
    if (memory.status !== "active") return { allowed: false, reason: "memory_not_active" };
    if (actor.employment === "external") return { allowed: false, reason: "external_agent_has_no_long_term_read" };
    if (actor.role === "system") return { allowed: true, reason: "trusted_local_principal" };
    const owner = memory.agentId === actor.id;
    if (memory.level === "L1") return { allowed: owner, reason: owner ? "working_memory_owner" : "working_memory_is_private" };
    // Agent memories are private regardless of their legacy scope value. Shared
    // material belongs to the file-backed knowledge domain instead.
    return { allowed: owner, reason: owner ? "private_owner" : "private_owner_mismatch" };
  }

  canRead(actor: MemoryActor, memory: MemoryRecord): boolean {
    return this.readDecision(actor, memory).allowed;
  }

  canonicalWriteDecision(actor: MemoryActor, memory: CanonicalMemoryWrite): MemoryPolicyDecision {
    if (!grantedProject(actor, memory.projectId)) return { allowed: false, reason: "project_not_granted" };
    if (actor.employment === "external") return { allowed: false, reason: "external_worker_cannot_write_canonical" };
    if (actor.role === "resource_manager") return { allowed: false, reason: "resource_manager_cannot_write_canonical" };
    if (actor.role === "user" || actor.role === "system") return { allowed: true, reason: "trusted_local_principal" };
    const allowed = memory.agentId === actor.id;
    return { allowed, reason: allowed ? "private_owner" : "private_owner_mismatch" };
  }

  canWriteCanonical(actor: MemoryActor, memory: CanonicalMemoryWrite): boolean {
    return this.canonicalWriteDecision(actor, memory).allowed;
  }

  candidateWriteDecision(actor: MemoryActor, input: { projectId: string; teamId?: string; scope: MemoryScope; trustLevel: number }): MemoryPolicyDecision {
    if (!grantedProject(actor, input.projectId)) return { allowed: false, reason: "project_not_granted" };
    if (input.scope !== "private") return { allowed: false, reason: "shared_content_belongs_to_knowledge" };
    if (actor.employment === "external") {
      const allowed = actor.role === "worker" && input.scope === "private" && input.trustLevel <= 30 && (!input.teamId || input.teamId === actor.teamId);
      return { allowed, reason: allowed ? "external_private_candidate" : "external_candidate_must_be_private_and_low_trust" };
    }
    if (actor.role === "resource_manager") return { allowed: false, reason: "resource_manager_is_read_only" };
    return { allowed: true, reason: "internal_candidate" };
  }

  canManage(actor: MemoryActor, memory: MemoryRecord): boolean {
    return this.canonicalWriteDecision(actor, memory).allowed;
  }
}

export class MemoryAccessDeniedError extends Error {
  constructor(readonly reason: string) {
    super(`Memory access denied: ${reason}`);
    this.name = "MemoryAccessDeniedError";
  }
}
