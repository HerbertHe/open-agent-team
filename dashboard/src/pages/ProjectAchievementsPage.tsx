import React, { useState, useEffect, useMemo } from 'react';
import { Card, Select, DatePicker, Typography, Empty, Spin, Tabs, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { codeToHtml } from 'shiki';
import dayjs from 'dayjs';
import { useThemeStore } from '../stores';

const { Title, Text } = Typography;

interface Project {
  name: string;
  projectName: string | null;
  projectRootDir: string;
  port: number | null;
  pid: number | null;
  startedAt: string | null;
  alive: boolean;
}

interface TeamConfig {
  name: string;
  worker: {
    total: number;
    model?: string;
  };
  leader: {
    model?: string;
  };
}

const ShikiRenderer: React.FC<{ code: string; lang: string; isDark: boolean }> = ({ code, lang, isDark }) => {
  const [html, setHtml] = useState<string>('');

  useEffect(() => {
    let mounted = true;
    codeToHtml(code, {
      lang: lang || 'text',
      theme: isDark ? 'vitesse-dark' : 'vitesse-light',
    })
      .then((res) => {
        if (mounted) setHtml(res);
      })
      .catch(() => {
        if (mounted) setHtml(`<pre><code>${code}</code></pre>`);
      });
    return () => { mounted = false; };
  }, [code, lang, isDark]);

  if (!html) {
    return <pre style={{ padding: 16, margin: 0, overflowX: 'auto', borderRadius: 8 }}><code>{code}</code></pre>;
  }
  return (
    <div className="shiki-container" dangerouslySetInnerHTML={{ __html: html }} />
  );
};

export const ProjectAchievementsPage: React.FC = () => {
  const { t } = useTranslation();
  const theme = useThemeStore((s) => s.theme);
  const isDark =
    theme === 'dark' ||
    (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    borderColor: 'var(--border-color)',
    borderRadius: 12,
    overflow: 'hidden',
  };

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');

  const [teams, setTeams] = useState<TeamConfig[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>('');

  const [selectedRole, setSelectedRole] = useState<string>(''); // e.g., 'admin', 'teamName-lead', 'teamName-worker-0'

  const [selectedDate, setSelectedDate] = useState<dayjs.Dayjs>(dayjs());
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  const [changelog, setChangelog] = useState<string>('');
  const [records, setRecords] = useState<{ name: string; content: string }[]>([]);

  const [loadingConfig, setLoadingConfig] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [loadingRecords, setLoadingRecords] = useState(false);

  // 1. Fetch projects
  useEffect(() => {
    fetch('/api/projects')
      .then(res => res.json())
      .then((data: Project[]) => {
        setProjects(data);
        if (data.length > 0) {
          setSelectedProject(data[0].name);
        }
      })
      .catch(console.error);
  }, []);

  // 2. Fetch team config when project changes
  useEffect(() => {
    if (!selectedProject) return;
    setLoadingConfig(true);
    fetch(`/api/projects/${encodeURIComponent(selectedProject)}/config`)
      .then(res => res.json())
      .then((data) => {
        if (data && data.teams) {
          setTeams(data.teams);
          if (data.teams.length > 0) {
            setSelectedTeam(data.teams[0].name);
            setSelectedRole('admin');
          }
        } else {
          setTeams([]);
        }
      })
      .catch(console.error)
      .finally(() => setLoadingConfig(false));
  }, [selectedProject]);

  // Handle default role selection
  useEffect(() => {
    if (teams.length > 0 && selectedTeam && !selectedRole) {
      setSelectedRole('admin');
    }
  }, [teams, selectedTeam, selectedRole]);

  // Roles Dropdown options
  const roleOptions = useMemo(() => {
    if (!selectedTeam) return [];
    const team = teams.find(t => t.name === selectedTeam);
    if (!team) return [];

    const options = [
      { label: t('role.admin', 'Admin'), value: 'admin' },
      { label: t('role.leader', 'Leader'), value: `${selectedTeam}-lead` }
    ];
    for (let i = 0; i < team.worker.total; i++) {
      options.push({ label: `${t('role.worker', 'Worker')} ${i + 1}`, value: `${selectedTeam}-worker-${i}` });
    }
    return options;
  }, [teams, selectedTeam, t]);

  // 3. Fetch changelog and available dates when project/role changes
  useEffect(() => {
    if (!selectedProject || !selectedRole) return;

    setLoadingData(true);

    Promise.all([
      fetch(`/api/projects/${encodeURIComponent(selectedProject)}/workspaces/${encodeURIComponent(selectedRole)}/changelog`).then(r => r.json()),
      fetch(`/api/projects/${encodeURIComponent(selectedProject)}/workspaces/${encodeURIComponent(selectedRole)}/record-dates`).then(r => r.json())
    ]).then(([changelogData, datesData]) => {
      setChangelog(changelogData.content || '');
      const dates: string[] = datesData.dates || [];
      setAvailableDates(dates);

      // Auto-select date
      if (dates.length > 0) {
        const todayStr = dayjs().format('YYYY-MM-DD');
        if (dates.includes(todayStr)) {
          setSelectedDate(dayjs());
        } else {
          setSelectedDate(dayjs(dates[0])); // Dates are sorted reverse
        }
      } else {
        setSelectedDate(dayjs()); // Fallback to today if empty
      }
    }).catch(console.error)
      .finally(() => setLoadingData(false));
  }, [selectedProject, selectedRole]);

  // 4. Fetch records when project/role/date changes
  useEffect(() => {
    if (!selectedProject || !selectedRole || !selectedDate) return;

    const dateStr = selectedDate.format('YYYY-MM-DD');
    if (availableDates.length > 0 && !availableDates.includes(dateStr)) {
      setRecords([]);
      return; // Do not fetch if the date has no records
    }

    setLoadingRecords(true);
    fetch(`/api/projects/${encodeURIComponent(selectedProject)}/workspaces/${encodeURIComponent(selectedRole)}/records?date=${dateStr}`)
      .then(r => r.json())
      .then(recordsData => {
        setRecords(recordsData.files || []);
      })
      .catch(console.error)
      .finally(() => setLoadingRecords(false));
  }, [selectedProject, selectedRole, selectedDate, availableDates]);

  return (
    <>
      <Helmet>
        <title>{`${t('nav.achievements')} - Open Agent Team`}</title>
      </Helmet>
      <style>{`
        .shiki-container pre {
          padding: 16px !important;
          margin: 0 !important;
          border-radius: 8px !important;
          overflow-x: auto !important;
        }
      `}</style>
      <Title level={3} style={{ color: 'var(--text-primary)', marginBottom: 24, marginTop: 0 }}>
        {t('nav.achievements', 'Project Achievements')}
      </Title>
      <Space direction="vertical" size="large" style={{ display: 'flex' }}>

        <Card style={cardStyle}>
          <Space size="large" wrap>
            <div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                {t('achievements.project', 'Project')}
              </Text>
              <Select
                style={{ width: 200 }}
                value={selectedProject}
                onChange={setSelectedProject}
                options={projects.map(p => ({ label: p.projectName || p.name, value: p.name }))}
              />
            </div>

            <div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                {t('achievements.team', 'Team')}
              </Text>
              <Select
                style={{ width: 200 }}
                value={selectedTeam}
                onChange={(v) => {
                  setSelectedTeam(v);
                  setSelectedRole('admin');
                }}
                disabled={loadingConfig || teams.length === 0}
                options={teams.map(t => ({ label: t.name, value: t.name }))}
              />
            </div>

            <div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                {t('achievements.role', 'Role')}
              </Text>
              <Select
                style={{ width: 200 }}
                value={selectedRole}
                onChange={setSelectedRole}
                disabled={loadingConfig || roleOptions.length === 0}
                options={roleOptions}
              />
            </div>

          </Space>
        </Card>

        <Spin spinning={loadingData}>
          <Tabs
            items={[
              {
                key: 'changelog',
                label: t('achievements.changelog', 'CHANGELOG'),
                children: (
                  <Card style={{ ...cardStyle, minHeight: 400, padding: 0 }} bodyStyle={{ padding: 24 }}>
                    {changelog ? (
                      <div style={{ color: isDark ? '#f6f4f1' : '#1f2937', fontSize: 14, lineHeight: 1.6 }}>
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            code({ node, inline, className, children, ...props }: any) {
                              const match = /language-(\w+)/.exec(className || '');
                              if (!inline && match) {
                                return (
                                  <ShikiRenderer
                                    code={String(children).replace(/\n$/, '')}
                                    lang={match[1]}
                                    isDark={isDark}
                                  />
                                );
                              }
                              return (
                                <code className={className} style={{ background: isDark ? '#333' : '#eee', padding: '2px 4px', borderRadius: 4 }} {...props}>
                                  {children}
                                </code>
                              );
                            }
                          }}
                        >
                          {changelog}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <Empty description={t('achievements.no_changelog', 'No CHANGELOG found')} />
                    )}
                  </Card>
                ),
              },
              {
                key: 'records',
                label: t('achievements.records', 'Records'),
                children: (
                  <Card style={{ ...cardStyle, minHeight: 400, padding: 0 }} bodyStyle={{ padding: 24 }}>
                    <div style={{ marginBottom: 16 }}>
                      <Space>
                        <Text strong>{t('achievements.date', 'Date')}:</Text>
                        <DatePicker
                          value={selectedDate}
                          onChange={(date) => date && setSelectedDate(date)}
                          allowClear={false}
                          disabledDate={(current) => {
                            if (current > dayjs().endOf('day')) return true;
                            // If there are no available dates, all dates should be disabled.
                            return !availableDates.includes(current.format('YYYY-MM-DD'));
                          }}
                        />
                      </Space>
                    </div>
                    <Spin spinning={loadingRecords}>
                      {records.length > 0 ? (
                        <Tabs
                          tabPosition="left"
                          style={{ minHeight: 400 }}
                          items={records.map(record => ({
                            key: record.name,
                            label: record.name,
                            children: (
                              <div style={{ paddingLeft: 24 }}>
                                <Title level={5} style={{ marginTop: 0, marginBottom: 16 }}>{record.name}</Title>
                                <div style={{ color: isDark ? '#f6f4f1' : '#1f2937', fontSize: 14, lineHeight: 1.6 }}>
                                  {record.name.endsWith('.md') ? (
                                    <ReactMarkdown
                                      remarkPlugins={[remarkGfm]}
                                      components={{
                                        code({ node, inline, className, children, ...props }: any) {
                                          const match = /language-(\w+)/.exec(className || '');
                                          if (!inline && match) {
                                            return (
                                              <ShikiRenderer
                                                code={String(children).replace(/\n$/, '')}
                                                lang={match[1]}
                                                isDark={isDark}
                                              />
                                            );
                                          }
                                          return (
                                            <code className={className} style={{ background: isDark ? '#333' : '#eee', padding: '2px 4px', borderRadius: 4 }} {...props}>
                                              {children}
                                            </code>
                                          );
                                        }
                                      }}
                                    >
                                      {record.content}
                                    </ReactMarkdown>
                                  ) : (
                                    <div style={{
                                      background: isDark ? '#121212' : '#ffffff',
                                      borderRadius: 8,
                                      border: `1px solid ${isDark ? '#333' : '#eee'}`,
                                      overflow: 'hidden'
                                    }}>
                                      <ShikiRenderer
                                        code={record.content}
                                        lang={record.name.split('.').pop() || 'text'}
                                        isDark={isDark}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          }))}
                        />
                      ) : (
                        <Empty description={t('achievements.no_records', 'No records found for the selected date')} />
                      )}
                    </Spin>
                  </Card>
                ),
              }
            ]}
          />
        </Spin>
      </Space>
    </>
  );
};
