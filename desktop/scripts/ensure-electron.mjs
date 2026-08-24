import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronEntry = require.resolve('electron');
const electronDir = dirname(electronEntry);
const pathFile = join(electronDir, 'path.txt');

function executableExists() {
  if (!existsSync(pathFile)) return false;
  const relativePath = readFileSync(pathFile, 'utf8').trim();
  return Boolean(relativePath) && existsSync(join(electronDir, 'dist', relativePath));
}

if (!executableExists()) {
  console.log('Electron binary is missing; downloading the configured Electron version…');
  const result = spawnSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' });
  if (result.status !== 0 || !executableExists()) {
    throw new Error('Electron could not be installed. Run `pnpm install` and retry.');
  }
}
