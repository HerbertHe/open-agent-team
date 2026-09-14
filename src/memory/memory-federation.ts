import type { MemoryActor, MemoryRecord } from "./types";
import { DefaultMemoryPolicy } from "./memory-policy";

export type FederatedMemoryShard = {
  projectId: string;
  online: boolean;
  search(actor: MemoryActor, query: string, limit: number): Promise<MemoryRecord[]>;
};

export type FederatedMemorySearchResult = {
  memories: Array<MemoryRecord & { projectId: string }>;
  searchedProjectIds: string[];
  unavailableProjectIds: string[];
  deniedProjectIds: string[];
};

/**
 * Fans a Resource Manager query out through project-owned services. It never
 * opens another project's SQLite database or Zvec collection directly.
 */
export async function federatedMemorySearch(input: {
  actor: MemoryActor;
  query: string;
  shards: FederatedMemoryShard[];
  limit?: number;
}): Promise<FederatedMemorySearchResult> {
  if (input.actor.role !== "resource_manager" || input.actor.employment !== "internal") {
    return { memories: [], searchedProjectIds: [], unavailableProjectIds: [], deniedProjectIds: input.shards.map(({ projectId }) => projectId) };
  }
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 20)));
  const unavailableProjectIds: string[] = [];
  const deniedProjectIds: string[] = [];
  const searchable = input.shards.filter((shard) => {
    if (!input.actor.projectIds.includes(shard.projectId)) { deniedProjectIds.push(shard.projectId); return false; }
    if (!shard.online) { unavailableProjectIds.push(shard.projectId); return false; }
    return true;
  });
  const settled = await Promise.all(searchable.map(async (shard) => {
    const actor: MemoryActor = { ...input.actor, projectId: shard.projectId, projectIds: [shard.projectId] };
    try {
      const policy = new DefaultMemoryPolicy();
      const memories = (await shard.search(actor, input.query.slice(0, 1_000), limit))
        .filter((memory) => memory.projectId === shard.projectId && policy.canRead(actor, memory));
      return { projectId: shard.projectId, memories };
    }
    catch { unavailableProjectIds.push(shard.projectId); return { projectId: shard.projectId, memories: [] }; }
  }));
  const memories = settled.flatMap(({ memories }) => memories).sort((left, right) =>
    right.salience - left.salience || right.confidence - left.confidence || right.updatedAt.localeCompare(left.updatedAt),
  ).slice(0, limit);
  return {
    memories,
    searchedProjectIds: settled.filter(({ projectId }) => !unavailableProjectIds.includes(projectId)).map(({ projectId }) => projectId),
    unavailableProjectIds: [...new Set(unavailableProjectIds)],
    deniedProjectIds: [...new Set(deniedProjectIds)],
  };
}
