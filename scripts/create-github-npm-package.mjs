#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const GITHUB_PACKAGE_NAME = '@herberthe/open-agent-team';
export const GITHUB_NPM_REGISTRY = 'https://npm.pkg.github.com/';

export function githubPackageManifest(source) {
  if (source.name !== 'open-agent-team') throw new Error(`Unexpected npm package name: ${String(source.name)}`);
  return {
    ...source,
    name: GITHUB_PACKAGE_NAME,
    publishConfig: { ...source.publishConfig, registry: GITHUB_NPM_REGISTRY },
  };
}

export async function createGithubNpmPackage(sourceArchive, destinationDirectory) {
  const archive = resolve(sourceArchive);
  const destination = resolve(destinationDirectory);
  const temporary = await mkdtemp(join(tmpdir(), 'oat-github-package-'));
  try {
    await exec('tar', ['-xzf', archive, '-C', temporary]);
    const packageDirectory = join(temporary, 'package');
    const manifestPath = join(packageDirectory, 'package.json');
    const source = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, `${JSON.stringify(githubPackageManifest(source), null, 2)}\n`, 'utf8');
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', destination, packageDirectory], { maxBuffer: 10 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    if (!Array.isArray(result) || result.length !== 1 || !result[0]?.filename) throw new Error('npm pack did not return a package filename.');
    await writeFile(join(destination, 'github-manifest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return { ...result[0], source: basename(archive) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , sourceArchive, destinationDirectory] = process.argv;
  if (!sourceArchive || !destinationDirectory) throw new Error('Usage: create-github-npm-package.mjs <npm.tgz> <destination-directory>');
  const result = await createGithubNpmPackage(sourceArchive, destinationDirectory);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
