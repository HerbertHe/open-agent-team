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

type GraphNode = { id: string; role: string; label: string; port?: number; teamName?: string; placeholder?: boolean };
type Graph = { nodes: GraphNode[]; edges: Array<{ source: string; target: string; kind: string }> };
type Task = { id: string; targetAgentId: string; createdBy?: string; prompt: string; conflictKey?: string; status: string; updatedAt?: string; error?: string };
type Event = { ts: string; source: 'orchestrator' | 'pi'; type: string; agentId?: string; role?: string; payload?: Record<string, unknown> };

export type OperationsFeature = {
  setProject(project: OperationProject | undefined): void;
  setLive(enabled: boolean): void;
  refresh(): Promise<void>;
  renderTasks(): string;
  renderMonitor(): string;
  renderProjectActions(): string;
  bind(root: ParentNode): void;
  dispose(): void;
};

type Options = {
  api<T>(path: string, init?: RequestInit): Promise<T>;
  notify(message: string, error?: boolean): void;
  rerender(): void;
  refreshProjects(): Promise<void>;
  restartProject(name: string): Promise<unknown>;
  deleteProject(name: string): Promise<unknown>;
  subscribeObservability(projectName: string): Promise<void>;
  unsubscribeObservability(): Promise<void>;
  onObservabilityEvent(listener: (payload: { projectName: string; event: unknown }) => void): () => void;
  onObservabilityStatus(listener: (payload: { projectName: string; connected: boolean }) => void): () => void;
  tr(key: string): string;
};

