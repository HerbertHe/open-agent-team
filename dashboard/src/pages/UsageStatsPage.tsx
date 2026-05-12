import { useState, useEffect, useMemo, useCallback } from 'react';
import { Card, Select, Segmented, Statistic, Row, Col, Spin, Empty, Typography } from 'antd';
import { Column, Pie } from '@ant-design/charts';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { useThemeStore } from '../stores';

interface TimelineItem {
  time: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

interface AgentItem {
  agentId: string;
  totalTokens: number;
  requests: number;
}

interface ModelItem {
  model: string;
  totalTokens: number;
  requests: number;
}

interface AggregatedStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCost: number;
  timeline: TimelineItem[];
  byAgent: AgentItem[];
  byModel: ModelItem[];
}

type TimeRange = 'all' | '30d' | '7d' | 'yesterday' | 'today';

const API_BASE = import.meta.env.DEV ? 'http://localhost:8787' : '';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatTimeLabel(time: string, isHourly: boolean): string {
  if (isHourly) {
    // "YYYY-MM-DDTHH:00" -> "HH:00"
    return time.slice(11, 16);
  }
  // "YYYY-MM-DD" -> "MM-DD"
  return time.slice(5, 10);
}

export function UsageStatsPage() {
  const { t } = useTranslation();
  const currentTheme = useThemeStore((s) => s.theme);
  const isDark =
    currentTheme === 'dark' ||
    (currentTheme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('all');
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [stats, setStats] = useState<AggregatedStats | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch project list
  useEffect(() => {
    fetch(`${API_BASE}/api/usage/projects`)
      .then((r) => r.json())
      .then((data: string[]) => setProjects(data))
      .catch(() => setProjects([]));
  }, []);

  // Determine groupBy based on range
  const groupBy = useMemo(
    () => (timeRange === 'today' || timeRange === 'yesterday' ? 'hour' : 'day'),
    [timeRange],
  );
  const isHourly = groupBy === 'hour';

  // Fetch stats
  const fetchStats = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      project: selectedProject,
      range: timeRange,
      groupBy,
    });
    fetch(`${API_BASE}/api/usage/stats?${params}`)
      .then((r) => r.json())
      .then((data: AggregatedStats) => setStats(data))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, [selectedProject, timeRange, groupBy]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Chart theme config
  const chartTheme = useMemo(
    () => ({
      type: (isDark ? 'classicDark' : 'classic') as 'classicDark' | 'classic',
      view: {
        viewFill: 'transparent',
      },
    }),
    [isDark],
  );

  // Token line chart colors
  const tokenLineColors = useMemo(
    () => (isDark ? ['#60a5fa', '#34d399'] : ['#3b82f6', '#10b981']),
    [isDark],
  );

  // Prepare line chart data (Tokens)
  const tokenData = useMemo(() => {
    if (!stats?.timeline) return [];
    const arr: Array<{ time: string; value: number; type: string }> = [];
    for (const item of stats.timeline) {
      const label = formatTimeLabel(item.time, isHourly);
      arr.push({ time: label, value: item.inputTokens, type: t('usage.input_tokens') });
      arr.push({ time: label, value: item.outputTokens, type: t('usage.output_tokens') });
    }
    return arr;
  }, [stats, isHourly, t]);

  // Prepare column chart data (Requests)
  const requestData = useMemo(() => {
    if (!stats?.timeline) return [];
    return stats.timeline.map((item) => ({
      time: formatTimeLabel(item.time, isHourly),
      requests: item.requests,
      type: t('usage.total_requests'),
    }));
  }, [stats, isHourly, t]);

  // Pie data for agents
  const agentPieData = useMemo(() => {
    if (!stats?.byAgent) return [];
    return stats.byAgent.map((a) => ({ name: a.agentId, value: a.totalTokens }));
  }, [stats]);

  // Pie data for models
  const modelPieData = useMemo(() => {
    if (!stats?.byModel) return [];
    return stats.byModel.map((m) => ({ name: m.model, value: m.totalTokens }));
  }, [stats]);

  const rangeOptions = useMemo(
    () => [
      { label: t('usage.range_all'), value: 'all' as const },
      { label: t('usage.range_30d'), value: '30d' as const },
      { label: t('usage.range_7d'), value: '7d' as const },
      { label: t('usage.range_yesterday'), value: 'yesterday' as const },
      { label: t('usage.range_today'), value: 'today' as const },
    ],
    [t],
  );

  const projectOptions = useMemo(
    () => [
      { label: t('usage.all_projects'), value: 'all' },
      ...projects.map((p) => ({ label: p, value: p })),
    ],
    [projects, t],
  );

  const cardStyle: React.CSSProperties = {
    background: isDark
      ? 'rgba(29,27,24,0.7)'
      : 'rgba(240,238,232,0.7)',
    backdropFilter: 'blur(8px)',
    border: `1px solid ${isDark ? '#3a3530' : '#e3e1db'}`,
  };

  const statValueStyle: React.CSSProperties = {
    color: isDark ? '#f6f4f1' : '#2d2a26',
    fontSize: '20px',
    fontWeight: 600,
  };

  return (
    <div style={{ padding: '0 0 24px 0' }}>
      <Helmet>
        <title>{`${t('nav.usage')} - Open Agent Team`}</title>
      </Helmet>
      <Typography.Title level={3} style={{ color: 'var(--text-primary)', marginBottom: 24 }}>
        {t('usage.title')}
      </Typography.Title>

      {/* Filters */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          marginBottom: 24,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <Select
          value={selectedProject}
          onChange={setSelectedProject}
          options={projectOptions}
          style={{ minWidth: 200 }}
          popupMatchSelectWidth={false}
        />
        <Segmented
          value={timeRange}
          onChange={(v) => setTimeRange(v as TimeRange)}
          options={rangeOptions}
        />
      </div>

      <Spin spinning={loading}>
        {!stats && !loading ? (
          <Empty description={t('usage.no_data')} />
        ) : stats ? (
          <>
            {/* Summary cards */}
            <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
              <Col xs={12} sm={6}>
                <Card style={cardStyle} styles={{ body: { padding: '16px 20px' } }}>
                  <Statistic
                    title={t('usage.total_requests')}
                    value={stats.totalRequests}
                    valueStyle={statValueStyle}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card style={cardStyle} styles={{ body: { padding: '16px 20px' } }}>
                  <Statistic
                    title={t('usage.total_input_tokens')}
                    value={stats.totalInputTokens}
                    formatter={() => formatNumber(stats.totalInputTokens)}
                    valueStyle={statValueStyle}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card style={cardStyle} styles={{ body: { padding: '16px 20px' } }}>
                  <Statistic
                    title={t('usage.total_output_tokens')}
                    value={stats.totalOutputTokens}
                    formatter={() => formatNumber(stats.totalOutputTokens)}
                    valueStyle={statValueStyle}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card style={cardStyle} styles={{ body: { padding: '16px 20px' } }}>
                  <Statistic
                    title={t('usage.total_cost')}
                    value={stats.totalCost}
                    precision={4}
                    prefix="$"
                    valueStyle={statValueStyle}
                  />
                </Card>
              </Col>
            </Row>

            {/* Token usage column chart */}
            <Card
              title={t('usage.token_trend')}
              style={{ ...cardStyle, marginBottom: 24 }}
              styles={{ body: { padding: '16px 20px' } }}
            >
              {tokenData.length > 0 ? (
                <Column
                  data={tokenData}
                  xField="time"
                  yField="value"
                  colorField="type"
                  group={{ padding: 0.1 }}
                  height={300}
                  theme={chartTheme}
                  style={{ radiusTopLeft: 4, radiusTopRight: 4 }}
                  scale={{ color: { range: tokenLineColors } }}
                  axis={{
                    x: {
                      labelAutoRotate: false,
                      label: { style: { fill: isDark ? '#9c958d' : '#6d6760', fontSize: 11 } },
                      line: { style: { stroke: isDark ? '#3a3530' : '#e3e1db' } },
                    },
                    y: {
                      label: { style: { fill: isDark ? '#9c958d' : '#6d6760', fontSize: 11 } },
                      grid: { line: { style: { stroke: isDark ? '#2e2a26' : '#e9e6df' } } },
                    },
                  }}
                  tooltip={{
                    channel: 'y',
                    valueFormatter: (v: number) => formatNumber(v),
                  }}
                  legend={{
                    color: {
                      itemLabelFill: isDark ? '#c9c3bb' : '#6d6760',
                    },
                  }}
                />
              ) : (
                <Empty description={t('usage.no_data')} />
              )}
            </Card>

            {/* Request count column chart */}
            <Card
              title={t('usage.request_trend')}
              style={{ ...cardStyle, marginBottom: 24 }}
              styles={{ body: { padding: '16px 20px' } }}
            >
              {requestData.length > 0 ? (
                <Column
                  data={requestData}
                  xField="time"
                  yField="requests"
                  height={280}
                  theme={chartTheme}
                  style={{
                    fill: isDark ? '#60a5fa' : '#3b82f6',
                    radiusTopLeft: 4,
                    radiusTopRight: 4,
                  }}
                  axis={{
                    x: {
                      labelAutoRotate: false,
                      label: { style: { fill: isDark ? '#9c958d' : '#6d6760', fontSize: 11 } },
                      line: { style: { stroke: isDark ? '#3a3530' : '#e3e1db' } },
                    },
                    y: {
                      label: { style: { fill: isDark ? '#9c958d' : '#6d6760', fontSize: 11 } },
                      grid: { line: { style: { stroke: isDark ? '#2e2a26' : '#e9e6df' } } },
                    },
                  }}
                  tooltip={{
                    channel: 'y',
                    valueFormatter: (v: number) => String(v),
                  }}
                />
              ) : (
                <Empty description={t('usage.no_data')} />
              )}
            </Card>

            {/* Pie charts */}
            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Card
                  title={t('usage.agent_distribution')}
                  style={cardStyle}
                  styles={{ body: { padding: '16px 20px' } }}
                >
                  {agentPieData.length > 0 ? (
                    <Pie
                      data={agentPieData}
                      angleField="value"
                      colorField="name"
                      height={280}
                      theme={chartTheme}
                      innerRadius={0.55}
                      label={{
                        text: 'name',
                        style: { fill: isDark ? '#c9c3bb' : '#6d6760', fontSize: 11 },
                        position: 'outside',
                      }}
                      tooltip={{
                        title: 'name',
                        items: [
                          {
                            channel: 'y',
                            valueFormatter: (v: number) => formatNumber(v) + ' tokens',
                          },
                        ],
                      }}
                      legend={{
                        color: {
                          itemLabelFill: isDark ? '#c9c3bb' : '#6d6760',
                        },
                      }}
                    />
                  ) : (
                    <Empty description={t('usage.no_data')} />
                  )}
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card
                  title={t('usage.model_distribution')}
                  style={cardStyle}
                  styles={{ body: { padding: '16px 20px' } }}
                >
                  {modelPieData.length > 0 ? (
                    <Pie
                      data={modelPieData}
                      angleField="value"
                      colorField="name"
                      height={280}
                      theme={chartTheme}
                      innerRadius={0.55}
                      label={{
                        text: 'name',
                        style: { fill: isDark ? '#c9c3bb' : '#6d6760', fontSize: 11 },
                        position: 'outside',
                      }}
                      tooltip={{
                        title: 'name',
                        items: [
                          {
                            channel: 'y',
                            valueFormatter: (v: number) => formatNumber(v) + ' tokens',
                          },
                        ],
                      }}
                      legend={{
                        color: {
                          itemLabelFill: isDark ? '#c9c3bb' : '#6d6760',
                        },
                      }}
                    />
                  ) : (
                    <Empty description={t('usage.no_data')} />
                  )}
                </Card>
              </Col>
            </Row>
          </>
        ) : null}
      </Spin>
    </div>
  );
}
