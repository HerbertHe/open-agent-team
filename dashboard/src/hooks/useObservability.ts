import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ObservabilityEvent, ObservabilityGraph, AgentStatus } from '../types';

const MAX_TIMELINE = 400;

/** SSE 重连间隔：首次 1s，之后指数退避最大 30s */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

function updateStatusFromEvent(
  prev: Record<string, AgentStatus>,
  ev: ObservabilityEvent
): Record<string, AgentStatus> {
  const id = ev.agentId;
  if (!id) return prev;
  const next = { ...prev };
  if (ev.source === 'pi') {
    if (ev.type === 'pi.command.executed') {
      next[id] = 'tool';
      return next;
    }
    if (ev.type === 'pi.session.status') {
      const raw = ev.payload?.piEvent as { properties?: { status?: string } } | undefined;
      const st = raw?.properties?.status;
      if (st === 'busy') next[id] = 'busy';
      return next;
    }
    if (ev.type === 'pi.session.idle') {
      next[id] = 'idle';
      return next;
    }
    if (ev.type === 'pi.session.error' || ev.type === 'pi.bridge.error') {
      next[id] = 'error';
      return next;
    }
    if (ev.type === 'pi.process.log' || ev.type === 'pi.local.log') {
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

const GRAPH_REFRESH_TYPES = new Set([
  'worker.spawned',
  'worker.bootstrap.start',
  'worker.spawn_aborted',
  'request_workers.done',
  'request_workers.start',
  'register_workers.done',
  'dispatch_worker_tasks.done',
  'worker.task.dispatched',
  'worker.task.prompt_sent',
  'worker.notify_complete_timeout',
  'leader.task.assigned',
  'admin.dashboard_instruction',
  'worker.dispatch_failed',
  'agent.cleanup.worker',
  'agent.cleanup.leader',
  'orchestrator.ready',
]);

/**
 * 构建指向目标 orchestrator 实例的 URL。
 *
 * - `baseUrl` 为空或 `undefined` 时（当前实例），返回相对路径（由 Vite 代理或 Express 静态托管处理）
 * - `baseUrl` 非空时（远端实例），返回绝对 URL
 */
function resolveUrl(baseUrl: string | undefined, urlPath: string): string {
  if (!baseUrl) return urlPath;
  // 去掉尾部斜杠
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${urlPath}`;
}

export interface UseObservabilityOptions {
  /**
   * 目标 orchestrator 的 base URL，例如 `http://127.0.0.1:8787`。
   * 留空则使用当前页面的相对路径（即 Vite 代理或同源 Express 服务）。
   */
  baseUrl?: string;
}

export function useObservability(opts?: UseObservabilityOptions) {
  const baseUrl = opts?.baseUrl;

  const [graph, setGraph] = useState<ObservabilityGraph | null>(null);
  const [events, setEvents] = useState<ObservabilityEvent[]>([]);
  const [agentStatus, setAgentStatus] = useState<Record<string, AgentStatus>>({});
  const [connected, setConnected] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);

  // 当 baseUrl 变化时，重置状态
  useEffect(() => {
    setGraph(null);
    setEvents([]);
    setAgentStatus({});
    setConnected(false);
    setGraphError(null);
  }, [baseUrl]);

  /** 从 graph 中提取可用的团队列表 */
  const teams = useMemo(() => {
    if (!graph) return [];
    const names = new Set<string>();
    for (const n of graph.nodes) {
      if (n.teamName) names.add(n.teamName);
    }
    return Array.from(names).sort();
  }, [graph]);

  const lastLogLineByAgent = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of events) {
      if (!e.agentId) continue;
      if (e.type === 'pi.process.log') {
        const line = e.payload?.line;
        if (typeof line !== 'string') continue;
        const s = line.length > 40 ? `${line.slice(0, 37)}…` : line;
        m[e.agentId] = s;
      } else if (e.type === 'pi.local.log') {
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
      const r = await fetch(resolveUrl(baseUrl, '/observability/graph'));
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data = (await r.json()) as ObservabilityGraph;
      setGraph(data);
      setGraphError(null);
    } catch (e) {
      setGraphError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl]);

  useEffect(() => {
    void refreshGraph();
  }, [refreshGraph]);

  // SSE with manual reconnect + exponential backoff
  const retriesRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // Reset retries on baseUrl change
    retriesRef.current = 0;

    const connect = () => {
      if (cancelled) return;

      const sseUrl = resolveUrl(baseUrl, '/observability/events');
      es = new EventSource(sseUrl);

      es.onopen = () => {
        retriesRef.current = 0;
        setConnected(true);
      };

      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;

        if (cancelled) return;

        const delay = Math.min(
          RECONNECT_BASE_MS * Math.pow(2, retriesRef.current),
          RECONNECT_MAX_MS,
        );
        retriesRef.current++;
        reconnectTimer = setTimeout(connect, delay);
      };

      const onData = (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data as string) as ObservabilityEvent;
          setEvents((prev) => {
            let n: ObservabilityEvent[];
            if (parsed.type === 'pi.message_update' && parsed.agentId) {
              const idx = (() => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  const e = prev[i];
                  if (e.type === 'pi.message_update' && e.agentId === parsed.agentId) return i;
                }
                return -1;
              })();
              if (idx >= 0) {
                n = prev.slice();
                n[idx] = parsed;
              } else {
                n = [...prev, parsed];
              }
            } else {
              n = [...prev, parsed];
            }
            if (n.length > MAX_TIMELINE) n.splice(0, n.length - MAX_TIMELINE);
            return n;
          });
          setAgentStatus((prev) => updateStatusFromEvent(prev, parsed));
          if (GRAPH_REFRESH_TYPES.has(parsed.type)) {
            void refreshGraph();
          }
        } catch {
          /* ignore parse errors */
        }
      };
      es.addEventListener('message', onData as EventListener);
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [baseUrl, refreshGraph]);

  const fetchAgentLogs = useCallback(async (agentId: string): Promise<{ process: string[]; localShare: string[] }> => {
    const r = await fetch(resolveUrl(baseUrl, `/observability/agent/${encodeURIComponent(agentId)}/logs`));
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const data = (await r.json()) as { process: string[]; localShare?: string[] };
    return {
      process: data.process ?? [],
      localShare: data.localShare ?? [],
    };
  }, [baseUrl]);

  return {
    graph,
    events,
    agentStatus,
    connected,
    graphError,
    refreshGraph,
    lastLogLineByAgent,
    fetchAgentLogs,
    teams,
  };
}
