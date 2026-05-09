import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Typography,
  Button,
  Space,
  Spin,
  Alert,
  Card,
  Form,
  Input,
  Select,
  Switch,
  InputNumber,
  Collapse,
  Divider,
  message,
} from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { codeToHtml } from 'shiki';

const { Title, Text } = Typography;
const { TextArea } = Input;

interface ProjectInfo {
  name: string;
  projectName: string | null;
  port: number | null;
  alive: boolean;
}

interface TeamFileConfig {
  $schema?: string;
  model?: string;
  models: Record<string, string>;
  providers?: Record<string, { compatible_type: string; base_url?: string; api_key?: string }>;
  project: { name: string; repo: string; base_branch: string };
  runtime?: { mode?: string; persistence?: { state_dir?: string } };
  workspace?: {
    provider?: string; root_dir?: string; persistent?: boolean;
    git?: { remote?: string; lfs?: string }; sparse_checkout?: { enabled?: boolean };
  };
  admin: { name: string; description: string; model?: string; prompt: string; skills: Array<{ source: string; names?: string[] }> };
  teams: Array<{
    name: string; branch_prefix: string;
    leader: { name: string; description: string; model?: string; prompt: string; skills: Array<{ source: string; names?: string[] }>; repos?: string[] };
    worker: { total: number; model?: string; prompt: string; extra_skills: Array<{ source: string; names?: string[] }>; lifecycle?: string; skill_sync?: string };
  }>;
}

function displayProjectLabel(p: ProjectInfo): string {
  const label = p.projectName ? `${p.projectName} (${p.name})` : p.name;
  return p.port ? `${label} :${p.port}` : label;
}

/** Detect dark mode */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', handler);
    // Also check data-theme attribute
    const obs = new MutationObserver(() => {
      const theme = document.documentElement.getAttribute('data-theme');
      if (theme) setDark(theme === 'dark');
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', handler); obs.disconnect(); };
  }, []);
  return dark;
}

