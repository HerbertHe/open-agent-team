import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/daily-release.yml', import.meta.url), 'utf8');

test('runs daily or manually instead of rebuilding on every push', () => {
  const triggers = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('\npermissions:'));
  assert.match(triggers, /schedule:/);
  assert.match(triggers, /cron: '0 10 \* \* \*'/);
  assert.match(triggers, /workflow_dispatch:/);
  assert.doesNotMatch(triggers, /push:/);
  assert.match(workflow, /build-desktop:\n\s+if: needs\.prepare\.outputs\.release == 'true'/);
});

test('publishes verified Desktop and npm artifacts from one release commit', () => {
  assert.match(workflow, /build-npm-package:/);
  assert.match(workflow, /npm pack --json --pack-destination npm-package/);
  assert.match(workflow, /create-github-npm-package\.mjs/);
  assert.match(workflow, /package\/dist\/index\.js/);
  assert.match(workflow, /needs: \[prepare, build-desktop, build-npm-package\]/);
  assert.match(workflow, /npm@11\.19\.1/);
  assert.match(workflow, /npm publish "\.\/npm-package\/\$\{package_file\}" --access public --provenance/);
  assert.doesNotMatch(workflow, /secrets\.NPM_TOKEN/);
  assert.match(workflow, /npm publish "\.\/npm-package\/\$\{package_file\}" --registry https:\/\/npm\.pkg\.github\.com\//);
  assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact@v4/);
  assert.match(workflow, /uses: actions\/upload-artifact@v7/);
  assert.match(workflow, /uses: actions\/download-artifact@v8/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /uses: actions\/attest@v4/);
  assert.match(workflow, /subject-path: release-assets\/\*/);
  assert.match(workflow, /Verify unsigned Windows installer/);
  assert.match(workflow, /Verify ad-hoc macOS app without Developer ID/);
  assert.match(workflow, /UNSIGNED-BUILD-NOTICE\.txt/);
  assert.match(workflow, /--notes "\$\{UNSIGNED_NOTICE\}"/);
  assert.match(workflow, /gh release edit "\$\{TAG\}" --draft=false --latest/);
});

test('skips a day without commits since the latest published release', () => {
  assert.match(workflow, /git rev-list --count "\$\{latest_release_tag\}\.\.HEAD"/);
  assert.match(workflow, /has_changes=false/);
  assert.match(workflow, /"\$\{has_changes\}" == "true"/);
});
