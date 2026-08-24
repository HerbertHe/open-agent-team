import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const testState = resolve(repositoryRoot, '__test__/niu-ma/.oat/state/orchestrator.json');
let shuttingDown = false;
let teamProcess;
let desktopProcess;
let signalsDir;

function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already stopped */ } }
}

async function waitForTestTeam(previousStartedAt) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (teamProcess?.exitCode !== null) throw new Error('The test team exited before it became ready.');
    try {
      const state = JSON.parse(await readFile(testState, 'utf8'));
      const port = Number(state.orchestratorPort);
      if (state.startedAt !== previousStartedAt && Number.isInteger(port) && port > 0) {
        const response = await fetch(`http://127.0.0.1:${port}/observability/graph`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
      }
    } catch { /* startup is still in progress */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Timed out waiting for the 牛马 test team to start.');
}

async function waitForSignal(path, label) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    try { await readFile(path, 'utf8'); return; } catch { /* waiting for Desktop main process */ }
    if (desktopProcess?.exitCode !== null) throw new Error(`Desktop exited before ${label}.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  terminate(desktopProcess);
  terminate(teamProcess);
  if (signalsDir) await rm(signalsDir, { recursive: true, force: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => void shutdown(0));
process.once('exit', () => terminate(teamProcess));

try {
  signalsDir = await mkdtemp(join(tmpdir(), 'oat-desktop-dev-'));
  const runtimeReady = join(signalsDir, 'runtime-ready');
  const teamReady = join(signalsDir, 'team-ready');
  console.log('Starting Desktop environment checks…');
  desktopProcess = spawn(pnpm, ['exec', 'electron-vite', 'dev'], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: { ...process.env, OAT_DESKTOP_DEV_LOCAL_LINK: repositoryRoot, OAT_DESKTOP_RUNTIME_READY_SIGNAL: runtimeReady, OAT_DESKTOP_TEAM_READY_SIGNAL: teamReady },
  });
  desktopProcess.once('exit', (code) => void shutdown(code ?? 0));
  await waitForSignal(runtimeReady, 'Desktop environment checks');
  console.log('Environment is ready. Starting the 牛马 test team…');
  let previousStartedAt;
  try { previousStartedAt = JSON.parse(await readFile(testState, 'utf8')).startedAt; } catch { /* first test-team launch */ }
  teamProcess = spawn(pnpm, ['exec', 'tsx', 'src/index.ts', 'start', '--daemon', '--config', '__test__/niu-ma/team.json'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  teamProcess.once('exit', (code) => { if (!shuttingDown) void shutdown(code ?? 1); });
  await waitForTestTeam(previousStartedAt);
  await writeFile(teamReady, 'ready', { encoding: 'utf8', mode: 0o600 });
  console.log('Test team is ready. Opening Desktop workspace…');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await shutdown(1);
}
