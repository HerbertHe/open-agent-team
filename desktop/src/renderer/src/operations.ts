import './operations.css';

/**
 * Native project operations for the desktop renderer.
 *
 * This module intentionally uses only the Orchestrator HTTP/SSE contract.  It
 * never imports, embeds, or proxies a separate web application.
 */
export type OperationProject = {
  name: string;
  root: string;
  port?: number;
  pid?: number;
  alive: boolean;
  agents: Array<{ id: string; role: string; label: string; status: string }>;
};

type GraphNode = { id: string; role: string; label: string; port?: number; teamName?: string; placeholder?: boolean; status?: 'running' | 'waiting' | 'idle' | 'failed' };
type Graph = { nodes: GraphNode[]; edges: Array<{ source: string; target: string; kind: string }> };
type TaskSnapshot = { id: string; createdAt: string; reason: string; status: string; progress?: { stage?: string; message: string; at: string }; error?: string };
type Task = { id: string; targetAgentId: string; createdBy?: string; prompt: string; conflictKey?: string; status: string; updatedAt?: string; pausedAt?: string; pauseReason?: string; recalledFromTaskId?: string; snapshots?: TaskSnapshot[]; scheduling?: { runnable: boolean; reason?: string }; lastProgress?: { stage?: string; message: string; at: string }; error?: string };
type Event = { ts: string; source: 'orchestrator' | 'pi'; type: string; agentId?: string; role?: string; payload?: Record<string, unknown> };

export type OperationsFeature = {
  setProject(project: OperationProject | undefined): void;
  setLive(enabled: boolean): void;
  refresh(): Promise<void>;
  renderTasks(): string;
  renderMonitor(): string;
  bind(root: ParentNode): void;
  dispose(): void;
};

type Options = {
  api<T>(path: string, init?: RequestInit): Promise<T>;
  notify(message: string, error?: boolean): void;
  rerender(): void;
  subscribeObservability(projectName: string): Promise<void>;
  unsubscribeObservability(): Promise<void>;
  onObservabilityEvent(listener: (payload: { projectName: string; event: unknown }) => void): () => void;
  onObservabilityStatus(listener: (payload: { projectName: string; connected: boolean }) => void): () => void;
  tr(key: string): string;
};

const esc = (value: string) => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] ?? char));
const statusClass = (status: string) => ['running', 'busy'].includes(status) ? 'busy' : ['failed', 'error'].includes(status) ? 'error' : status === 'completed' || status === 'done' ? 'done' : 'idle';
const short = (value: string, length = 72) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
const shortId = (value: string) => value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;

/** Keep high-frequency liveness chatter available for status/logs, but out of the timeline. */
function isTimelineNoise(event: Event): boolean {
  if (event.source !== 'pi') return false;
  if (event.type === 'pi.session.idle') return true;
  if (event.type === 'pi.session.status') {
    const piEvent = event.payload?.piEvent as { properties?: { status?: unknown } } | undefined;
    const status = piEvent?.properties?.status;
    if (status === 'idle' || (status && typeof status === 'object' && 'type' in status && (status as { type?: unknown }).type === 'idle')) return true;
  }
  if (/heartbeat|heart[-_.]?beat|keep[-_]?alive$/i.test(event.type)) return true;
  if (event.type === 'pi.process.log' || event.type === 'pi.local.log') {
    const line = event.payload?.line;
    return typeof line === 'string' && /heartbeat|keep[-_]?alive/i.test(line);
  }
  return false;
}

function nodeColors(role: string, status: string, placeholder?: boolean): { fill: string; stroke: string } {
  const fill = placeholder ? '#e6e6e6' : role === 'admin' ? '#f0e3ff' : role === 'leader' ? '#e1efff' : role === 'worker' ? '#e5f6de' : '#f2ede4';
  const stroke = placeholder ? '#8c8c8c' : status === 'error' ? '#c84a3b' : status === 'done' ? '#368855' : ['busy', 'tool'].includes(status) ? '#2c83c5' : status === 'instructed' ? '#79b9eb' : '#8d8270';
  return { fill, stroke };
}

