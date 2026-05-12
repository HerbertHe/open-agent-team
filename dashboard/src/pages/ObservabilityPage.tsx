import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import {
  Typography,
  Tag,
  List,
  Space,
  Alert,
  Input,
  Button,
  Select,
  Spin,
} from 'antd';
import { useTranslation } from 'react-i18next';
import { useObservability } from '../hooks/useObservability';
import { AgentLogModal } from '../components/AgentLogModal';
import { AdminInstructionSender } from '../components/AdminInstructionSender';
import { ProgressReportBox } from '../components/ProgressReportBox';
import { isTimelineNoiseEvent } from '../timelineEventFilter';
import type { ObservabilitySource } from '../types';

const AgentGraph = lazy(async () => {
  const m = await import('../components/AgentGraph');
  return { default: m.AgentGraph };
});

const { Text, Title } = Typography;

interface ProjectInfo {
  name: string;
  projectName: string | null;
  port: number | null;
  alive: boolean;
}

function extractTeamFromAgentId(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  if (agentId === 'admin') return undefined;
  const leadMatch = agentId.match(/^(.+)-lead$/);
  if (leadMatch) return leadMatch[1];
  const workerMatch = agentId.match(/^(.+)-worker-\d+$/);
  if (workerMatch) return workerMatch[1];
  return undefined;
}

function formatEventLine(ev: { ts: string; source: string; type: string; agentId?: string }): string {
  const who = ev.agentId ? ` ${ev.agentId}` : '';
  return `[${ev.ts}] ${ev.source} ${ev.type}${who}`;
}

/** 显示格式: 配置名称 (项目ID) */
function displayProjectLabel(p: ProjectInfo): string {
  const label = p.projectName ? `${p.projectName} (${p.name})` : p.name;
  return p.port ? `${label} :${p.port}` : label;
}

