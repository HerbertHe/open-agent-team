import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ForwardRefExoticComponent, type SVGProps } from 'react';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { IpcTaskTransport, ResourceAgentTransport, type ChatTarget } from './chat-transport';
import { useI18n, type Language } from './i18n';
import IconPanelLeftClose from '~icons/lucide/panel-left-close';
import IconPanelRightClose from '~icons/lucide/panel-right-close';
import IconRefresh from '~icons/lucide/refresh-cw';
import IconActivity from '~icons/lucide/activity';
import IconTasks from '~icons/lucide/list-todo';
import IconResources from '~icons/lucide/folder-kanban';
import IconSettings from '~icons/lucide/settings-2';
import IconCog from '~icons/lucide/settings';
import IconClose from '~icons/lucide/x';
import IconBot from '~icons/lucide/bot-message-square';
import IconFolder from '~icons/lucide/folder-git-2';
import IconFile from '~icons/lucide/file';
import IconLoader from '~icons/lucide/loader-circle';
import IconArrowUp from '~icons/lucide/arrow-up';
import IconSquare from '~icons/lucide/square';
import IconChevronDown from '~icons/lucide/chevron-down';
import IconChevronRight from '~icons/lucide/chevron-right';
import IconCrown from '~icons/lucide/crown';
import IconGripVertical from '~icons/lucide/grip-vertical';
import IconTrash2 from '~icons/lucide/trash-2';
import IconContainer from '~icons/lucide/container';
import IconGitBranch from '~icons/lucide/git-branch';
import IconBrain from '~icons/lucide/brain';
import IconSparkles from '~icons/lucide/sparkles';
import IconScrollText from '~icons/lucide/scroll-text';
import { ManagementWorkspace, NativeFeatureWorkspace, OperationsWorkspace } from './FeatureWorkspaces';
import {
  ConversationMessageRoleEnum,
  ResourceOperationStatusEnum,
  ResourceRequiredActionEnum,
  type ResourceAgentReply,
  type ResourceHistoryMessage,
} from '../../shared/resource-types';

type Agent = Project['agents'][number];
type DeliveryReport = { id: string; taskId: string; agentId: string; role: 'leader' | 'worker'; stage: 'review_submitted' | 'release_submitted'; summary: string; createdAt: string; reviewId?: string; releaseProposalId?: string; branch?: string; changedFiles?: string[]; tests?: Array<{ command: string; status: string; evidencePath?: string }>; artifactPaths?: string[] };
type Task = { id: string; targetAgentId: string; createdBy?: string; parentTaskId?: string; prompt: string; status: string; createdAt?: string; startedAt?: string; updatedAt?: string; completedAt?: string; lastProgress?: { stage?: string; message: string; at: string }; deliveryReports?: DeliveryReport[] };
type ObservabilityEvent = { ts: string; source: 'orchestrator' | 'pi'; type: string; agentId?: string; payload?: Record<string, unknown> };
type GlobalConfig = { resource_agent?: { model?: string }; logRetentionDays?: number };
type GlobalModels = { models?: Record<string, string> };
type WorkspaceEntry = { name: string; path: string; type: 'directory' | 'file' };
type WorkspaceDirectory = { kind: 'directory'; path: string; entries: WorkspaceEntry[] };
type WorkspaceFile = { kind: 'file'; path: string; size: number; content: string; binary?: boolean; truncated?: boolean };
type MemoryLevel = 'L1' | 'L2' | 'L3';
type MemoryRecord = { id: string; projectId: string; agentId: string; teamId?: string; level: MemoryLevel; kind: string; content: string; summary: string; confidence: number; salience: number; evidenceCount: number; sourceEventIds: string[]; sources?: Array<{ eventId: string; agentId?: string; role: string; eventType: string; createdAt: string }>; status: string; createdAt: string; updatedAt: string; lastConfirmedAt: string };
type DreamRun = { id: string; status: string; trigger: string; startedAt: string; completedAt?: string; processedEvents: number; createdL2: number; promotedL3: number; error?: string };
type MemoryOverview = { enabled: boolean; counts: Record<MemoryLevel, number>; pendingEvents: number; lastDream?: DreamRun; runningDream?: DreamRun; lastActivityAt?: string };
type TeamConfig = { model?: string; models?: Record<string, string>; runtime?: { mode?: 'local_process' | 'docker'; docker?: { image?: string; network?: 'none' | 'bridge' | 'host'; extra_args?: string[] }; persistence?: { state_dir?: string } }; workspace?: { git?: { remote?: string; remote_url?: string; user_name?: string; user_email?: string; push_enabled?: boolean } }; admin?: { name?: string; description?: string; model?: string }; teams?: Array<{ name: string; leader?: { name?: string; description?: string; model?: string; repos?: string[]; skills?: Array<{ names?: string[] }> }; worker?: { total?: number; model?: string; extra_skills?: Array<{ names?: string[] }> } }> };
type GitAgentStatus = { agentId: string; role: string; workspacePath: string; branch?: string; headCommit?: string; headSubject?: string; dirty: boolean; ahead: number; behind: number; mergedIntoBase: boolean; error?: string };
type GitStatus = { repository: { path: string; baseBranch: string; headCommit?: string; remote?: string; remoteUrl?: string; pushEnabled: boolean; userName?: string; userEmail?: string; identityValid: boolean }; agents: GitAgentStatus[]; reviews: Array<{ id: string; workerId: string; leaderId: string; status: string; mergeCommit?: string }>; releases: Array<{ id: string; leaderId: string; status: string; mergeCommit?: string; pushedAt?: string; pushedRemote?: string }> };
enum GitReviewStatus { Merged = 'merged' }
enum ProjectRuntimeMode { LocalProcess = 'local_process', Docker = 'docker' }
enum DockerContainerState { Running = 'running' }
type DockerStatus = { installed: boolean; daemonRunning: boolean; available: boolean; version?: string; cliVersion?: string; issue?: 'not_installed' | 'permission_denied' | 'daemon_unavailable'; error?: string; autoInstallSupported: boolean; runtimeMode: ProjectRuntimeMode; migrationLocked: boolean; configured?: { image?: string; network?: string; extraArgs: string[] }; containers: Array<{ id: string; name: string; image: string; state: string; status: string; createdAt: string; agentId: string; role: string }>; runtimeEntries: Array<{ agentId: string; role: string; containerName: string; startedAt: string; state: string; recentErrors: string[] }> };
type LogSummary = { agents: Array<{ agentId: string; files: number; bytes: number; oldestAt?: string; newestAt?: string }>; files: number; bytes: number; retentionDays: number; cleaned?: number; errors?: Array<{ file: string; error: string }> };
type Workspace = 'chat' | 'resource-agent' | 'tasks' | 'monitor' | 'docker' | 'logs' | 'usage' | 'achievements' | 'config' | 'resources' | 'plugins' | 'channels' | 'settings';

const workspaceGroups: Array<[string, Workspace[]]> = [
  ['workspace.operate', ['tasks', 'monitor', 'docker']], ['workspace.insights', ['usage', 'achievements']], ['workspace.configure', ['config', 'resources', 'plugins', 'channels', 'settings']],
];
const workspaceTitleKey: Record<Workspace, string> = { chat: 'workspace.back', 'resource-agent': 'resource.agent', tasks: 'workspace.tasks', monitor: 'workspace.monitor', docker: 'workspace.docker', logs: 'logs.title', usage: 'workspace.usage', achievements: 'workspace.achievements', config: 'workspace.config', resources: 'workspace.resources', plugins: 'workspace.plugins', channels: 'workspace.channels', settings: 'workspace.settings' };

