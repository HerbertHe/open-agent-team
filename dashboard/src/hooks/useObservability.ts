import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ObservabilityEvent, ObservabilityGraph, AgentStatus } from '../types';

const MAX_TIMELINE = 400;

function updateStatusFromEvent(
  prev: Record<string, AgentStatus>,
  ev: ObservabilityEvent
): Record<string, AgentStatus> {
  const id = ev.agentId;
  if (!id) return prev;
  const next = { ...prev };
  if (ev.source === 'opencode') {
    if (ev.type === 'command.executed') {
      next[id] = 'tool';
      return next;
    }
    if (ev.type === 'session.status') {
      const raw = ev.payload?.opencodeEvent as { properties?: { status?: string } } | undefined;
      const st = raw?.properties?.status;
      if (st === 'busy') next[id] = 'busy';
      return next;
    }
    if (ev.type === 'session.idle') {
      next[id] = 'idle';
      return next;
    }
    if (ev.type === 'session.error' || ev.type === 'opencode.bridge.error') {
      next[id] = 'error';
      return next;
    }
    if (ev.type === 'opencode.process.log' || ev.type === 'opencode.local.log') {
      next[id] = next[id] === 'error' ? 'error' : 'busy';
      return next;
    }
  }
  if (ev.source === 'orchestrator') {
    if (ev.type?.startsWith('merge.') && ev.type?.endsWith('.start')) {
      next[id] = 'busy';
      return next;
    }
    if (ev.type?.startsWith('merge.') && ev.type?.endsWith('.done')) {
      next[id] = 'done';
      return next;
    }
    if (
      ev.type === 'worker.spawned' ||
      ev.type === 'worker.bootstrap.start' ||
      ev.type === 'request_workers.start'
    ) {
      next[id] = 'busy';
      return next;
    }
    if (ev.type === 'leader.task.assigned') {
      next[id] = 'standby';
      return next;
    }
    if (ev.type === 'admin.dashboard_instruction') {
      next[id] = 'instructed';
      return next;
    }
    if (ev.type === 'worker.task.dispatched') {
      next[id] = 'standby';
      return next;
    }
    if (ev.type === 'worker.spawn_aborted') {
      next[id] = 'error';
      return next;
    }
    if (ev.type === 'worker.notify_complete_timeout') {
      next[id] = 'error';
      return next;
    }
    if (ev.type?.startsWith('prompt.')) {
      next[id] = 'busy';
      return next;
    }
    if (ev.type === 'report_progress') {
      const stage = ev.payload?.['stage'];
      if (stage === 'done') next[id] = 'done';
      else next[id] = 'busy';
      return next;
    }
    if (ev.type === 'request_workers.error') {
      next[id] = 'error';
      return next;
    }
  }
  return next;
}

export function useObservability() {
  const [graph, setGraph] = useState<ObservabilityGraph | null>(null);
  const [events, setEvents] = useState<ObservabilityEvent[]>([]);
  const [agentStatus, setAgentStatus] = useState<Record<string, AgentStatus>>({});
  const [connected, setConnected] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);

  const lastLogLineByAgent = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of events) {
      if (!e.agentId) continue;
      if (e.type === 'opencode.process.log') {
        const line = e.payload?.line;
        if (typeof line !== 'string') continue;
        const s = line.length > 40 ? `${line.slice(0, 37)}…` : line;
        m[e.agentId] = s;
      } else if (e.type === 'opencode.local.log') {
        const line = e.payload?.line;
        if (typeof line !== 'string') continue;
        const s = line.length > 44 ? `${line.slice(0, 41)}…` : line;
        m[e.agentId] = s;
      }
    }
    return m;
  }, [events]);

  const refreshGraph = useCallback(async () => {
    try {
      const r = await fetch('/observability/graph');
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data = (await r.json()) as ObservabilityGraph;
      setGraph(data);
      setGraphError(null);
    } catch (e) {
      setGraphError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refreshGraph();
  }, [refreshGraph]);

  useEffect(() => {
    const es = new EventSource('/observability/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const onData = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data as string) as ObservabilityEvent;
        setEvents((prev) => {
          const n = [...prev, parsed];
          if (n.length > MAX_TIMELINE) n.splice(0, n.length - MAX_TIMELINE);
          return n;
        });
        setAgentStatus((prev) => updateStatusFromEvent(prev, parsed));
        const t = parsed.type;
        if (
          t === 'worker.spawned' ||
          t === 'worker.bootstrap.start' ||
          t === 'worker.spawn_aborted' ||
          t === 'request_workers.done' ||
          t === 'request_workers.start' ||
          t === 'register_workers.done' ||
          t === 'dispatch_worker_tasks.done' ||
          t === 'worker.task.dispatched' ||
          t === 'worker.task.prompt_sent' ||
          t === 'worker.notify_complete_timeout' ||
          t === 'leader.task.assigned' ||
          t === 'admin.dashboard_instruction' ||
          t === 'worker.dispatch_failed' ||
          t === 'agent.cleanup.worker' ||
          t === 'agent.cleanup.leader' ||
          t === 'orchestrator.ready'
        ) {
          void refreshGraph();
        }
      } catch {
        /* ignore parse errors */
      }
    };
    es.addEventListener('message', onData as EventListener);
    return () => {
      es.close();
    };
  }, [refreshGraph]);

  const fetchAgentLogs = useCallback(async (agentId: string): Promise<{ process: string[]; localShare: string[] }> => {
    const r = await fetch(`/observability/agent/${encodeURIComponent(agentId)}/logs`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const data = (await r.json()) as { process: string[]; localShare?: string[] };
    return {
      process: data.process ?? [],
      localShare: data.localShare ?? [],
    };
  }, []);

  return {
    graph,
    events,
    agentStatus,
    connected,
    graphError,
    refreshGraph,
    lastLogLineByAgent,
    fetchAgentLogs,
  };
}
