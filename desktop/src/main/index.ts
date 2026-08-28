import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { get } from 'node:https';
import { createConnection } from 'node:net';
import { homedir, platform, arch, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AgentRoleEnum,
  BaseBranchEnum,
  DockerNetworkModeEnum,
  QueuedTaskStatusEnum,
  RuntimeModeEnum,
} from '../../../src/types/enums.js';
import { buildResourceProjectConfig, validateResourceProjectConfig } from '../../../src/resources/config-builder.js';
import { ResourceSupervisor, type ResourceProposal } from './resource-supervisor.js';
import {
  AgentRuntimeStatusEnum,
  ProjectRestartAvailabilityEnum,
  ProjectRestartPhaseEnum,
  ProjectRestartTriggerEnum,
  ProjectRuntimeModeEnum,
  ResourceRequiredActionEnum,
  type ProjectRestartStatus,
} from '../shared/resource-types.js';

type CommandResult = { code: number; stdout: string; stderr: string };
type RuntimeStatus = {
  node: { installed: boolean; compatible: boolean; version?: string; source?: 'system' | 'managed'; path?: string };
  oat: { installed: boolean; version?: string; path?: string; source?: 'local-link' | 'managed' | 'system' };
};
type UpdateStatus = { oat: { checked: boolean; latest?: string; available: boolean; error?: string }; desktop: { checked: boolean; latest?: string; available: boolean; error?: string } };
type Project = { name: string; projectName?: string | null; root: string; port?: number; pid?: number; startedAt?: string | null; alive: boolean; agents: Array<{ id: string; role: string; label: string; status: string }> };
type ProviderProbe = { baseUrl: string; apiKey?: string };
type OrchestratorRequest = { projectName: string; path: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };
type ControlPlaneResult = { handled: boolean; value?: unknown };
type OrchestratorState = { orchestratorPort?: unknown; pid?: unknown; startedAt?: unknown; configPath?: unknown; argv?: unknown };
type StatePidStatus = 'missing' | 'stopped' | 'mismatch' | 'current';
enum ProjectRuntimeMode { LocalProcess = 'local_process', Docker = 'docker' }
enum ActiveTaskStatus { Queued = 'queued', Running = 'running', Waiting = 'waiting', ReviewPending = 'review_pending' }
type DockerContainerSummary = { id: string; name: string; image: string; state: string; status: string; createdAt: string; agentId: string; role: string };
type DockerHostIssue = 'not_installed' | 'permission_denied' | 'daemon_unavailable';
type DockerManagementStatus = { installed: boolean; daemonRunning: boolean; available: boolean; version?: string; cliVersion?: string; issue?: DockerHostIssue; error?: string; autoInstallSupported: boolean; runtimeMode: ProjectRuntimeMode; migrationLocked: boolean; configured?: { image?: string; network?: string; extraArgs: string[] }; containers: DockerContainerSummary[]; runtimeEntries: Array<{ agentId: string; role: string; containerName: string; startedAt: string; state: string; recentErrors: string[] }> };
type DockerHostStatus = Pick<DockerManagementStatus, 'installed' | 'daemonRunning' | 'available' | 'version' | 'cliVersion' | 'issue' | 'error' | 'autoInstallSupported'> & { executable?: string };
const DESKTOP_APP_ID = 'me.ibert.oat-desktop';
const observabilityStreams = new Map<number, AbortController>();
const projectRestartPhases = new Map<string, ProjectRestartPhaseEnum>();
let resourceSupervisor: ResourceSupervisor | undefined;

function desktopIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'logo.png')
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../logo/logo-512.png');
}

const REQUIRED_NODE_MAJOR = 22;
const PROJECT_PROBE_TIMEOUT_MS = 5_000;
const ORCHESTRATOR_IDENTITY_TIMEOUT_MS = 2_500;
const ORCHESTRATOR_STOP_TIMEOUT_MS = 15_000;
const ORCHESTRATOR_START_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const APP_DIR = () => join(app.getPath('userData'), 'runtime');
const managedNodeRoot = () => join(APP_DIR(), 'node');
const oatPrefix = () => join(APP_DIR(), 'oat');
const isWindows = process.platform === 'win32';
const nodeName = isWindows ? 'node.exe' : 'node';
const npmName = isWindows ? 'npm.cmd' : 'npm';
const oatName = isWindows ? 'oat.cmd' : 'oat';
const rendererEntry = () => join(dirname(fileURLToPath(import.meta.url)), '../renderer/index.html');
const oatDataDir = () => join(homedir(), '.oat');
let runtimeInstallPromise: Promise<RuntimeStatus> | undefined;
let dockerInstallPromise: Promise<DockerHostStatus> | undefined;

function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl) return false;
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    return new URL(senderUrl).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin;
  }
  return senderUrl === pathToFileURL(rendererEntry()).toString();
}

function requireTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!isTrustedRenderer(event)) throw new Error('This IPC operation is restricted to the OAT renderer.');
}

function isTrustedNavigationUrl(url: string): boolean {
  try {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin;
    }
    return url === pathToFileURL(rendererEntry()).toString();
  } catch { return false; }
}

async function exists(path: string): Promise<boolean> {
  try { await fs.access(path); return true; } catch { return false; }
}

