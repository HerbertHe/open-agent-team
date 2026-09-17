/** Domain-neutral contract shared by private memories and file-backed knowledge. */
export type SemanticResourceType = "memory" | "knowledge";
export type SemanticIndexState = "pending" | "indexed" | "failed" | "not_applicable";
export type SemanticVisibility = "private" | "team" | "project" | "restricted";

export interface SemanticDocument {
  id: string;
  projectId: string;
  resourceType: SemanticResourceType;
  resourceId: string;
  sourceId?: string;
  ownerAgentId?: string;
  visibility: SemanticVisibility;
  teamId?: string;
  allowedAgentIds: string[];
  content: string;
  contentHash: string;
  status: "active" | "superseded" | "deleted";
  metadata: Record<string, unknown>;
  indexState: SemanticIndexState;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticPrincipal {
  agentId: string;
  projectId: string;
  teamId?: string;
  role?: "admin" | "leader" | "worker";
}

export interface SemanticSearchRequest {
  principal: SemanticPrincipal;
  resourceType: SemanticResourceType;
  query: string;
  limit: number;
  maxPromptTokens: number;
}

export interface SemanticSearchHit {
  document: SemanticDocument;
  score: number;
  route: "lexical" | "dense" | "hybrid";
}

export function canReadSemanticDocument(principal: SemanticPrincipal, document: SemanticDocument): boolean {
  if (principal.projectId !== document.projectId || document.status !== "active") return false;
  if (document.resourceType === "memory") {
    return document.visibility === "private" && document.ownerAgentId === principal.agentId;
  }
  if (document.visibility === "project") return true;
  if (document.visibility === "team") return principal.role === "admin" || Boolean(principal.teamId && principal.teamId === document.teamId);
  if (document.visibility === "restricted") return document.allowedAgentIds.includes(principal.agentId);
  return false;
}
