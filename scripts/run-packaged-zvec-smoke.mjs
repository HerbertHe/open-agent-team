#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const release = path.resolve('desktop/release');
const candidates = process.platform === 'darwin'
  ? [path.join(release, 'mac-arm64', 'OAT.app', 'Contents', 'MacOS', 'OAT')]
  : process.platform === 'win32'
    ? [path.join(release, 'win-unpacked', 'OAT.exe')]
    : [path.join(release, 'linux-unpacked', 'oat'), path.join(release, 'linux-arm64-unpacked', 'oat'), path.join(release, 'linux-unpacked', 'OAT')];
const executable = (await Promise.all(candidates.map(async (candidate) => await fs.stat(candidate).then(() => candidate, () => undefined)))).find(Boolean);
if (!executable) throw new Error(`Packaged OAT executable was not found under ${release}.`);
const report = path.join(os.tmpdir(), `oat-zvec-packaged-${process.platform}-${process.arch}.json`);
await new Promise((resolve, reject) => {
  const child = spawn(executable, [], {
    stdio: 'inherit',
    env: { ...process.env, OAT_ZVEC_COMPATIBILITY_SMOKE: '1', OAT_ZVEC_COMPATIBILITY_REPORT: report },
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Packaged Zvec smoke timed out.')); }, 120_000);
  child.once('error', reject);
  child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Packaged Zvec smoke exited with ${code}.`)); });
});
const result = JSON.parse(await fs.readFile(report, 'utf8'));
const requiredCapabilities = ['batchUpsert', 'fetch', 'scalarFilter', 'vectorQuery', 'fullTextSearch', 'denseFtsRrf', 'closeReopenRecovery'];
if (result.packageVersion !== '0.7.0' || requiredCapabilities.some((capability) => result.collection?.[capability] !== true)) {
  throw new Error(`Packaged Zvec smoke failed: ${JSON.stringify(result)}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