const esc = (value: string) => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] ?? char));
const statusClass = (status: string) => ['running', 'busy'].includes(status) ? 'busy' : ['failed', 'error'].includes(status) ? 'error' : status === 'completed' || status === 'done' ? 'done' : 'idle';
const short = (value: string, length = 72) => value.length > length ? `${value.slice(0, length - 1)}…` : value;

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
  let activeLogAgentId: string | undefined;
  let activeLogTab: 'local' | 'pi' | 'live' = 'live';
  let activeLog: { process: string[]; localShare: string[] } = { process: [], localShare: [] };
  let logLoading = false;
  let logError = '';

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
    if (changed) { graph = undefined; tasks = []; events = []; statuses = {}; activeLogAgentId = undefined; activeLog = { process: [], localShare: [] }; stopStream(); void refresh().then(options.rerender); }
  };
  const setLive = (enabled: boolean) => {
    if (live === enabled) return;
    live = enabled;
    if (!live) { stopStream(); return; }
    if (base()) void refresh().then(options.rerender);
  };
  const taskRows = () => tasks.slice().sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map(task => `<tr>
    <td><code>${esc(task.id.slice(0, 12))}</code></td><td>${esc(task.targetAgentId)}</td>
    <td title="${esc(task.prompt)}">${esc(short(task.prompt))}</td>
    <td><span class="op-badge ${statusClass(task.status)}">${esc(task.status)}</span>${task.conflictKey ? `<small>${esc(task.conflictKey)}</small>` : ''}${task.error ? `<small class="op-error">${esc(task.error)}</small>` : ''}</td>
    <td><button data-op-edit-task="${esc(task.id)}">Edit</button><button data-op-delete-task="${esc(task.id)}">${options.tr('delete')}</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No tasks.</td></tr>';
  const renderTasks = () => !base() ? `<div class="empty operations-empty"><h3>${options.tr('offline')}</h3></div>` : `<section class="content ops-page">
    <div class="section-heading"><div><span class="eyebrow">SAFE FIFO DISPATCH</span><h2>${options.tr('tasks')}</h2></div><button data-op-refresh>${options.tr('refresh')}</button></div>
    <form class="panel form-grid" data-op-task-form>
      <label>Target agent<select name="targetAgentId" required>${(graph?.nodes ?? project?.agents ?? []).filter(agent => !('placeholder' in agent) || (agent as GraphNode).placeholder !== true).map(agent => `<option value="${esc(agent.id)}">${esc(agent.label)} (${esc(agent.role)})</option>`).join('')}</select></label>
      <label>Conflict key<input name="conflictKey" placeholder="exclusive resource, optional" /></label>
      <label class="span-2">Prompt<textarea name="prompt" required placeholder="Independent work, scope, and acceptance criteria"></textarea></label>
      <button class="primary">${options.tr('create')}</button></form>
    <div class="table-wrap"><table><thead><tr><th>ID</th><th>Agent</th><th>Prompt</th><th>Status</th><th>Actions</th></tr></thead><tbody>${taskRows()}</tbody></table></div>
  </section>`;
  const graphTopology = () => {
    const nodes = (graph?.nodes ?? []).filter(node => team === 'all' || node.role === 'admin' || node.teamName === team);
    const visible = new Set(nodes.map(node => node.id));
    const edges = (graph?.edges ?? []).filter(edge => visible.has(edge.source) && visible.has(edge.target));
    if (!nodes.length) return '<p class="empty">No topology data.</p>';

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
    const nodeSvg = nodes.map(node => {
      const point = position.get(node.id); if (!point) return '';
      const status = statuses[node.id] ?? project?.agents.find(agent => agent.id === node.id)?.status ?? 'idle';
      const colors = nodeColors(node.role, status, node.placeholder);
      const previewEvent = events.slice().reverse().find(event => event.agentId === node.id && (event.type === 'pi.process.log' || event.type === 'pi.local.log'));
      const rawPreview = previewEvent?.payload?.line;
      const preview = typeof rawPreview === 'string' ? short(rawPreview, 34) : 'No log output';
      const port = node.placeholder || !node.port ? 'not started' : `:${node.port}`;
      return `<g class="op-topology-node ${node.placeholder ? 'placeholder' : ''}" data-op-agent-log="${esc(node.id)}" tabindex="0" role="button" aria-label="Open ${esc(node.label)} log"><rect x="${point.x - 78}" y="${point.y - 46}" width="156" height="92" rx="12" fill="${colors.fill}" stroke="${colors.stroke}" /><text x="${point.x}" y="${point.y - 19}" class="op-node-title">${esc(short(node.label, 22))}</text><text x="${point.x}" y="${point.y - 2}" class="op-node-meta">${esc(node.role)} · ${esc(status)}</text><text x="${point.x}" y="${point.y + 15}" class="op-node-port">${esc(port)}</text><text x="${point.x}" y="${point.y + 33}" class="op-node-preview">${esc(preview)}</text></g>`;
    }).join('');
    return `<div class="op-topology-shell"><div class="op-topology-controls"><button data-op-topology-zoom="out" aria-label="Zoom out">−</button><button data-op-topology-zoom="reset" aria-label="Reset topology view">Reset</button><button data-op-topology-zoom="in" aria-label="Zoom in">+</button><span>Drag to pan · scroll to zoom</span></div><svg class="op-topology" data-op-topology viewBox="0 0 ${width} ${height}" role="img" aria-label="Agent topology"><defs><marker id="op-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs><g data-op-topology-layer transform="translate(${topologyPan.x} ${topologyPan.y}) scale(${topologyZoom})">${edgeSvg}${nodeSvg}</g></svg></div>`;
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
      <div class="section-heading"><div><span class="eyebrow">LIVE ORCHESTRATOR</span><h2>${options.tr('monitor')}</h2></div><span><span class="op-connection ${connected ? 'connected' : ''}">${connected ? 'SSE connected' : 'SSE reconnecting'}</span><button data-op-refresh>${options.tr('refresh')}</button></span></div>
      <div class="op-admin panel"><label>Admin instruction<textarea data-op-admin-input placeholder="Describe the desired outcome. Admin will plan and delegate independent work."></textarea></label><button class="primary" data-op-send-admin>Send instruction</button></div>
      <div class="op-monitor-grid"><section class="panel"><h3>Agent topology</h3><p class="hint">Click a node to inspect process, local-share, Pi, and live-tail data.</p>${graphTopology()}</section>
      <section class="panel"><h3>Progress reports</h3><div class="op-progress">${activity.map(event => `<article><strong>${esc(event.agentId ?? 'system')}</strong><small>${esc(String(event.payload?.stage ?? 'working'))} · ${esc(event.ts)}</small><p>${esc(String(event.payload?.message ?? ''))}</p></article>`).join('') || '<p class="empty">No progress reports yet.</p>'}</div></section></div>
      <section class="panel op-monitor-tasks"><div class="section-heading"><h3>Task board</h3><small>${tasks.length} tasks · newest update first</small></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Agent</th><th>Prompt</th><th>Status</th><th>Actions</th></tr></thead><tbody>${taskRows()}</tbody></table></div></section>
      <section class="panel op-events"><div class="op-event-filters"><select data-op-team><option value="all">All teams</option>${teams.map(name => `<option value="${esc(name)}" ${team === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select><select data-op-source><option value="all">All sources</option><option value="orchestrator" ${source === 'orchestrator' ? 'selected' : ''}>Orchestrator</option><option value="pi" ${source === 'pi' ? 'selected' : ''}>Pi</option></select><input data-op-filter value="${esc(filter)}" placeholder="Filter type, agent, source or content" /></div>
      <h3>Realtime event stream</h3><div class="op-event-list">${filteredEvents().map(event => `<article><code>${esc(event.ts)} ${esc(event.source)} ${esc(event.type)}${event.agentId ? ` ${esc(event.agentId)}` : ''}</code>${event.payload && Object.keys(event.payload).length ? `<pre>${esc(JSON.stringify(event.payload, null, 2))}</pre>` : ''}</article>`).join('') || '<p class="empty">Waiting for events…</p>'}</div></section>
      ${renderLogDialog()}
    </section>`;
  };
  const renderProjectActions = () => project ? `<span class="op-project-actions"><button data-op-restart-project="${esc(project.name)}">${options.tr('restart')}</button>${!project.alive ? `<button data-op-delete-project="${esc(project.name)}">${options.tr('delete')}</button>` : ''}</span>` : '';
  const logLine = (event: Event) => `${event.ts} ${event.type}${event.payload?.stream ? ` [${String(event.payload.stream)}]` : ''}${event.payload && Object.keys(event.payload).length ? ` ${JSON.stringify(event.payload)}` : ''}`;
  const renderLogDialog = () => {
    if (!activeLogAgentId) return '<dialog class="op-log-dialog" data-op-log-dialog></dialog>';
    const piEvents = events.filter(event => event.agentId === activeLogAgentId && event.source === 'pi' && event.type !== 'pi.process.log' && event.type !== 'pi.local.log').slice(-500);
    const live = events.filter(event => event.agentId === activeLogAgentId && !isTimelineNoise(event)).slice(-500);
    const content = activeLogTab === 'local'
      ? activeLog.localShare.join('\n') || 'No local-share output.'
      : activeLogTab === 'pi'
        ? piEvents.map(logLine).join('\n') || 'No Pi events.'
        : `${activeLog.process.join('\n')}${activeLog.process.length && live.length ? '\n' : ''}${live.map(logLine).join('\n')}` || 'No live output.';
    return `<dialog class="op-log-dialog" data-op-log-dialog><div class="op-log-body"><div class="op-log-heading"><div><h3>${esc(activeLogAgentId)}</h3><p>Showing up to the latest 500 events.</p></div><button data-op-log-refresh ${logLoading ? 'disabled' : ''}>${logLoading ? 'Loading…' : 'Refresh'}</button></div>${logError ? `<p class="op-error">${esc(logError)}</p>` : ''}<div class="op-log-tabs" role="tablist"><button data-op-log-tab="local" class="${activeLogTab === 'local' ? 'active' : ''}">Local share</button><button data-op-log-tab="pi" class="${activeLogTab === 'pi' ? 'active' : ''}">Pi (${piEvents.length})</button><button data-op-log-tab="live" class="${activeLogTab === 'live' ? 'active' : ''}">Live (${live.length})</button></div><pre>${esc(content)}</pre></div><form method="dialog"><button>Close</button></form></dialog>`;
  };
  const openLog = async (agentId: string) => {
    activeLogAgentId = agentId; activeLogTab = 'live'; activeLog = { process: [], localShare: [] }; logError = ''; logLoading = true;
    options.rerender();
    try {
      const logs = await options.api<{ process?: string[]; localShare?: string[] }>(`/observability/agent/${encodeURIComponent(agentId)}/logs`);
      activeLog = { process: logs.process ?? [], localShare: logs.localShare ?? [] };
    } catch (error) { logError = message(error); }
    finally { logLoading = false; options.rerender(); }
  };
  const bind = (root: ParentNode) => {
    root.querySelector<HTMLFormElement>('[data-op-task-form]')?.addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const body = Object.fromEntries(new FormData(form));
      void options.api<Task>('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(() => { form.reset(); return refresh(); }).then(options.rerender).catch(error => options.notify(message(error), true));
    });
    root.querySelectorAll<HTMLButtonElement>('[data-op-delete-task]').forEach(button => button.addEventListener('click', () => {
      if (!window.confirm('Delete this task?')) return; void options.api(`/tasks/${encodeURIComponent(button.dataset.opDeleteTask ?? '')}`, { method: 'DELETE' }).then(refresh).then(options.rerender).catch(error => options.notify(message(error), true));
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-op-edit-task]').forEach(button => button.addEventListener('click', () => {
      const task = tasks.find(item => item.id === button.dataset.opEditTask); if (!task) return;
      const prompt = window.prompt('Task prompt', task.prompt); if (prompt === null) return;
      const conflictKey = window.prompt('Conflict key (empty removes)', task.conflictKey ?? ''); if (conflictKey === null) return;
      const status = window.prompt('Status: queued, running, completed, cancelled, failed', task.status); if (status === null) return;
      void options.api(`/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, conflictKey: conflictKey || undefined, status }) }).then(refresh).then(options.rerender).catch(error => options.notify(message(error), true));
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-op-refresh]').forEach(button => button.addEventListener('click', () => void refresh().then(options.rerender)));
    root.querySelector<HTMLButtonElement>('[data-op-send-admin]')?.addEventListener('click', () => {
      const input = root.querySelector<HTMLTextAreaElement>('[data-op-admin-input]'); const prompt = input?.value.trim(); if (!prompt) return;
      void options.api('/tool/admin_instruction', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) }).then(() => { if (input) input.value = ''; options.notify('Admin instruction sent'); }).catch(error => options.notify(message(error), true));
    });
    root.querySelector<HTMLSelectElement>('[data-op-team]')?.addEventListener('change', event => { team = (event.currentTarget as HTMLSelectElement).value; options.rerender(); });
    root.querySelector<HTMLSelectElement>('[data-op-source]')?.addEventListener('change', event => { source = (event.currentTarget as HTMLSelectElement).value; options.rerender(); });
    root.querySelector<HTMLInputElement>('[data-op-filter]')?.addEventListener('input', event => { filter = (event.currentTarget as HTMLInputElement).value; options.rerender(); });
    root.querySelectorAll<HTMLElement>('[data-op-agent-log]').forEach(node => {
      const open = () => { const agentId = node.dataset.opAgentLog; if (agentId) void openLog(agentId); };
      node.addEventListener('click', open);
      node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-op-topology-zoom]').forEach(button => button.addEventListener('click', () => {
      const action = button.dataset.opTopologyZoom;
      topologyZoom = action === 'in' ? Math.min(2.5, topologyZoom + 0.2) : action === 'out' ? Math.max(0.45, topologyZoom - 0.2) : 1;
      if (action === 'reset') topologyPan = { x: 0, y: 0 };
      const layer = root.querySelector<SVGGElement>('[data-op-topology-layer]');
      if (layer) layer.setAttribute('transform', `translate(${topologyPan.x} ${topologyPan.y}) scale(${topologyZoom})`);
    }));
    const topology = root.querySelector<SVGSVGElement>('[data-op-topology]');
    if (topology) {
      let drag: { x: number; y: number; panX: number; panY: number } | undefined;
      const applyTransform = () => root.querySelector<SVGGElement>('[data-op-topology-layer]')?.setAttribute('transform', `translate(${topologyPan.x} ${topologyPan.y}) scale(${topologyZoom})`);
      topology.addEventListener('wheel', event => {
        event.preventDefault();
        topologyZoom = Math.max(0.45, Math.min(2.5, topologyZoom + (event.deltaY < 0 ? 0.12 : -0.12)));
        applyTransform();
      }, { passive: false });
      topology.addEventListener('pointerdown', event => {
        if ((event.target as Element).closest('[data-op-agent-log]')) return;
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
    const dialog = root.querySelector<HTMLDialogElement>('[data-op-log-dialog]');
    if (activeLogAgentId && dialog && !dialog.open) dialog.showModal();
    dialog?.addEventListener('close', () => { activeLogAgentId = undefined; activeLog = { process: [], localShare: [] }; logError = ''; });
    root.querySelector<HTMLButtonElement>('[data-op-log-refresh]')?.addEventListener('click', () => {
      const agentId = activeLogAgentId; if (!agentId) return;
      logLoading = true; options.rerender();
      void options.api<{ process?: string[]; localShare?: string[] }>(`/observability/agent/${encodeURIComponent(agentId)}/logs`).then(logs => {
        activeLog = { process: logs.process ?? [], localShare: logs.localShare ?? [] }; logError = '';
      }).catch(error => { logError = message(error); }).finally(() => { logLoading = false; options.rerender(); });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-op-log-tab]').forEach(button => button.addEventListener('click', () => { activeLogTab = (button.dataset.opLogTab as typeof activeLogTab) ?? 'live'; options.rerender(); }));
    root.querySelector<HTMLButtonElement>('[data-op-restart-project]')?.addEventListener('click', () => {
      const name = project?.name; if (!name) return; void options.restartProject(name).then(() => options.notify('Restart requested')).then(options.refreshProjects).catch(error => options.notify(message(error), true));
    });
    root.querySelector<HTMLButtonElement>('[data-op-delete-project]')?.addEventListener('click', () => {
      const name = project?.name; if (!name || !window.confirm(`Delete stopped project ${name}? This removes its local project directory.`)) return;
      void options.deleteProject(name).then(() => options.notify('Project deleted')).then(options.refreshProjects).catch(error => options.notify(message(error), true));
    });
  };
  return { setProject, setLive, refresh, renderTasks, renderMonitor, renderProjectActions, bind, dispose: () => { stopStream(); removeEventListener(); removeStatusListener(); } };
}