function topologyStatusLabel(status: string, tr: (key: string) => string): string {
  const key = ({ running: 'status.running', waiting: 'status.waiting', idle: 'status.available', failed: 'status.failed', busy: 'status.busy', error: 'status.failed', done: 'status.completed', standby: 'status.waiting', instructed: 'status.busy', tool: 'status.busy' } as Record<string, string>)[status];
  return key ? tr(key) : status;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A small framework-free replacement for the legacy React observability hook. */
export function createOperationsFeature(options: Options): OperationsFeature {
  let project: OperationProject | undefined;
  let graph: Graph | undefined;
  let tasks: Task[] = [];
  let events: Event[] = [];
  let statuses: Record<string, string> = {};
  let connected = false;
  let live = false;
  let subscribed = false;
  let retries = 0;
  let filter = '';
  let source = 'all';
  let team = 'all';
  let latestRender = 0;
  let topologyZoom = 1;
  let topologyPan = { x: 0, y: 0 };

  const base = () => project?.alive && project.port ? `http://127.0.0.1:${project.port}` : undefined;
  const updateStatus = (event: Event) => {
    if (!event.agentId) return;
    const type = event.type;
    if (type === 'task.failed' || type.includes('.error') || type.includes('_aborted')) statuses[event.agentId] = 'error';
    else if (type === 'task.completed' || (type === 'report_progress' && event.payload?.stage === 'done')) statuses[event.agentId] = 'done';
    else if (type === 'pi.session.idle') statuses[event.agentId] = 'idle';
    else if (type === 'pi.command.executed') statuses[event.agentId] = 'tool';
    else if (type === 'admin.operator_instruction') statuses[event.agentId] = 'instructed';
    else if (type === 'task.started' || type === 'pi.process.log' || type === 'pi.local.log' || type === 'report_progress' || type.startsWith('prompt.')) statuses[event.agentId] = 'busy';
    else if (type === 'leader.task.assigned' || type === 'worker.task.dispatched') statuses[event.agentId] = 'standby';
  };
  const delayedRender = () => {
    const now = Date.now();
    if (now - latestRender < 300) return;
    latestRender = now;
    options.rerender();
  };
  const stopStream = () => {
    if (subscribed) void options.unsubscribeObservability().catch(() => undefined);
    subscribed = false; connected = false;
  };
  const connect = () => {
    if (!project || subscribed) return;
    subscribed = true;
    void options.subscribeObservability(project.name).catch(error => { subscribed = false; connected = false; options.notify(message(error), true); delayedRender(); });
  };
  const removeEventListener = options.onObservabilityEvent(({ projectName, event: rawEvent }) => {
    if (projectName !== project?.name || !rawEvent || typeof rawEvent !== 'object') return;
    const event = rawEvent as Event;
    if (event.type === 'pi.message_update' && event.agentId) {
      const old = events.map((item, index) => item.type === 'pi.message_update' && item.agentId === event.agentId ? index : -1).filter(index => index >= 0).pop();
      if (old === undefined) events.push(event); else events[old] = event;
    } else events.push(event);
    events = events.slice(-500); updateStatus(event);
    if (event.type.startsWith('task.')) void loadTasks();
    if (['worker.spawned', 'task.created', 'task.deleted', 'task.updated', 'orchestrator.ready'].includes(event.type)) void loadGraph();
    delayedRender();
  });
  const removeStatusListener = options.onObservabilityStatus(({ projectName, connected: nextConnected }) => {
    if (projectName !== project?.name) return;
    connected = nextConnected; delayedRender();
  });
  const loadGraph = async () => { graph = await options.api<Graph>('/observability/graph'); };
  const loadTasks = async () => { tasks = await options.api<Task[]>('/tasks'); };
  const refresh = async () => {
    if (!base()) { graph = undefined; tasks = []; events = []; statuses = {}; stopStream(); return; }
    try { await Promise.all([loadGraph(), loadTasks()]); } catch (error) { options.notify(message(error), true); }
    if (live && !subscribed) connect();
  };
  const setProject = (next: OperationProject | undefined) => {
    const changed = next?.name !== project?.name || next?.port !== project?.port || next?.pid !== project?.pid || next?.alive !== project?.alive;
    project = next;
    if (changed) { graph = undefined; tasks = []; events = []; statuses = {}; stopStream(); void refresh().then(options.rerender); }
  };
  const setLive = (enabled: boolean) => {
    if (live === enabled) return;
    live = enabled;
    if (!live) { stopStream(); return; }
    if (base()) void refresh().then(options.rerender);
  };
  const agentName = (agentId: string) => {
    const worker = agentId.match(/^(.*)-worker-(\d+)$/);
    if (worker) return `${worker[1]} worker ${Number(worker[2]) + 1}`;
    return graph?.nodes.find((node) => node.id === agentId)?.label || project?.agents.find((agent) => agent.id === agentId)?.label || agentId;
  };
  const taskRows = () => tasks.slice().sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map(task => `<tr>
    <td><code title="${esc(task.id)}">${esc(shortId(task.id))}</code></td><td title="${esc(task.targetAgentId)}">${esc(agentName(task.targetAgentId))}</td>
    <td title="${esc(task.prompt)}">${esc(short(task.prompt))}</td>
    <td><span class="op-badge ${statusClass(task.status)}">${esc(options.tr(`status.${task.status}`))}</span>${task.conflictKey ? `<small>${esc(task.conflictKey)}</small>` : ''}${task.error ? `<small class="op-error">${esc(task.error)}</small>` : ''}</td></tr>`).join('') || `<tr><td colspan="4" class="empty">${options.tr('ops.noTasks')}</td></tr>`;
  const taskTable = () => `<div class="table-wrap op-task-table"><table><thead><tr><th>ID</th><th>${options.tr('ops.agent')}</th><th>${options.tr('ops.task')}</th><th>${options.tr('ops.status')}</th></tr></thead><tbody>${taskRows()}</tbody></table></div>`;
  const taskCount = (status: string) => tasks.filter(task => task.status === status).length;
  const taskTime = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const taskTextBlock = (kind: 'delivery' | 'error', label: string, value: string, detailThreshold: number) => {
    const hasDetail = value.length > detailThreshold || value.includes('\n');
    return `<section class="op-task-text op-task-${kind}"><span>${esc(label)}</span><p>${esc(value)}</p>${hasDetail ? `<details><summary>${esc(options.tr('taskPanel.viewFull'))}</summary><div>${esc(value)}</div></details>` : ''}</section>`;
  };
  const taskCard = (task: Task) => {
    const canPause = task.status === 'queued';
    const canResume = task.status === 'paused';
    const snapshots = task.snapshots ?? [];
    const blocker = task.status === 'queued' && task.scheduling?.reason ? `<p class="op-task-blocker">${esc(options.tr('taskPanel.blocked'))}: ${esc(task.scheduling.reason)}</p>` : '';
    const progress = task.lastProgress?.message ? taskTextBlock('delivery', task.status === 'completed' ? options.tr('taskPanel.latestDelivery') : options.tr('taskPanel.latestProgress'), task.lastProgress.message, 180) : '';
    const error = task.error ? taskTextBlock('error', options.tr('taskPanel.errorDetail'), task.error, 120) : '';
    const history = snapshots.length ? `<details class="op-task-snapshots"><summary>${esc(options.tr('taskPanel.snapshots'))} · ${snapshots.length}</summary><ol>${snapshots.slice().reverse().slice(0, 8).map(snapshot => `<li><time>${esc(snapshot.createdAt)}</time><span>${esc(snapshot.reason)} · ${esc(snapshot.status)}</span>${snapshot.progress?.message ? `<p>${esc(snapshot.progress.message)}</p>` : ''}</li>`).join('')}</ol></details>` : '';
    const actions = `${canPause ? `<button data-op-task-action="pause" data-task-id="${esc(task.id)}">${esc(options.tr('taskPanel.pause'))}</button>` : ''}${canResume ? `<button data-op-task-action="resume" data-task-id="${esc(task.id)}">${esc(options.tr('taskPanel.resume'))}</button>` : ''}`;
    return `<article class="op-task-card status-${esc(task.status)}">
      <header><span class="op-badge ${statusClass(task.status)}">${esc(options.tr(`status.${task.status}`))}</span><code title="${esc(task.id)}">${esc(shortId(task.id))}</code></header>
      <h4 title="${esc(task.prompt)}">${esc(task.prompt)}</h4>
      <div class="op-task-meta"><span>${esc(agentName(task.targetAgentId))}</span><time>${esc(taskTime(task.updatedAt))}</time></div>${blocker}${progress}${error}
      ${task.recalledFromTaskId ? `<p class="op-task-origin">${esc(options.tr('taskPanel.recalledFrom'))}: ${esc(shortId(task.recalledFromTaskId))}</p>` : ''}
      ${history}
      ${actions ? `<footer>${actions}</footer>` : ''}
    </article>`;
  };
  const boardColumn = (key: string, title: string, statuses: string[]) => {
    const columnTasks = tasks.filter(task => statuses.includes(task.status)).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return `<section class="op-kanban-column column-${key}"><header><h3>${esc(title)}</h3><span>${columnTasks.length}</span></header><div>${columnTasks.map(taskCard).join('') || `<p class="op-kanban-empty">${esc(options.tr('taskPanel.emptyColumn'))}</p>`}</div></section>`;
  };
  const readOnlyNotice = () => `<aside class="op-readonly-note"><span class="op-readonly-icon">↗</span><div><strong>${options.tr('ops.readOnlyTitle')}</strong><p>${options.tr('ops.readOnlyHint')}</p></div></aside>`;
  const renderTasks = () => !base() ? `<div class="empty operations-empty"><h3>${options.tr('offline')}</h3></div>` : `<section class="content ops-page">
    <div class="op-page-header"><div><span class="eyebrow">${options.tr('ops.activityEyebrow')}</span><h2>${options.tr('tasks')}</h2><p>${options.tr('ops.tasksSubtitle')}</p></div><button class="op-quiet-button" data-op-refresh>${options.tr('refresh')}</button></div>
    <div class="op-stat-row"><article><span>${options.tr('status.running')}</span><strong>${taskCount('running')}</strong></article><article><span>${options.tr('status.queued')}</span><strong>${taskCount('queued')}</strong></article><article><span>${options.tr('status.paused')}</span><strong>${taskCount('paused')}</strong></article><article><span>${options.tr('ops.totalTasks')}</span><strong>${tasks.length}</strong></article></div>
    <div class="op-kanban" aria-label="${esc(options.tr('taskPanel.title'))}">
      ${boardColumn('backlog', options.tr('taskPanel.backlog'), ['queued'])}
      ${boardColumn('active', options.tr('taskPanel.active'), ['running'])}
      ${boardColumn('waiting', options.tr('taskPanel.waiting'), ['waiting', 'review_pending', 'paused'])}
      ${boardColumn('finished', options.tr('taskPanel.finished'), ['completed', 'failed', 'cancelled'])}
    </div>
  </section>`;
  const graphTopology = () => {
    const nodes = (graph?.nodes ?? []).filter(node => team === 'all' || node.role === 'admin' || node.teamName === team);
    const visible = new Set(nodes.map(node => node.id));
    const edges = (graph?.edges ?? []).filter(edge => visible.has(edge.source) && visible.has(edge.target));
    if (!nodes.length) return `<p class="empty">${options.tr('ops.noTopology')}</p>`;

    const byId = new Map(nodes.map(node => [node.id, node]));
    const incoming = new Map(nodes.map(node => [node.id, 0]));
    const children = new Map(nodes.map(node => [node.id, [] as string[]]));
    for (const edge of edges) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
      children.get(edge.source)?.push(edge.target);
    }
    const rank = new Map<string, number>();
    const queue = nodes.filter(node => (incoming.get(node.id) ?? 0) === 0).map(node => node.id);
    queue.forEach(id => rank.set(id, 0));
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i]; const level = rank.get(id) ?? 0;
      for (const child of children.get(id) ?? []) {
        rank.set(child, Math.max(rank.get(child) ?? 0, level + 1));
        incoming.set(child, (incoming.get(child) ?? 1) - 1);
        if ((incoming.get(child) ?? 0) === 0) queue.push(child);
      }
    }
    // A malformed cyclic graph remains usable instead of leaving nodes unplaced.
    nodes.forEach(node => { if (!rank.has(node.id)) rank.set(node.id, 0); });
    const rows = new Map<number, GraphNode[]>();
    nodes.forEach(node => { const level = rank.get(node.id) ?? 0; rows.set(level, [...(rows.get(level) ?? []), node]); });
    rows.forEach((row) => row.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })));
    const maxPerRow = Math.max(...Array.from(rows.values(), row => row.length));
    const width = Math.max(680, maxPerRow * 188 + 80);
    const height = Math.max(260, rows.size * 148 + 80);
    const position = new Map<string, { x: number; y: number }>();
    Array.from(rows.entries()).sort(([a], [b]) => a - b).forEach(([level, row]) => {
      const rowWidth = row.length * 188;
      row.forEach((node, index) => position.set(node.id, { x: (width - rowWidth) / 2 + index * 188 + 94, y: 58 + level * 148 }));
    });
    const edgeSvg = edges.map(edge => {
      const from = position.get(edge.source); const to = position.get(edge.target);
      if (!from || !to) return '';
      return `<path d="M ${from.x} ${from.y + 47} C ${from.x} ${from.y + 86}, ${to.x} ${to.y - 86}, ${to.x} ${to.y - 47}" marker-end="url(#op-arrow)" class="op-topology-edge ${esc(edge.kind)}" />`;
    }).join('');
    const topologyKey = JSON.stringify({
      nodes: nodes.map((node) => [node.id, node.role, node.label, node.port, Boolean(node.placeholder)]),
      edges: edges.map((edge) => [edge.source, edge.target, edge.kind]),
      controls: options.tr('ops.panZoom'),
    });
    const nodeSvg = nodes.map(node => {
      const point = position.get(node.id); if (!point) return '';
      const status = node.placeholder ? 'idle' : node.status ?? statuses[node.id] ?? project?.agents.find(agent => agent.id === node.id)?.status ?? 'idle';
      const colors = nodeColors(node.role, status, node.placeholder);
      const previewEvent = events.slice().reverse().find(event => event.agentId === node.id && (event.type === 'pi.process.log' || event.type === 'pi.local.log'));
      const rawPreview = previewEvent?.payload?.line;
      const preview = typeof rawPreview === 'string' ? short(rawPreview, 34) : options.tr('ops.noOutput');
      const runtime = node.placeholder ? options.tr('ops.notStarted') : options.tr('ops.agentOnline');
      return `<g class="op-topology-node ${node.placeholder ? 'placeholder' : ''}" data-op-node-id="${esc(node.id)}"><rect x="${point.x - 78}" y="${point.y - 46}" width="156" height="92" rx="12" fill="${colors.fill}" stroke="${colors.stroke}" /><text x="${point.x}" y="${point.y - 19}" class="op-node-title">${esc(short(node.label, 22))}</text><text x="${point.x}" y="${point.y - 2}" class="op-node-meta">${esc(node.role)} · ${esc(topologyStatusLabel(status, options.tr))}</text><text x="${point.x}" y="${point.y + 15}" class="op-node-port">${esc(runtime)}</text><text x="${point.x}" y="${point.y + 33}" class="op-node-preview">${esc(preview)}</text></g>`;
    }).join('');
    return `<div data-op-topology-host data-topology-key="${esc(topologyKey)}"><div class="op-topology-shell"><div class="op-topology-controls"><button data-op-topology-zoom="out" aria-label="${options.tr('ops.zoomOut')}">−</button><button data-op-topology-zoom="reset" aria-label="${options.tr('ops.resetTopology')}">${options.tr('ops.reset')}</button><button data-op-topology-zoom="in" aria-label="${options.tr('ops.zoomIn')}">+</button><span>${options.tr('ops.panZoom')}</span></div><svg class="op-topology" data-op-topology viewBox="0 0 ${width} ${height}" role="img" aria-label="Agent topology"><defs><marker id="op-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs><g data-op-topology-layer transform="translate(${topologyPan.x} ${topologyPan.y}) scale(${topologyZoom})">${edgeSvg}${nodeSvg}</g></svg></div></div>`;
  };
  const filteredEvents = () => events.filter(event => {
    if (isTimelineNoise(event)) return false;
    if (source !== 'all' && event.source !== source) return false;
    if (team !== 'all' && event.agentId && event.agentId !== 'admin' && !event.agentId.startsWith(`${team}-`)) return false;
    const needle = filter.trim().toLowerCase();
    return !needle || [event.type, event.source, event.agentId ?? '', JSON.stringify(event.payload ?? {})].join(' ').toLowerCase().includes(needle);
  }).slice().reverse();
  const renderMonitor = () => {
    if (!base()) return `<div class="empty operations-empty"><h3>${options.tr('offline')}</h3></div>`;
    const teams = Array.from(new Set((graph?.nodes ?? []).map(node => node.teamName).filter((name): name is string => Boolean(name))));
    const activity = events.filter(event => event.type === 'report_progress').slice().reverse().slice(0, 8);
    return `<section class="content ops-page">
      <div class="op-page-header"><div><span class="eyebrow">${options.tr('ops.monitorEyebrow')}</span><h2>${options.tr('monitor')}</h2><p>${options.tr('ops.monitorSubtitle')}</p></div><div class="op-header-actions"><span class="op-connection ${connected ? 'connected' : ''}"><i></i>${connected ? options.tr('ops.connected') : options.tr('ops.reconnecting')}</span><button class="op-quiet-button" data-op-refresh>${options.tr('refresh')}</button></div></div>
      ${readOnlyNotice()}
      <div class="op-monitor-grid"><section class="op-surface"><div class="op-surface-heading"><div><h3>${options.tr('ops.topology')}</h3><p>${options.tr('ops.topologyHint')}</p></div></div>${graphTopology()}</section>
      <section class="op-surface op-progress-surface"><div class="op-surface-heading"><div><h3>${options.tr('ops.latestProgress')}</h3><p>${options.tr('ops.progressHint')}</p></div></div><div class="op-progress">${activity.map(event => `<article><strong>${esc(event.agentId ?? 'system')}</strong><small>${esc(String(event.payload?.stage ?? 'working'))} · ${esc(event.ts)}</small><p>${esc(String(event.payload?.message ?? ''))}</p></article>`).join('') || `<p class="empty">${options.tr('ops.noProgress')}</p>`}</div></section></div>
      <section class="op-surface op-monitor-tasks"><div class="op-surface-heading"><div><h3>${options.tr('ops.recentTasks')}</h3><p>${tasks.length} ${options.tr('ops.tasksByUpdate')}</p></div><span class="op-muted">${options.tr('ops.readOnly')}</span></div>${taskTable()}</section>
      <section class="op-surface op-events"><div class="op-surface-heading"><div><h3>${options.tr('ops.liveEvents')}</h3><p>${options.tr('ops.eventsHint')}</p></div></div><div class="op-event-filters"><select data-op-team><option value="all">${options.tr('ops.allTeams')}</option>${teams.map(name => `<option value="${esc(name)}" ${team === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select><select data-op-source><option value="all">${options.tr('ops.allSources')}</option><option value="orchestrator" ${source === 'orchestrator' ? 'selected' : ''}>Orchestrator</option><option value="pi" ${source === 'pi' ? 'selected' : ''}>Pi</option></select><input data-op-filter value="${esc(filter)}" placeholder="${options.tr('ops.filterPlaceholder')}" /></div>
      <div class="op-event-list">${filteredEvents().map(event => `<article><code>${esc(event.ts)} ${esc(event.source)} ${esc(event.type)}${event.agentId ? ` ${esc(event.agentId)}` : ''}</code>${event.payload && Object.keys(event.payload).length ? `<pre>${esc(JSON.stringify(event.payload, null, 2))}</pre>` : ''}</article>`).join('') || `<p class="empty">${options.tr('ops.waitingEvents')}</p>`}</div></section>
    </section>`;
  };
  const bind = (root: ParentNode) => {
    root.querySelectorAll<HTMLButtonElement>('[data-op-refresh]').forEach(button => button.addEventListener('click', () => void refresh().then(options.rerender)));
    root.querySelector<HTMLSelectElement>('[data-op-team]')?.addEventListener('change', event => { team = (event.currentTarget as HTMLSelectElement).value; options.rerender(); });
    root.querySelector<HTMLSelectElement>('[data-op-source]')?.addEventListener('change', event => { source = (event.currentTarget as HTMLSelectElement).value; options.rerender(); });
    root.querySelector<HTMLInputElement>('[data-op-filter]')?.addEventListener('input', event => { filter = (event.currentTarget as HTMLInputElement).value; options.rerender(); });
    root.querySelectorAll<HTMLButtonElement>('[data-op-task-action]').forEach(button => button.addEventListener('click', () => {
      const action = button.dataset.opTaskAction; const taskId = button.dataset.taskId;
      if (!action || !taskId) return;
      button.disabled = true;
      void options.api(`/tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'POST' })
        .then(() => loadTasks())
        .then(() => { options.notify(options.tr(`taskPanel.${action}Success`)); options.rerender(); })
        .catch(error => { options.notify(message(error), true); button.disabled = false; });
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-op-topology-zoom]').forEach(button => {
      if (button.dataset.opBound === 'true') return;
      button.dataset.opBound = 'true';
      button.addEventListener('click', () => {
      const action = button.dataset.opTopologyZoom;
      topologyZoom = action === 'in' ? Math.min(2.5, topologyZoom + 0.2) : action === 'out' ? Math.max(0.45, topologyZoom - 0.2) : 1;
      if (action === 'reset') topologyPan = { x: 0, y: 0 };
      const layer = root.querySelector<SVGGElement>('[data-op-topology-layer]');
      if (layer) layer.setAttribute('transform', `translate(${topologyPan.x} ${topologyPan.y}) scale(${topologyZoom})`);
      });
    });
    const topology = root.querySelector<SVGSVGElement>('[data-op-topology]');
    if (topology && topology.dataset.opBound !== 'true') {
      topology.dataset.opBound = 'true';
      let drag: { x: number; y: number; panX: number; panY: number } | undefined;
      const applyTransform = () => root.querySelector<SVGGElement>('[data-op-topology-layer]')?.setAttribute('transform', `translate(${topologyPan.x} ${topologyPan.y}) scale(${topologyZoom})`);
      topology.addEventListener('wheel', event => {
        event.preventDefault();
        topologyZoom = Math.max(0.45, Math.min(2.5, topologyZoom + (event.deltaY < 0 ? 0.12 : -0.12)));
        applyTransform();
      }, { passive: false });
      topology.addEventListener('pointerdown', event => {
        drag = { x: event.clientX, y: event.clientY, panX: topologyPan.x, panY: topologyPan.y };
        topology.setPointerCapture(event.pointerId);
        topology.classList.add('dragging');
      });
      topology.addEventListener('pointermove', event => {
        if (!drag) return;
        topologyPan = { x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y };
        applyTransform();
      });
      const stopDrag = () => { drag = undefined; topology.classList.remove('dragging'); };
      topology.addEventListener('pointerup', stopDrag);
      topology.addEventListener('pointercancel', stopDrag);
    }
  };
  return { setProject, setLive, refresh, renderTasks, renderMonitor, bind, dispose: () => { stopStream(); removeEventListener(); removeStatusListener(); } };
}
