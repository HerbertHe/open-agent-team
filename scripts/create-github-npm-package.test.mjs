import assert from 'node:assert/strict';
import test from 'node:test';
import { GITHUB_NPM_REGISTRY, GITHUB_PACKAGE_NAME, githubPackageManifest } from './create-github-npm-package.mjs';

test('creates a GitHub-scoped mirror manifest without changing package identity metadata', () => {
  const source = {
    name: 'open-agent-team',
    version: '2026.9.18',
    repository: { type: 'git', url: 'git+https://github.com/herberthe/open-agent-team.git' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
  };
  const result = githubPackageManifest(source);
  assert.equal(result.name, GITHUB_PACKAGE_NAME);
  assert.equal(result.version, source.version);
  assert.deepEqual(result.repository, source.repository);
  assert.equal(result.publishConfig.registry, GITHUB_NPM_REGISTRY);
  assert.equal(source.name, 'open-agent-team');
});

test('rejects an archive for a different package', () => {
  assert.throws(() => githubPackageManifest({ name: 'another-package' }), /Unexpected npm package name/);
});
