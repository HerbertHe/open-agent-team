import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyZvecRelease, ZVEC_RELEASE_MATRIX } from './verify-zvec-release.mjs';

test('M15 release policy pins supported bindings and rejects unsupported architectures', async () => {
  const report = await verifyZvecRelease();
  assert.deepEqual(report.errors, []);
  assert.equal(report.defaultDecision, 'opt-in');
  assert.equal(ZVEC_RELEASE_MATRIX.find((item) => item.platform === 'darwin' && item.arch === 'x64')?.publish, false);
  assert.equal(ZVEC_RELEASE_MATRIX.find((item) => item.platform === 'win32' && item.arch === 'ia32')?.publish, false);
});
