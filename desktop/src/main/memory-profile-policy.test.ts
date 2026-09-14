import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGlobalModelCatalog } from '../../../src/models/global-models.js';
import { changedReferencedProfiles, profileImpactFromConfigs } from './memory-profile-policy.js';

const profile = { kind: 'deterministic-fake' as const, model: 'test', dimensions: 4, normalization: 'l2' as const, revision: '1', timeoutMs: 1000, batchSize: 8, maxAttempts: 1 as const };

test('M14 profile impact distinguishes explicit, inherited and disabled projects', () => {
  const impact = profileImpactFromConfigs('memory-v1', { memoryDefaults: { embeddingProfile: 'memory-v1' } }, [
    { name: 'explicit', alive: true, config: { memory: { embeddingRef: 'memory-v1', retrieval: { backend: 'zvec_hybrid' } } } },
    { name: 'inherited', projectName: 'Inherited', alive: false, config: { memory: { retrieval: { backend: 'lexical' } } } },
    { name: 'disabled', alive: true, config: { memory: { embeddingRef: null } } },
  ]);
  assert.equal(impact.globalDefault, true);
  assert.deepEqual(impact.projects.map(({ projectName, source }) => ({ projectName, source })), [
    { projectName: 'explicit', source: 'explicit' },
    { projectName: 'inherited', source: 'global-default' },
  ]);
});

test('M14 blocks in-place changes only for referenced immutable profiles', () => {
  const current = parseGlobalModelCatalog({ embeddingProfiles: { 'memory-v1': profile, unused: profile } });
  const next = parseGlobalModelCatalog({ embeddingProfiles: {
    'memory-v1': { ...profile, dimensions: 8, revision: '2' },
    unused: { ...profile, dimensions: 8, revision: '2' },
    'memory-v2': { ...profile, dimensions: 8, revision: '2' },
  } });
  assert.deepEqual(changedReferencedProfiles(current, next, [
    { profile: 'memory-v1', globalDefault: false, projects: [{ projectName: 'alpha', source: 'explicit', backend: 'zvec_hybrid', alive: true }] },
    { profile: 'unused', globalDefault: false, projects: [] },
  ]), ['memory-v1']);
});
