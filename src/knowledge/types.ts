import type { SemanticIndexState, SemanticVisibility } from "../semantic/types";

export type KnowledgeOrigin = "agent_output" | "user_upload" | "workspace_file" | "migration";
export type KnowledgeSourceStatus = "pending" | "parsing" | "indexing" | "ready" | "unsupported" | "failed" | "deleted";

export interface KnowledgeCollection {
  id: string;
  projectId: string;
  name: string;
  visibility: Exclude<SemanticVisibility, "private">;
  teamId?: string;
  allowedAgentIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSource {
  id: string;
  projectId: string;
  collectionId: string;
  path: string;
  canonicalPath: string;
  mimeType: string;
  contentHash: string;
  size: number;
  origin: KnowledgeOrigin;
  createdByAgentId?: string;
  sourceTaskId?: string;
  status: KnowledgeSourceStatus;
  version: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  indexedAt?: string;
}

export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  ordinal: number;
  heading?: string;
  content: string;
  contentHash: string;
  tokenCount: number;
  pageNumber?: number;
  lineStart?: number;
  lineEnd?: number;
  indexState: SemanticIndexState;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeReference {
  documentId: string;
  sourceId: string;
  chunkId: string;
  path: string;
  title: string;
  visibility: Exclude<SemanticVisibility, "private">;
  teamId?: string;
  contentHash: string;
  heading?: string;
  lineStart?: number;
  lineEnd?: number;
  score?: number;
}

export interface KnowledgeContext {
  context: string;
  references: KnowledgeReference[];
}

export interface KnowledgeOperationsSnapshot {
  enabled: boolean;
  roots: { project: string; teams: string; uploads: string };
  counts: Record<KnowledgeSourceStatus, number>;
  sourceCount: number;
  chunkCount: number;
  index: { pending: number; indexed: number; failed: number; notApplicable: number; deadLetters: number };
  sources: KnowledgeSource[];
  generatedAt: string;
}
