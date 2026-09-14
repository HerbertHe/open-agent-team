import type { GlobalModelCatalog } from '../../../src/models/global-models.js';

export type EmbeddingProfileProjectReference = {
  projectName: string;
  displayName?: string;
  source: 'explicit' | 'global-default';
  backend: string;
  alive: boolean;
};

export type EmbeddingProfileImpact = {
  profile: string;
  globalDefault: boolean;
  projects: EmbeddingProfileProjectReference[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function profileImpactFromConfigs(
  profile: string,
  globalConfig: Record<string, unknown>,
  projects: Array<{ name: string; projectName?: string | null; alive: boolean; config?: Record<string, unknown> }>,
): EmbeddingProfileImpact {
  const defaults = record(globalConfig.memoryDefaults);
  const globalDefault = defaults?.embeddingProfile === profile;
  const references = projects.flatMap((project): EmbeddingProfileProjectReference[] => {
    const memory = record(project.config?.memory);
    const explicit = memory && Object.hasOwn(memory, 'embeddingRef') ? memory.embeddingRef : undefined;
    const source = explicit === profile ? 'explicit' : explicit === undefined && globalDefault ? 'global-default' : undefined;
    if (!source) return [];
    const retrieval = record(memory?.retrieval);
    return [{
      projectName: project.name,
      displayName: project.projectName ?? undefined,
      source,
      backend: typeof retrieval?.backend === 'string' ? retrieval.backend : 'lexical',
      alive: project.alive,
    }];
  });
  return { profile, globalDefault, projects: references };
}

export function changedReferencedProfiles(
  current: GlobalModelCatalog,
  next: GlobalModelCatalog,
  impacts: EmbeddingProfileImpact[],
): string[] {
  return Object.keys(current.embeddingProfiles).filter((name) => {
    const changed = JSON.stringify(current.embeddingProfiles[name]) !== JSON.stringify(next.embeddingProfiles[name]);
    const impact = impacts.find((item) => item.profile === name);
    return changed && Boolean(impact?.globalDefault || impact?.projects.length);
  });
}