export function ObservabilityPage() {
  const { t } = useTranslation();

  // --- 项目列表 ---
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as ProjectInfo[];
      setProjects(data);
      const alive = data.filter(p => p.alive && p.port);
      if (alive.length > 0) {
        setSelectedProject((prev) => {
          if (!prev || !alive.some(p => p.name === prev)) return alive[0].name;
          return prev;
        });
      }
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const baseUrl = useMemo(() => {
    if (!selectedProject) return undefined;
    const proj = projects.find(p => p.name === selectedProject);
    if (proj?.port && proj.alive) return `http://127.0.0.1:${proj.port}`;
    return undefined;
  }, [selectedProject, projects]);

  // --- 可观测数据 ---
  const {
    graph,
    events,
    agentStatus,
    connected,
    graphError,
    refreshGraph,
    lastLogLineByAgent,
    fetchAgentLogs,
    teams,
  } = useObservability({ baseUrl });

  const [filter, setFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | ObservabilitySource>('all');
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [logModalAgentId, setLogModalAgentId] = useState<string | null>(null);

  const projectOptions = useMemo(() => {
    return projects
      .filter(p => p.alive && p.port)
      .map(p => ({ value: p.name, label: displayProjectLabel(p) }));
  }, [projects]);

  const teamOptions = useMemo(() => [
    { value: 'all', label: t('observability.all_teams') },
    ...teams.map((name) => ({ value: name, label: name })),
  ], [teams, t]);

  const filteredGraph = useMemo(() => {
    if (!graph || teamFilter === 'all') return graph;
    const visibleNodeIds = new Set<string>();
    for (const n of graph.nodes) {
      if (n.role === 'admin') {
        visibleNodeIds.add(n.id);
      } else if (n.teamName === teamFilter) {
        visibleNodeIds.add(n.id);
      }
    }
    return {
      nodes: graph.nodes.filter((n) => visibleNodeIds.has(n.id)),
      edges: graph.edges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)),
    };
  }, [graph, teamFilter]);

  const filtered = useMemo(() => {
    let visible = events.filter((e) => !isTimelineNoiseEvent(e));
    if (sourceFilter !== 'all') {
      visible = visible.filter((e) => e.source === sourceFilter);
    }
    if (teamFilter !== 'all') {
      visible = visible.filter((e) => {
        const team = extractTeamFromAgentId(e.agentId);
        return !e.agentId || e.agentId === 'admin' || team === teamFilter;
      });
    }
    const q = filter.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter(
      (e) =>
        e.type.toLowerCase().includes(q) ||
        (e.agentId?.toLowerCase().includes(q) ?? false) ||
        e.source.toLowerCase().includes(q)
    );
  }, [events, filter, sourceFilter, teamFilter]);

  return (
    <>
      <Helmet>
        <title>{`${t('nav.observability')} - Open Agent Team`}</title>
      </Helmet>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        {/* 标题 + 项目选择器 (左侧) */}
        <Space>
          <Title level={3} style={{ color: 'var(--text-primary)', margin: 0 }}>
            {t('observability.title')}
          </Title>
          <Select
            value={selectedProject}
            onChange={(v) => {
              setSelectedProject(v);
              setTeamFilter('all');
            }}
            options={projectOptions}
            style={{ minWidth: 220 }}
            aria-label={t('observability.select_project')}
          />
        </Space>
        {/* SSE 状态 + 刷新 (右侧) */}
        <Space>
          <Tag color={connected ? 'green' : 'red'}>
            {connected ? t('observability.sse_connected') : t('observability.sse_disconnected')}
          </Tag>
          <Button size="small" onClick={() => void refreshGraph()}>
            {t('observability.refresh_topology')}
          </Button>
        </Space>
      </div>

      {graphError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('observability.topology_error')}
          description={graphError}
        />
      )}

      <div className="dashboard-grid">
        <aside className="dashboard-left">
          <AdminInstructionSender />
          <ProgressReportBox events={events} />
        </aside>
        <div className="dashboard-right-stack">
          <section className="graph-panel" aria-label={t('observability.agent_topology')}>
            <Text strong className="dashboard-section-title">
              {t('observability.agent_topology')}
            </Text>
            <Text type="secondary" className="graph-panel-hint" style={{ display: 'block', marginBottom: 8 }}>
              {t('observability.topology_hint')}
            </Text>
            <div className="graph-panel-canvas">
              <Suspense
                fallback={
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
                    <Spin tip={t('observability.loading_topology')} />
                  </div>
                }
              >
                <AgentGraph
                  data={filteredGraph}
                  agentStatus={agentStatus}
                  lastLogLineByAgent={lastLogLineByAgent}
                  onNodeClick={(id) => setLogModalAgentId(id)}
                />
              </Suspense>
            </div>
          </section>
          <section className="timeline-panel" aria-label={t('observability.realtime_logs')}>
            <Text strong className="dashboard-section-title">
              {t('observability.realtime_logs')}
            </Text>
            <Text type="secondary" className="timeline-panel-hint" style={{ display: 'block', marginBottom: 8 }}>
              {t('observability.logs_hint')}
            </Text>
            <div className="timeline-panel-body">
              <div className="timeline-panel-filters">
                {teams.length > 0 && (
                  <Select
                    value={teamFilter}
                    onChange={setTeamFilter}
                    options={teamOptions}
                    aria-label={t('observability.all_teams')}
                    style={{ width: 160 }}
                  />
                )}
                <Select<'all' | ObservabilitySource>
                  value={sourceFilter}
                  onChange={setSourceFilter}
                  options={[
                    { value: 'all', label: t('observability.all_sources') },
                    { value: 'pi', label: 'Pi' },
                    { value: 'orchestrator', label: 'Orchestrator' },
                  ]}
                  aria-label={t('observability.all_sources')}
                  style={{ width: 160 }}
                />
                <Input
                  placeholder={t('observability.filter_placeholder')}
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
                        <pre className="event-payload">
                          {JSON.stringify(
                            {
                              stage: item.payload?.['stage'] ?? '-',
                              message:
                                typeof item.payload?.['message'] === 'string'
                                  ? (item.payload['message'] as string)
                                  : '',
                            },
                            null,
                            2
                          )}
                        </pre>
                      ) : item.payload && Object.keys(item.payload).length > 0 ? (
                        <pre className="event-payload">{JSON.stringify(item.payload, null, 2)}</pre>
                      ) : null}
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          </section>
        </div>
      </div>

      <AgentLogModal
        agentId={logModalAgentId}
        open={logModalAgentId !== null}
        onClose={() => setLogModalAgentId(null)}
        events={events}
        fetchAgentLogs={fetchAgentLogs}
      />
    </>
  );
}
