import { lazy, Suspense, useMemo, useState } from 'react';
import {
  ConfigProvider,
  Layout,
  Typography,
  Tag,
  List,
  Space,
  Alert,
  Input,
  Button,
  Select,
  theme,
  Spin,
} from 'antd';
import { XProvider } from '@ant-design/x';
import { useObservability } from './hooks/useObservability';
import { AgentLogModal } from './components/AgentLogModal';
import { AdminInstructionSender } from './components/AdminInstructionSender';
import { isTimelineNoiseEvent } from './timelineEventFilter';
import type { ObservabilitySource } from './types';
import './App.css';

const AgentGraph = lazy(async () => {
  const m = await import('./components/AgentGraph');
  return { default: m.AgentGraph };
});

const { Header, Content } = Layout;
const { Text } = Typography;

function formatEventLine(ev: { ts: string; source: string; type: string; agentId?: string }): string {
  const who = ev.agentId ? ` ${ev.agentId}` : '';
  return `[${ev.ts}] ${ev.source} ${ev.type}${who}`;
}

export default function App() {
  const {
    graph,
    events,
    agentStatus,
    connected,
    graphError,
    refreshGraph,
    lastLogLineByAgent,
    fetchAgentLogs,
  } = useObservability();
  const [filter, setFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | ObservabilitySource>('all');
  const [logModalAgentId, setLogModalAgentId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let visible = events.filter((e) => !isTimelineNoiseEvent(e));
    if (sourceFilter !== 'all') {
      visible = visible.filter((e) => e.source === sourceFilter);
    }
    const q = filter.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter(
      (e) =>
        e.type.toLowerCase().includes(q) ||
        (e.agentId?.toLowerCase().includes(q) ?? false) ||
        e.source.toLowerCase().includes(q)
    );
  }, [events, filter, sourceFilter]);

  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <XProvider>
      <Layout className="dashboard-layout" style={{ minHeight: '100vh', height: '100vh' }}>
        <Header className="app-header">
          <div className="app-header-brand">
            <Text strong className="app-header-title">
              Open Agent Team · 可观测
            </Text>
          </div>
          <div className="app-header-actions">
            <Tag color={connected ? 'green' : 'red'}>{connected ? 'SSE 已连接' : 'SSE 未连接'}</Tag>
            <Button size="small" onClick={() => void refreshGraph()}>
              刷新拓扑
            </Button>
          </div>
        </Header>
        <Content className="app-content">
          {graphError && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="无法拉取拓扑（请确认 oat Orchestrator 已启动，且 Vite 代理目标端口正确）"
              description={graphError}
            />
          )}
          <div className="dashboard-grid">
            <aside className="dashboard-left">
              <AdminInstructionSender />
            </aside>
            <div className="dashboard-right-stack">
              <section className="graph-panel" aria-label="Agent 拓扑">
                <Text strong className="dashboard-section-title">
                  Agent 拓扑
                </Text>
                <Text type="secondary" className="graph-panel-hint" style={{ display: 'block', marginBottom: 8 }}>
                  Admin → Leader → Worker；节点第二行起为进程日志摘要；点击节点查看完整日志
                </Text>
                <div className="graph-panel-canvas">
                  <Suspense
                    fallback={
                      <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
                        <Spin tip="加载拓扑…" />
                      </div>
                    }
                  >
                    <AgentGraph
                      data={graph}
                      agentStatus={agentStatus}
                      lastLogLineByAgent={lastLogLineByAgent}
                      onNodeClick={(id) => setLogModalAgentId(id)}
                    />
                  </Suspense>
                </div>
              </section>
              <section className="timeline-panel" aria-label="实时日志">
                <Text strong className="dashboard-section-title">
                  实时日志
                </Text>
                <Text type="secondary" className="timeline-panel-hint" style={{ display: 'block', marginBottom: 8 }}>
                  SSE 事件流；最新事件在列表顶部
                </Text>
                <div className="timeline-panel-body">
                  <div className="timeline-panel-filters">
                    <Select<'all' | ObservabilitySource>
                      value={sourceFilter}
                      onChange={setSourceFilter}
                      options={[
                        { value: 'all', label: '全部来源' },
                        { value: 'opencode', label: 'OpenCode' },
                        { value: 'orchestrator', label: 'Orchestrator' },
                      ]}
                      aria-label="按事件来源筛选"
                      style={{ width: 160 }}
                    />
                    <Input
                      placeholder="筛选事件类型 / agentId / source"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      allowClear
                    />
                  </div>
                  <List
                    size="small"
                    bordered
                    className="event-list"
                    dataSource={[...filtered].reverse()}
                    renderItem={(item) => (
                      <List.Item>
                        <Space direction="vertical" size={0} style={{ width: '100%' }}>
                          <Text code style={{ fontSize: 11 }}>
                            {formatEventLine(item)}
                          </Text>
                          {item.type === 'report_progress' ? (
                            <Text type="secondary" ellipsis style={{ fontSize: 11 }}>
                              阶段:{' '}
                              {item.payload?.['stage']
                                ? String(item.payload['stage'])
                                : '-'}
                              {typeof item.payload?.['message'] === 'string' &&
                              item.payload?.['message']
                                ? ` · ${item.payload['message'] as string}`
                                : ''}
                            </Text>
                          ) : item.payload && Object.keys(item.payload).length > 0 ? (
                            <Text type="secondary" ellipsis style={{ fontSize: 11 }}>
                              {JSON.stringify(item.payload)}
                            </Text>
                          ) : null}
                        </Space>
                      </List.Item>
                    )}
                  />
                </div>
              </section>
            </div>
          </div>
        </Content>
      </Layout>
      <AgentLogModal
        agentId={logModalAgentId}
        open={logModalAgentId !== null}
        onClose={() => setLogModalAgentId(null)}
        events={events}
        fetchAgentLogs={fetchAgentLogs}
      />
      </XProvider>
    </ConfigProvider>
  );
}