function run(file: string, args: string[], timeout = 30_000): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, env: { ...process.env, NO_UPDATE_NOTIFIER: '1' } });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${file}`)); }, timeout);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolveResult({ code: code ?? 1, stdout, stderr }); });
  });
}

function dockerCandidates(): string[] {
  if (isWindows) return [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'), 'docker.exe'];
  if (platform() === 'darwin') return ['/Applications/Docker.app/Contents/Resources/bin/docker', join(homedir(), 'Applications', 'Docker.app', 'Contents', 'Resources', 'bin', 'docker'), '/opt/homebrew/bin/docker', '/usr/local/bin/docker', 'docker'];
  return ['/usr/bin/docker', '/usr/local/bin/docker', 'docker'];
}

async function locateDocker(): Promise<{ executable?: string; cliVersion?: string }> {
  for (const candidate of dockerCandidates()) {
    try {
      const result = await run(candidate, ['--version'], 10_000);
      if (result.code === 0) return { executable: candidate, cliVersion: result.stdout.trim() };
    } catch { /* try the next trusted location */ }
  }
  return {};
}

function supportsDockerAutoInstall(): boolean {
  return ['darwin', 'win32', 'linux'].includes(platform());
}

async function dockerHostStatus(): Promise<DockerHostStatus> {
  const located = await locateDocker();
  if (!located.executable) return { installed: false, daemonRunning: false, available: false, autoInstallSupported: supportsDockerAutoInstall(), issue: 'not_installed' };
  const engine = await run(located.executable, ['version', '--format', '{{.Server.Version}}'], 10_000).catch((error) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  const daemonRunning = engine.code === 0 && Boolean(engine.stdout.trim());
  const error = daemonRunning ? undefined : engine.stderr.trim() || engine.stdout.trim();
  return { installed: true, daemonRunning, available: daemonRunning, executable: located.executable, cliVersion: located.cliVersion, version: daemonRunning ? engine.stdout.trim() : undefined, issue: daemonRunning ? undefined : /permission denied|access is denied/i.test(error ?? '') ? 'permission_denied' : 'daemon_unavailable', error, autoInstallSupported: supportsDockerAutoInstall() };
}

async function requireDockerExecutable(requireEngine = true): Promise<string> {
  const status = await dockerHostStatus();
  if (!status.executable) throw new Error('Docker is not installed. Confirm installation in Docker management first.');
  if (requireEngine && !status.daemonRunning) throw new Error('Docker is installed, but Docker Engine is not running.');
  return status.executable;
}

function isCompatible(version: string): boolean {
  const match = /^v?(\d+)\./.exec(version.trim());
  return Boolean(match && Number(match[1]) >= REQUIRED_NODE_MAJOR && Number(match[1]) < 25);
}

async function locateNode(): Promise<{ path?: string; version?: string; source?: 'system' | 'managed' }> {
  const managed = isWindows ? join(managedNodeRoot(), 'node.exe') : join(managedNodeRoot(), 'bin', 'node');
  const candidates = [managed, nodeName];
  for (const candidate of candidates) {
    try {
      const result = await run(candidate, ['--version']);
      if (result.code === 0) return { path: candidate, version: result.stdout.trim(), source: candidate === managed ? 'managed' : 'system' };
    } catch { /* try next candidate */ }
  }
  return {};
}

async function locateOat(): Promise<{ path?: string; version?: string; source?: 'local-link' | 'managed' | 'system' }> {
  const localLink = !app.isPackaged ? process.env.OAT_DESKTOP_DEV_LOCAL_LINK : undefined;
  if (localLink) {
    const manifest = await readJson<{ name?: unknown; version?: unknown }>(join(localLink, 'package.json'));
    if (manifest?.name === 'open-agent-team' && typeof manifest.version === 'string') return { path: localLink, version: manifest.version, source: 'local-link' };
  }
  const managed = join(oatPrefix(), 'bin', oatName);
  const candidates = app.isPackaged ? [managed, oatName] : [oatName, managed];
  for (const candidate of candidates) {
    try {
      const result = await run(candidate, ['--version']);
      if (result.code === 0) return { path: candidate, version: result.stdout.trim(), source: candidate === managed ? 'managed' : app.isPackaged ? 'system' : 'local-link' };
    } catch { /* try next candidate */ }
  }
  return {};
}

async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const node = await locateNode();
  const oat = await locateOat();
  return {
    node: { installed: Boolean(node.path), compatible: Boolean(node.version && isCompatible(node.version)), version: node.version, source: node.source, path: node.path },
    oat: { installed: Boolean(oat.path), version: oat.version, path: oat.path, source: oat.source },
  };
}

function nodeArchiveName(version: string): string {
  const os = platform(); const cpu = arch();
  const nodeArch = cpu === 'x64' || cpu === 'arm64' ? cpu : undefined;
  if (!nodeArch || !['darwin', 'linux', 'win32'].includes(os)) throw new Error(`Unsupported platform: ${os}/${cpu}`);
  const ext = os === 'win32' ? 'zip' : 'tar.gz';
  return `node-v${version}-${os === 'win32' ? 'win' : os}-${nodeArch}.${ext}`;
}

async function downloadResponse(url: URL, target: string, redirects: number, deadline: number): Promise<void> {
  if (url.protocol !== 'https:') throw new Error('Downloads and redirects must use HTTPS.');
  if (redirects > MAX_DOWNLOAD_REDIRECTS) throw new Error(`Download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects.`);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Download timed out.');
  await new Promise<void>((resolveDownload, rejectDownload) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error) rejectDownload(error);
      else resolveDownload();
    };
    const request = get(url, { signal: AbortSignal.timeout(remaining) }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        response.destroy();
        if (!location) { finish(new Error(`Download redirect (HTTP ${status}) did not include a location.`)); return; }
        let redirected: URL;
        try { redirected = new URL(location, url); }
        catch { finish(new Error('Download redirect returned an invalid location.')); return; }
        void downloadResponse(redirected, target, redirects + 1, deadline).then(() => finish(), finish);
        return;
      }
      if (status !== 200) {
        response.resume();
        finish(new Error(`Download failed: HTTP ${status}`));
        return;
      }
      const output = createWriteStream(target, { flags: 'w', mode: 0o600 });
      void pipeline(response, output).then(() => finish(), finish);
    });
    request.once('error', finish);
  });
}

async function download(url: string, target: string): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true });
  try {
    await downloadResponse(new URL(url), target, 0, Date.now() + DOWNLOAD_TIMEOUT_MS);
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function commandExists(file: string, args = ['--version']): Promise<boolean> {
  try { return (await run(file, args, 10_000)).code === 0; } catch { return false; }
}

async function firstAvailableCommand(candidates: string[], args = ['--version']): Promise<string | undefined> {
  for (const candidate of candidates) if (await commandExists(candidate, args)) return candidate;
  return undefined;
}

async function installDockerOnMac(): Promise<void> {
  const brew = await firstAvailableCommand(['/opt/homebrew/bin/brew', '/usr/local/bin/brew', 'brew']);
  if (brew) {
    const result = await run(brew, ['install', '--cask', 'docker'], 15 * 60_000);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Homebrew could not install Docker Desktop.');
    return;
  }
  const dockerRoot = join(APP_DIR(), 'docker-installer');
  const dmg = join(dockerRoot, 'Docker.dmg');
  const mountPoint = join(dockerRoot, 'mounted');
  const cpu = arch() === 'arm64' ? 'arm64' : arch() === 'x64' ? 'amd64' : undefined;
  if (!cpu) throw new Error(`Docker Desktop automatic installation does not support ${arch()} macOS.`);
  await fs.rm(dockerRoot, { recursive: true, force: true });
  await fs.mkdir(mountPoint, { recursive: true });
  await download(`https://desktop.docker.com/mac/main/${cpu}/Docker.dmg`, dmg);
  const attached = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmg], 120_000);
  if (attached.code !== 0) throw new Error(attached.stderr.trim() || 'Unable to mount the Docker Desktop installer.');
  try {
    const source = join(mountPoint, 'Docker.app');
    const signature = await run('codesign', ['--verify', '--deep', '--strict', source], 60_000);
    if (signature.code !== 0) throw new Error(signature.stderr.trim() || 'Docker Desktop signature verification failed.');
    const identity = await run('codesign', ['-dv', '--verbose=4', source], 30_000);
    if (identity.code !== 0 || !identity.stderr.includes('TeamIdentifier=9BNSXJN65R')) throw new Error('Docker Desktop publisher verification failed.');
    const applications = join(homedir(), 'Applications');
    await fs.mkdir(applications, { recursive: true });
    const copied = await run('ditto', [source, join(applications, 'Docker.app')], 5 * 60_000);
    if (copied.code !== 0) throw new Error(copied.stderr.trim() || 'Unable to copy Docker Desktop to Applications.');
  } finally {
    await run('hdiutil', ['detach', mountPoint], 60_000).catch(() => undefined);
    await fs.rm(dockerRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installDockerOnWindows(): Promise<void> {
  if (!await commandExists('winget.exe')) throw new Error('Automatic installation requires Windows Package Manager (winget).');
  const result = await run('winget.exe', ['install', '--id', 'Docker.DockerDesktop', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'], 15 * 60_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Windows Package Manager could not install Docker Desktop.');
}

async function installDockerOnLinux(): Promise<void> {
  if (!await commandExists('apt-get', ['--version'])) throw new Error('Automatic Docker installation currently supports apt-based Linux distributions. Use the official Docker installation guide for this system.');
  const privilege = typeof process.getuid === 'function' && process.getuid() === 0 ? undefined : 'pkexec';
  if (privilege && !await commandExists(privilege, ['--version'])) throw new Error('Automatic installation requires PolicyKit (pkexec) to request administrator approval.');
  const execute = async (file: string, args: string[], timeout: number): Promise<void> => {
    const result = privilege ? await run(privilege, [file, ...args], timeout) : await run(file, args, timeout);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${file} failed.`);
  };
  await execute('apt-get', ['update'], 10 * 60_000);
  await execute('apt-get', ['install', '-y', 'docker.io'], 15 * 60_000);
  await execute('systemctl', ['enable', '--now', 'docker'], 120_000);
  const username = userInfo().username;
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(username)) await execute('usermod', ['-aG', 'docker', username], 60_000);
}

async function waitForDockerEngine(timeoutMs = 120_000): Promise<DockerHostStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await dockerHostStatus();
  while (!status.daemonRunning && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    status = await dockerHostStatus();
  }
  return status;
}

async function startDocker(): Promise<DockerHostStatus> {
  const current = await dockerHostStatus();
  if (!current.installed || !current.executable) throw new Error('Docker is not installed.');
  if (current.daemonRunning) return current;
  const desktopStart = await run(current.executable, ['desktop', 'start'], 30_000).catch(() => undefined);
  if (!desktopStart || desktopStart.code !== 0) {
    if (platform() === 'darwin') {
      const appPath = current.executable.includes('/Applications/') ? resolve(current.executable, '../../../..') : 'Docker';
      const launched = await run('/usr/bin/open', appPath === 'Docker' ? ['-a', 'Docker'] : [appPath], 30_000);
      if (launched.code !== 0) throw new Error(launched.stderr.trim() || 'Unable to start Docker Desktop.');
    } else if (isWindows) {
      const desktop = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
      const launched = spawn(desktop, [], { detached: true, stdio: 'ignore', windowsHide: false }); launched.unref();
    } else {
      const privilege = typeof process.getuid === 'function' && process.getuid() === 0 ? undefined : 'pkexec';
      const started = privilege ? await run(privilege, ['systemctl', 'start', 'docker'], 120_000) : await run('systemctl', ['start', 'docker'], 120_000);
      if (started.code !== 0) throw new Error(started.stderr.trim() || 'Unable to start Docker Engine.');
    }
  }
  const ready = await waitForDockerEngine();
  if (!ready.daemonRunning) throw new Error(ready.error || 'Docker Engine did not become ready in time.');
  return ready;
}

async function performDockerInstall(): Promise<DockerHostStatus> {
  const current = await dockerHostStatus();
  if (current.installed) return current.daemonRunning ? current : startDocker();
  if (platform() === 'darwin') await installDockerOnMac();
  else if (isWindows) await installDockerOnWindows();
  else if (platform() === 'linux') await installDockerOnLinux();
  else throw new Error(`Docker automatic installation is not supported on ${platform()}.`);
  const installed = await dockerHostStatus();
  if (!installed.installed) throw new Error('Docker installation completed, but the Docker CLI could not be located. Restart OAT Desktop and try again.');
  try { return await startDocker(); }
  catch (error) {
    if (platform() !== 'linux') throw error;
    return { ...(await dockerHostStatus()), error: 'Docker was installed. Sign out and back in once to apply Docker group access, then start Docker Engine.' };
  }
}

function installDocker(): Promise<DockerHostStatus> {
  if (!dockerInstallPromise) dockerInstallPromise = performDockerInstall().finally(() => { dockerInstallPromise = undefined; });
  return dockerInstallPromise;
}

type DockerInstallLocale = 'zh-CN' | 'en' | 'fr' | 'ja';
const dockerInstallDialogs: Record<DockerInstallLocale, { title: string; detail: string; install: string; cancel: string }> = {
  'zh-CN': { title: '安装 Docker', detail: '将下载并安装 Docker，过程中可能请求管理员授权。继续即表示你已查看并接受 Docker 的条款及适用许可。', install: '确认安装', cancel: '取消' },
  en: { title: 'Install Docker', detail: 'Docker will be downloaded and installed and may request administrator approval. Continue only after reviewing and accepting Docker’s terms and applicable licensing.', install: 'Install', cancel: 'Cancel' },
  fr: { title: 'Installer Docker', detail: 'Docker sera téléchargé et installé et peut demander une autorisation administrateur. Continuez après avoir accepté les conditions et licences applicables de Docker.', install: 'Installer', cancel: 'Annuler' },
  ja: { title: 'Docker をインストール', detail: 'Docker をダウンロードしてインストールします。管理者承認が必要な場合があります。Docker の規約と適用ライセンスを確認し、同意した場合のみ続行してください。', install: 'インストール', cancel: 'キャンセル' },
};

async function confirmAndInstallDocker(event: IpcMainInvokeEvent, requestedLocale: unknown): Promise<DockerHostStatus> {
  const locale = typeof requestedLocale === 'string' && requestedLocale in dockerInstallDialogs ? requestedLocale as DockerInstallLocale : 'en';
  const copy = dockerInstallDialogs[locale];
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = { type: 'warning' as const, title: copy.title, message: copy.title, detail: copy.detail, buttons: [copy.install, copy.cancel], defaultId: 1, cancelId: 1, noLink: true };
  const confirmation = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (confirmation.response !== 0) return dockerHostStatus();
  return installDocker();
}

async function installManagedNode(): Promise<void> {
  const latestFile = join(APP_DIR(), 'SHASUMS256.txt');
  await download('https://nodejs.org/dist/latest-v22/SHASUMS256.txt', latestFile);
  const sums = await fs.readFile(latestFile, 'utf8');
  const version = /node-v(\d+\.\d+\.\d+)-(?:darwin|linux|win)-/m.exec(sums)?.[1];
  if (!version) throw new Error('Unable to resolve the latest Node.js 22 release.');
  const archive = nodeArchiveName(version);
  const expected = new RegExp(`^([a-f0-9]{64})\\s+${archive.replaceAll('.', '\\.')}\\s*$`, 'm').exec(sums)?.[1];
  if (!expected) throw new Error(`Checksum unavailable for ${archive}.`);
  const downloaded = join(APP_DIR(), archive);
  await download(`https://nodejs.org/dist/v${version}/${archive}`, downloaded);
  const actual = createHash('sha256').update(await fs.readFile(downloaded)).digest('hex');
  if (actual !== expected) throw new Error('Node.js checksum verification failed.');
  await fs.rm(managedNodeRoot(), { recursive: true, force: true });
  if (isWindows) {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive', '-LiteralPath', downloaded, '-DestinationPath', APP_DIR(), '-Force']);
    if (result.code !== 0) throw new Error(result.stderr || 'Unable to unpack Node.js.');
    await fs.rename(join(APP_DIR(), `node-v${version}-win-${arch()}`), managedNodeRoot());
  } else {
    const result = await run('tar', ['-xzf', downloaded, '-C', APP_DIR()]);
    if (result.code !== 0) throw new Error(result.stderr || 'Unable to unpack Node.js.');
    await fs.rename(join(APP_DIR(), `node-v${version}-${platform()}-${arch()}`), managedNodeRoot());
  }
  await fs.rm(downloaded, { force: true });
}

async function performEnsureOat(update: boolean): Promise<RuntimeStatus> {
  void update;
  let node = await locateNode();
  if (!node.path || !node.version || !isCompatible(node.version)) { await installManagedNode(); node = await locateNode(); }
  if (!node.path) throw new Error('A compatible Node.js runtime could not be installed.');
  const npm = isWindows ? join(managedNodeRoot(), npmName) : join(managedNodeRoot(), 'bin', npmName);
  const npmPath = await exists(npm) ? npm : npmName;
  const result = await run(npmPath, ['install', '--global', '--prefix', oatPrefix(), 'open-agent-team@latest'], 180_000);
  if (result.code !== 0) throw new Error(result.stderr || 'OAT installation failed.');
  return getRuntimeStatus();
}

function ensureOat(update = false): Promise<RuntimeStatus> {
  if (runtimeInstallPromise) return runtimeInstallPromise;
  const operation = performEnsureOat(update);
  runtimeInstallPromise = operation;
  const clear = (): void => { if (runtimeInstallPromise === operation) runtimeInstallPromise = undefined; };
  void operation.then(clear, clear);
  return operation;
}

/** Startup is intentionally explicit: the renderer keeps the loading screen up
 * until this check completes. Development never downloads a release package;
 * its OAT executable is resolved from the local linked package first. */
async function prepareRuntime(): Promise<RuntimeStatus> {
  const status = await getRuntimeStatus();
  if (!app.isPackaged) {
    if (!status.node.compatible) throw new Error(`Node.js ${REQUIRED_NODE_MAJOR}–24 is required for Desktop development.`);
    if (!status.oat.installed) throw new Error('The local linked OAT package is unavailable. Run pnpm link in the OAT package first.');
    const runtimeReady = process.env.OAT_DESKTOP_RUNTIME_READY_SIGNAL;
    const teamReady = process.env.OAT_DESKTOP_TEAM_READY_SIGNAL;
    if (runtimeReady && teamReady) {
      await fs.writeFile(runtimeReady, 'ready', { encoding: 'utf8', mode: 0o600 });
      const deadline = Date.now() + 35_000;
      while (!(await exists(teamReady))) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the development test team to start.');
        await delay(150);
      }
    }
    return status;
  }
  return status.node.compatible && status.oat.installed ? status : ensureOat(false);
}

async function ensureNodeRuntime(): Promise<RuntimeStatus> {
  const current = await getRuntimeStatus();
  if (current.node.compatible) return current;
  if (!app.isPackaged) throw new Error(`Node.js ${REQUIRED_NODE_MAJOR}–24 is required for Desktop development.`);
  await installManagedNode();
  return getRuntimeStatus();
}

async function ensureOatTool(): Promise<RuntimeStatus> {
  const current = await getRuntimeStatus();
  if (!current.node.compatible) throw new Error('A compatible Node.js runtime is required before installing OAT.');
  if (current.oat.installed) return current;
  if (!app.isPackaged) throw new Error('The local linked OAT package is unavailable. Run pnpm link in the OAT package first.');
  return ensureOat(false);
}

function versionNewer(latest: string | undefined, current: string): boolean {
  const toParts = (value: string) => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  if (!latest) return false;
  const [a, b] = [toParts(latest), toParts(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) { if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0); }
  return false;
}

async function checkForUpdates(): Promise<UpdateStatus> {
  const current = await getRuntimeStatus();
  const oat = { checked: false, latest: undefined as string | undefined, available: false, error: undefined as string | undefined };
  const desktop = { checked: false, latest: undefined as string | undefined, available: false, error: undefined as string | undefined };
  try {
    const node = await locateNode(); const npm = node.source === 'managed' ? join(managedNodeRoot(), isWindows ? npmName : `bin/${npmName}`) : npmName;
    const result = await run(npm, ['view', 'open-agent-team', 'version'], 20_000);
    if (result.code !== 0) throw new Error(result.stderr || 'npm registry lookup failed.');
    oat.latest = result.stdout.trim(); oat.available = versionNewer(oat.latest, current.oat.version ?? '0.0.0'); oat.checked = true;
  } catch (error) { oat.error = error instanceof Error ? error.message : String(error); }
  try {
    const response = await fetch('https://api.github.com/repos/herberthe/open-agent-team/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'open-agent-team-desktop' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const release = await response.json() as { tag_name?: string };
    desktop.latest = release.tag_name; desktop.available = versionNewer(desktop.latest, app.getVersion()); desktop.checked = true;
  } catch (error) { desktop.error = error instanceof Error ? error.message : String(error); }
  return { oat, desktop };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return undefined; }
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function stateArgv(state: OrchestratorState): string[] | undefined {
  return Array.isArray(state.argv) && state.argv.length >= 2 && state.argv.every((argument) => typeof argument === 'string' && argument.length > 0)
    ? state.argv
    : undefined;
}

/**
 * A PID alone is not an identity: operating systems may reuse it after the
 * original Orchestrator exits. On POSIX, compare the recorded executable and
 * entrypoint before acting on a process. Windows uses its built-in process
 * metadata query for the same check.
 */
async function inspectStatePid(state: OrchestratorState): Promise<StatePidStatus> {
  if (!validPid(state.pid)) return 'missing';
  try { process.kill(state.pid, 0); } catch { return 'stopped'; }
  const argv = stateArgv(state);
  if (!argv) return 'mismatch';
  try {
    const result = process.platform === 'win32'
      ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}').CommandLine`], ORCHESTRATOR_IDENTITY_TIMEOUT_MS)
      : await run('ps', ['-p', String(state.pid), '-o', 'command='], ORCHESTRATOR_IDENTITY_TIMEOUT_MS);
    const command = result.stdout.trim();
    if (result.code !== 0 || !command) return 'mismatch';
    const comparable = process.platform === 'win32' ? command.toLowerCase() : command;
    const executable = process.platform === 'win32' ? basename(argv[0]).toLowerCase() : basename(argv[0]);
    const entrypoint = process.platform === 'win32' ? basename(argv[1]).toLowerCase() : basename(argv[1]);
    return comparable.includes(executable) && comparable.includes(entrypoint) ? 'current' : 'mismatch';
  } catch { return 'mismatch'; }
}

/** Returns false only when lsof was able to establish that another PID owns the saved port. */
async function statePidOwnsPort(pid: number, port: number): Promise<boolean | undefined> {
  try {
    if (process.platform === 'win32') {
      const result = await run('netstat.exe', ['-ano', '-p', 'tcp'], ORCHESTRATOR_IDENTITY_TIMEOUT_MS);
      if (result.code !== 0) return undefined;
      const listeners = result.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((columns) => columns.length >= 5 && columns[0].toUpperCase() === 'TCP' && columns[3].toUpperCase() === 'LISTENING' && columns[1].endsWith(`:${port}`));
      return listeners.some((columns) => columns[4] === String(pid));
    }
    const result = await run('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], ORCHESTRATOR_IDENTITY_TIMEOUT_MS);
    if (result.code !== 0) return result.stderr.trim() ? undefined : false;
    return result.stdout.split(/\s+/).some((entry) => entry === String(pid));
  } catch {
    // lsof is not guaranteed to be installed; the command-line check above is
    // still enough to reject the common stale-PID case.
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolveListening) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveListening(listening);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function waitForProjectRelease(pid: number, port?: number): Promise<void> {
  const deadline = Date.now() + ORCHESTRATOR_STOP_TIMEOUT_MS;
  do {
    const [pidAlive, portListening] = await Promise.all([
      Promise.resolve(isPidAlive(pid)),
      port ? isPortListening(port) : Promise.resolve(false),
    ]);
    if (!pidAlive && !portListening) return;
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error('The previous Orchestrator did not release its process and port before the restart timeout.');
}

async function listProjects(): Promise<Project[]> {
  const projectsDir = join(homedir(), '.oat', 'projects');
  let entries: string[] = [];
  try { entries = await fs.readdir(projectsDir); } catch { return []; }
  return Promise.all(entries.map(async (name) => {
    const link = join(projectsDir, name);
    let root = link;
    try { root = await fs.realpath(link); } catch { /* retain link */ }
    const state = await readJson<OrchestratorState>(join(root, '.oat', 'state', 'orchestrator.json'));
    const port = validPort(state?.orchestratorPort) ? state.orchestratorPort : undefined;
    let alive = Boolean(state && (await inspectStatePid(state)) === 'current');
    if (alive && state && port && validPid(state.pid) && (await statePidOwnsPort(state.pid, port)) === false) alive = false;
    let agents: Project['agents'] = [];
    if (alive && port) {
      try {
        const [graphResponse, tasksResponse] = await Promise.all([
          fetch(`http://127.0.0.1:${port}/observability/graph`, { signal: AbortSignal.timeout(PROJECT_PROBE_TIMEOUT_MS) }),
          fetch(`http://127.0.0.1:${port}/tasks`, { signal: AbortSignal.timeout(PROJECT_PROBE_TIMEOUT_MS) }),
        ]);
        if (!graphResponse.ok) throw new Error(`Project health probe returned HTTP ${graphResponse.status}.`);
        const graph = await graphResponse.json() as { nodes?: Array<{ id: string; role: string; label: string }> };
        const tasks = tasksResponse.ok
          ? await tasksResponse.json() as Array<{ targetAgentId: string; status: string }>
          : [];
        // Finished tasks are retained by the Orchestrator as history. They must
        // not keep an Agent marked busy in the desktop project tree.
        const activeAgentIds = new Set(tasks.filter((task) => task.status === 'queued' || task.status === 'running').map((task) => task.targetAgentId));
        agents = (graph.nodes ?? []).map((agent) => ({ ...agent, status: activeAgentIds.has(agent.id) ? 'running' : 'idle' }));
      } catch {
        // A PID can survive briefly after its HTTP server has stopped. Treat a
        // failed probe as offline so renderer code never keeps requesting it.
        alive = false; agents = [];
      }
    }
    let projectName: string | null = null;
    try {
      const configPath = typeof state?.configPath === 'string' ? resolve(root, state.configPath) : join(root, 'team.json');
      const config = await readJson<{ project?: { name?: string } }>(configPath);
      projectName = config?.project?.name ?? null;
    } catch { /* project metadata is optional */ }
    return { name, projectName, root, port, pid: validPid(state?.pid) ? state.pid : undefined, startedAt: typeof state?.startedAt === 'string' ? state.startedAt : null, alive, agents };
  }));
}

/** Resolve a registered project without accepting paths from the renderer. */
async function registeredProject(name: string): Promise<{ link: string; root: string }> {
  if (!isSafePathSegment(name)) throw new Error('Invalid project name.');
  const link = join(homedir(), '.oat', 'projects', name);
  const root = await fs.realpath(link);
  return { link, root };
}

/** Registered names and workspace agent ids are opaque path segments, never paths. */
function isSafePathSegment(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && value.trim() === value
    && value !== '.'
    && value !== '..'
    && !/[\\/\0]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function controlRequestUrl(path: unknown): URL {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('Invalid control-plane request path.');
  const url = new URL(path, 'http://oat-desktop.local');
  if (url.origin !== 'http://oat-desktop.local' || url.hash) throw new Error('Invalid control-plane request path.');
  return url;
}

function controlSegments(url: URL): string[] {
  try { return url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment)); }
  catch { throw new Error('Invalid control-plane request path.'); }
}

function controlMethod(input: Omit<OrchestratorRequest, 'projectName'>): string {
  const method = input.init?.method?.toUpperCase() ?? 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported control-plane request method.');
  return method;
}

function jsonBody(input: Omit<OrchestratorRequest, 'projectName'>): Record<string, unknown> {
  if (typeof input.init?.body !== 'string') throw new Error('A JSON object request body is required.');
  let body: unknown;
  try { body = JSON.parse(input.init.body); } catch { throw new Error('Control-plane request body is not valid JSON.'); }
  if (!isRecord(body)) throw new Error('Control-plane request body must be a JSON object.');
  return body;
}

function pathInside(root: string, target: string): boolean {
  const diff = relative(root, target);
  return diff === '' || (!diff.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && diff !== '..' && !isAbsolute(diff));
}

async function projectConfigPath(name: string): Promise<string> {
  const { root } = await registeredProject(name);
  const state = await readJson<{ configPath?: unknown }>(join(root, '.oat', 'state', 'orchestrator.json'));
  const configured = typeof state?.configPath === 'string' ? state.configPath : 'team.json';
  const configPath = resolve(root, configured);
  if (!pathInside(root, configPath)) throw new Error('Project configuration path is outside the registered project.');
  return configPath;
}

async function localGlobalConfig(): Promise<Record<string, unknown>> {
  const existing = await readJson<unknown>(join(oatDataDir(), 'oat.json'));
  return isRecord(existing) ? existing : {};
}

async function saveLocalGlobalConfig(updates: Record<string, unknown>): Promise<void> {
  const config = { ...await localGlobalConfig(), ...updates };
  await fs.mkdir(oatDataDir(), { recursive: true });
  await fs.writeFile(join(oatDataDir(), 'oat.json'), JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
}

type LocalModels = { providers: Record<string, unknown>; models: Record<string, unknown> };
async function localGlobalModels(): Promise<LocalModels> {
  const existing = await readJson<unknown>(join(oatDataDir(), 'models.json'));
  return isRecord(existing)
    ? { providers: isRecord(existing.providers) ? existing.providers : {}, models: isRecord(existing.models) ? existing.models : {} }
    : { providers: {}, models: {} };
}

async function saveLocalGlobalModels(incoming: Record<string, unknown>): Promise<void> {
  const current = incoming.replace === true ? { providers: {}, models: {} } : await localGlobalModels();
  const providers = isRecord(incoming.providers) ? incoming.providers : {};
  const models = isRecord(incoming.models) ? incoming.models : {};
  const result = incoming.replace === true
    ? { providers, models }
    : { providers: { ...current.providers, ...providers }, models: { ...current.models, ...models } };
  await fs.mkdir(oatDataDir(), { recursive: true });
  await fs.writeFile(join(oatDataDir(), 'models.json'), JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Resolve provider credentials in memory without exposing or copying them to
 * the global catalog. Existing project configs remain the current credential
 * source until Desktop gains a dedicated keychain-backed store. */
async function resourceGlobalModels(): Promise<LocalModels> {
  const catalog = structuredClone(await localGlobalModels());
  const missing = new Set(Object.entries(catalog.providers)
    .filter(([, value]) => !isRecord(value) || typeof value.api_key !== 'string' || !value.api_key)
    .map(([key]) => key));
  if (!missing.size) return catalog;
  for (const project of await listProjects()) {
    let config: Record<string, unknown> | undefined;
    try { config = await localProjectConfig(project.name, { path: '' }, 'GET') as Record<string, unknown>; } catch { continue; }
    if (!isRecord(config.providers)) continue;
    for (const key of [...missing]) {
      const declared = config.providers[key];
      if (!isRecord(declared) || typeof declared.api_key !== 'string' || !declared.api_key) continue;
      const current = isRecord(catalog.providers[key]) ? catalog.providers[key] : {};
      catalog.providers[key] = { ...current, api_key: declared.api_key };
      missing.delete(key);
    }
    if (!missing.size) break;
  }
  return catalog;
}

async function resourceInventory(): Promise<Record<string, unknown>> {
  const projects = await listProjects();
  const detail = await Promise.all(projects.map(async (project) => {
    let config: Record<string, unknown> | undefined;
    try { config = await localProjectConfig(project.name, { path: '' }, 'GET') as Record<string, unknown>; } catch { /* reported as invalid below */ }
    let tasks: Array<{ status?: unknown }> = [];
    if (project.alive) {
      try { tasks = await requestOrchestrator({ projectName: project.name, path: '/tasks' }) as Array<{ status?: unknown }>; } catch { /* runtime may be recovering */ }
    }
    const agentsByRole = {
      [AgentRoleEnum.Admin]: project.agents.filter((agent) => agent.role === AgentRoleEnum.Admin).length,
      [AgentRoleEnum.Leader]: project.agents.filter((agent) => agent.role === AgentRoleEnum.Leader).length,
      [AgentRoleEnum.Worker]: project.agents.filter((agent) => agent.role === AgentRoleEnum.Worker).length,
    };
    const teams = Array.isArray(config?.teams) ? config.teams : [];
    const workerCapacity = teams.reduce((total, team) => total + (isRecord(team) && isRecord(team.worker) && Number.isInteger(team.worker.total) ? Number(team.worker.total) : 0), 0);
    return {
      name: project.name,
      projectName: project.projectName,
      alive: project.alive,
      configValid: Boolean(config),
      runtimeMode: isRecord(config?.runtime) && config?.runtime.mode === ProjectRuntimeMode.Docker ? ProjectRuntimeMode.Docker : ProjectRuntimeMode.LocalProcess,
      teamCount: teams.length,
      workerCapacity,
      agents: agentsByRole,
      busyAgents: project.agents.filter((agent) => agent.status === AgentRuntimeStatusEnum.Running).length,
      failedAgents: project.agents.filter((agent) => agent.status === AgentRuntimeStatusEnum.Failed).length,
      tasks: Object.fromEntries(Object.values(QueuedTaskStatusEnum).map((status) => [status, tasks.filter((task) => task.status === status).length])),
    };
  }));
  return {
    generatedAt: new Date().toISOString(),
    projects: {
      total: projects.length,
      running: projects.filter((project) => project.alive).length,
      stopped: projects.filter((project) => !project.alive).length,
    },
    agents: {
      total: projects.reduce((total, project) => total + project.agents.length, 0),
      busy: projects.flatMap((project) => project.agents).filter((agent) => agent.status === AgentRuntimeStatusEnum.Running).length,
      failed: projects.flatMap((project) => project.agents).filter((agent) => agent.status === AgentRuntimeStatusEnum.Failed).length,
    },
    detail,
  };
}

async function draftResourceProject(input: {
  projectName: string;
  repo?: string;
  modelAlias: string;
  runtimeMode: ProjectRuntimeModeEnum;
  dockerImage?: string;
  teams: Array<{ name: string; responsibility: string; workers: number; repos?: string[] }>;
}): Promise<{ projectName: string; config: Record<string, unknown> }> {
  const catalog = await localGlobalModels();
  const modelId = catalog.models[input.modelAlias];
  if (typeof modelId !== 'string' || !modelId.trim()) throw new Error(`Model alias ${input.modelAlias} is not registered in the global model catalog.`);
  const config = buildResourceProjectConfig({
    projectName: input.projectName,
    repo: input.repo,
    modelAlias: input.modelAlias,
    modelId,
    runtimeMode: input.runtimeMode === ProjectRuntimeModeEnum.Docker ? RuntimeModeEnum.Docker : RuntimeModeEnum.LocalProcess,
    dockerImage: input.dockerImage,
    dockerNetwork: DockerNetworkModeEnum.Bridge,
    baseBranch: BaseBranchEnum.Main,
    teams: input.teams,
  });
  return { projectName: config.project.name, config: config as unknown as Record<string, unknown> };
}

async function provisionResourceProject(proposal: ResourceProposal): Promise<{ requiredAction: ResourceRequiredActionEnum; message: string }> {
  const config = validateResourceProjectConfig(proposal.config);
  const registryName = config.project.name;
  if (!isSafePathSegment(registryName)) throw new Error('The generated project name cannot be used as a registered project identifier.');
  const linkRoot = join(homedir(), '.oat', 'projects');
  const linkPath = join(linkRoot, registryName);
  if (await exists(linkPath)) throw new Error(`Project ${registryName} is already registered.`);
  const root = join(homedir(), '.oat', 'projects-data', registryName);
  const rootAlreadyExists = await exists(root);
  if (rootAlreadyExists && (await fs.readdir(root)).length > 0) throw new Error(`Project directory ${root} already exists and is not empty.`);
  await fs.mkdir(root, { recursive: true });
  const target = join(root, 'team.json');
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    validateResourceProjectConfig(JSON.parse(await fs.readFile(temporary, 'utf8')));
    await fs.rename(temporary, target);
    await fs.mkdir(linkRoot, { recursive: true });
    await fs.symlink(root, linkPath, isWindows ? 'junction' : 'dir');
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    await fs.rm(linkPath, { force: true }).catch(() => undefined);
    if (!rootAlreadyExists) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    requiredAction: ResourceRequiredActionEnum.ManualProjectStart,
    message: `项目 ${registryName} 已创建，team.json 已通过 Schema 校验并注册到项目列表。资源管理主任没有启动本地团队进程或 Docker 的权限，请由你手动启动该项目。`,
  };
}

function getResourceSupervisor(): ResourceSupervisor {
  resourceSupervisor ??= new ResourceSupervisor({
    globalConfig: localGlobalConfig,
    globalModels: resourceGlobalModels,
    inventory: resourceInventory,
    draft: draftResourceProject,
    apply: provisionResourceProject,
  });
  return resourceSupervisor;
}

async function localProjectConfig(name: string, input: Omit<OrchestratorRequest, 'projectName'>, method: string): Promise<unknown> {
  const configPath = await projectConfigPath(name);
  if (method === 'GET') {
    const parsed = await readJson<unknown>(configPath);
    if (!isRecord(parsed)) throw new Error('Project configuration is not a JSON object.');
    return parsed;
  }
  const config = validateResourceProjectConfig(jsonBody(input)) as unknown as Record<string, unknown>;
  const current = await readJson<Record<string, unknown>>(configPath);
  if (!current) throw new Error('The current project configuration cannot be read.');
  const { root } = await registeredProject(name);
  const policyPath = join(root, '.oat', 'runtime-policy.json');
  const policy = await readJson<{ dockerRequired?: unknown }>(policyPath);
  const modeOf = (value: Record<string, unknown>): ProjectRuntimeMode => isRecord(value.runtime) && value.runtime.mode === ProjectRuntimeMode.Docker ? ProjectRuntimeMode.Docker : ProjectRuntimeMode.LocalProcess;
  const before = modeOf(current); const after = modeOf(config);
  if ((policy?.dockerRequired === true || before === ProjectRuntimeMode.Docker) && after !== ProjectRuntimeMode.Docker) {
    throw new Error('A project migrated to Docker isolation cannot be changed back to local process isolation.');
  }
  if (after === ProjectRuntimeMode.Docker) {
    const runtime = isRecord(config.runtime) ? config.runtime : undefined;
    const dockerConfig = runtime && isRecord(runtime.docker) ? runtime.docker : undefined;
    if (!dockerConfig || typeof dockerConfig.image !== 'string' || !dockerConfig.image.trim()) throw new Error('Docker image is required.');
    if (dockerConfig.network !== undefined && !['none', 'bridge', 'host'].includes(String(dockerConfig.network))) throw new Error('Docker network must be none, bridge, or host.');
    const extraArgs = dockerConfig.extra_args ?? [];
    if (!Array.isArray(extraArgs) || !extraArgs.every((arg) => typeof arg === 'string')) throw new Error('Docker extra arguments must be a string array.');
    const safe = (arg: string) => ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges'].includes(arg)
      || [/^--cpus=\d+(?:\.\d+)?$/, /^--memory=\d+[kKmMgG]?$/, /^--memory-swap=-?\d+[kKmMgG]?$/, /^--pids-limit=\d+$/, /^--ulimit=[a-z_]+=[0-9]+(?::[0-9]+)?$/, /^--tmpfs=\/tmp(?::[A-Za-z0-9,=_-]+)?$/].some((pattern) => pattern.test(arg));
    const unsafe = extraArgs.find((arg) => !safe(arg));
    if (unsafe) throw new Error(`Docker argument ${unsafe} is not allowed.`);
    if (before !== ProjectRuntimeMode.Docker) {
      const dockerStatus = await dockerHostStatus();
      if (!dockerStatus.installed) throw new Error('Docker must be installed before migration.');
      if (!dockerStatus.daemonRunning) throw new Error('Docker Engine must be running before migration.');
      try {
        const tasks = await requestOrchestrator({ projectName: name, path: '/tasks' }) as Array<{ status?: unknown }>;
        if (tasks.some((task) => Object.values(ActiveTaskStatus).includes(task.status as ActiveTaskStatus))) throw new Error('Stop active Agent work before migrating the runtime to Docker.');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Stop active')) throw error;
      }
    }
  }
  const tempConfig = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(tempConfig, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempConfig, configPath);
  if (after === ProjectRuntimeMode.Docker) {
    await fs.mkdir(dirname(policyPath), { recursive: true });
    const tempPolicy = `${policyPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPolicy, `${JSON.stringify({ dockerRequired: true, lockedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPolicy, policyPath);
  }
  return { ok: true };
}

async function localDockerStatus(name: string): Promise<DockerManagementStatus> {
  const config = await localProjectConfig(name, { path: '' }, 'GET') as Record<string, unknown>;
  const runtime = isRecord(config.runtime) ? config.runtime : undefined;
  const mode = runtime?.mode === ProjectRuntimeMode.Docker ? ProjectRuntimeMode.Docker : ProjectRuntimeMode.LocalProcess;
  const dockerConfig = runtime && isRecord(runtime.docker) ? runtime.docker : undefined;
  const { root } = await registeredProject(name);
  const migrationLocked = mode === ProjectRuntimeMode.Docker || Boolean((await readJson<{ dockerRequired?: unknown }>(join(root, '.oat', 'runtime-policy.json')))?.dockerRequired);
  const host = await dockerHostStatus();
  const base = { installed: host.installed, daemonRunning: host.daemonRunning, available: host.available, version: host.version, cliVersion: host.cliVersion, issue: host.issue, error: host.error, autoInstallSupported: host.autoInstallSupported, runtimeMode: mode, migrationLocked, configured: { image: typeof dockerConfig?.image === 'string' ? dockerConfig.image : undefined, network: typeof dockerConfig?.network === 'string' ? dockerConfig.network : undefined, extraArgs: Array.isArray(dockerConfig?.extra_args) ? dockerConfig.extra_args.map(String) : [] } };
  if (!host.daemonRunning || !host.executable) return { ...base, containers: [], runtimeEntries: [] };
  const projectLabel = isRecord(config.project) && typeof config.project.name === 'string' ? config.project.name : name;
  const format = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Label "oat.agent"}}\t{{.Label "oat.role"}}';
  const listed = await run(host.executable, ['ps', '-a', '--filter', 'label=oat.managed=true', '--filter', `label=oat.project=${projectLabel}`, '--format', format], 10_000);
  const containers = listed.code === 0 ? listed.stdout.split('\n').filter(Boolean).map((line): DockerContainerSummary => { const [id = '', containerName = '', image = '', state = '', status = '', createdAt = '', agentId = '', role = ''] = line.split('\t'); return { id, name: containerName, image, state, status, createdAt, agentId, role }; }) : [];
  let runtimeEntries: DockerManagementStatus['runtimeEntries'] = [];
  try { const live = await requestOrchestrator({ projectName: name, path: '/docker/runtime' }) as { containers?: DockerManagementStatus['runtimeEntries'] }; runtimeEntries = live.containers ?? []; } catch { /* project may be stopped */ }
  return { ...base, containers, runtimeEntries };
}

async function assertManagedContainer(name: string, container: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw new Error('Invalid Docker container identifier.');
  const config = await localProjectConfig(name, { path: '' }, 'GET') as Record<string, unknown>;
  const projectLabel = isRecord(config.project) && typeof config.project.name === 'string' ? config.project.name : name;
  const docker = await requireDockerExecutable();
  const inspected = await run(docker, ['inspect', '--format', '{{ index .Config.Labels "oat.project" }}\t{{ index .Config.Labels "oat.managed" }}', container], 10_000);
  const [owner, managed] = inspected.stdout.trim().split('\t');
  if (inspected.code !== 0 || owner !== projectLabel || managed !== 'true') throw new Error('The container is not managed by the selected OAT project.');
}

async function localDockerLogs(name: string, container: string, tail: number): Promise<{ logs: string }> {
  await assertManagedContainer(name, container);
  const result = await run(await requireDockerExecutable(), ['logs', '--tail', String(Math.min(500, Math.max(1, tail))), container], 15_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Unable to read Docker logs.');
  return { logs: `${result.stdout}${result.stderr}`.slice(-200_000) };
}

async function removeManagedContainer(name: string, container: string): Promise<{ ok: true }> {
  await assertManagedContainer(name, container);
  const docker = await requireDockerExecutable();
  const state = await run(docker, ['inspect', '--format', '{{.State.Running}}', container], 10_000);
  let projectRunning = false; try { await runningProject(name); projectRunning = true; } catch { /* stopped project */ }
  if (projectRunning && state.stdout.trim() === 'true') throw new Error('A running project must stop or safely restart this Agent before its container can be removed.');
  const removed = await run(docker, ['rm', '-f', container], 15_000);
  if (removed.code !== 0) throw new Error(removed.stderr.trim() || 'Unable to remove the Docker container.');
  return { ok: true };
}

async function localAchievement(name: string, agentId: string, resource: string, url: URL): Promise<unknown> {
  if (!isSafePathSegment(name) || !isSafePathSegment(agentId)) throw new Error('Invalid project or agent identifier.');
  const { root } = await registeredProject(name);
  const workspace = join(root, '.oat', 'workspaces', agentId);
  if (resource === 'changelog') {
    let content = '';
    try { content = await fs.readFile(join(workspace, 'CHANGELOG.md'), 'utf8'); } catch { /* achievements may not exist yet */ }
    return { content };
  }
  if (resource === 'record-dates') {
    let entries: string[] = [];
    try { entries = await fs.readdir(join(workspace, 'records')); } catch { /* no records yet */ }
    return { dates: entries.filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry)).sort().reverse() };
  }
  if (url.searchParams.size !== 1) throw new Error('Invalid achievements request path.');
  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid record date is required.');
  const directory = join(workspace, 'records', date);
  const files: Array<{ name: string; content: string }> = [];
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) if (entry.isFile()) files.push({ name: entry.name, content: await fs.readFile(join(directory, entry.name), 'utf8') });
  } catch { /* no records for this date */ }
  return { files };
}

/**
 * Supported control-plane data lives under ~/.oat or a registered project and
 * is deliberately served here rather than via an arbitrary local HTTP proxy.
 */
async function localControlPlane(input: Omit<OrchestratorRequest, 'projectName'>): Promise<ControlPlaneResult> {
  const url = controlRequestUrl(input.path);
  const method = controlMethod(input);
  const segments = controlSegments(url);
  const noQuery = !url.search;
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'global-config' && noQuery) {
    if (method === 'GET') return { handled: true, value: await localGlobalConfig() };
    if (method !== 'PUT') throw new Error('Unsupported local control-plane request method.');
    await saveLocalGlobalConfig(jsonBody(input)); return { handled: true, value: { ok: true } };
  }
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'global-models' && noQuery) {
    if (method === 'GET') return { handled: true, value: await localGlobalModels() };
    if (method !== 'PUT') throw new Error('Unsupported local control-plane request method.');
    await saveLocalGlobalModels(jsonBody(input)); return { handled: true, value: { ok: true } };
  }
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'projects' && noQuery) {
    if (method !== 'GET') throw new Error('Unsupported local control-plane request method.');
    return { handled: true, value: await listProjects() };
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'restart' && noQuery) {
    if (method !== 'POST') throw new Error('Unsupported local control-plane request method.');
    if (!isSafePathSegment(segments[2])) throw new Error('Invalid project name.');
    const trigger = jsonBody(input).trigger;
    if (trigger !== ProjectRestartTriggerEnum.HumanUi) throw new Error('Project restart requires an explicit human UI action.');
    return { handled: true, value: await restartProject(segments[2], ProjectRestartTriggerEnum.HumanUi) };
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'restart-status' && noQuery) {
    if (method !== 'GET') throw new Error('Unsupported local control-plane request method.');
    if (!isSafePathSegment(segments[2])) throw new Error('Invalid project name.');
    return { handled: true, value: await projectRestartStatus(segments[2]) };
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'config' && noQuery) {
    if (!['GET', 'PUT'].includes(method)) throw new Error('Unsupported local control-plane request method.');
    return { handled: true, value: await localProjectConfig(segments[2], input, method) };
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'docker' && noQuery) {
    if (method !== 'GET') throw new Error('Unsupported Docker management request method.');
    if (!isSafePathSegment(segments[2])) throw new Error('Invalid project name.');
    return { handled: true, value: await localDockerStatus(segments[2]) };
  }
  if (segments.length === 7 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'docker' && segments[4] === 'containers' && segments[6] === 'logs') {
    if (method !== 'GET') throw new Error('Unsupported Docker log request method.');
    const tail = Number(url.searchParams.get('tail') ?? 200);
    return { handled: true, value: await localDockerLogs(segments[2], segments[5], Number.isFinite(tail) ? tail : 200) };
  }
  if (segments.length === 6 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'docker' && segments[4] === 'containers' && noQuery) {
    if (method !== 'DELETE') throw new Error('Unsupported Docker container management request method.');
    return { handled: true, value: await removeManagedContainer(segments[2], segments[5]) };
  }
  if (segments.length === 7 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'docker' && segments[4] === 'agents' && segments[6] === 'restart' && noQuery) {
    if (method !== 'POST') throw new Error('Unsupported Docker Agent management request method.');
    if (!isSafePathSegment(segments[2]) || !isSafePathSegment(segments[5])) throw new Error('Invalid project or Agent identifier.');
    return { handled: true, value: await requestOrchestrator({ projectName: segments[2], path: `/docker/agents/${encodeURIComponent(segments[5])}/restart`, init: { method: 'POST' } }) };
  }
  if (segments.length === 6 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'workspaces' && ['changelog', 'record-dates', 'records'].includes(segments[5])) {
    if (method !== 'GET') throw new Error('Unsupported local control-plane request method.');
    if (segments[5] !== 'records' && !noQuery) throw new Error('Invalid achievements request path.');
    return { handled: true, value: await localAchievement(segments[2], segments[4], segments[5], url) };
  }
  return { handled: false };
}

async function runningProject(name: string): Promise<{ port: number }> {
  const { root } = await registeredProject(name);
  const state = await readJson<OrchestratorState>(join(root, '.oat', 'state', 'orchestrator.json'));
  if (!state || !validPort(state.orchestratorPort)) throw new Error('The selected project has no valid Orchestrator port.');
  if ((await inspectStatePid(state)) !== 'current' || !validPid(state.pid)) throw new Error('The selected project is not running.');
  const ownership = await statePidOwnsPort(state.pid, state.orchestratorPort);
  if (ownership === false) throw new Error('The selected project state does not match its recorded Orchestrator port.');
  const port = state.orchestratorPort;
  return { port };
}

function requestTarget(port: number, path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid Orchestrator request path.');
  const target = new URL(path, `http://127.0.0.1:${port}`);
  if (target.origin !== `http://127.0.0.1:${port}`) throw new Error('Invalid Orchestrator request origin.');
  return target;
}

async function requestOrchestrator(input: OrchestratorRequest): Promise<unknown> {
  if (!input || typeof input.projectName !== 'string' || typeof input.path !== 'string') throw new Error('Invalid Orchestrator request.');
  const { port } = await runningProject(input.projectName);
  return requestAtPort(port, input);
}

async function requestAtPort(port: number, input: Pick<OrchestratorRequest, 'path' | 'init'>): Promise<unknown> {
  const method = input.init?.method?.toUpperCase() ?? 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported Orchestrator request method.');
  const headers = Object.fromEntries(Object.entries(input.init?.headers ?? {}).filter(([key]) => /^content-type$/i.test(key)));
  const timeout = input.path === '/api/channels/weixin/login-wait' ? 125_000 : 30_000;
  const response = await fetch(requestTarget(port, input.path), { method, headers, body: input.init?.body, signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  if (!response.ok) {
    try { throw new Error((JSON.parse(text) as { error?: string }).error || `HTTP ${response.status}`); }
    catch (error) { if (error instanceof SyntaxError) throw new Error(text || `HTTP ${response.status}`); throw error; }
  }
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

async function requestControlPlane(input: Omit<OrchestratorRequest, 'projectName'>): Promise<unknown> {
  if (!input || typeof input.path !== 'string') throw new Error('Invalid control-plane request.');
  const local = await localControlPlane(input);
  if (local.handled) return local.value;
  const control = (await listProjects()).find(project => project.alive && project.port);
  if (!control?.port) throw new Error('No running project is available as the local control plane.');
  return requestAtPort(control.port, input);
}

function stopObservabilityStream(senderId: number): void {
  observabilityStreams.get(senderId)?.abort();
  observabilityStreams.delete(senderId);
}

async function subscribeObservability(event: IpcMainInvokeEvent, projectName: string): Promise<void> {
  if (typeof projectName !== 'string') throw new Error('Invalid project name.');
  stopObservabilityStream(event.sender.id);
  const controller = new AbortController();
  observabilityStreams.set(event.sender.id, controller);
  const { port } = await runningProject(projectName);
  const pump = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/observability/events`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        event.sender.send('observability:status', { projectName, connected: true });
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
        while (!controller.signal.aborted) {
          const part = await reader.read();
          if (part.done) break;
          pending += decoder.decode(part.value, { stream: true });
          let boundary: number;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (!data) continue;
            try { event.sender.send('observability:event', { projectName, event: JSON.parse(data) }); } catch { /* ignore malformed events */ }
          }
        }
      } catch {
        if (controller.signal.aborted) break;
        event.sender.send('observability:status', { projectName, connected: false });
        await new Promise(resolveWait => setTimeout(resolveWait, 3_000));
      }
    }
  };
  void pump();
}

async function projectRestartStatus(name: string): Promise<ProjectRestartStatus> {
  const phase = projectRestartPhases.get(name) ?? ProjectRestartPhaseEnum.Idle;
  if (phase !== ProjectRestartPhaseEnum.Idle && phase !== ProjectRestartPhaseEnum.Completed && phase !== ProjectRestartPhaseEnum.Failed) {
    return { availability: ProjectRestartAvailabilityEnum.AlreadyRestarting, phase, activeTaskCount: 0, projectAlive: true, message: 'Project team restart is already in progress.' };
  }
  let root: string;
  try { ({ root } = await registeredProject(name)); }
  catch { return { availability: ProjectRestartAvailabilityEnum.Unavailable, phase, activeTaskCount: 0, projectAlive: false, message: 'Project is not registered.' }; }
  const state = await readJson<OrchestratorState>(join(root, '.oat', 'state', 'orchestrator.json'));
  if (!state || !stateArgv(state)) {
    return { availability: ProjectRestartAvailabilityEnum.StartupCommandMissing, phase, activeTaskCount: 0, projectAlive: false, message: 'Start the project manually once before using restart.' };
  }
  const pidStatus = await inspectStatePid(state);
  const projectAlive = pidStatus === 'current' && validPid(state.pid);
  if (!projectAlive) {
    return { availability: ProjectRestartAvailabilityEnum.ProjectStopped, phase, activeTaskCount: 0, projectAlive: false, message: 'The project is stopped. Start it manually; restart only operates on a running project team.' };
  }
  const port = validPort(state.orchestratorPort) ? state.orchestratorPort : undefined;
  if (port && (await statePidOwnsPort(state.pid as number, port)) === false) {
    return { availability: ProjectRestartAvailabilityEnum.StaleProcessState, phase, activeTaskCount: 0, projectAlive: true, message: 'The saved project process does not own its recorded port.' };
  }
  let activeTaskCount = 0;
  try {
    const tasks = await requestOrchestrator({ projectName: name, path: '/tasks' }) as Array<{ status?: unknown }>;
    activeTaskCount = tasks.filter((task) => Object.values(ActiveTaskStatus).includes(task.status as ActiveTaskStatus)).length;
  } catch { /* the health checks below provide the actionable failure */ }
  if (activeTaskCount > 0) {
    return { availability: ProjectRestartAvailabilityEnum.ActiveTasks, phase, activeTaskCount, projectAlive: true, message: `${activeTaskCount} active task(s) must reach a checkpoint before restart.` };
  }
  const config = await readJson<Record<string, unknown>>(await projectConfigPath(name));
  const runtimeMode = config && isRecord(config.runtime) && config.runtime.mode === ProjectRuntimeMode.Docker ? ProjectRuntimeModeEnum.Docker : ProjectRuntimeModeEnum.LocalProcess;
  if (runtimeMode === ProjectRuntimeModeEnum.Docker) {
    const docker = await dockerHostStatus();
    if (!docker.installed || !docker.daemonRunning) {
      return { availability: ProjectRestartAvailabilityEnum.DockerEngineUnavailable, phase, activeTaskCount, projectAlive: true, runtimeMode, message: 'Start Docker Engine manually before restarting this project team.' };
    }
  }
  return { availability: ProjectRestartAvailabilityEnum.Ready, phase, activeTaskCount, projectAlive: true, runtimeMode };
}

async function restartProject(name: string, trigger: ProjectRestartTriggerEnum): Promise<{ ok: true; newPid?: number }> {
  if (trigger !== ProjectRestartTriggerEnum.HumanUi) throw new Error('Project restart requires an explicit human UI action.');
  const status = await projectRestartStatus(name);
  if (status.availability !== ProjectRestartAvailabilityEnum.Ready) throw new Error(status.message || `Project restart is unavailable: ${status.availability}`);
  projectRestartPhases.set(name, ProjectRestartPhaseEnum.Validating);
  try {
  const { root } = await registeredProject(name);
  const statePath = join(root, '.oat', 'state', 'orchestrator.json');
  const state = await readJson<OrchestratorState>(statePath);
  const argv = state ? stateArgv(state) : undefined;
  if (!state || !argv) throw new Error('Cannot determine this project\'s startup command.');
  const config = await readJson<Record<string, unknown>>(await projectConfigPath(name));
  if (config && isRecord(config.runtime) && config.runtime.mode === ProjectRuntimeMode.Docker) {
    const docker = await dockerHostStatus();
    if (!docker.installed) throw new Error('Docker is required by this project but is not installed. Open Docker management to review and confirm installation.');
    if (!docker.daemonRunning) throw new Error('Docker Engine is not running. Start it manually before restarting the project team.');
  }
  const pidStatus = await inspectStatePid(state);
  const port = validPort(state.orchestratorPort) ? state.orchestratorPort : undefined;
  if (pidStatus === 'current' && validPid(state.pid)) {
    if (port && (await statePidOwnsPort(state.pid, port)) === false) {
      throw new Error('The saved PID does not own this project\'s recorded Orchestrator port. Refusing to terminate it.');
    }
    projectRestartPhases.set(name, ProjectRestartPhaseEnum.Stopping);
    process.kill(state.pid, 'SIGTERM');
    projectRestartPhases.set(name, ProjectRestartPhaseEnum.WaitingForRelease);
    await waitForProjectRelease(state.pid, port);
  } else if (port && await isPortListening(port)) {
    throw new Error('A process is active on this project\'s recorded port, but its PID cannot be verified. Stop it before restarting.');
  }
  const [command, ...args] = argv;
  projectRestartPhases.set(name, ProjectRestartPhaseEnum.Starting);
  const child = spawn(command, args, { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env } });
  let launchFailure: Error | undefined;
  let launchStderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    launchStderr = `${launchStderr}${String(chunk)}`.slice(-4_000);
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', (error) => { launchFailure = error; rejectSpawn(error); });
    child.once('exit', (code, signal) => {
      const detail = launchStderr.trim();
      launchFailure = new Error(`The restarted Orchestrator exited before it became ready (${signal ? `signal ${signal}` : `code ${code ?? 1}`})${detail ? `:\n${detail}` : ''}`);
    });
  });
  if (!validPid(child.pid)) throw new Error('The restarted Orchestrator did not report a process id.');
  const newPid = child.pid;
  child.unref();
  projectRestartPhases.set(name, ProjectRestartPhaseEnum.WaitingForReady);
  const startDeadline = Date.now() + ORCHESTRATOR_START_TIMEOUT_MS;
  do {
    if (launchFailure || child.exitCode !== null || child.signalCode !== null) {
      throw launchFailure ?? new Error('The restarted Orchestrator exited before it became ready.');
    }
    const startedState = await readJson<OrchestratorState>(statePath);
    if (startedState?.pid === newPid && (await inspectStatePid(startedState)) === 'current') {
      projectRestartPhases.set(name, ProjectRestartPhaseEnum.Completed);
      return { ok: true, newPid };
    }
    await delay(200);
  } while (Date.now() < startDeadline);
  if (isPidAlive(newPid)) {
    try { process.kill(newPid, 'SIGTERM'); } catch { /* the child stopped between checks */ }
  }
  projectRestartPhases.set(name, ProjectRestartPhaseEnum.Failed);
  throw new Error('The restarted Orchestrator did not publish valid startup state before the timeout.');
  } catch (error) {
    projectRestartPhases.set(name, ProjectRestartPhaseEnum.Failed);
    throw error;
  }
}

async function validateProjectDeletion(link: string, root: string, state: OrchestratorState | undefined): Promise<void> {
  const normalizedRoot = resolve(root);
  const projectsDir = resolve(oatDataDir(), 'projects');
  const protectedPaths = [resolve('/'), resolve(homedir()), resolve(oatDataDir()), projectsDir, resolve(app.getPath('userData'))];
  if (dirname(normalizedRoot) === normalizedRoot
    || protectedPaths.some((protectedPath) => normalizedRoot === protectedPath || pathInside(normalizedRoot, protectedPath))
    || pathInside(resolve(oatDataDir()), normalizedRoot)) {
    throw new Error('Refusing to delete a broad or application-owned path.');
  }

  const linkStat = await fs.lstat(link);
  if (!linkStat.isSymbolicLink()) throw new Error('Refusing to delete a project registration that is not a symbolic link.');
  if (await fs.realpath(link) !== normalizedRoot) throw new Error('The project registration changed while it was being validated.');
  const rootStat = await fs.stat(normalizedRoot);
  if (!rootStat.isDirectory()) throw new Error('The registered project target is not a directory.');

  const oatMarker = await fs.realpath(join(normalizedRoot, '.oat')).catch(() => undefined);
  if (!oatMarker || !pathInside(normalizedRoot, oatMarker) || !(await fs.stat(oatMarker)).isDirectory()) {
    throw new Error('Refusing to delete a target without a valid project data marker.');
  }
  const stateMarker = await fs.realpath(join(normalizedRoot, '.oat', 'state', 'orchestrator.json')).catch(() => undefined);
  if (!stateMarker || !pathInside(normalizedRoot, stateMarker)) {
    throw new Error('Refusing to delete a target whose Orchestrator state marker is outside its root.');
  }
  if (!state || !stateArgv(state) || !validPort(state.orchestratorPort)) {
    throw new Error('Refusing to delete a target without valid Orchestrator state.');
  }
  const configured = typeof state.configPath === 'string' ? state.configPath : 'team.json';
  const configPath = resolve(normalizedRoot, configured);
  if (!pathInside(normalizedRoot, configPath)) throw new Error('Refusing to delete a project whose configuration is outside its root.');
  const realConfigPath = await fs.realpath(configPath).catch(() => undefined);
  const config = realConfigPath && pathInside(normalizedRoot, realConfigPath)
    ? await readJson<unknown>(realConfigPath)
    : undefined;
  if (!isRecord(config) || !isRecord(config.project) || typeof config.project.name !== 'string' || !config.project.name.trim()) {
    throw new Error('Refusing to delete a target without a valid team configuration marker.');
  }
}

async function deleteProject(name: string): Promise<{ ok: true }> {
  const { link, root } = await registeredProject(name);
  const state = await readJson<OrchestratorState>(join(root, '.oat', 'state', 'orchestrator.json'));
  await validateProjectDeletion(link, root, state);
  const port = validPort(state?.orchestratorPort) ? state.orchestratorPort : undefined;
  if (state && (await inspectStatePid(state)) === 'current') {
    throw new Error('Project is still running. Stop it before deleting it.');
  }
  if (port && await isPortListening(port)) {
    throw new Error('A process is still active on this project\'s recorded port. Stop it before deleting it.');
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.unlink(link).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  return { ok: true };
}

/** Probe a user-selected model endpoint in the main process, never the renderer. */
async function listProviderModels(input: ProviderProbe): Promise<string[]> {
  if (!input || typeof input.baseUrl !== 'string') throw new Error('Provider base URL is required.');
  let endpoint: URL;
  try {
    endpoint = new URL(input.baseUrl);
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') throw new Error('unsupported protocol');
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/models`;
    endpoint.search = ''; endpoint.hash = '';
  } catch { throw new Error('Provider base URL must use HTTP or HTTPS.'); }
  const headers = typeof input.apiKey === 'string' && input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : undefined;
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
  const data = await response.json() as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
  const entries = Array.isArray(data) ? data : data.data ?? [];
  return entries.map((entry) => entry.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1080, minHeight: 720, show: false,
    title: 'OAT',
    icon: desktopIconPath(),
    // Replace the default chrome with the renderer toolbar while preserving
    // macOS's native traffic lights (we never draw window controls ourselves).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: '#f7f6f4', symbolColor: '#2d2a26', height: 44 } }),
    webPreferences: { preload: join(dirname(fileURLToPath(import.meta.url)), '../preload/index.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: false },
  });
  win.once('ready-to-show', () => win.show());
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(rendererEntry());
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') void shell.openExternal(url);
    } catch { /* reject malformed or custom-protocol navigation */ }
    return { action: 'deny' };
  });
  const preventUntrustedNavigation = (event: Electron.Event, url: string) => { if (!isTrustedNavigationUrl(url)) event.preventDefault(); };
  win.webContents.on('will-navigate', preventUntrustedNavigation);
  win.webContents.on('will-redirect', preventUntrustedNavigation);
  win.webContents.once('destroyed', () => stopObservabilityStream(win.webContents.id));
}

app.whenReady().then(() => {
  // Keep the native app identity aligned with the product name in the Dock,
  // menu bar and window chrome (Electron otherwise uses its default name in dev).
  app.setName('OAT');
  app.setAppUserModelId(DESKTOP_APP_ID);
  if (process.platform === 'darwin') app.dock?.setIcon(desktopIconPath());
  ipcMain.handle('runtime:status', (event) => { requireTrustedRenderer(event); return getRuntimeStatus(); });
  ipcMain.handle('runtime:prepare', (event) => { requireTrustedRenderer(event); return prepareRuntime(); });
  ipcMain.handle('runtime:ensure-node', (event) => { requireTrustedRenderer(event); return ensureNodeRuntime(); });
  ipcMain.handle('runtime:ensure-oat', (event) => { requireTrustedRenderer(event); return ensureOatTool(); });
  ipcMain.handle('runtime:install', (event) => { requireTrustedRenderer(event); return ensureOat(false); });
  ipcMain.handle('runtime:update-oat', (event) => { requireTrustedRenderer(event); return ensureOat(true); });
  ipcMain.handle('updates:check', (event) => { requireTrustedRenderer(event); return checkForUpdates(); });
  ipcMain.handle('docker:install', (event, locale: unknown) => { requireTrustedRenderer(event); return confirmAndInstallDocker(event, locale); });
  ipcMain.handle('docker:status', (event) => { requireTrustedRenderer(event); return dockerHostStatus(); });
  ipcMain.handle('docker:start', (event) => { requireTrustedRenderer(event); return startDocker(); });
  ipcMain.handle('projects:list', (event) => { requireTrustedRenderer(event); return listProjects(); });
  ipcMain.handle('projects:restart-status', (event, name: string) => { requireTrustedRenderer(event); return projectRestartStatus(name); });
  ipcMain.handle('projects:restart', (event, name: string) => { requireTrustedRenderer(event); return restartProject(name, ProjectRestartTriggerEnum.HumanUi); });
  ipcMain.handle('projects:delete', (event, name: string) => { requireTrustedRenderer(event); return deleteProject(name); });
  ipcMain.handle('resource-agent:send', (event, text: string) => {
    requireTrustedRenderer(event);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Resource Manager message is required.');
    return getResourceSupervisor().send(text.trim());
  });
  ipcMain.handle('resource-agent:history', (event) => { requireTrustedRenderer(event); return getResourceSupervisor().history(); });
  ipcMain.handle('resource-agent:confirm', (event, proposalId: string) => {
    requireTrustedRenderer(event);
    if (typeof proposalId !== 'string' || !proposalId.trim()) throw new Error('Resource proposal id is required.');
    return getResourceSupervisor().confirm(proposalId);
  });
  ipcMain.handle('resource-agent:cancel', (event) => { requireTrustedRenderer(event); return getResourceSupervisor().cancel(); });
  ipcMain.handle('providers:list-models', (event, input: ProviderProbe) => { requireTrustedRenderer(event); return listProviderModels(input); });
  ipcMain.handle('orchestrator:request', (event, input: OrchestratorRequest) => { requireTrustedRenderer(event); return requestOrchestrator(input); });
  ipcMain.handle('control-plane:request', (event, input: Omit<OrchestratorRequest, 'projectName'>) => { requireTrustedRenderer(event); return requestControlPlane(input); });
  ipcMain.handle('observability:subscribe', (event, projectName: string) => { requireTrustedRenderer(event); return subscribeObservability(event, projectName); });
  ipcMain.handle('observability:unsubscribe', (event) => { requireTrustedRenderer(event); stopObservabilityStream(event.sender.id); });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => resourceSupervisor?.dispose());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
