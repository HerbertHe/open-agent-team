import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Tag, Button, Space, Typography, Descriptions, Table, Popconfirm, App } from 'antd';
import { useObservability } from '../hooks/useObservability';

const { Title } = Typography;

interface ProjectInfo {
  name: string;
  projectName: string | null;
  projectRootDir: string;
  port: number | null;
  pid: number | null;
  startedAt: string | null;
  alive: boolean;
}

/** 显示格式: 配置名称 (项目ID) */
function displayProjectName(p: ProjectInfo): string {
  if (p.projectName) return `${p.projectName} (${p.name})`;
  return p.name;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const { graph } = useObservability();

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as ProjectInfo[];
      setProjects(data);
    } catch {
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const handleDeleteProject = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        void messageApi.error(body.error ?? `${res.status}`);
        return;
      }
      void messageApi.success(t('projects.deleted'));
      void loadProjects();
    } catch (e) {
      void messageApi.error(e instanceof Error ? e.message : String(e));
    }
  }, [loadProjects, t]);

  const nodes = graph?.nodes ?? [];
  const projectCount = projects.length;
  const teamCount = new Set(nodes.filter(n => n.role === 'leader').map(n => n.teamName)).size;
  const adminCount = nodes.filter(n => n.role === 'admin').length;
  const leaderCount = nodes.filter(n => n.role === 'leader').length;
  const workerCount = nodes.filter(n => n.role === 'worker').length;
  const totalAgents = adminCount + leaderCount + workerCount;

  const projectColumns = [
    {
      title: t('team_config.field.name'),
      key: 'name',
      render: (_: unknown, record: ProjectInfo) => (
        <span style={{ fontWeight: 600 }}>{displayProjectName(record)}</span>
      ),
    },
    {
      title: t('projects.port'),
      dataIndex: 'port',
      key: 'port',
      render: (port: number | null) => port ?? '—',
    },
    {
      title: t('projects.status'),
      key: 'status',
      render: (_: unknown, record: ProjectInfo) => (
        <Tag color={record.alive ? 'green' : 'default'}>
          {record.alive ? t('projects.alive') : t('projects.dead')}
        </Tag>
      ),
    },
    {
      title: t('projects.started_at'),
      dataIndex: 'startedAt',
      key: 'startedAt',
      render: (v: string | null) => v ? new Date(v).toLocaleString() : '—',
    },
    {
      title: t('projects.actions'),
      key: 'actions',
      width: 100,
      render: (_: unknown, record: ProjectInfo) => (
        <Popconfirm
          title={t('projects.delete_confirm_title')}
          description={t('projects.delete_confirm_desc')}
          onConfirm={() => void handleDeleteProject(record.name)}
          okText={t('projects.delete_ok')}
          cancelText={t('projects.delete_cancel')}
          okButtonProps={{ danger: true }}
          disabled={record.alive}
          placement="topRight"
        >
          <Button
            type="link"
            danger
            size="small"
            disabled={record.alive}
            title={record.alive ? t('projects.delete_disabled_tip') : undefined}
          >
            {t('projects.delete')}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ color: 'var(--text-primary)', marginBottom: 24 }}>
        {t('dashboard.title')}
      </Title>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, marginBottom: 24 }}>
        {/* Project Info Card */}
        <Card
          title={t('dashboard.project_info')}
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
          styles={{ header: { borderBottomColor: 'var(--border-color)', color: 'var(--text-primary)' } }}
        >
          <Descriptions column={1} size="small">
            <Descriptions.Item label={t('dashboard.projects')}>
              {projectCount}
            </Descriptions.Item>
            <Descriptions.Item label={t('dashboard.teams')}>
              {teamCount}
            </Descriptions.Item>
            <Descriptions.Item label={t('dashboard.agents_total')}>
              <Space size="middle">
                <span>{totalAgents}</span>
                <Tag>{`Admin ${adminCount}`}</Tag>
                <Tag>{`Leader ${leaderCount}`}</Tag>
                <Tag>{`Worker ${workerCount}`}</Tag>
              </Space>
            </Descriptions.Item>
          </Descriptions>
        </Card>
      </div>

      {/* Running Projects */}
      <Card
        title={t('projects.title')}
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
        styles={{ header: { borderBottomColor: 'var(--border-color)', color: 'var(--text-primary)' } }}
        extra={
          <Button type="link" size="small" onClick={() => void loadProjects()}>
            {t('header.refresh')}
          </Button>
        }
      >
        <Table
          dataSource={projects}
          columns={projectColumns}
          rowKey="name"
          loading={projectsLoading}
          pagination={false}
          size="small"
          locale={{ emptyText: t('projects.no_projects') }}
        />
      </Card>
    </div>
  );
}
