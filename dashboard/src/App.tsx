import { lazy, Suspense, useMemo, useState } from 'react';
import { ConfigProvider, Layout, Typography, Tag, List, Space, Alert, Input, Button, theme, Spin } from 'antd';
import { useObservability } from './hooks/useObservability';
import { AgentLogModal } from './components/AgentLogModal';
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
  const [logModalAgentId, setLogModalAgentId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return events;
    return events.filter(
      (e) =>
        e.type.toLowerCase().includes(q) ||
        (e.agentId?.toLowerCase().includes(q) ?? false) ||
        e.source.toLowerCase().includes(q)
    );
  }, [events, filter]);

  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ display: 'flex', alignItems: 'center', gap: 16, background: '#001529' }}>
          <Text strong style={{ color: '#fff', fontSize: 16 }}>
            Open Agent Team · 可观测
          </Text>
          <Tag color={connected ? 'green' : 'red'}>{connected ? 'SSE 已连接' : 'SSE 未连接'}</Tag>
          <Button size="small" onClick={() => void refreshGraph()}>
            刷新拓扑
          </Button>
        </Header>
        <Content style={{ padding: 16 }}>
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
            <div className="graph-panel">
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                Agent 拓扑（Admin → Leader → Worker）；仅展示已注册的 Agent；节点第二行起为进程日志摘要；点击节点查看完整日志
              </Text>
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
            <div className="timeline-panel">
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <Input
                  placeholder="筛选事件类型 / agentId / source"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  allowClear
                />
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
                        {item.payload && Object.keys(item.payload).length > 0 && (
                          <Text type="secondary" ellipsis style={{ fontSize: 11 }}>
                            {JSON.stringify(item.payload)}
                          </Text>
                        )}
                      </Space>
                    </List.Item>
                  )}
                />
              </Space>
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
    </ConfigProvider>
  );
}
