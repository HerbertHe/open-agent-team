#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ZVEC_RELEASE_MATRIX = Object.freeze([
  { platform: 'darwin', arch: 'arm64', binding: '@zvec/bindings-darwin-arm64', publish: true },
  { platform: 'darwin', arch: 'x64', binding: null, publish: false, reason: 'Zvec 0.7.0 has no darwin-x64 prebuilt binding.' },
  { platform: 'linux', arch: 'x64', binding: '@zvec/bindings-linux-x64', publish: true },
  { platform: 'linux', arch: 'arm64', binding: '@zvec/bindings-linux-arm64', publish: true },
  { platform: 'win32', arch: 'x64', binding: '@zvec/bindings-win32-x64', publish: true },
  { platform: 'win32', arch: 'ia32', binding: null, publish: false, reason: 'Zvec does not support Windows ia32.' },
]);

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const includes = (values, expected) => Array.isArray(values) && values.includes(expected);

export async function verifyZvecRelease(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const [cli, desktop, zvec] = await Promise.all([
    readJson(path.join(root, 'package.json')),
    readJson(path.join(root, 'desktop', 'package.json')),
    readJson(path.join(root, 'node_modules', '@zvec', 'zvec', 'package.json')),
  ]);
  const errors = [];
  if (cli.dependencies?.['@zvec/zvec'] !== '0.7.0' || desktop.dependencies?.['@zvec/zvec'] !== '0.7.0') errors.push('CLI and Desktop must pin @zvec/zvec exactly to 0.7.0.');
  if (zvec.license !== 'Apache-2.0') errors.push(`Unexpected @zvec/zvec license: ${String(zvec.license)}`);
  if (cli.license !== 'MIT') errors.push(`Unexpected OAT license: ${String(cli.license)}`);
  const unpack = desktop.build?.asarUnpack;
  if (!includes(unpack, 'node_modules/@zvec/**/*.node') || !includes(unpack, 'node_modules/@zvec/**/jieba_dict/**/*')) errors.push('Electron must unpack Zvec native bindings and Jieba dictionaries.');
  const optional = desktop.optionalDependencies ?? {};
  for (const target of ZVEC_RELEASE_MATRIX.filter(({ publish }) => publish)) {
    if (optional[target.binding] !== '0.7.0') errors.push(`Desktop must pin ${target.binding}@0.7.0 as an optional dependency.`);
    if (zvec.optionalDependencies?.[target.binding] !== '0.7.0') errors.push(`@zvec/zvec does not declare ${target.binding}@0.7.0.`);
  }
  const winTarget = desktop.build?.win?.target?.find?.(({ target }) => target === 'nsis');
  if (!winTarget?.arch?.includes('x64') || winTarget.arch.includes('ia32')) errors.push('Windows Desktop release must target x64 and must not target ia32.');
  const macTarget = desktop.build?.mac?.target?.find?.(({ target }) => target === 'dmg');
  if (!macTarget?.arch?.includes('arm64') || macTarget.arch.includes('x64')) errors.push('Zvec-enabled macOS release must target arm64 only.');
  const workflow = await fs.readFile(path.join(root, '.github', 'workflows', 'daily-release.yml'), 'utf8');
  for (const name of ['linux-x64', 'linux-arm64', 'windows-x64', 'macos-arm64']) if (!workflow.includes(`name: ${name}`)) errors.push(`Release workflow is missing ${name}.`);
  if (!workflow.includes('run-packaged-zvec-smoke.mjs')) errors.push('Release workflow must execute the packaged Zvec smoke test.');
  return {
    ok: errors.length === 0,
    errors,
    zvecVersion: zvec.version,
    licenses: { oat: cli.license, zvec: zvec.license },
    matrix: ZVEC_RELEASE_MATRIX,
    defaultDecision: 'opt-in',
    reason: 'Default activation still requires signed/notarized artifacts and production-profile project evaluations.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyZvecRelease();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
