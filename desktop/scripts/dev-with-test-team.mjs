import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const devTeams = [
  {
    label: '牛马测试团队',
    config: '__test__/niu-ma/team.json',
    state: resolve(repositoryRoot, '__test__/niu-ma/.oat/state/orchestrator.json'),
  },
  {
    label: '热点营销运营团队',
    config: '__test__/hotspot-marketing/team.json',
    state: resolve(repositoryRoot, '__test__/hotspot-marketing/.oat/state/orchestrator.json'),
  },
];
let shuttingDown = false;
const teamProcesses = new Map();
let desktopProcess;
let signalsDir;
let startupLog;
let startupError;
let teamsReady = false;
let startupLogStream;

function recordStartup(message) {
  console.log(message);
  startupLogStream?.write(`${message}\n`);
}

function relayTeamOutput(team, teamProcess) {
  const relay = (stream, target) => stream?.on('data', (chunk) => {
    target.write(chunk);
    startupLogStream?.write(chunk);
  });
  relay(teamProcess.stdout, process.stdout);
  relay(teamProcess.stderr, process.stderr);
  recordStartup(`[${team.label}] process started.`);
}

function processRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopExistingTeam(team) {
  let state;
  try { state = JSON.parse(await readFile(team.state, 'utf8')); } catch { return; }
  const pid = Number(state.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !processRunning(pid)) return;
  const expectedConfig = resolve(repositoryRoot, team.config);
  if (resolve(String(state.configPath ?? '')) !== expectedConfig) {
    throw new Error(`Refusing to stop PID ${pid}: ${team.label} state points to an unexpected config path.`);
  }
  recordStartup(`[${team.label}] stopping previous development instance (PID ${pid})…`);
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 100 && processRunning(pid); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (processRunning(pid)) {
    recordStartup(`[${team.label}] previous instance did not stop cleanly; forcing shutdown.`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
  }
}

function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already stopped */ } }
}

async function waitForTeam(team, previousStartedAt) {
  while (true) {
    const teamProcess = teamProcesses.get(team.config);
    if (teamProcess?.exitCode !== null) throw new Error(`${team.label} exited before it became ready.`);
    try {
      const state = JSON.parse(await readFile(team.state, 'utf8'));
      const port = Number(state.orchestratorPort);
      if (state.startedAt !== previousStartedAt && Number.isInteger(port) && port > 0) {
        const response = await fetch(`http://127.0.0.1:${port}/observability/graph`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
      }
    } catch { /* startup is still in progress */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

async function waitForSignal(path, label) {
  while (true) {
    try { await readFile(path, 'utf8'); return; } catch { /* waiting for Desktop main process */ }
    if (desktopProcess?.exitCode !== null) throw new Error(`Desktop exited before ${label}.`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  terminate(desktopProcess);
  for (const teamProcess of teamProcesses.values()) terminate(teamProcess);
  startupLogStream?.end();
  if (signalsDir) await rm(signalsDir, { recursive: true, force: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => void shutdown(0));
process.once('exit', () => {
  for (const teamProcess of teamProcesses.values()) terminate(teamProcess);
});

try {
  signalsDir = await mkdtemp(join(tmpdir(), 'oat-desktop-dev-'));
  const runtimeReady = join(signalsDir, 'runtime-ready');
  const teamReady = join(signalsDir, 'team-ready');
  startupError = join(signalsDir, 'startup-error');
  startupLog = join(signalsDir, 'startup.log');
  await writeFile(startupLog, '', { encoding: 'utf8', mode: 0o600 });
  startupLogStream = createWriteStream(startupLog, { flags: 'a', mode: 0o600 });
  recordStartup('Starting Desktop environment checks…');
  desktopProcess = spawn(pnpm, ['exec', 'electron-vite', 'dev'], {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: { ...process.env, OAT_DESKTOP_DEV_LOCAL_LINK: repositoryRoot, OAT_DESKTOP_RUNTIME_READY_SIGNAL: runtimeReady, OAT_DESKTOP_TEAM_READY_SIGNAL: teamReady, OAT_DESKTOP_STARTUP_ERROR_SIGNAL: startupError, OAT_DESKTOP_STARTUP_LOG: startupLog },
  });
  desktopProcess.once('exit', (code) => void shutdown(code ?? 0));
  await waitForSignal(runtimeReady, 'Desktop environment checks');
  for (const team of devTeams) await stopExistingTeam(team);
  recordStartup(`Environment is ready. Starting ${devTeams.length} development teams…`);
  for (const team of devTeams) {
    let previousStartedAt;
    try { previousStartedAt = JSON.parse(await readFile(team.state, 'utf8')).startedAt; } catch { /* first launch */ }
    const teamProcess = spawn(pnpm, ['exec', 'tsx', 'src/index.ts', 'start', '--daemon', '--config', team.config], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    teamProcesses.set(team.config, teamProcess);
    relayTeamOutput(team, teamProcess);
    teamProcess.once('exit', (code) => {
      if (shuttingDown) return;
      const message = `${team.label} exited unexpectedly with code ${code ?? 'unknown'}.`;
      recordStartup(message);
      if (teamsReady) void shutdown(code ?? 1);
      else if (startupError) void writeFile(startupError, message, { encoding: 'utf8', mode: 0o600 });
    });
    await waitForTeam(team, previousStartedAt);
    recordStartup(`[${team.label}] ready.`);
  }
  teamsReady = true;
  await writeFile(teamReady, 'ready', { encoding: 'utf8', mode: 0o600 });
  recordStartup('Development teams are ready. Opening Desktop workspace…');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (startupError && desktopProcess?.exitCode === null) {
    recordStartup(`Startup failed: ${message}`);
    await writeFile(startupError, message, { encoding: 'utf8', mode: 0o600 });
  } else {
    await shutdown(1);
  }
}
