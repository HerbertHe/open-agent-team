import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('scripts/set-release-version.mjs');

test('sets the same date SemVer for CLI and Desktop manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oat-release-version-'));
  try {
    await writeFile(join(root, 'package.json'), '{"name":"cli","version":"1.0.0"}\n');
    await writeFile(join(root, 'desktop.json'), '{"name":"desktop","version":"1.0.0"}\n');
    await mkdir(join(root, 'desktop'));
    await rename(join(root, 'desktop.json'), join(root, 'desktop/package.json'));
    execFileSync(process.execPath, [script, '2026.8.28'], { cwd: root });
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '2026.8.28');
    assert.equal(JSON.parse(await readFile(join(root, 'desktop/package.json'), 'utf8')).version, '2026.8.28');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects padded or impossible npm versions', () => {
  assert.throws(() => execFileSync(process.execPath, [script, '2026.08.28'], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [script, '2026.2.30'], { stdio: 'pipe' }));
});