export function TeamConfigPage() {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<TeamFileConfig | null>(null);
  const [jsonPreview, setJsonPreview] = useState('');
  const [shikiHtml, setShikiHtml] = useState('');
  const isDark = useIsDark();

  // --- Project list & selection ---
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) return;
      const data = (await res.json()) as ProjectInfo[];
      setProjects(data);
      // Auto-select first project if none selected
      if (data.length > 0) {
        setSelectedProject((prev) => {
          if (!prev || !data.some(p => p.name === prev)) return data[0].name;
          return prev;
        });
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const projectOptions = useMemo(() => {
    return projects.map((p) => ({ value: p.name, label: displayProjectLabel(p) }));
  }, [projects]);

  // --- API URLs based on selection ---
  const configApiUrl = useMemo(() => {
    if (!selectedProject) return '/api/team-config';
    return `/api/projects/${encodeURIComponent(selectedProject)}/config`;
  }, [selectedProject]);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(configApiUrl);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json() as TeamFileConfig;
      setConfig(data);
      form.setFieldsValue(transformToFormValues(data));
      const preview = JSON.stringify(data, null, 2);
      setJsonPreview(preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [form, configApiUrl]);

  useEffect(() => { void fetchConfig(); }, [fetchConfig]);

  // --- Shiki highlight ---
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!jsonPreview) { setShikiHtml(''); return; }
    // Debounce highlighting
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      void codeToHtml(jsonPreview, {
        lang: 'json',
        theme: isDark ? 'vitesse-dark' : 'vitesse-light',
      }).then(setShikiHtml).catch(() => setShikiHtml(''));
    }, 150);
    return () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); };
  }, [jsonPreview, isDark]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const values = form.getFieldsValue(true);
      const payload = transformFromFormValues(values, config);
      const res = await fetch(configApiUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setConfig(payload);
      setJsonPreview(JSON.stringify(payload, null, 2));
      void message.success(t('team_config.save_success'));

      // Trigger project restart
      if (selectedProject) {
        try {
          void message.loading({ content: t('team_config.restarting'), key: 'restart', duration: 0 });
          const restartRes = await fetch(`/api/projects/${encodeURIComponent(selectedProject)}/restart`, { method: 'POST' });
          if (!restartRes.ok) {
            const body = (await restartRes.json()) as { error?: string };
            void message.error({ content: body.error ?? 'Restart failed', key: 'restart' });
          } else {
            void message.success({ content: t('team_config.restart_success'), key: 'restart' });
          }
        } catch (e) {
          void message.warning({ content: t('team_config.restart_failed'), key: 'restart' });
        }
      }
    } catch (e) {
      void message.error(`${t('team_config.save_error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleFormChange = () => {
    try {
      const values = form.getFieldsValue(true);
      const payload = transformFromFormValues(values, config);
      setJsonPreview(JSON.stringify(payload, null, 2));
    } catch {
      // ignore partial form state
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin tip={t('team_config.loading')} size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('team_config.load_error')}
        description={error}
        action={<Button onClick={() => void fetchConfig()}>{t('header.refresh')}</Button>}
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Space>
          <Title level={3} style={{ color: 'var(--text-primary)', margin: 0 }}>
            {t('team_config.title')}
          </Title>
          <Select
            value={selectedProject}
            onChange={(v) => setSelectedProject(v)}
            options={projectOptions}
            style={{ minWidth: 220 }}
            aria-label={t('observability.select_project')}
          />
        </Space>
        <Space>
          <Button onClick={() => { form.setFieldsValue(transformToFormValues(config!)); handleFormChange(); }}>
            {t('team_config.reset')}
          </Button>
          <Button type="primary" loading={saving} onClick={() => void handleSave()}>
            {saving ? t('team_config.saving') : t('team_config.save')}
          </Button>
        </Space>
      </div>

      <div className="config-grid">
        {/* Form */}
        <div style={{ minWidth: 0 }}>
          <Form form={form} layout="vertical" onValuesChange={handleFormChange}>
            <Collapse
              defaultActiveKey={['project', 'admin', 'teams']}
              items={[
                {
                  key: 'global',
                  label: t('team_config.section.global'),
                  children: (
                    <>
                      <Form.Item label={t('team_config.field.model')} name="model"><Input placeholder="e.g. default" /></Form.Item>
                      <Form.List name="modelAliases">
                        {(fields, { add, remove }) => (
                          <>
                            <Text strong>{t('team_config.section.models')}</Text>
                            {fields.map((field) => (
                              <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                                <Form.Item name={[field.name, 'alias']} noStyle><Input placeholder={t('team_config.field.alias')} style={{ width: 140 }} /></Form.Item>
                                <Form.Item name={[field.name, 'modelId']} noStyle><Input placeholder={t('team_config.field.model_id')} style={{ width: 220 }} /></Form.Item>
                                <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                              </Space>
                            ))}
                            <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />} size="small">{t('action.add_model_alias')}</Button>
                          </>
                        )}
                      </Form.List>
                    </>
                  ),
                },
                {
                  key: 'providers',
                  label: t('team_config.section.providers'),
                  children: (
                    <Form.List name="providers">
                      {(fields, { add, remove }) => (
                        <>
                          {fields.map((field) => (
                            <Card key={field.key} size="small" style={{ marginBottom: 8 }} extra={<Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />}>
                              <Form.Item label={t('team_config.field.name')} name={[field.name, 'key']}><Input /></Form.Item>
                              <Form.Item label={t('team_config.field.compatible_type')} name={[field.name, 'compatible_type']}>
                                <Select options={[{ value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }]} />
                              </Form.Item>
                              <Form.Item label={t('team_config.field.base_url')} name={[field.name, 'base_url']}><Input /></Form.Item>
                              <Form.Item label={t('team_config.field.api_key')} name={[field.name, 'api_key']}><Input.Password /></Form.Item>
                            </Card>
                          ))}
                          <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />} size="small">{t('action.add_provider')}</Button>
                        </>
                      )}
                    </Form.List>
                  ),
                },
                {
                  key: 'project',
                  label: t('team_config.section.project'),
                  children: (
                    <>
                      <Form.Item label={t('team_config.field.name')} name={['project', 'name']} rules={[{ required: true }]}><Input /></Form.Item>
                      <Form.Item label={t('team_config.field.repo')} name={['project', 'repo']} rules={[{ required: true }]}><Input /></Form.Item>
                      <Form.Item label={t('team_config.field.base_branch')} name={['project', 'base_branch']}>
                        <Select options={[{ value: 'main' }, { value: 'master' }]} />
                      </Form.Item>
                    </>
                  ),
                },
                {
                  key: 'runtime',
                  label: t('team_config.section.runtime'),
                  children: (
                    <>
                      <Form.Item label={t('team_config.field.mode')} name={['runtime', 'mode']}>
                        <Select options={[{ value: 'local_process' }, { value: 'flue' }]} />
                      </Form.Item>
                      <Form.Item label={t('team_config.field.state_dir')} name={['runtime', 'persistence', 'state_dir']}><Input /></Form.Item>
                    </>
                  ),
                },
                {
                  key: 'workspace',
                  label: t('team_config.section.workspace'),
                  children: (
                    <>
                      <Form.Item label={t('team_config.field.provider')} name={['workspace', 'provider']}>
                        <Select options={[{ value: 'worktree' }, { value: 'shared_clone' }, { value: 'full_clone' }]} />
                      </Form.Item>
                      <Form.Item label={t('team_config.field.root_dir')} name={['workspace', 'root_dir']}><Input /></Form.Item>
                      <Form.Item label={t('team_config.field.persistent')} name={['workspace', 'persistent']} valuePropName="checked"><Switch /></Form.Item>
                      <Form.Item label={t('team_config.field.remote')} name={['workspace', 'git', 'remote']}><Input /></Form.Item>
                      <Form.Item label={t('team_config.field.lfs')} name={['workspace', 'git', 'lfs']}>
                        <Select options={[{ value: 'pull' }, { value: 'skip' }, { value: 'allow_pull_deny_change' }]} />
                      </Form.Item>
                      <Form.Item label={t('team_config.field.sparse_checkout')} name={['workspace', 'sparse_checkout', 'enabled']} valuePropName="checked"><Switch /></Form.Item>
                    </>
                  ),
                },
                {
                  key: 'admin',
                  label: t('team_config.section.admin'),
                  children: (
                    <>
                      <Form.Item label={t('team_config.field.name')} name={['admin', 'name']} rules={[{ required: true }]}><Input /></Form.Item>
                      <Form.Item label={t('team_config.field.description')} name={['admin', 'description']} rules={[{ required: true }]}><TextArea rows={2} /></Form.Item>
                      <Form.Item label={t('team_config.field.model')} name={['admin', 'model']}><Input /></Form.Item>
                      <Form.Item label={t('team_config.field.prompt')} name={['admin', 'prompt']} rules={[{ required: true }]}><TextArea rows={4} /></Form.Item>
                    </>
                  ),
                },
                {
                  key: 'teams',
                  label: t('team_config.section.teams'),
                  children: (
                    <Form.List name="teams">
                      {(fields, { add, remove }) => (
                        <>
                          {fields.map((field) => (
                            <Card
                              key={field.key}
                              size="small"
                              style={{ marginBottom: 12 }}
                              title={<Form.Item name={[field.name, 'name']} noStyle><Input placeholder={t('team_config.field.name')} bordered={false} style={{ fontWeight: 600 }} /></Form.Item>}
                              extra={<Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />}
                            >
                              <Form.Item label={t('team_config.field.branch_prefix')} name={[field.name, 'branch_prefix']}><Input /></Form.Item>
                              <Divider plain>Leader</Divider>
                              <Form.Item label={t('team_config.field.name')} name={[field.name, 'leader', 'name']}><Input /></Form.Item>
                              <Form.Item label={t('team_config.field.description')} name={[field.name, 'leader', 'description']}><TextArea rows={2} /></Form.Item>
                              <Form.Item label={t('team_config.field.model')} name={[field.name, 'leader', 'model']}><Input /></Form.Item>
                              <Form.Item label={t('team_config.field.prompt')} name={[field.name, 'leader', 'prompt']}><TextArea rows={3} /></Form.Item>
                              <Divider plain>Worker</Divider>
                              <Form.Item label={t('team_config.field.total')} name={[field.name, 'worker', 'total']}><InputNumber min={1} /></Form.Item>
                              <Form.Item label={t('team_config.field.model')} name={[field.name, 'worker', 'model']}><Input /></Form.Item>
                              <Form.Item label={t('team_config.field.prompt')} name={[field.name, 'worker', 'prompt']}><TextArea rows={3} /></Form.Item>
                              <Form.Item label={t('team_config.field.lifecycle')} name={[field.name, 'worker', 'lifecycle']}>
                                <Select options={[{ value: 'ephemeral_after_merge_to_main' }, { value: 'persistent' }]} />
                              </Form.Item>
                              <Form.Item label={t('team_config.field.skill_sync')} name={[field.name, 'worker', 'skill_sync']}>
                                <Select options={[{ value: 'inherit_and_inject_on_spawn' }, { value: 'manual' }]} />
                              </Form.Item>
                            </Card>
                          ))}
                          <Button type="dashed" onClick={() => add({ name: '', branch_prefix: '', leader: { name: '', description: '', prompt: '', skills: [] }, worker: { total: 1, prompt: '', extra_skills: [] } })} icon={<PlusOutlined />}>
                            {t('action.add_team')}
                          </Button>
                        </>
                      )}
                    </Form.List>
                  ),
                },
              ]}
            />
          </Form>
        </div>

        {/* JSON Preview with Shiki */}
        <Card
          title={t('team_config.json_preview')}
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
          styles={{ header: { borderBottomColor: 'var(--border-color)', color: 'var(--text-primary)' } }}
        >
          {shikiHtml ? (
            <div
              style={{
                maxHeight: 'calc(100vh - 200px)',
                overflow: 'auto',
                fontSize: 12,
                margin: 0,
              }}
              dangerouslySetInnerHTML={{ __html: shikiHtml }}
            />
          ) : (
            <pre style={{
              maxHeight: 'calc(100vh - 200px)',
              overflow: 'auto',
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-primary)',
              margin: 0,
            }}>
              {jsonPreview}
            </pre>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ---- Helpers ---- */

function transformToFormValues(config: TeamFileConfig) {
  const modelAliases = Object.entries(config.models || {}).map(([alias, modelId]) => ({ alias, modelId }));
  const providers = Object.entries(config.providers || {}).map(([key, v]) => ({ key, ...v }));

  return {
    model: config.model,
    modelAliases,
    providers,
    project: config.project,
    runtime: config.runtime || {},
    workspace: config.workspace || {},
    admin: config.admin,
    teams: config.teams,
  };
}

function transformFromFormValues(values: any, original: TeamFileConfig | null): TeamFileConfig {
  const models: Record<string, string> = {};
  for (const a of values.modelAliases || []) {
    if (a?.alias && a?.modelId) models[a.alias] = a.modelId;
  }

  const providers: Record<string, any> = {};
  for (const p of values.providers || []) {
    if (p?.key) {
      const { key, ...rest } = p;
      providers[key] = rest;
    }
  }

  return {
    $schema: original?.$schema,
    model: values.model || undefined,
    models,
    providers: Object.keys(providers).length > 0 ? providers : undefined,
    project: values.project,
    runtime: values.runtime,
    workspace: values.workspace,
    admin: values.admin,
    teams: values.teams,
  };
}
