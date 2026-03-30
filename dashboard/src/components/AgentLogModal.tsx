import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Button, Space, Typography } from 'antd';
import type { ObservabilityEvent } from '../types';

const { Text } = Typography;

function formatOpencodeEvent(e: ObservabilityEvent): string {
  if (e.type === 'opencode.process.log' || e.type === 'opencode.local.log') return '';
  const base = `[${e.ts}] ${e.type}`;
  const pay = e.payload && Object.keys(e.payload).length > 0 ? ` ${JSON.stringify(e.payload)}` : '';
  return base + pay;
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
  const [localShareLines, setLocalShareLines] = useState<string[]>([]);
  const [liveTail, setLiveTail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenEventLenRef = useRef(0);

  const load = async () => {
    if (!agentId) return;
    setLoading(true);
    setError(null);
    try {
      const { process, localShare } = await fetchAgentLogs(agentId);
      setProcessLines(process);
      setLocalShareLines(localShare);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProcessLines([]);
      setLocalShareLines([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !agentId) {
      setProcessLines([]);
      setLocalShareLines([]);
      setLiveTail('');
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
    const lines: string[] = [];
    for (const e of newEvents) {
      if (e.type === 'opencode.local.log') {
        const line = e.payload?.line;
        if (typeof line === 'string') {
          setLocalShareLines((prev) => [...prev, line].slice(-2500));
        }
      }
    }
    for (const e of newEvents) {
      if (e.agentId !== agentId) continue;
      if (e.type === 'opencode.process.log') {
        const stream = e.payload?.stream;
        const line = e.payload?.line;
        if (typeof line !== 'string') continue;
        const prefix = stream === 'stderr' || stream === 'stdout' ? `[${stream}] ` : '';
        lines.push(prefix + line);
      } else if (e.type === 'opencode.local.log') {
        const line = e.payload?.line;
        if (typeof line === 'string') lines.push(line);
      }
    }
    if (lines.length > 0) {
      setLiveTail((prev) => (prev ? `${prev}\n${lines.join('\n')}` : lines.join('\n')));
    }
  }, [events, open, agentId]);

  const opencodeSection = useMemo(() => {
    if (!agentId) return '';
    const rows = events
      .filter(
        (e) =>
          e.agentId === agentId &&
          e.source === 'opencode' &&
          e.type !== 'opencode.process.log' &&
          e.type !== 'opencode.local.log'
      )
      .slice(-80)
      .map(formatOpencodeEvent)
      .filter(Boolean);
    return rows.join('\n');
  }, [events, agentId]);

  const fullText = useMemo(() => {
    const proc = processLines.join('\n');
    const tail = liveTail ? `\n${liveTail}` : '';
    const local =
      localShareLines.length > 0
        ? `\n\n--- ~/.local/share/opencode/log（全局，与各 serve 共用） ---\n${localShareLines.join('\n')}`
        : '';
    const oc = opencodeSection ? `\n\n--- OpenCode 事件（最近） ---\n${opencodeSection}` : '';
    return (proc + tail + local + oc).trim() || '（暂无日志）';
  }, [processLines, liveTail, localShareLines, opencodeSection]);

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
      <textarea
        readOnly
        value={fullText}
        spellCheck={false}
        style={{
          width: '100%',
          minHeight: 420,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 12,
          padding: 8,
          boxSizing: 'border-box',
          background: '#fafafa',
          border: '1px solid #d9d9d9',
          borderRadius: 6,
        }}
      />
    </Modal>
  );
}
