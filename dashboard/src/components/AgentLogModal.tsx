import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Space, Typography } from 'antd';
import type { ObservabilityEvent } from '../types';

const { Text } = Typography;

/** 事件类型对应的颜色 */
function eventTypeColor(type: string): string {
  if (type.startsWith('report_progress')) return '#722ed1';
  if (type.startsWith('pi.process.log')) return '#8c8c8c';
  if (type.startsWith('pi.local.log')) return '#8c8c8c';
  if (type.includes('task')) return '#1677ff';
  if (type.includes('complete') || type.includes('done')) return '#52c41a';
  if (type.includes('error') || type.includes('fail')) return '#ff4d4f';
  return '#fa8c16';
}

/** stream 前缀颜色 */
function streamColor(stream?: string): string {
  if (stream === 'stderr') return '#ff4d4f';
  return '#8c8c8c';
}

interface LogEntry {
  ts: string;
  type: string;
  content: string;
  stream?: string;
}

export function AgentLogModal({
  agentId,
  open,
  onClose,
  events,
  fetchAgentLogs,
}: {
  agentId: string | null;
  open: boolean;
  onClose: () => void;
  events: ObservabilityEvent[];
  fetchAgentLogs: (id: string) => Promise<{ process: string[]; localShare: string[] }>;
}) {
  const [processLines, setProcessLines] = useState<string[]>([]);
  const [liveTail, setLiveTail] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenEventLenRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    if (!agentId) return;
    setLoading(true);
    setError(null);
    try {
      const { process: proc } = await fetchAgentLogs(agentId);
      setProcessLines(proc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProcessLines([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !agentId) {
      setProcessLines([]);
      setLiveTail([]);
      seenEventLenRef.current = 0;
      return;
    }
    seenEventLenRef.current = events.length;
    void load();
  }, [open, agentId]);

  useEffect(() => {
    if (!open || !agentId) return;
    const newEvents = events.slice(seenEventLenRef.current);
    seenEventLenRef.current = events.length;
    const entries: LogEntry[] = [];
    for (const e of newEvents) {
      if (e.agentId !== agentId) continue;
      if (e.type === 'pi.process.log') {
        const line = e.payload?.line;
        const stream = e.payload?.stream as string | undefined;
        if (typeof line === 'string') {
          entries.push({ ts: e.ts, type: e.type, content: line, stream });
        }
      } else if (e.type !== 'pi.local.log') {
        const pay = e.payload && Object.keys(e.payload).length > 0 ? JSON.stringify(e.payload) : '';
        entries.push({ ts: e.ts, type: e.type, content: pay });
      }
    }
    if (entries.length > 0) {
      setLiveTail((prev) => [...prev, ...entries].slice(-500));
      // Auto scroll to bottom
      setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [events, open, agentId]);

  // Pi events (non-log)
  const piEvents = useMemo(() => {
    if (!agentId) return [];
    return events
      .filter(
        (e) =>
          e.agentId === agentId &&
          e.source === 'pi' &&
          e.type !== 'pi.process.log' &&
          e.type !== 'pi.local.log'
      )
      .slice(-80)
      .map((e) => ({
        ts: e.ts,
        type: e.type,
        content: e.payload && Object.keys(e.payload).length > 0 ? JSON.stringify(e.payload) : '',
      }));
  }, [events, agentId]);

  return (
    <Modal
      title={agentId ? `Agent 日志 · ${agentId}` : 'Agent 日志'}
      open={open}
      onCancel={onClose}
      width="min(900px, 96vw)"
      footer={
        <Space>
          <Button onClick={() => void load()} loading={loading}>
            刷新日志
          </Button>
          <Button type="primary" onClick={onClose}>
            关闭
          </Button>
        </Space>
      }
    >
      {error && (
        <Text type="danger" style={{ display: 'block', marginBottom: 8 }}>
          {error}
        </Text>
      )}
      <div
        className="agent-log-container"
        style={{
          maxHeight: 'min(60vh, 560px)',
          overflow: 'auto',
          background: '#1e1e1e',
          borderRadius: 8,
          padding: '12px 16px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        {/* Process log lines */}
        {processLines.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: '#569cd6', fontWeight: 600, marginBottom: 4 }}>── Process Logs ──</div>
            {processLines.map((line, i) => (
              <div key={`p-${i}`} style={{ color: '#d4d4d4', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {line}
              </div>
            ))}
          </div>
        )}

        {/* Pi events */}
        {piEvents.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: '#569cd6', fontWeight: 600, marginBottom: 4 }}>── Pi Events ──</div>
            {piEvents.map((entry, i) => (
              <div key={`pi-${i}`} style={{ display: 'flex', gap: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 2 }}>
                <span style={{ color: '#6a9955', flexShrink: 0 }}>{entry.ts}</span>
                <span style={{ color: eventTypeColor(entry.type), flexShrink: 0, fontWeight: 500 }}>{entry.type}</span>
                {entry.content && <span style={{ color: '#d4d4d4' }}>{entry.content}</span>}
              </div>
            ))}
          </div>
        )}

        {/* Live tail */}
        {liveTail.length > 0 && (
          <div>
            <div style={{ color: '#569cd6', fontWeight: 600, marginBottom: 4 }}>── Live ──</div>
            {liveTail.map((entry, i) => (
              <div key={`l-${i}`} style={{ display: 'flex', gap: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 2 }}>
                <span style={{ color: '#6a9955', flexShrink: 0 }}>{entry.ts}</span>
                <span style={{ color: eventTypeColor(entry.type), flexShrink: 0, fontWeight: 500 }}>{entry.type}</span>
                {entry.stream && (
                  <span style={{ color: streamColor(entry.stream), flexShrink: 0 }}>[{entry.stream}]</span>
                )}
                {entry.content && <span style={{ color: '#d4d4d4' }}>{entry.content}</span>}
              </div>
            ))}
          </div>
        )}

        {processLines.length === 0 && piEvents.length === 0 && liveTail.length === 0 && (
          <div style={{ color: '#6a6a6a', textAlign: 'center', padding: 24 }}>
            （暂无日志）
          </div>
        )}
        <div ref={logEndRef} />
      </div>
    </Modal>
  );
}