const requestControl = <T,>(path: string, init?: { method?: string; body?: unknown }) => window.oatDesktop.requestControlPlane({ path, init: init ? { method: init.method, headers: { 'Content-Type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) } : undefined }) as Promise<T>;
const requestProject = <T,>(projectName: string, path: string, init?: { method?: string; body?: unknown }) => window.oatDesktop.requestOrchestrator({ projectName, path, init: init ? { method: init.method, headers: { 'Content-Type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) } : undefined }) as Promise<T>;

function configuredAgents(project: Project | undefined, config: TeamConfig | undefined): Agent[] {
  const live = [...(project?.agents ?? [])]; if (!config) return live;
  const agents: Agent[] = []; const fallbackStatus = project?.alive ? 'idle' : 'offline';
  const take = (matches: (agent: Agent) => boolean) => { const index = live.findIndex(matches); return index < 0 ? undefined : live.splice(index, 1)[0]; };
  const add = (liveAgent: Agent | undefined, fallback: Agent, label?: string) => agents.push({ ...(liveAgent ?? fallback), label: label || liveAgent?.label || fallback.label, status: liveAgent?.status || fallback.status });
  if (config.admin) {
    const runtimeAdmin = take((agent) => isAdminAgent(agent));
    add(runtimeAdmin, { id: 'admin', role: 'admin', label: config.admin.description || config.admin.name || 'admin', status: fallbackStatus }, config.admin.description || config.admin.name);
  }
  for (const team of config.teams ?? []) {
    const prefix = `${team.name}-`;
    const runtimeLeader = take((agent) => isLeaderAgent(agent) && agent.id.startsWith(prefix));
    add(runtimeLeader, { id: `${team.name}-lead`, role: 'leader', label: team.leader?.description || `${team.name} leader`, status: fallbackStatus }, team.leader?.description);
    const runtimeWorkers = live.filter((agent) => isWorkerAgent(agent) && agent.id.startsWith(prefix)).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const worker of runtimeWorkers) live.splice(live.indexOf(worker), 1);
    const runtimeWorkersByIndex = new Map(runtimeWorkers.map((worker) => [Number(worker.id.match(/-worker-(\d+)$/)?.[1] ?? -1), worker]));
    const highestRuntimeIndex = Math.max(-1, ...runtimeWorkersByIndex.keys());
    const workerCount = Math.max(team.worker?.total || 0, highestRuntimeIndex + 1);
    for (let index = 0; index < workerCount; index += 1) add(runtimeWorkersByIndex.get(index), { id: `${team.name}-worker-${index}`, role: 'worker', label: `${team.name} worker ${index + 1}`, status: fallbackStatus }, `${team.name} worker ${index + 1}`);
  }
  return [...agents, ...live];
}
function teamOf(agent: Agent) { return agent.role === 'admin' ? 'Admin' : agent.id.match(/^(.+?)-(?:lead|leader|worker)(?:-|$)/i)?.[1] ?? agent.role; }
function isAdminAgent(agent: Agent) { return agent.role.toLowerCase().includes('admin'); }
function isLeaderAgent(agent: Agent) { return /(?:^|[-_\s])(?:lead|leader)(?:$|[-_\s])|leader/i.test(agent.role); }
function isWorkerAgent(agent: Agent) { return agent.role.toLowerCase().includes('worker'); }
function messageText(message: UIMessage) { return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join(''); }
function eventText(event: ObservabilityEvent) {
  const payload = event.payload ?? {};
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.line === 'string') return payload.line;
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.task === 'object' && payload.task && 'prompt' in payload.task && typeof payload.task.prompt === 'string') return payload.task.prompt;
  return event.type.replace(/[._]/g, ' ');
}
function eventStage(event: ObservabilityEvent) {
  const stage = event.payload?.stage;
  return typeof stage === 'string' ? stage : event.type.replace(/[._]/g, ' ');
}
function eventSourceName(event: ObservabilityEvent) {
  return event.source === 'pi' ? 'Pi' : 'Orchestrator';
}
function taskFromEvent(event: ObservabilityEvent): Task | undefined {
  const task = event.payload?.task;
  if (!task || typeof task !== 'object' || !('id' in task) || !('targetAgentId' in task) || !('prompt' in task) || !('status' in task)) return undefined;
  return typeof task.id === 'string' && typeof task.targetAgentId === 'string' && typeof task.prompt === 'string' && typeof task.status === 'string' ? task as Task : undefined;
}
function eventTaskId(event: ObservabilityEvent) {
  const task = taskFromEvent(event);
  if (task) return task.id;
  return typeof event.payload?.taskId === 'string' ? event.payload.taskId : undefined;
}
// Project and Agent names are user data. Keep their emoji and other Unicode
// characters intact; Iconify is only for application controls and decoration.
function displayName(value: string | null | undefined) { return (value || '').trim() || 'Untitled project'; }
function MarqueeText({ value, className = '' }: { value: string; className?: string }) {
  const viewport = useRef<HTMLSpanElement>(null); const content = useRef<HTMLSpanElement>(null); const [distance, setDistance] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setDistance(Math.max(0, (content.current?.scrollWidth ?? 0) - (viewport.current?.clientWidth ?? 0)));
    measure(); const observer = new ResizeObserver(measure); if (viewport.current) observer.observe(viewport.current); return () => observer.disconnect();
  }, [value]);
  return <span ref={viewport} className={`marquee ${distance ? 'is-overflowing' : ''} ${className}`} style={{ '--marquee-distance': `${distance}px` } as CSSProperties}><span ref={content} className="marquee-content">{value}</span></span>;
}
function AgentTreeRow({ member, selected, thinking, nested = false, onSelect }: { member: Agent; selected: boolean; thinking: boolean; nested?: boolean; onSelect(): void }) {
  const isAdmin = isAdminAgent(member);
  return <button type="button" onClick={onSelect} className={`${nested ? 'w-full' : 'ml-2 w-[calc(100%-0.5rem)]'} mt-1 flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-body leading-5 ${isAdmin ? 'border-amber-300 bg-amber-50 text-oat-ink hover:bg-amber-100' : selected ? 'border-transparent bg-stone-100 text-oat-ink' : 'border-transparent hover:bg-stone-50'}`}>
    {thinking ? <IconLoader className="h-3 w-3 shrink-0 animate-spin text-oat-taupe" /> : <i className={`h-1.5 w-1.5 rounded-full ${isAdmin ? 'bg-amber-500' : member.status === 'running' ? 'bg-emerald-500' : member.status === 'failed' ? 'bg-red-500' : 'bg-amber-500'}`} />}
    {isAdmin && <IconCrown className="h-3 w-3 shrink-0 text-amber-600" />}
    <MarqueeText value={displayName(member.label || member.id)} className="min-w-0 flex-1" />
  </button>;
}
type IconComponent = ForwardRefExoticComponent<SVGProps<SVGSVGElement> & { title?: string }>;
const icons = { resources: IconResources, refresh: IconRefresh, activity: IconActivity, tasks: IconTasks, docker: IconContainer, logs: IconScrollText, memory: IconBrain, settings: IconSettings, git: IconGitBranch, workspace: IconFolder, close: IconClose, leftPanel: IconPanelLeftClose, rightPanel: IconPanelRightClose } satisfies Record<string, IconComponent>;
function IconButton({ label, icon, onClick }: { label: string; icon: keyof typeof icons; onClick(): void }) { const Icon = icons[icon]; return <button type="button" onClick={onClick} title={label} aria-label={label} className="app-no-drag grid h-8 w-8 place-items-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-oat-ink"><Icon className="h-4 w-4" aria-hidden="true" /></button>; }

export function App() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]); const [projectName, setProjectName] = useState<string>(); const [config, setConfig] = useState<TeamConfig>(); const [agentId, setAgentId] = useState<string>(); const [workspace, setWorkspace] = useState<Workspace>('chat');
  const [resourcesOpen, setResourcesOpen] = useState(true); const [detailsOpen, setDetailsOpen] = useState(true); const [prompt, setPrompt] = useState(''); const [runtime, setRuntime] = useState<RuntimeStatus>(); const [agentTasks, setAgentTasks] = useState<Task[]>([]); const [projectTasks, setProjectTasks] = useState<Task[]>([]); const [agentEvents, setAgentEvents] = useState<ObservabilityEvent[]>([]); const [resourceModel, setResourceModel] = useState(''); const [globalModelChoices, setGlobalModelChoices] = useState<string[]>([]); const [resourceModelSaving, setResourceModelSaving] = useState(false);
  const [modelSaving, setModelSaving] = useState(false); const [gitSettingsOpen, setGitSettingsOpen] = useState(false); const [workspaceBrowserOpen, setWorkspaceBrowserOpen] = useState(false); const [memoryOpen, setMemoryOpen] = useState(false);
  const [resourceReply, setResourceReply] = useState<ResourceAgentReply>();
  const project = projects.find((item) => item.name === projectName) ?? projects[0];
  const agents = useMemo(() => configuredAgents(project, config), [project, config]);
  const agent = agents.find((item) => item.id === agentId) ?? agents[0];
  const showDetails = detailsOpen && (workspace === 'chat' || workspace === 'resource-agent');
  const workspaceColumns = `${resourcesOpen ? '268px ' : ''}minmax(0, 1fr)${showDetails ? ' 390px' : ''}`;
  const isAdmin = Boolean(agent?.role.toLowerCase().includes('admin'));
  const target = useRef<ChatTarget>({ alive: false, isAdmin: false }); target.current = { projectName: project?.name, alive: Boolean(project?.alive), isAdmin, agentId: agent?.id, agentLabel: agent?.label, onTaskQueued: (task) => setAgentTasks((tasks) => [...tasks.filter((item) => item.id !== task.id), task]) };
  const transport = useMemo(() => new IpcTaskTransport(() => target.current), []);
  const resourceTransport = useMemo(() => new ResourceAgentTransport(setResourceReply), []);
  const { messages, sendMessage, status, error, stop } = useChat({ transport, throttle: 25 });
  const resourceChat = useChat({ transport: resourceTransport, throttle: 25 });
  const projectChatBusy = status === 'submitted' || status === 'streaming';
  const resourceChatBusy = resourceChat.status === 'submitted' || resourceChat.status === 'streaming';
  useEffect(() => {
    let active = true;
    void window.oatDesktop.getResourceAgentHistory().then((history: ResourceHistoryMessage[]) => {
      if (!active || resourceChat.messages.length) return;
      resourceChat.setMessages(history.map((message): UIMessage => ({
        id: message.id,
        role: message.role === ConversationMessageRoleEnum.User ? 'user' : 'assistant',
        parts: [{ type: 'text', text: message.text }],
      })));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async () => {
    const [nextProjects, nextRuntime, globalConfig, globalModels] = await Promise.all([window.oatDesktop.listProjects(), window.oatDesktop.getRuntimeStatus(), requestControl<GlobalConfig>('/api/global-config').catch((): GlobalConfig => ({})), requestControl<GlobalModels>('/api/global-models').catch((): GlobalModels => ({ models: {} }))]);
    setProjects(nextProjects); setRuntime(nextRuntime); setResourceModel(globalConfig.resource_agent?.model ?? ''); setGlobalModelChoices(Object.keys(globalModels.models ?? {}).sort()); setProjectName((selected) => selected && nextProjects.some((item) => item.name === selected) ? selected : nextProjects[0]?.name);
  }, []);
  useEffect(() => { void refresh(); const interval = window.setInterval(() => void refresh(), 12_000); return () => window.clearInterval(interval); }, [refresh]);
  useEffect(() => { if (!project?.name) { setConfig(undefined); return; } void requestControl<TeamConfig>(`/api/projects/${encodeURIComponent(project.name)}/config`).then(setConfig).catch(() => setConfig(undefined)); }, [project?.name]);
  useEffect(() => { setAgentId(undefined); }, [project?.name]);
  useEffect(() => {
    if (!project?.name || !project.alive || !agent?.id) { setAgentTasks([]); setProjectTasks([]); return; }
    let active = true;
    let interval: number | undefined;
    const load = () => void requestProject<Task[]>(project.name, '/tasks').then((tasks) => { if (active) { setProjectTasks(tasks); setAgentTasks(tasks.filter((task) => task.targetAgentId === agent.id && (task.status === 'queued' || task.status === 'running'))); } }).catch(() => { if (active) { setAgentTasks([]); setProjectTasks([]); if (interval) window.clearInterval(interval); } });
    load(); interval = window.setInterval(load, 6_000); return () => { active = false; if (interval) window.clearInterval(interval); };
  }, [project?.name, project?.alive, agent?.id]);
  useEffect(() => {
    setAgentEvents([]);
    if (!project?.name || !project.alive || !agent?.id) return;
    let active = true;
    const unsubscribe = window.oatDesktop.onObservabilityEvent(({ projectName: eventProject, event }) => {
      if (!active || eventProject !== project.name || !event || typeof event !== 'object') return;
      const next = event as ObservabilityEvent;
      if (next.agentId !== agent.id) return;
      const nextTask = taskFromEvent(next);
      if (nextTask) setProjectTasks((tasks) => [...tasks.filter((task) => task.id !== nextTask.id), nextTask]);
      if (next.type === 'task.completed' || next.type === 'task.failed') {
        const taskId = typeof next.payload?.task === 'object' && next.payload.task && 'id' in next.payload.task && typeof next.payload.task.id === 'string' ? next.payload.task.id : undefined;
        setAgentTasks((tasks) => taskId ? tasks.filter((task) => task.id !== taskId) : tasks.filter((task) => task.status === 'queued' || task.status === 'running'));
        void refresh();
      }
      setAgentEvents((events) => {
        const updated = next.type === 'pi.message_update' ? [...events.filter((item) => item.type !== 'pi.message_update'), next] : [...events, next];
        return updated.slice(-80);
      });
    });
    void window.oatDesktop.subscribeObservability(project.name);
    return () => { active = false; unsubscribe(); void window.oatDesktop.unsubscribeObservability(); };
  }, [project?.name, project?.alive, agent?.id, refresh]);
  const submit = (event: React.FormEvent) => { event.preventDefault(); const value = prompt.trim(); if (!value) return; setPrompt(''); void sendMessage({ text: value }); };
  const reorderAdminQueue = async (taskIds: string[]) => {
    if (!project?.name || !agent?.id) return;
    const before = agentTasks;
    const byId = new Map(agentTasks.map((task) => [task.id, task]));
    setAgentTasks((tasks) => [...tasks.filter((task) => task.status !== 'queued'), ...taskIds.map((id) => byId.get(id)).filter((task): task is Task => Boolean(task))]);
    try {
      const next = await requestProject<Task[]>(project.name, '/tasks/reorder', { method: 'POST', body: { targetAgentId: agent.id, taskIds } });
      setAgentTasks(next.filter((task) => task.targetAgentId === agent.id));
    } catch (reason) { setAgentTasks(before); }
  };
  const deleteAdminTask = async (taskId: string) => {
    if (!project?.name) return;
    const before = agentTasks;
    setAgentTasks((tasks) => tasks.filter((task) => task.id !== taskId));
    try { await requestProject(project.name, `/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }); }
    catch { setAgentTasks(before); }
  };
  const updateAgentModel = async (model: string) => {
    if (!project?.name || !agent || !config || modelSaving) return;
    const next = structuredClone(config);
    if (isAdminAgent(agent)) next.admin = { ...next.admin, model };
    else {
      const team = next.teams?.find((item) => item.name === teamOf(agent));
      if (!team) return;
      if (isWorkerAgent(agent)) team.worker = { ...team.worker, model };
      else team.leader = { ...team.leader, model };
    }
    setModelSaving(true);
    try { await requestControl(`/api/projects/${encodeURIComponent(project.name)}/config`, { method: 'PUT', body: next }); setConfig(next); }
    finally { setModelSaving(false); }
  };
  const updateResourceModel = async (model: string) => {
    if (resourceModelSaving) return;
    const previous = resourceModel;
    setResourceModel(model); setResourceModelSaving(true);
    try { await requestControl('/api/global-config', { method: 'PUT', body: { resource_agent: { model } } }); }
    catch { setResourceModel(previous); }
    finally { setResourceModelSaving(false); }
  };
  const confirmResourceProposal = async (proposalId: string) => {
    const reply = await window.oatDesktop.confirmResourceProposal(proposalId);
    setResourceReply(reply);
    await refresh();
  };
  return <div className="desktop-shell flex min-h-screen flex-col bg-oat-canvas text-oat-ink"><header className="app-drag flex h-11 shrink-0 items-center border-b border-oat-line bg-white/90 pl-20 pr-3"><div className="flex min-w-0 flex-1 items-center gap-1"><IconButton label={resourcesOpen ? t('header.collapseResources') : t('header.showResources')} icon="leftPanel" onClick={() => setResourcesOpen((open) => !open)} /><IconButton label={t('header.refresh')} icon="refresh" onClick={() => void refresh()} /><span className="ml-2 truncate text-xs font-medium">{workspace === 'resource-agent' ? t('resource.agent') : displayName(project?.projectName || project?.name)}</span></div><div className="flex items-center gap-1"><IconButton label={t('workspace.tasks')} icon="tasks" onClick={() => setWorkspace('tasks')} /><IconButton label={t('workspace.monitor')} icon="activity" onClick={() => setWorkspace('monitor')} /><IconButton label={t('workspace.docker')} icon="docker" onClick={() => setWorkspace('docker')} />{agent && (isAdminAgent(agent) || isLeaderAgent(agent)) && <IconButton label={t('memory.open')} icon="memory" onClick={() => setMemoryOpen(true)} />}{agent && <IconButton label={t('workspaceFiles.open')} icon="workspace" onClick={() => setWorkspaceBrowserOpen(true)} />}<IconButton label={t('git.configure')} icon="git" onClick={() => setGitSettingsOpen(true)} /><IconButton label={t('workspace.config')} icon="settings" onClick={() => setWorkspace('config')} />{(workspace === 'chat' || workspace === 'resource-agent') && <IconButton label={detailsOpen ? t('header.collapseDetails') : t('header.showDetails')} icon="rightPanel" onClick={() => setDetailsOpen((open) => !open)} />}</div></header><div className="desktop-grid grid min-h-0 flex-1" style={{ gridTemplateColumns: workspaceColumns }}>
    <aside className={`desktop-rail flex min-h-0 flex-col overflow-hidden border-r border-oat-line bg-white ${resourcesOpen ? '' : 'hidden'}`}>
      <section className="agent-tree oat-scrollbar min-h-0 flex-1 overflow-auto p-3">
        <div className="mb-3 text-xs font-semibold tracking-normal text-stone-500">{t('resource.title')}</div>
        <button onClick={() => setWorkspace('resource-agent')} className={`mb-5 flex w-full items-center gap-2 rounded-xl border p-3 text-left ${workspace === 'resource-agent' ? 'border-oat-taupe bg-[#ece9e4] text-oat-ink shadow-sm' : 'border-oat-line hover:bg-stone-50'}`}>
          <span className={`grid h-8 w-8 place-items-center rounded-lg text-white ${workspace === 'resource-agent' ? 'bg-oat-taupe' : 'bg-oat-ink'}`}>{resourceChatBusy ? <IconLoader className="h-4 w-4 animate-spin" /> : <IconBot className="h-4 w-4" />}</span>
          <span className="min-w-0 flex-1"><strong className="block text-body font-semibold">{t('resource.agent')}</strong><small className="block truncate text-xs leading-4 text-stone-500">{resourceChatBusy ? t('resource.thinking') : t('resource.history')}</small></span>
        </button>
        <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold tracking-normal text-stone-500"><IconFolder className="h-3.5 w-3.5" />{t('resource.projects')}</div>
        {projects.map((item) => {
          const members = configuredAgents(item, item.name === project?.name ? config : undefined);
          const admins = members.filter(isAdminAgent);
          const leaders = members.filter(isLeaderAgent);
          const workers = members.filter(isWorkerAgent);
          const leaderTeams = new Set(leaders.map(teamOf));
          const orphanWorkers = workers.filter((member) => !leaderTeams.has(teamOf(member)));
          const otherMembers = members.filter((member) => !isAdminAgent(member) && !isLeaderAgent(member) && !isWorkerAgent(member));
          const select = (member: Agent) => { setProjectName(item.name); setAgentId(member.id); setWorkspace('chat'); };
          const row = (member: Agent, nested = false) => <AgentTreeRow key={member.id} member={member} nested={nested} selected={agent?.id === member.id && project?.name === item.name} thinking={projectChatBusy && item.name === project?.name && member.id === agent?.id} onSelect={() => select(member)} />;
          return <details key={item.name} open={item.name === project?.name} className="mb-2">
            <summary onClick={() => setProjectName(item.name)} className={`rounded-lg border px-2 py-2 text-body leading-5 font-semibold ${item.name === project?.name ? 'border-stone-300 bg-stone-100' : 'border-transparent hover:bg-stone-50'}`}>
              <IconChevronRight className="project-chevron mr-1 inline-block h-4 w-4 align-[-3px] text-stone-500" /><i className={`mr-1.5 inline-block h-2 w-2 rounded-full ${item.alive ? 'bg-emerald-500' : 'bg-stone-300'}`} />{displayName(item.projectName || item.name)}<span className="float-right text-xs font-normal text-stone-400">{members.length}</span>
            </summary>
            <button type="button" onClick={() => { setProjectName(item.name); setWorkspace('tasks'); }} className={`mt-1 flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-body leading-5 ${workspace === 'tasks' && item.name === project?.name ? 'bg-stone-100 text-oat-ink' : 'text-stone-600 hover:bg-stone-50'}`}><IconTasks className="h-3.5 w-3.5" />{t('taskPanel.title')}</button>
            {admins.map((member) => row(member))}
            {leaders.map((leader) => {
              const teamWorkers = workers.filter((worker) => teamOf(worker) === teamOf(leader));
              return <div key={leader.id}>{row(leader)}{teamWorkers.length > 0 && <div className="ml-5 border-l border-stone-200 pl-1.5">{teamWorkers.map((worker) => row(worker, true))}</div>}</div>;
            })}
            {orphanWorkers.map((member) => row(member))}
            {otherMembers.map((member) => row(member))}
          </details>;
        })}
        {!projects.length && <p className="p-2 text-xs text-stone-500">{t('resource.noProjects')}</p>}
      </section>
      <div className="flex items-center justify-between border-t border-oat-line p-3 text-xs text-stone-500"><span className="flex items-center gap-2"><i className={`h-2 w-2 rounded-full ${runtime?.oat.installed ? 'bg-emerald-500' : 'bg-amber-500'}`} />{runtime?.oat.installed ? t('app.ready') : t('app.setup')}</span><span className="flex items-center gap-1"><IconButton label={t('logs.open')} icon="logs" onClick={() => setWorkspace('logs')} /><button type="button" onClick={() => setWorkspace('settings')} title={t('app.settings')} aria-label={t('app.settings')} className="grid h-7 w-7 place-items-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-oat-ink"><IconCog className="h-4 w-4" /></button></span></div>
    </aside>
    <main className="flex min-w-0 flex-col overflow-hidden">{workspace === 'chat' ? <ChatWorkspace project={project} agent={agent} config={config} modelChoices={globalModelChoices} canMessage={isAdmin} messages={messages} tasks={projectTasks} events={agentEvents} prompt={prompt} status={status} error={error} onPrompt={setPrompt} onSubmit={submit} onStop={stop} onWorkspace={setWorkspace} onReorderQueue={reorderAdminQueue} onDeleteTask={deleteAdminTask} onConfigureModel={updateAgentModel} modelSaving={modelSaving} /> : workspace === 'resource-agent' ? <ResourceAgentWorkspace messages={resourceChat.messages} status={resourceChat.status} error={resourceChat.error} onSend={resourceChat.sendMessage} onStop={resourceChat.stop} model={resourceModel} modelChoices={globalModelChoices} onConfigureModel={updateResourceModel} modelSaving={resourceModelSaving} reply={resourceReply} onConfirmProposal={confirmResourceProposal} /> : workspace === 'tasks' || workspace === 'monitor' ? <OperationsWorkspace kind={workspace} project={project} onBack={() => setWorkspace('chat')} onProjectsChanged={refresh} /> : workspace === 'docker' ? <DockerWorkspace project={project} onBack={() => setWorkspace('chat')} /> : workspace === 'logs' ? <LogMaintenanceWorkspace project={project} onBack={() => setWorkspace('chat')} /> : workspace === 'usage' || workspace === 'achievements' || workspace === 'plugins' || workspace === 'channels' ? <NativeFeatureWorkspace kind={workspace} project={project} projects={projects} onBack={() => setWorkspace('chat')} /> : <ManagementWorkspace kind={workspace} project={project} projects={projects} selectedTeam={agent ? teamOf(agent) : undefined} onBack={() => setWorkspace('chat')} onProjectsChanged={refresh} />}</main>
    {showDetails && <aside className="desktop-rail oat-scrollbar min-h-0 overflow-auto border-l border-oat-line bg-stone-50">{workspace === 'resource-agent' ? <ResourceAgentBadge /> : <><AgentDetails project={project} agent={agent} config={config} tasks={agentTasks} allTasks={projectTasks} onWorkspace={setWorkspace} /><GitPanel project={project} agent={agent} /><DelegatedTasks agent={agent} agents={agents} tasks={projectTasks} /></>}</aside>}
  </div>{workspaceBrowserOpen && project && agent && <WorkspaceBrowserDialog project={project} agent={agent} onClose={() => setWorkspaceBrowserOpen(false)} />}{memoryOpen && project && agent && <MemoryDialog project={project} agents={agents.filter((item) => isAdminAgent(item) || isLeaderAgent(item))} initialAgentId={agent.id} onClose={() => setMemoryOpen(false)} />}{gitSettingsOpen && <GitSettingsDialog project={project} onClose={() => setGitSettingsOpen(false)} />}</div>;
}

function ResourceAgentWorkspace({ messages, status, error, onSend, onStop, model, modelChoices, onConfigureModel, modelSaving, reply, onConfirmProposal }: { messages: UIMessage[]; status: string; error?: Error; onSend(message: { text: string }): unknown; onStop(): void; model: string; modelChoices: string[]; onConfigureModel(model: string): void; modelSaving: boolean; reply?: ResourceAgentReply; onConfirmProposal(proposalId: string): Promise<void> }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const submit = (event: React.FormEvent) => { event.preventDefault(); const text = draft.trim(); if (!text) return; setDraft(''); void onSend({ text }); };
  return <><div className="oat-scrollbar flex flex-1 flex-col gap-3 overflow-auto px-[clamp(1.25rem,7vw,6rem)] py-8">{messages.length ? messages.map((message) => <article key={message.id} className={`chat-bubble max-w-[44rem] rounded-xl border border-oat-line bg-white p-3 text-sm ${message.role === 'user' ? 'self-end bg-stone-100' : ''}`}>{message.role !== 'user' && <small className="text-micro text-stone-500">{t('resource.agent')}</small>}<p className={message.role === 'user' ? 'whitespace-pre-wrap' : 'mt-1 whitespace-pre-wrap'}>{messageText(message)}</p></article>) : <div className="m-auto max-w-lg text-center text-stone-500"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-oat-ink text-white"><IconBot className="h-6 w-6" /></span><h2 className="mt-4 text-xl font-semibold text-oat-ink">{t('resource.historyTitle')}</h2><p className="mt-2">{t('resource.historyText')}</p></div>}{reply?.proposalId && reply.status === ResourceOperationStatusEnum.WaitingConfirmation && <article className="max-w-[44rem] rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm"><strong>{t('resource.confirmProposal')}</strong><p className="mt-2 text-stone-600">{t('resource.confirmProposalHint')}</p><button type="button" onClick={() => void onConfirmProposal(reply.proposalId!)} className="mt-3 rounded-lg bg-oat-ink px-3 py-2 text-xs font-semibold text-white">{t('resource.applyProposal')}</button></article>}{reply && reply.requiredAction !== ResourceRequiredActionEnum.None && <article className="max-w-[44rem] rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">{reply.text}</article>}{error && <p className="max-w-[44rem] rounded-lg bg-red-50 p-3 text-sm text-red-700">{error.message}</p>}</div><ChatComposer value={draft} onChange={setDraft} onSubmit={submit} placeholder={t('resource.placeholder')} busy={status === 'submitted' || status === 'streaming'} onStop={onStop} model={model} modelChoices={modelChoices} onConfigureModel={onConfigureModel} modelSaving={modelSaving} /></>;
}

function ChatComposer({ value, onChange, onSubmit, placeholder, busy, disabled = false, onStop, model, modelChoices = [], onConfigureModel, modelSaving = false }: { value: string; onChange(value: string): void; onSubmit(event: React.FormEvent): void; placeholder: string; busy: boolean; disabled?: boolean; onStop?(): void; model?: string; modelChoices?: string[]; onConfigureModel?(model: string): void; modelSaving?: boolean }) {
  const { t } = useI18n();
  const choices = Array.from(new Set(modelChoices));
  const registeredCurrent = Boolean(model && choices.includes(model));
  return <form onSubmit={onSubmit} className="bg-oat-canvas px-[clamp(1rem,5vw,4.5rem)] py-4"><div className="mx-auto max-w-3xl rounded-2xl border border-stone-200 bg-white p-3 shadow-[0_6px_22px_rgb(45_42_38/8%)]"><textarea value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} placeholder={placeholder} className="min-h-[4.25rem] w-full resize-none border-0 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-stone-400 disabled:cursor-not-allowed disabled:opacity-60" /><div className="mt-2 flex items-center justify-end"><div className="flex items-center gap-2">{onConfigureModel && <label title={t('chat.configureModel')} className="relative flex max-w-52 items-center text-xs text-stone-600"><span className="sr-only">{t('chat.configureModel')}</span><select value={registeredCurrent ? model : ''} disabled={modelSaving || !choices.length} onChange={(event) => onConfigureModel(event.target.value)} className="app-no-drag max-w-52 cursor-pointer appearance-none bg-transparent py-1 pl-2 pr-6 text-right outline-none hover:text-oat-ink disabled:cursor-not-allowed disabled:opacity-50">{!registeredCurrent && <option value="" disabled>{model ? `${t('chat.currentModel')}: ${model}` : t('chat.chooseModel')}</option>}{choices.length ? choices.map((choice) => <option key={choice} value={choice}>{choice}</option>) : <option value="">{t('chat.noModels')}</option>}</select><IconChevronDown className="pointer-events-none absolute right-0 h-3.5 w-3.5" /></label>}{busy && onStop ? <button type="button" title={t('chat.stop')} aria-label={t('chat.stop')} onClick={onStop} className="grid h-8 w-8 place-items-center rounded-full bg-oat-ink text-white"><IconSquare className="h-3.5 w-3.5" /></button> : <button title={t('chat.send')} aria-label={t('chat.send')} disabled={disabled || !value.trim()} className="grid h-8 w-8 place-items-center rounded-full bg-oat-ink text-white disabled:cursor-not-allowed disabled:opacity-35"><IconArrowUp className="h-4 w-4" /></button>}</div></div></div></form>;
}

function ResourceAgentBadge() { const { t } = useI18n(); return <div className="p-3"><section className="overflow-hidden rounded-2xl border border-stone-300 bg-white shadow-sm"><div className="h-9 bg-oat-ink"><div className="mx-auto h-9 w-px bg-white/30" /></div><div className="-mt-4 px-4 pb-4"><span className="grid h-14 w-14 place-items-center rounded-2xl border-4 border-white bg-oat-ink text-white shadow-sm"><IconBot className="h-6 w-6" /></span><p className="mt-3 text-micro font-bold tracking-widest text-stone-500">OPEN AGENT TEAM</p><h2 className="mt-1 text-sm font-semibold">{t('resource.agent')}</h2><p className="mt-1 text-xs text-stone-500">{t('resource.steward')}</p><div className="mt-4 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">{t('resource.historyText')}</div></div></section><div className="mt-3"><Card title={t('resource.scope')} items={[[t('agent.access'), t('resource.scopeAccess')], [t('agent.policy'), t('resource.taskPolicy')]]} /></div></div>; }

function TaskQueue({ tasks, onReorder, onDelete }: { tasks: Task[]; onReorder(taskIds: string[]): void; onDelete(taskId: string): void }) {
  const { t } = useI18n();
  const dragId = useRef<string | undefined>(undefined);
  const [overId, setOverId] = useState<string>();
  const queued = tasks.filter((task) => task.status === 'queued');
  const active = tasks.filter((task) => task.status !== 'queued');
  const drop = (targetId: string) => {
    const sourceId = dragId.current;
    dragId.current = undefined; setOverId(undefined);
    if (!sourceId || sourceId === targetId) return;
    const order = queued.map((task) => task.id); const from = order.indexOf(sourceId); const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, ...order.splice(from, 1)); onReorder(order);
  };
  if (!tasks.length) return null;
  return <section className="mx-auto w-full max-w-3xl rounded-2xl border border-oat-line bg-white p-2 shadow-[0_6px_22px_rgb(45_42_38/5%)]">
    {active.map((task) => <div key={task.id} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-xs"><i className={`h-2 w-2 shrink-0 rounded-full ${task.status === 'running' ? 'bg-amber-500' : task.status === 'completed' ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-red-500' : 'bg-stone-400'}`} /><span className="min-w-0 flex-1 truncate">{task.prompt}</span><span className="shrink-0 text-micro text-stone-400">{task.status}</span></div>)}
    {queued.map((task, index) => <article key={task.id} draggable onDragStart={(event) => { dragId.current = task.id; event.dataTransfer.effectAllowed = 'move'; }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOverId(task.id); }} onDrop={() => drop(task.id)} onDragEnd={() => { dragId.current = undefined; setOverId(undefined); }} className={`group flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors ${overId === task.id ? 'bg-amber-50 ring-1 ring-amber-300' : 'hover:bg-stone-50'}`}>
      <span title={t('queue.drag')} aria-label={t('queue.drag')} className="grid h-5 w-4 shrink-0 cursor-grab place-items-center text-stone-300 active:cursor-grabbing"><IconGripVertical className="h-4 w-4" /></span>
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded border border-dashed border-stone-300 text-micro text-stone-400">{index + 1}</span>
      <span className="min-w-0 flex-1 truncate" title={task.prompt}>{task.prompt}</span>
      <span className="shrink-0 text-micro text-stone-400">{t('queue.queued')}</span>
      <button type="button" onClick={() => onDelete(task.id)} title={t('queue.delete')} aria-label={t('queue.delete')} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-stone-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"><IconTrash2 className="h-3.5 w-3.5" /></button>
    </article>)}
  </section>;
}

function TasksWorkspace({ project, onBack }: { project?: Project; onBack(): void }) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>(); const [error, setError] = useState<string>();
  useEffect(() => {
    if (!project?.name || !project.alive) { setTasks([]); return; }
    let active = true;
    const load = () => void requestProject<Task[]>(project.name, '/tasks').then((next) => { if (active) { setTasks(next); setError(undefined); } }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    load(); const interval = window.setInterval(load, 3_000); return () => { active = false; window.clearInterval(interval); };
  }, [project?.name, project?.alive]);
  const tone = (status: string) => status === 'running' ? 'bg-amber-500' : status === 'review_pending' ? 'bg-violet-500' : status === 'completed' ? 'bg-emerald-500' : status === 'failed' ? 'bg-red-500' : status === 'cancelled' ? 'bg-stone-400' : 'bg-sky-500';
  const columns = [
    ['queued', t('status.queued')], ['running', t('status.running')], ['review_pending', t('status.review_pending')], ['completed', t('status.completed')], ['failed', t('status.failed')], ['cancelled', t('status.cancelled')],
  ] as const;
  // The board is a requirements view: only Admin-created root tasks are
  // top-level cards. Leader and Worker work remains linked as descendants.
  const ordered = tasks?.filter((task) => !task.parentTaskId).slice().sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''));
  const assignee = (agentId: string) => { const agent = project?.agents.find((item) => item.id === agentId); return agent ? `${displayName(project?.projectName || project?.name)} · ${teamOf(agent)} · ${agent.label || agent.id}` : `${displayName(project?.projectName || project?.name)} · ${agentId}`; };
  return <section className="oat-scrollbar min-h-0 flex-1 overflow-auto p-4"><div className="w-full"><button type="button" onClick={onBack} className="mb-4 text-sm text-stone-500 hover:text-oat-ink">← {t('workspace.back')}</button><div className="flex items-center justify-between"><div><h1 className="text-xl font-semibold">{t('taskPanel.title')}</h1><p className="mt-1 text-sm text-stone-500">{displayName(project?.projectName || project?.name)}</p></div><span className="text-xs text-stone-400">{t('taskPanel.live')}</span></div>{error ? <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : tasks === undefined ? <p className="mt-4 text-sm text-stone-500">{t('loading')}</p> : tasks.length ? <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">{columns.map(([status, title]) => { const items = ordered?.filter((task) => task.status === status) ?? []; return <section key={status} className="min-h-44 rounded-xl bg-stone-100/80 p-2"><div className="flex items-center gap-2 border-b border-stone-200 pb-2"><i className={`h-2 w-2 rounded-full ${tone(status)}`} /><h2 className="text-xs font-semibold">{title}</h2><span className="text-micro text-stone-400">{items.length}</span></div>{items.length ? <ol className="mt-2 space-y-2">{items.map((task) => <li key={task.id} className="rounded-lg border border-oat-line bg-white p-3 shadow-[0_3px_10px_rgb(45_42_38/5%)]"><div className="flex items-start gap-2"><i className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone(task.status)}`} /><div className="min-w-0 flex-1"><code className="block truncate text-micro text-stone-500">{task.id}</code><p className="mt-2 line-clamp-4 text-xs leading-5 text-oat-ink">{task.prompt}</p>{task.lastProgress && <p className="mt-2 line-clamp-3 rounded-md bg-stone-50 px-2 py-1 text-micro leading-4 text-stone-600"><span className="font-medium">{task.lastProgress.stage || t('taskPanel.progress')}：</span>{task.lastProgress.message}</p>}<p className="mt-2 truncate text-micro text-stone-400">{assignee(task.targetAgentId)}</p></div></div></li>)}</ol> : <p className="mt-2 text-xs text-stone-400">{t('taskPanel.emptyColumn')}</p>}</section>; })}</div> : <p className="mt-4 rounded-xl border border-dashed border-stone-200 p-4 text-sm text-stone-500">{t('taskPanel.empty')}</p>}</div></section>;
}

function ChatWorkspace({ project, agent, config, modelChoices, canMessage, messages, tasks, events, prompt, status, error, onPrompt, onSubmit, onStop, onWorkspace: _onWorkspace, onReorderQueue, onDeleteTask, onConfigureModel, modelSaving }: { project?: Project; agent?: Agent; config?: TeamConfig; modelChoices: string[]; canMessage: boolean; messages: UIMessage[]; tasks: Task[]; events: ObservabilityEvent[]; prompt: string; status: string; error?: Error; onPrompt(value: string): void; onSubmit(event: React.FormEvent): void; onStop(): void; onWorkspace(workspace: Workspace): void; onReorderQueue(taskIds: string[]): void; onDeleteTask(taskId: string): void; onConfigureModel(model: string): void; modelSaving: boolean }) {
  const { t } = useI18n();
  const team = agent && !isAdminAgent(agent) ? config?.teams?.find((item) => item.name === teamOf(agent)) : undefined;
  const currentModel = !agent ? undefined : isAdminAgent(agent) ? config?.admin?.model || config?.model : isWorkerAgent(agent) ? team?.worker?.model || team?.leader?.model || config?.model : team?.leader?.model || config?.model;
  const visibleMessages = messages.filter((message) => message.role === 'user' || Boolean(messageText(message).trim()));
  const taskById = new Map<string, Task>();
  for (const task of tasks) { if (task.targetAgentId === agent?.id) taskById.set(task.id, task); }
  for (const event of events) { const task = taskFromEvent(event); if (task && task.targetAgentId === agent?.id) taskById.set(task.id, task); }
  const taskHistory = [...taskById.values()].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  // Operator messages belong exclusively to the Admin conversation. Leader and
  // Worker views render only tasks explicitly assigned to that Agent.
  const unmatchedMessages = canMessage ? visibleMessages.filter((message) => message.role !== 'user' || !taskHistory.some((task) => task.prompt === messageText(message))) : [];
  const eventsForTask = (task: Task) => {
    const start = task.startedAt ?? task.createdAt ?? '';
    const end = task.completedAt ?? task.updatedAt;
    const isActive = task.status === 'running' || task.status === 'queued';
    return events.filter((event) => {
      if (eventTaskId(event) === task.id) return true;
      if (eventTaskId(event) || !start || event.ts < start) return false;
      return isActive || !end || event.ts <= end;
    });
  };
  const agentName = (agentId: string) => project?.agents.find((item) => item.id === agentId)?.label || agentId;
  return <><div className="oat-scrollbar flex flex-1 flex-col gap-4 overflow-auto px-[clamp(1.25rem,7vw,6rem)] py-8">{taskHistory.length ? taskHistory.map((task) => <Fragment key={task.id}><article className="chat-bubble self-end max-w-[44rem] rounded-xl border border-oat-line bg-stone-100 p-3 text-sm"><p className="whitespace-pre-wrap">{task.prompt}</p></article><AgentRun task={task} events={eventsForTask(task)} agentName={agentName} /></Fragment>) : !unmatchedMessages.length && <div className="m-auto text-center"><img src="/logo.svg" className="mx-auto h-12 w-12" /><h2 className="mt-4 text-lg font-semibold text-oat-ink">{canMessage ? t('chat.startAdmin') : t('chat.report')}</h2></div>}{unmatchedMessages.map((message) => <article key={message.id} className={`chat-bubble max-w-[44rem] rounded-xl border border-oat-line bg-white p-3 text-sm ${message.role === 'user' ? 'self-end bg-stone-100' : ''}`}>{message.role !== 'user' && <small className="text-micro text-stone-500">{t('chat.team')}</small>}<p className={message.role === 'user' ? 'whitespace-pre-wrap' : 'mt-1 whitespace-pre-wrap'}>{messageText(message)}</p></article>)}{error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error.message}</p>}</div>{canMessage && <ChatComposer value={prompt} onChange={onPrompt} onSubmit={onSubmit} placeholder={t('chat.messageAdmin')} disabled={!project?.alive || !agent} busy={status === 'submitted' || status === 'streaming'} onStop={onStop} model={currentModel} modelChoices={modelChoices} onConfigureModel={onConfigureModel} modelSaving={modelSaving} />}</>;
}

function DeliveryReportCard({ report, agentName }: { report: DeliveryReport; agentName: (agentId: string) => string }) {
  const { t } = useI18n();
  const isLeader = report.role === 'leader';
  const reference = report.releaseProposalId || report.reviewId;
  return <article className={`delivery-report-card mt-4 rounded-xl border bg-white p-4 ${isLeader ? 'is-leader' : 'is-worker'}`}>
    <header className="flex flex-wrap items-center gap-2 border-b border-stone-100 pb-3">
      <span className={`rounded-full px-2.5 py-1 text-micro font-semibold ${isLeader ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'}`}>{isLeader ? t('chat.leaderReport') : t('chat.workerReport')}</span>
      <strong className="text-xs text-oat-ink">{agentName(report.agentId)}</strong>
      <time className="ml-auto text-micro text-stone-400">{new Date(report.createdAt).toLocaleString()}</time>
    </header>
    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-oat-ink">{report.summary || t(isLeader ? 'chat.leaderReportDefault' : 'chat.workerReportDefault')}</p>
    <dl className="mt-3 grid gap-2 rounded-lg bg-stone-50 p-3 text-xs sm:grid-cols-2">
      {reference && <div className="min-w-0"><dt className="text-stone-400">{isLeader ? t('chat.releaseProposal') : t('chat.reviewRequest')}</dt><dd className="mt-0.5 truncate font-mono text-stone-700" title={reference}>{reference}</dd></div>}
      {report.branch && <div className="min-w-0"><dt className="text-stone-400">{t('chat.deliveryBranch')}</dt><dd className="mt-0.5 truncate font-mono text-stone-700" title={report.branch}>{report.branch}</dd></div>}
    </dl>
    {!!report.changedFiles?.length && <details className="mt-3 group"><summary className="flex list-none items-center gap-2 text-xs font-medium text-stone-600"><IconChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />{t('chat.changedFiles')} · {report.changedFiles.length}</summary><ul className="mt-2 space-y-1 pl-5 font-mono text-xs text-stone-500">{report.changedFiles.map((file) => <li key={file} className="break-all">{file}</li>)}</ul></details>}
    {!!report.tests?.length && <details className="mt-3 group"><summary className="flex list-none items-center gap-2 text-xs font-medium text-stone-600"><IconChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />{t('chat.testResults')} · {report.tests.length}</summary><ul className="mt-2 space-y-1.5 pl-5 text-xs">{report.tests.map((test, index) => <li key={`${test.command}:${index}`} className="flex gap-2"><span className={test.status === 'passed' ? 'text-emerald-600' : 'text-red-600'}>{test.status}</span><code className="break-all text-stone-600">{test.command}</code></li>)}</ul></details>}
    {!!report.artifactPaths?.length && <details className="mt-3 group"><summary className="flex list-none items-center gap-2 text-xs font-medium text-stone-600"><IconChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />{t('chat.artifacts')} · {report.artifactPaths.length}</summary><ul className="mt-2 space-y-1 pl-5 font-mono text-xs text-stone-500">{report.artifactPaths.map((artifact) => <li key={artifact} className="break-all">{artifact}</li>)}</ul></details>}
  </article>;
}

function AgentRun({ events, task, agentName }: { events: ObservabilityEvent[]; task: Task; agentName: (agentId: string) => string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const reply = [...events].reverse().find((event) => event.type === 'report_progress' && ['user_response', 'done'].includes(String(event.payload?.stage)) && typeof event.payload?.message === 'string');
  const processEvents = events.filter((event) => event.type === 'report_progress' || event.type === 'pi.message_update' || event.type === 'pi.process.log' || event.type === 'pi.local.log' || event.type.startsWith('task.') || event.type.startsWith('pi.command.'));
  const latestThought = [...processEvents].reverse().find((event) => event !== reply);
  const startedAt = task.startedAt ?? task.createdAt ?? processEvents[0]?.ts;
  const running = ['running', 'queued', 'waiting', 'review_pending'].includes(task.status);
  const finishedAt = task.completedAt ?? task.updatedAt;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running, task.id]);
  const elapsedEnd = running ? now : finishedAt ? new Date(finishedAt).getTime() : now;
  const elapsed = startedAt ? Math.max(0, Math.round((elapsedEnd - new Date(startedAt).getTime()) / 1000)) : 0;
  const formatElapsed = (totalSeconds: number) => {
    const days = Math.floor(totalSeconds / 86_400); const hours = Math.floor(totalSeconds % 86_400 / 3_600); const minutes = Math.floor(totalSeconds % 3_600 / 60); const seconds = totalSeconds % 60;
    if (days) return `${days}${t('time.day')} ${hours}${t('time.hour')}`;
    if (hours) return `${hours}${t('time.hour')} ${minutes}${t('time.minute')}`;
    if (minutes) return `${minutes}${t('time.minute')} ${seconds}${t('time.second')}`;
    return `${seconds}${t('time.second')}`;
  };
  return <section className="mx-auto w-full max-w-3xl text-sm"><div className="flex items-center gap-2 border-b border-oat-line pb-2 text-xs text-stone-500"><i className={`h-2 w-2 rounded-full ${running ? 'bg-amber-500' : 'bg-emerald-500'}`} />{running ? t('chat.processing') : t('chat.processed')} {formatElapsed(elapsed)}</div>{reply && <article className="mt-4"><p className="whitespace-pre-wrap leading-6 text-oat-ink">{reply.payload?.message as string}</p></article>}{task.deliveryReports?.map((report) => <DeliveryReportCard key={report.id} report={report} agentName={agentName} />)}<details className="mt-4 group"><summary className="flex min-w-0 list-none items-center gap-2 text-xs text-stone-500"><IconChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" /><span className="shrink-0">{t('chat.thinking')}</span>{latestThought && <span className="min-w-0 truncate text-stone-400"><span className="mr-1.5 font-medium text-stone-500">{eventSourceName(latestThought)} · {eventStage(latestThought)}</span>{eventText(latestThought)}</span>}</summary><div className="mt-2 space-y-1.5 pl-5 text-xs leading-5 text-stone-500">{processEvents.slice(-8).map((event, index) => <p key={`${event.ts}:${event.type}:${index}`} className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-stone-400">↳</span><span className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-medium ${event.source === 'pi' ? 'bg-blue-50 text-blue-700' : 'bg-stone-100 text-stone-600'}`}>{eventSourceName(event)}</span><span className="max-w-36 shrink-0 truncate text-micro text-stone-400" title={event.type}>{eventStage(event)}</span><span className="min-w-0 truncate">{eventText(event)}</span></p>)}</div></details></section>;
}

function AgentDetails({ project, agent, config, tasks, allTasks, onWorkspace }: { project?: Project; agent?: Agent; config?: TeamConfig; tasks: Task[]; allTasks: Task[]; onWorkspace(workspace: Workspace): void }) {
  const { t } = useI18n();
  if (!agent) return <div className="m-3 rounded-xl border border-oat-line bg-white p-4 text-sm"><strong>{t('agent.none')}</strong><p className="mt-2 text-stone-500">{t('agent.choose')}</p></div>;
  const team = config?.teams?.find((item) => item.name === teamOf(agent)); const isWorker = agent.role === 'worker'; const isAdmin = agent.role.toLowerCase().includes('admin'); const skills = isWorker ? team?.worker?.extra_skills : team?.leader?.skills;
  const active = tasks.find((task) => task.status === 'running'); const complete = tasks.filter((task) => ['completed', 'failed', 'cancelled'].includes(task.status)).length; const busy = agent.status === 'running' || Boolean(active); const stateKey = agent.status === 'failed' ? 'status.attention' : !project?.alive ? 'status.offline' : busy ? 'status.busy' : 'status.available'; const stateTone = stateKey === 'status.busy' ? 'bg-amber-500' : stateKey === 'status.available' ? 'bg-emerald-500' : stateKey === 'status.attention' ? 'bg-red-500' : 'bg-stone-400'; const progress = tasks.length ? Math.round((complete / tasks.length) * 100) : 0; const queue = tasks.slice(0, 3);
  return <div className="space-y-3 p-3"><section className="overflow-hidden rounded-2xl border border-stone-300 bg-white shadow-sm"><div className="h-9 bg-oat-ink"><div className="mx-auto h-9 w-px bg-white/30" /></div><div className="-mt-4 px-4 pb-4"><div className="grid h-14 w-14 place-items-center rounded-2xl border-4 border-white bg-oat-taupe shadow-sm"><img src="/logo.svg" className="h-8 w-8" /></div><div className="mt-3"><p className="text-micro font-bold tracking-widest text-stone-500">OPEN AGENT TEAM</p><h2 className="mt-1 break-words text-sm font-semibold">{agent.label || agent.id}</h2><p className="mt-1 text-xs text-stone-500">{agent.role} · {isAdmin ? t('agent.inbox') : t('agent.reportOnly')}</p></div><div className="mt-4 flex items-center justify-between rounded-lg bg-stone-50 px-3 py-2"><span className="flex items-center gap-2 text-xs font-medium"><i className={`h-2 w-2 rounded-full ${stateTone}`} />{t(stateKey)}</span><span className="text-micro text-stone-500">{tasks.length} {t('agent.tasks')}</span></div></div></section><section className="rounded-xl border border-oat-line bg-white p-3"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold">{isAdmin ? t('agent.taskProgress') : t('agent.workQueue')}</h3><span className="text-xs text-stone-500">{complete}/{tasks.length}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100"><div className="h-full rounded-full bg-oat-taupe transition-all" style={{ width: `${progress}%` }} /></div>{isAdmin ? <><p className="mt-3 text-xs leading-5 text-stone-600">{active ? active.prompt : tasks.find((task) => task.status === 'queued')?.prompt || t('agent.noTask')}</p><p className="mt-2 text-micro text-stone-500">{active ? t('agent.executing') : tasks.some((task) => task.status === 'queued') ? t('agent.queued') : t('agent.awaiting')}</p></> : queue.length ? <ol className="mt-3 space-y-2">{queue.map((task) => <li key={task.id} className="flex min-w-0 items-center gap-2 text-xs"><i className={`h-1.5 w-1.5 shrink-0 rounded-full ${task.status === 'running' ? 'bg-amber-500' : task.status === 'failed' ? 'bg-red-500' : task.status === 'completed' ? 'bg-emerald-500' : 'bg-stone-400'}`} /><span className="flex-1 truncate text-stone-700">{task.prompt}</span><span className="shrink-0 text-micro text-stone-400">{t(`status.${task.status}`)}</span></li>)}</ol> : <p className="mt-3 text-xs text-stone-500">{t('agent.noQueue')}</p>}</section><div><Card title={t('agent.allowed')} items={[[t('agent.project'), project?.projectName || project?.name || '—'], [t('agent.model'), (isWorker ? team?.worker?.model : team?.leader?.model) || t('agent.defaultModel')], [t('agent.workspace'), project?.root || '—'], [t('agent.repositories'), team?.leader?.repos?.join(', ') || t('agent.projectWorkspace')], [t('agent.skills'), skills?.flatMap((skill) => skill.names || []).join(', ') || t('agent.noSkills')]]} /></div><div><Card title={t('agent.policy')} items={[[t('agent.access'), isAdmin ? t('agent.adminAccess') : t('agent.readOnlyAccess')]]} /></div></div>;
}
function DelegatedTasks({ agent, agents, tasks }: { agent?: Agent; agents: Agent[]; tasks: Task[] }) {
  const { t } = useI18n();
  const delegated = agent ? tasks.filter((task) => task.createdBy === agent.id).slice(-5).reverse() : [];
  if (!agent || !delegated.length) return null;
  const nameOf = (agentId: string) => agents.find((item) => item.id === agentId)?.label || agentId;
  return <section className="mx-3 mb-3 rounded-xl border border-oat-line bg-white p-3"><h3 className="text-xs font-semibold">{t('agent.delegated')}</h3><p className="mt-1 text-micro text-stone-500">{t('agent.delegatedHint')}</p><ol className="mt-3 space-y-2">{delegated.map((task) => <li key={task.id} className="rounded-lg bg-stone-50 px-2 py-2"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium text-stone-700">{nameOf(task.targetAgentId)}</span><span className="shrink-0 text-micro text-stone-400">{t(`status.${task.status}`)}</span></div><p className="mt-1 truncate text-micro text-stone-500">{task.prompt}</p></li>)}</ol></section>;
}

function GitPanel({ project, agent }: { project?: Project; agent?: Agent }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatus>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!project?.name || !project.alive) { setStatus(undefined); return; }
    try {
      const next = await requestProject<GitStatus>(project.name, '/git/status');
      setStatus(next); setError(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [project?.name, project?.alive]);
  useEffect(() => { void load(); if (!project?.alive) return; const interval = window.setInterval(() => void load(), 6_000); return () => window.clearInterval(interval); }, [load, project?.alive]);
  const short = (value?: string) => value ? value.slice(0, 8) : '—';
  const branch = status?.agents.find((item) => item.agentId === agent?.id);
  return <section className="mx-3 mb-3 rounded-xl border border-oat-line bg-white p-3">
    <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold">{agent?.label || agent?.id || t('agent.none')} · 分支</h3><button type="button" onClick={() => void load()} className="rounded-md p-1 text-stone-500 hover:bg-stone-100" title={t('git.refresh')} aria-label={t('git.refresh')}><IconRefresh className="h-3.5 w-3.5" /></button></div>
    {!project?.alive ? <p className="mt-2 text-xs text-stone-500">{t('git.startProject')}</p> : !status ? <p className="mt-2 text-xs text-stone-500">{error || t('loading')}</p> : !branch ? <p className="mt-2 text-xs text-stone-500">当前 Agent 暂无分支信息。</p> : <article className="mt-3 rounded-lg bg-stone-50 p-2"><div className="flex items-center justify-between gap-2"><strong className="truncate text-xs text-stone-700">{branch.branch || '—'}</strong><code className="shrink-0 text-micro text-stone-500">{short(branch.headCommit)}</code></div><p className="mt-1 truncate text-micro text-stone-400">{branch.headSubject || branch.error || '—'}</p><div className="mt-2 flex gap-2 text-micro"><span className={branch.dirty ? 'text-amber-700' : 'text-emerald-700'}>{branch.dirty ? t('git.dirty') : t('git.clean')}</span><span className="text-stone-500">↑{branch.ahead} ↓{branch.behind}</span><span className={branch.mergedIntoBase ? 'text-emerald-700' : 'text-stone-400'}>{branch.mergedIntoBase ? t('git.merged') : t('git.notMerged')}</span></div></article>}
  </section>;
}

function WorkspaceBrowserDialog({ project, agent, onClose }: { project: Project; agent: Agent; onClose(): void }) {
  const { t } = useI18n();
  const [directory, setDirectory] = useState<WorkspaceDirectory>();
  const [file, setFile] = useState<WorkspaceFile>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestSequence = useRef(0);
  const requestEntry = useCallback(async (entryPath: string) => {
    const sequence = ++requestSequence.current;
    setLoading(true); setError(undefined);
    try {
      const result = await requestProject<WorkspaceDirectory | WorkspaceFile>(project.name, `/workspace/${encodeURIComponent(agent.id)}/files?path=${encodeURIComponent(entryPath)}`);
      if (sequence !== requestSequence.current) return;
      if (result.kind === 'directory') { setDirectory(result); setFile(undefined); }
      else setFile(result);
    } catch (reason) {
      if (sequence === requestSequence.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [agent.id, project.name]);
  useEffect(() => {
    setDirectory(undefined); setFile(undefined); setError(undefined);
    if (project.alive) void requestEntry('');
  }, [agent.id, project.alive, project.name, requestEntry]);
  const segments = directory?.path ? directory.path.split('/').filter(Boolean) : [];
  const breadcrumbs = [{ label: t('workspaceFiles.root'), path: '' }, ...segments.map((segment, index) => ({ label: segment, path: segments.slice(0, index + 1).join('/') }))];
  const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="workspace-browser-title" className="workspace-browser-dialog flex h-[min(720px,calc(100vh-2rem))] flex-col overflow-hidden rounded-2xl border border-oat-line bg-white shadow-2xl">
      <header className="flex items-start justify-between gap-4 border-b border-oat-line px-5 py-4"><div className="min-w-0"><div className="flex items-center gap-2"><h2 id="workspace-browser-title" className="truncate text-base font-semibold">{t('workspaceFiles.title')}</h2><span className="rounded-full bg-stone-100 px-2 py-1 text-micro font-semibold text-stone-500">{t('workspaceFiles.readOnly')}</span></div><p className="mt-1 truncate text-xs text-stone-500">{agent.label || agent.id} · {project.projectName || project.name}</p></div><button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-stone-500 hover:bg-stone-100" aria-label={t('docker.close')}><IconClose className="h-4 w-4" /></button></header>
      {!project.alive ? <div className="m-auto text-sm text-stone-500">{t('workspaceFiles.startProject')}</div> : <><nav className="flex min-h-11 items-center gap-1 overflow-x-auto border-b border-oat-line bg-stone-50 px-4 text-xs">{breadcrumbs.map((crumb, index) => <Fragment key={crumb.path || '/'}><button type="button" onClick={() => void requestEntry(crumb.path)} className="max-w-48 truncate rounded px-2 py-1 text-stone-600 hover:bg-white hover:text-oat-ink">{crumb.label}</button>{index < breadcrumbs.length - 1 && <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-stone-300" />}</Fragment>)}</nav>
      <div className="workspace-browser-body grid min-h-0 flex-1"><aside className="oat-scrollbar min-h-0 min-w-0 overflow-auto border-r border-oat-line p-2">{loading && !directory ? <p className="p-3 text-xs text-stone-400">{t('loading')}</p> : directory?.entries.length ? directory.entries.map((entry) => <button type="button" key={entry.path} onClick={() => void requestEntry(entry.path)} title={entry.path} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-stone-50 ${file?.path === entry.path ? 'bg-stone-100 text-oat-ink' : 'text-stone-600'}`}>{entry.type === 'directory' ? <IconFolder className="h-4 w-4 shrink-0 text-amber-600" /> : <IconFile className="h-4 w-4 shrink-0 text-stone-400" />}<span className="min-w-0 flex-1 truncate">{entry.name}</span>{entry.type === 'directory' && <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-stone-300" />}</button>) : <p className="p-3 text-xs text-stone-400">{t('workspaceFiles.empty')}</p>}</aside>
        <main className="oat-scrollbar min-h-0 min-w-0 overflow-auto bg-[#fcfcfb]">{error ? <p className="m-4 rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p> : loading && file ? <p className="p-5 text-xs text-stone-400">{t('loading')}</p> : file ? <><div className="sticky top-0 flex min-w-0 items-center justify-between gap-4 border-b border-oat-line bg-white/95 px-4 py-3 text-xs backdrop-blur"><code className="min-w-0 truncate text-stone-600">{file.path}</code><span className="shrink-0 text-stone-400">{formatSize(file.size)}</span></div>{file.binary ? <p className="p-5 text-sm text-stone-500">{t('workspaceFiles.binary')}</p> : file.truncated ? <p className="p-5 text-sm text-stone-500">{t('workspaceFiles.tooLarge')}</p> : <pre className="workspace-file-preview p-5 font-mono text-xs leading-5 text-stone-700">{file.content}</pre>}</> : <div className="grid h-full place-content-center text-center text-stone-400"><IconFile className="mx-auto h-8 w-8" /><p className="mt-3 text-xs">{t('workspaceFiles.selectFile')}</p></div>}</main>
      </div></>}</section>
  </div>;
}

function MemoryDialog({ project, agents, initialAgentId, onClose }: { project: Project; agents: Agent[]; initialAgentId: string; onClose(): void }) {
  const { t } = useI18n();
  const [agentId, setAgentId] = useState(initialAgentId); const [level, setLevel] = useState<MemoryLevel>('L1');
  const [overview, setOverview] = useState<MemoryOverview>(); const [items, setItems] = useState<MemoryRecord[]>([]);
  const [error, setError] = useState<string>(); const [loading, setLoading] = useState(false); const [dreaming, setDreaming] = useState(false);
  const load = useCallback(async () => {
    if (!project.alive) return;
    setLoading(true);
    try {
      const [nextOverview, nextItems] = await Promise.all([
        requestProject<MemoryOverview>(project.name, `/memory/overview?agentId=${encodeURIComponent(agentId)}`),
        requestProject<MemoryRecord[]>(project.name, `/memory?agentId=${encodeURIComponent(agentId)}&level=${level}&limit=200`),
      ]);
      setOverview(nextOverview); setItems(nextItems); setError(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [agentId, level, project.alive, project.name]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!project.alive) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [load, project.alive]);
  const dream = async () => {
    if (dreaming) return; setDreaming(true);
    try {
      const run = await requestProject<DreamRun>(project.name, '/memory/dream', { method: 'POST' });
      if (run.status === 'skipped') setError(run.error || t('memory.busy'));
      else setError(undefined);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setDreaming(false); }
  };
  const forget = async (id: string) => {
    if (!window.confirm(t('memory.forgetConfirm'))) return;
    await requestProject(project.name, `/memory/${encodeURIComponent(id)}/forget`, { method: 'POST' }); await load();
  };
  const promote = async (id: string) => { await requestProject(project.name, `/memory/${encodeURIComponent(id)}/promote`, { method: 'POST' }); await load(); };
  const formatTime = (value?: string) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
  return <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby="memory-title" className="flex h-[min(760px,calc(100vh-2rem))] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-oat-line bg-[#faf9f7] shadow-2xl">
    <header className="flex items-start justify-between gap-4 border-b border-oat-line bg-white px-5 py-4"><div><div className="flex items-center gap-2"><IconBrain className="h-5 w-5 text-oat-taupe" /><h2 id="memory-title" className="text-base font-semibold">{t('memory.title')}</h2></div><p className="mt-1 text-xs text-stone-500">{t('memory.subtitle')}</p></div><div className="flex items-center gap-2"><button type="button" onClick={() => void dream()} disabled={dreaming || !project.alive} className="flex items-center gap-2 rounded-lg bg-oat-ink px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"><IconSparkles className={`h-3.5 w-3.5 ${dreaming ? 'animate-pulse' : ''}`} />{dreaming ? t('memory.dreaming') : t('memory.dream')}</button><button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-stone-500 hover:bg-stone-100" aria-label={t('docker.close')}><IconClose className="h-4 w-4" /></button></div></header>
    {!project.alive ? <div className="m-auto text-sm text-stone-500">{t('memory.startProject')}</div> : <><div className="grid grid-cols-4 gap-3 border-b border-oat-line p-4">{(['L1', 'L2', 'L3'] as MemoryLevel[]).map((item) => <button type="button" key={item} onClick={() => setLevel(item)} className={`rounded-xl border p-3 text-left ${level === item ? 'border-oat-taupe bg-white shadow-sm' : 'border-oat-line bg-white/60 hover:bg-white'}`}><span className="text-xs font-semibold">{item} · {t(`memory.${item.toLowerCase()}`)}</span><strong className="mt-2 block text-xl">{overview?.counts[item] ?? 0}</strong></button>)}<article className="rounded-xl border border-oat-line bg-white/60 p-3"><span className="text-xs font-semibold">{t('memory.pending')}</span><strong className="mt-2 block text-xl">{overview?.pendingEvents ?? 0}</strong></article></div>
      <div className="flex min-h-0 flex-1"><aside className="w-60 shrink-0 border-r border-oat-line bg-white p-3"><label className="text-micro font-semibold text-stone-500">{t('memory.agent')}<select value={agentId} onChange={(event) => setAgentId(event.target.value)} className="mt-2 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-oat-ink">{agents.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label><dl className="mt-5 space-y-3 text-xs"><div><dt className="text-stone-400">{t('memory.lastActivity')}</dt><dd className="mt-1 text-stone-600">{formatTime(overview?.lastActivityAt)}</dd></div><div><dt className="text-stone-400">{t('memory.lastDream')}</dt><dd className="mt-1 text-stone-600">{overview?.lastDream ? `${overview.lastDream.status} · ${formatTime(overview.lastDream.completedAt || overview.lastDream.startedAt)}` : '—'}</dd></div>{overview?.lastDream && <div><dt className="text-stone-400">{t('memory.dreamResult')}</dt><dd className="mt-1 text-stone-600">{overview.lastDream.processedEvents} / +{overview.lastDream.createdL2} L2 / +{overview.lastDream.promotedL3} L3</dd></div>}</dl><button type="button" onClick={() => void load()} className="mt-5 flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-2 text-xs text-stone-600 hover:bg-stone-50"><IconRefresh className="h-3.5 w-3.5" />{t('memory.refresh')}</button></aside>
      <main className="oat-scrollbar min-h-0 flex-1 overflow-auto p-4">
        {error && <p className="mb-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}
        {loading && !items.length ? <p className="p-4 text-sm text-stone-400">{t('loading')}</p> : items.length ? <div className="grid gap-3">{items.map((memory) => <article key={memory.id} className="rounded-xl border border-oat-line bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex items-center gap-2"><span className="rounded-full bg-stone-100 px-2 py-1 text-micro font-semibold text-stone-600">{memory.kind}</span><span className="text-micro text-stone-400">{formatTime(memory.updatedAt)}</span></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-stone-700">{memory.summary}</p></div><div className="flex shrink-0 gap-1">{memory.level === 'L2' && <button type="button" onClick={() => void promote(memory.id)} className="rounded-md border border-stone-200 px-2 py-1 text-micro text-stone-600 hover:bg-stone-50">{t('memory.promote')}</button>}<button type="button" onClick={() => void forget(memory.id)} className="rounded-md border border-red-100 px-2 py-1 text-micro text-red-600 hover:bg-red-50">{t('memory.forget')}</button></div></div>
          <div className="mt-3 flex flex-wrap gap-3 border-t border-stone-100 pt-3 text-micro text-stone-400"><span>{t('memory.confidence')} {Math.round(memory.confidence * 100)}%</span><span>{t('memory.salience')} {Math.round(memory.salience * 100)}%</span><span>{t('memory.evidence')} {memory.evidenceCount}</span><span>{t('memory.sources')} {memory.sources?.length || memory.sourceEventIds.length}</span></div>
          {(memory.sources?.length ?? 0) > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{memory.sources?.slice(0, 6).map((source) => <span key={source.eventId} title={`${source.role} · ${formatTime(source.createdAt)}`} className="rounded-md bg-stone-50 px-2 py-1 font-mono text-micro text-stone-500">{source.agentId || source.role} · {source.eventType}</span>)}</div>}
        </article>)}</div> : <div className="grid h-full place-content-center text-center text-stone-400"><IconBrain className="mx-auto h-9 w-9" /><p className="mt-3 text-sm">{t('memory.empty')}</p></div>}
      </main></div></>}</section></div>;
}

function GitSettingsDialog({ project, onClose }: { project?: Project; onClose(): void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatus>(); const [error, setError] = useState<string>(); const [saving, setSaving] = useState(false); const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ remote: '', remoteUrl: '', userName: '', userEmail: '', pushEnabled: false });
  const load = useCallback(async () => {
    if (!project?.name) return;
    try {
      if (project.alive) {
        const next = await requestProject<GitStatus>(project.name, '/git/status');
        setStatus(next); setForm({ remote: next.repository.remote ?? '', remoteUrl: next.repository.remoteUrl ?? '', userName: next.repository.userName ?? '', userEmail: next.repository.userEmail ?? '', pushEnabled: next.repository.pushEnabled });
      } else {
        const next = await requestControl<TeamConfig>(`/api/projects/${encodeURIComponent(project.name)}/config`);
        const git = next.workspace?.git;
        setStatus(undefined); setForm({ remote: git?.remote ?? '', remoteUrl: git?.remote_url ?? '', userName: git?.user_name ?? '', userEmail: git?.user_email ?? '', pushEnabled: git?.push_enabled === true });
      }
      setEditing(false); setError(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [project?.alive, project?.name]);
  useEffect(() => { void load(); }, [load]);
  const change = (next: Partial<typeof form>) => { setEditing(true); setForm((current) => ({ ...current, ...next })); };
  const save = async () => {
    if (!project?.name || saving) return;
    setSaving(true); setError(undefined);
    try {
      if (project.alive) setStatus(await requestProject<GitStatus>(project.name, '/git/config', { method: 'PUT', body: form }));
      else await requestControl(`/api/projects/${encodeURIComponent(project.name)}/git/config`, { method: 'PUT', body: form });
      setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <div className="app-no-drag fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby="git-settings-title" className="w-full max-w-lg rounded-2xl border border-oat-line bg-white p-5 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><p className="text-micro font-bold tracking-widest text-stone-400">PROJECT SETTINGS</p><h2 id="git-settings-title" className="mt-1 text-base font-semibold">{t('git.configure')}</h2><p className="mt-1 text-xs text-stone-500">{displayName(project?.projectName || project?.name)}</p></div><button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-stone-500 hover:bg-stone-100" aria-label={t('docker.close')}><IconClose className="h-4 w-4" /></button></div>{!project?.name ? <p className="mt-5 text-sm text-stone-500">{t('resource.noProjects')}</p> : <div className="mt-5"><div className="mb-4 flex items-center justify-between rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600"><span>{project.alive ? (status?.repository.remote ? `${status.repository.remote} · ${status.repository.pushEnabled ? t('git.remoteEnabled') : t('git.remoteDisabled')}` : t('git.localOnly')) : t('git.startProject')}</span>{project.alive && <span className={status?.repository.identityValid ? 'text-emerald-700' : 'text-amber-700'}>{status?.repository.identityValid ? t('git.identityValid') : t('git.identityMissing')}</span>}</div><GitConfigForm form={form} editing={editing} saving={saving} error={error} onChange={change} onSave={save} expanded /></div>}</section></div>;
}

function GitConfigForm({ form, editing, saving, error, onChange, onSave, expanded = false }: { form: { remote: string; remoteUrl: string; userName: string; userEmail: string; pushEnabled: boolean }; editing: boolean; saving: boolean; error?: string; onChange(next: Partial<{ remote: string; remoteUrl: string; userName: string; userEmail: string; pushEnabled: boolean }>): void; onSave(): Promise<void>; expanded?: boolean }) {
  const { t } = useI18n();
  const fields = <div className="mt-2 grid gap-2"><label className="grid gap-1 text-micro text-stone-500">{t('git.remoteName')}<input value={form.remote} onChange={(event) => onChange({ remote: event.target.value })} placeholder="origin" className="rounded-md border border-stone-200 px-2 py-1.5 text-xs text-oat-ink outline-none focus:border-oat-taupe" /></label><label className="grid gap-1 text-micro text-stone-500">{t('git.remoteUrl')}<input value={form.remoteUrl} onChange={(event) => onChange({ remoteUrl: event.target.value })} placeholder="git@host:owner/repo.git" className="rounded-md border border-stone-200 px-2 py-1.5 text-xs text-oat-ink outline-none focus:border-oat-taupe" /></label><div className="grid grid-cols-2 gap-2"><label className="grid gap-1 text-micro text-stone-500">{t('git.userName')}<input value={form.userName} onChange={(event) => onChange({ userName: event.target.value })} className="min-w-0 rounded-md border border-stone-200 px-2 py-1.5 text-xs text-oat-ink outline-none focus:border-oat-taupe" /></label><label className="grid gap-1 text-micro text-stone-500">{t('git.userEmail')}<input value={form.userEmail} onChange={(event) => onChange({ userEmail: event.target.value })} className="min-w-0 rounded-md border border-stone-200 px-2 py-1.5 text-xs text-oat-ink outline-none focus:border-oat-taupe" /></label></div><label className="flex items-start gap-2 text-micro text-stone-600"><input type="checkbox" checked={form.pushEnabled} onChange={(event) => onChange({ pushEnabled: event.target.checked })} className="mt-0.5" /><span>{t('git.enablePush')}<small className="mt-0.5 block text-micro text-stone-400">{t('git.adminOnly')}</small></span></label>{error && <p className="text-micro text-red-600">{error}</p>}<button type="button" onClick={() => void onSave()} disabled={saving || !editing} className="rounded-md bg-oat-ink px-3 py-1.5 text-micro font-semibold text-white disabled:opacity-40">{saving ? t('git.saving') : t('git.save')}</button></div>;
  return expanded ? fields : <details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-stone-600">{t('git.configure')}</summary>{fields}</details>;
}
function Card({ title, items }: { title: string; items: Array<[string, string]> }) { return <section className="mb-3 rounded-xl border border-oat-line bg-white p-3"><h3 className="mb-2 text-xs font-semibold">{title}</h3>{items.map(([key, value]) => <div key={key} className="border-t border-stone-100 py-2 first:border-0 first:pt-0"><dt className="text-micro text-stone-500">{key}</dt><dd className="mt-0.5 break-words text-xs">{value}</dd></div>)}</section>; }
function JsonHighlight({ value }: { value: unknown }) {
  const source = JSON.stringify(value, null, 2); const pattern = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g; const nodes: React.ReactNode[] = []; let offset = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) { if (match.index > offset) nodes.push(source.slice(offset, match.index)); const className = match[2] ? 'text-sky-700' : match[1] ? 'text-emerald-700' : match[3] ? 'text-violet-700' : 'text-amber-700'; nodes.push(<span className={className} key={`${match.index}:${match[0]}`}>{match[0]}</span>); offset = pattern.lastIndex; }
  if (offset < source.length) nodes.push(source.slice(offset));
  return <pre className="overflow-auto rounded-xl border border-oat-line bg-white p-4 font-mono text-xs leading-6 text-stone-800">{nodes}</pre>;
}
function SettingsWorkspace({ data }: { data?: unknown }) {
  const { t, language, setLanguage, theme, setTheme } = useI18n(); const [globalConfig, setGlobalConfig] = useState('{}'); const [globalModels, setGlobalModels] = useState('{}'); const [notice, setNotice] = useState<string>();
  useEffect(() => { if (!data || typeof data !== 'object') return; const value = data as { globalConfig?: unknown; globalModels?: unknown }; setGlobalConfig(JSON.stringify(value.globalConfig ?? {}, null, 2)); setGlobalModels(JSON.stringify(value.globalModels ?? {}, null, 2)); }, [data]);
  const save = async () => { try { await Promise.all([requestControl('/api/global-config', { method: 'PUT', body: JSON.parse(globalConfig) }), requestControl('/api/global-models', { method: 'PUT', body: JSON.parse(globalModels) })]); setNotice(t('settings.saved')); } catch { setNotice(t('settings.failed')); } };
  const languages: Array<[Language, string]> = [['zh-CN', '简体中文'], ['en', 'English'], ['fr', 'Français'], ['ja', '日本語']];
  return <section className="oat-scrollbar min-h-0 flex-1 overflow-auto p-6"><div className="mb-6"><h1 className="text-xl font-semibold">{t('settings.title')}</h1></div><div className="grid max-w-4xl gap-4"><section className="rounded-xl border border-oat-line bg-white p-4"><h2 className="text-sm font-semibold">{t('settings.general')}</h2><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-xs text-stone-600">{t('app.language')}<select value={language} onChange={(event) => setLanguage(event.target.value as Language)} className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-oat-ink">{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="grid gap-2 text-xs text-stone-600">{t('app.theme')}<select value={theme} onChange={(event) => setTheme(event.target.value as 'system' | 'light' | 'dark')} className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-oat-ink"><option value="system">{t('theme.system')}</option><option value="light">{t('theme.light')}</option><option value="dark">{t('theme.dark')}</option></select></label></div></section><section className="rounded-xl border border-oat-line bg-white p-4"><h2 className="text-sm font-semibold">{t('settings.globalConfig')}</h2><textarea value={globalConfig} onChange={(event) => setGlobalConfig(event.target.value)} spellCheck={false} className="mt-3 min-h-48 w-full rounded-lg border border-stone-200 bg-stone-50 p-3 font-mono text-xs leading-5 outline-none focus:border-oat-taupe" /></section><section className="rounded-xl border border-oat-line bg-white p-4"><h2 className="text-sm font-semibold">{t('settings.models')}</h2><textarea value={globalModels} onChange={(event) => setGlobalModels(event.target.value)} spellCheck={false} className="mt-3 min-h-48 w-full rounded-lg border border-stone-200 bg-stone-50 p-3 font-mono text-xs leading-5 outline-none focus:border-oat-taupe" /></section><div className="flex items-center justify-end gap-3"><span className="text-xs text-stone-500">{notice}</span><button onClick={() => void save()} className="rounded-lg bg-oat-ink px-4 py-2 text-sm font-semibold text-white">{t('settings.save')}</button></div></div></section>;
}
function LogMaintenanceWorkspace({ project, onBack }: { project?: Project; onBack(): void }) {
  const { t } = useI18n();
  const message = (key: string, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
  const [summary, setSummary] = useState<LogSummary>();
  const [retentionDays, setRetentionDays] = useState(3);
  const [busy, setBusy] = useState<'scan' | 'save' | 'cleanup'>();
  const [error, setError] = useState<string>();
  const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const scan = useCallback(async () => {
    if (!project?.name || !project.alive) return;
    setBusy('scan'); setError(undefined);
    try { const next = await requestProject<LogSummary>(project.name, '/logs/summary'); setSummary(next); setRetentionDays(next.retentionDays); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  }, [project?.alive, project?.name]);
  const saveRetention = async () => {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) { setError(t('logs.retentionInvalid')); return; }
    setBusy('save'); setError(undefined);
    try { await requestControl('/api/global-config', { method: 'PUT', body: { logRetentionDays: retentionDays } }); setSummary((current) => current ? { ...current, retentionDays } : current); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const cleanup = async () => {
    if (!project?.name || !project.alive || !window.confirm(message('logs.cleanupConfirm', { days: retentionDays }))) return;
    setBusy('cleanup'); setError(undefined);
    try { const next = await requestProject<LogSummary>(project.name, '/logs/cleanup', { method: 'POST' }); setSummary(next); setRetentionDays(next.retentionDays); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  return <section className="log-maintenance-workspace oat-scrollbar min-h-0 flex-1 overflow-auto p-6"><div className="mx-auto w-full max-w-5xl"><button onClick={onBack} className="docker-back">← {t('workspace.back')}</button><header className="log-maintenance-header"><span className="log-maintenance-icon"><IconScrollText className="h-6 w-6" /></span><div className="min-w-0 flex-1"><p className="log-maintenance-eyebrow">RUNTIME MAINTENANCE</p><h1>{t('logs.title')}</h1><p>{t('logs.subtitle')}</p></div><button type="button" onClick={() => void scan()} disabled={!project?.alive || busy === 'scan'} className="log-secondary-button">{busy === 'scan' ? t('logs.scanning') : t('logs.scan')}</button></header>{error && <p className="docker-error">{error}</p>}
    <article className="log-boundary-card"><div><h2>{t('logs.boundaryTitle')}</h2><p>{t('logs.boundaryText')}</p></div><ul><li>{t('logs.scopeRuntime')}</li><li>{t('logs.scopeMemory')}</li><li>{t('logs.scopeTask')}</li></ul></article>
    <article className="log-retention-card"><div><p className="log-maintenance-eyebrow">AUTOMATIC CLEANUP</p><h2>{t('logs.retentionTitle')}</h2><p>{t('logs.retentionText')}</p></div><div className="log-retention-controls"><label>{t('logs.retentionDays')}<input type="number" min="1" max="365" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /></label><button type="button" onClick={() => void saveRetention()} disabled={busy === 'save'} className="log-primary-button">{busy === 'save' ? t('logs.saving') : t('logs.save')}</button></div></article>
    {!project?.alive ? <p className="mt-6 text-sm text-stone-500">{t('logs.startProject')}</p> : !summary ? <article className="log-empty-state"><IconScrollText className="h-6 w-6" /><div><strong>{t('logs.readyToScan')}</strong><p>{t('logs.readyToScanText')}</p></div></article> : <><div className="log-summary-grid"><article><span>{t('logs.agentFolders')}</span><strong>{summary.agents.length}</strong></article><article><span>{t('logs.files')}</span><strong>{summary.files}</strong></article><article><span>{t('logs.totalSize')}</span><strong>{formatSize(summary.bytes)}</strong></article></div><article className="log-agent-card"><div className="log-agent-heading"><div><h2>{t('logs.agentBreakdown')}</h2><p>{t('logs.agentBreakdownText')}</p></div><button type="button" onClick={() => void cleanup()} disabled={busy === 'cleanup'} className="log-danger-button">{busy === 'cleanup' ? t('logs.cleaning') : t('logs.cleanupNow')}</button></div>{summary.cleaned !== undefined && <p className="log-cleanup-result">{message('logs.cleaned', { count: summary.cleaned })}</p>}{summary.agents.length ? <div className="log-agent-table"><div className="log-agent-row log-agent-labels"><span>{t('logs.agent')}</span><span>{t('logs.files')}</span><span>{t('logs.totalSize')}</span><span>{t('logs.latest')}</span></div>{summary.agents.map((item) => <div className="log-agent-row" key={item.agentId}><strong title={item.agentId}>{item.agentId}</strong><span>{item.files}</span><span>{formatSize(item.bytes)}</span><time>{item.newestAt ? new Date(item.newestAt).toLocaleString() : '—'}</time></div>)}</div> : <p className="log-no-files">{t('logs.none')}</p>}</article></>}</div></section>;
}

function DockerWorkspace({ project, onBack }: { project?: Project; onBack(): void }) {
  const { t, language } = useI18n();
  const [status, setStatus] = useState<DockerStatus>(); const [error, setError] = useState<string>(); const [busy, setBusy] = useState<string>(); const [logs, setLogs] = useState<{ name: string; content: string }>();
  const loading = useRef(false); const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ image: 'node:22-bookworm', network: 'bridge' as 'none' | 'bridge' | 'host', extraArgs: '--cpus=2, --memory=4g' });
  const load = useCallback(async () => {
    if (!project?.name || loading.current) return; loading.current = true;
    try {
      const next = await requestControl<DockerStatus>(`/api/projects/${encodeURIComponent(project.name)}/docker`);
      setStatus(next); setError(undefined);
      if (next.configured && !editing) setForm({ image: next.configured.image || 'node:22-bookworm', network: (next.configured.network as 'none' | 'bridge' | 'host') || 'bridge', extraArgs: next.configured.extraArgs.join(', ') });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { loading.current = false; }
  }, [project?.name, editing]);
  useEffect(() => { void load(); const interval = window.setInterval(() => void load(), 5_000); return () => window.clearInterval(interval); }, [load]);
  const saveRuntime = async () => {
    if (!project?.name || busy) return;
    if (status?.runtimeMode === ProjectRuntimeMode.LocalProcess && !window.confirm(t('docker.migrationConfirm'))) return;
    setBusy('config'); setError(undefined);
    try {
      const config = await requestControl<TeamConfig>(`/api/projects/${encodeURIComponent(project.name)}/config`);
      const next = structuredClone(config);
      next.runtime = { ...next.runtime, mode: ProjectRuntimeMode.Docker, docker: { image: form.image.trim(), network: form.network, extra_args: form.extraArgs.split(',').map((arg) => arg.trim()).filter(Boolean) } };
      await requestControl(`/api/projects/${encodeURIComponent(project.name)}/config`, { method: 'PUT', body: next });
      await window.oatDesktop.restartProject(project.name);
      setEditing(false);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const restartAgent = async (agentId: string) => {
    if (!project?.name || busy) return; setBusy(agentId); setError(undefined);
    try { await requestControl(`/api/projects/${encodeURIComponent(project.name)}/docker/agents/${encodeURIComponent(agentId)}/restart`, { method: 'POST' }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const showLogs = async (container: DockerStatus['containers'][number]) => {
    if (!project?.name) return; setBusy(`logs:${container.id}`); setError(undefined);
    try { const value = await requestControl<{ logs: string }>(`/api/projects/${encodeURIComponent(project.name)}/docker/containers/${encodeURIComponent(container.id)}/logs?tail=200`); setLogs({ name: container.name, content: value.logs }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const removeContainer = async (container: DockerStatus['containers'][number]) => {
    if (!project?.name || busy || !window.confirm(t('docker.removeConfirm'))) return; setBusy(`remove:${container.id}`); setError(undefined);
    try { await requestControl(`/api/projects/${encodeURIComponent(project.name)}/docker/containers/${encodeURIComponent(container.id)}`, { method: 'DELETE' }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const installDocker = async () => {
    if (busy) return;
    setBusy('install'); setError(undefined);
    try { await window.oatDesktop.installDocker(language); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const startDocker = async () => {
    if (busy) return; setBusy('start'); setError(undefined);
    try { await window.oatDesktop.startDocker(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const unavailableTitle = status?.issue === 'permission_denied' ? t('docker.permissionDenied') : t('docker.daemonStopped');
  const unavailableHint = status?.issue === 'permission_denied' ? t('docker.permissionDeniedHint') : t('docker.daemonStoppedHint');
  const runningContainers = status?.containers.filter((container) => container.state === DockerContainerState.Running).length ?? 0;
  return <section className="docker-workspace oat-scrollbar min-h-0 flex-1 overflow-auto p-6"><div className="mx-auto w-full max-w-6xl"><button onClick={onBack} className="docker-back">← {t('workspace.back')}</button><header className="docker-page-header"><div className="flex min-w-0 items-center gap-4"><span className="docker-brand-mark"><IconContainer className="h-6 w-6" /></span><div><p className="docker-eyebrow">DOCKER CONTROL</p><h1>{t('docker.title')}</h1><p>{t('docker.subtitle')}</p></div></div><button type="button" onClick={() => void load()} className="docker-secondary-button">{t('docker.refresh')}</button></header>
    {error && <p className="docker-error">{error}</p>}
    {!status ? <p className="mt-8 text-sm text-stone-500">{t('loading')}</p> : <div className="docker-page-content">{!status.installed ? <article className="docker-engine-banner"><div><span className="docker-banner-kicker">ENGINE REQUIRED</span><h2>{t('docker.notInstalled')}</h2><p>{t('docker.installNotice')}</p></div><div className="docker-banner-actions"><button type="button" onClick={() => void installDocker()} disabled={Boolean(busy) || !status.autoInstallSupported} className="docker-primary-button">{busy === 'install' ? t('docker.installing') : t('docker.install')}</button><a href="https://docs.docker.com/desktop/" target="_blank" rel="noreferrer">{t('docker.installGuide')} →</a></div></article> : !status.daemonRunning ? <article className="docker-engine-banner"><div><span className="docker-banner-kicker">ENGINE ACTION REQUIRED</span><h2>{unavailableTitle}</h2><p>{unavailableHint}</p></div><button type="button" onClick={() => void startDocker()} disabled={Boolean(busy)} className="docker-primary-button">{busy === 'start' ? t('docker.starting') : t('docker.start')}</button></article> : <article className="docker-engine-banner is-ready"><div><span className="docker-banner-kicker">ENGINE ONLINE</span><h2>{t('docker.available')} · Docker {status.version}</h2><p>{status.cliVersion || t('docker.subtitle')}</p></div><span className="docker-online-dot">{t('docker.available')}</span></article>}
      <div className="docker-overview-grid"><article className="docker-overview-card"><span>{t('docker.engine')}</span><strong className={status.available ? 'text-[#2496ed]' : 'text-red-600'}>{status.available ? t('docker.available') : status.installed ? unavailableTitle : t('docker.notInstalled')}</strong><small>{status.version || status.cliVersion || '—'}</small></article><article className="docker-overview-card"><span>{t('docker.runtime')}</span><strong>{status.runtimeMode === ProjectRuntimeMode.Docker ? t('docker.isolated') : t('docker.localProcess')}</strong><small>{status.migrationLocked ? t('docker.locked') : t('docker.canMigrate')}</small></article><article className="docker-overview-card"><span>{t('docker.containers')}</span><strong>{status.containers.length}</strong><small>{runningContainers} {t('docker.running')}</small></article></div>
      <article className="docker-settings-card"><div className="docker-section-heading"><div><p className="docker-eyebrow">RUNTIME CONFIGURATION</p><h2>{status.runtimeMode === ProjectRuntimeMode.Docker ? t('docker.configuration') : t('docker.migrate')}</h2><p>{status.runtimeMode === ProjectRuntimeMode.Docker ? t('docker.noDowngrade') : t('docker.migrateHint')}</p></div><span className="docker-config-badge">{status.runtimeMode === ProjectRuntimeMode.Docker ? 'DOCKER' : 'LOCAL'}</span></div><div className="docker-form-grid"><label>{t('docker.image')}<input value={form.image} onChange={(event) => { setEditing(true); setForm((value) => ({ ...value, image: event.target.value })); }} /></label><label>{t('docker.network')}<select value={form.network} onChange={(event) => { setEditing(true); setForm((value) => ({ ...value, network: event.target.value as 'none' | 'bridge' | 'host' })); }}><option value="bridge">bridge</option><option value="none">none</option><option value="host">host</option></select></label><label>{t('docker.extraArgs')}<input value={form.extraArgs} onChange={(event) => { setEditing(true); setForm((value) => ({ ...value, extraArgs: event.target.value })); }} /></label></div><p className="docker-safe-hint">{t('docker.safeArgs')}</p><button type="button" onClick={() => void saveRuntime()} disabled={busy === 'config' || !status.available || (status.runtimeMode === ProjectRuntimeMode.Docker && !editing)} className="docker-primary-button">{busy === 'config' ? t('docker.saving') : status.runtimeMode === ProjectRuntimeMode.Docker ? t('docker.saveRestart') : t('docker.migrateRestart')}</button></article>
      <article className="docker-settings-card"><div className="docker-section-heading"><div><p className="docker-eyebrow">AGENT CONTAINERS</p><h2>{t('docker.managedContainers')}</h2><p>{status.runtimeMode === ProjectRuntimeMode.Docker ? t('docker.subtitle') : t('docker.migrateToManage')}</p></div><span className="docker-container-count">{status.containers.length}</span></div>{status.containers.length ? <div className="docker-container-grid">{status.containers.map((container) => { const runtime = status.runtimeEntries.find((entry) => entry.agentId === container.agentId); const removable = !project?.alive || container.state !== DockerContainerState.Running; return <article key={container.id} className="docker-container-card"><header><div className="min-w-0"><strong>{container.agentId || container.name}</strong><span>{container.role} · {container.id}</span></div><span className={`docker-container-state ${container.state === DockerContainerState.Running ? 'is-running' : ''}`}>{container.state}</span></header><dl><div><dt>{t('docker.image')}</dt><dd title={container.image}>{container.image}</dd></div><div><dt>{t('docker.status')}</dt><dd title={container.status}>{container.status}</dd></div></dl>{runtime?.recentErrors.length ? <p className="docker-container-error">{runtime.recentErrors.at(-1)}</p> : null}<footer><button type="button" onClick={() => void showLogs(container)}>{t('docker.logs')}</button><button type="button" onClick={() => void restartAgent(container.agentId)} disabled={!container.agentId || busy === container.agentId || container.state !== DockerContainerState.Running}>{busy === container.agentId ? t('docker.restarting') : t('docker.restartAgent')}</button>{removable && <button type="button" onClick={() => void removeContainer(container)} disabled={busy === `remove:${container.id}`} className="is-danger">{t('docker.remove')}</button>}</footer></article>; })}</div> : <div className="docker-empty-state"><IconContainer className="h-5 w-5" /><span>{status.runtimeMode === ProjectRuntimeMode.Docker ? t('docker.noContainers') : t('docker.migrateToManage')}</span></div>}</article>
      {logs && <article className="docker-settings-card"><div className="docker-section-heading"><div><p className="docker-eyebrow">CONTAINER LOGS</p><h2>{logs.name}</h2></div><button onClick={() => setLogs(undefined)} className="docker-text-button">{t('docker.close')}</button></div><pre className="docker-log-output">{logs.content || t('docker.noLogs')}</pre></article>}
    </div>}
  </div></section>;
}

function SecondaryWorkspace({ workspace, data, error, onWorkspace }: { workspace: Workspace; data?: unknown; error?: string; onWorkspace(workspace: Workspace): void }) { const { t } = useI18n(); return <div className="flex min-h-0 flex-1 overflow-hidden"><nav className="oat-scrollbar min-h-0 w-44 shrink-0 overflow-auto border-r border-oat-line bg-white px-3 py-4"><button onClick={() => onWorkspace('chat')} className="mb-7 flex h-8 w-full items-center rounded-md px-2 text-left text-sm hover:bg-stone-50">← {t('workspace.back')}</button>{workspaceGroups.map(([group, pages], index) => <div key={group} className={`${index ? 'mt-6' : ''}`}><p className="mb-2 px-2 text-micro font-bold tracking-widest text-stone-500">{t(group)}</p>{pages.map((page) => <button key={page} onClick={() => onWorkspace(page)} className={`mt-1 w-full rounded px-2 py-2 text-left text-sm ${workspace === page ? 'bg-stone-100' : 'hover:bg-stone-50'}`}>{t(workspaceTitleKey[page])}</button>)}</div>)}</nav><section className="oat-scrollbar min-h-0 flex-1 overflow-auto p-6"><div className="mb-5"><h1 className="text-xl font-semibold">{t(workspaceTitleKey[workspace])}</h1></div>{error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : data === undefined ? <p className="text-sm text-stone-500">{t('loading')}</p> : <JsonHighlight value={data} />}</section></div>; }
