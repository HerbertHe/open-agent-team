import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import { useBlocker } from 'react-router-dom';
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
  Tag,
  App,
} from 'antd';
import type { FormInstance } from 'antd';
import { PlusOutlined, DeleteOutlined, DownOutlined, RightOutlined, SyncOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

const { Title } = Typography;
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
    worker: { total: number; model?: string; prompt: string; extra_skills: Array<{ source: string; names?: string[] }>; skill_sync?: string };
  }>;
}

function displayProjectLabel(p: ProjectInfo): string {
  const label = p.projectName ? `${p.projectName} (${p.name})` : p.name;
  return p.port ? `${label} :${p.port}` : label;
}

/** Detect dark mode — synced with global theme store */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() => {
    // Check data-theme attribute first (set by theme store)
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'white' || attr === 'light') return false;
    // 'auto' or unset — fall back to OS preference
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const resolve = () => {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'dark') return true;
      if (attr === 'white' || attr === 'light') return false;
      return mq.matches; // auto
    };
    const mqHandler = () => setDark(resolve());
    mq.addEventListener('change', mqHandler);
    // Watch data-theme attribute changes
    const obs = new MutationObserver(() => setDark(resolve()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', mqHandler); obs.disconnect(); };
  }, []);
  return dark;
}

/** Reusable Select that derives options from modelAliases form field */
function ModelAliasSelect({ form, ...rest }: { form: FormInstance } & Omit<ComponentProps<typeof Select>, 'options'>) {
  const modelAliases: Array<{ alias?: string; modelId?: string }> | undefined = Form.useWatch('modelAliases', form);
  const options = useMemo(() => {
    if (!modelAliases) return [];
    return modelAliases
      .filter((a) => a?.alias)
      .map((a) => ({ value: a.alias!, label: `${a.alias}${a.modelId ? ` → ${a.modelId}` : ''}` }));
  }, [modelAliases]);
  return <Select {...rest} options={options} />;
}

/** Collapsible provider card */
function ProviderCard({ field, index, remove, t }: {
  field: { key: number; name: number };
  index: number;
  remove: (index: number) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <Card
      key={field.key}
      size="small"
      style={{ marginBottom: 8, cursor: 'default' }}
      styles={{ body: collapsed ? { padding: 0 } : undefined }}
      title={
        <span
          style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <RightOutlined style={{ fontSize: 10 }} /> : <DownOutlined style={{ fontSize: 10 }} />}
          {t('team_config.provider_index', { index: index + 1 })}
        </span>
      }
      extra={<Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />}
    >
      {!collapsed && (
        <>
          <Form.Item label={t('team_config.field.name')} name={[field.name, 'key']}><Input /></Form.Item>
          <Form.Item label={t('team_config.field.compatible_type')} name={[field.name, 'compatible_type']}>
            <Select options={[{ value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }]} />
          </Form.Item>
          <Form.Item label={t('team_config.field.base_url')} name={[field.name, 'base_url']}><Input /></Form.Item>
          <Form.Item label={t('team_config.field.api_key')} name={[field.name, 'api_key']}><Input.Password /></Form.Item>
        </>
      )}
    </Card>
  );
}

/** Collapsible team card */
function TeamCard({ field, index, remove, form, t }: {
  field: { key: number; name: number };
  index: number;
  remove: (index: number) => void;
  form: FormInstance;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [collapsed, setCollapsed] = useState(true);

  const skillSyncOptions = [
    { value: 'inherit_and_inject_on_spawn', label: t('team_config.option.skill_sync_inherit') },
    { value: 'manual', label: t('team_config.option.skill_sync_manual') },
  ];

  return (
    <Card
      key={field.key}
      size="small"
      style={{ marginBottom: 12, cursor: 'default' }}
      styles={{ body: collapsed ? { padding: 0 } : undefined }}
      title={
        <span
          style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <RightOutlined style={{ fontSize: 10 }} /> : <DownOutlined style={{ fontSize: 10 }} />}
          {t('team_config.team_index', { index: index + 1 })}
        </span>
      }
      extra={<Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />}
    >
      {!collapsed && (
        <>
          <Form.Item label={t('team_config.field.team_name')} name={[field.name, 'name']} rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label={t('team_config.field.branch_prefix')} name={[field.name, 'branch_prefix']} rules={[{ required: true }]}><Input /></Form.Item>
          <Divider plain>{t('team_config.section.leader')}</Divider>
          <Form.Item label={t('team_config.field.name')} name={[field.name, 'leader', 'name']} rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label={t('team_config.field.description')} name={[field.name, 'leader', 'description']} rules={[{ required: true }]}><TextArea rows={2} /></Form.Item>
          <Form.Item label={t('team_config.field.model')} name={[field.name, 'leader', 'model']}>
            <ModelAliasSelect form={form} placeholder={t('team_config.placeholder.inherit_global')} allowClear />
          </Form.Item>
          <Form.Item label={t('team_config.field.prompt')} name={[field.name, 'leader', 'prompt']} rules={[{ required: true }]}><TextArea rows={3} /></Form.Item>
          <Divider plain>{t('team_config.section.worker')}</Divider>
          <Form.Item label={t('team_config.field.total')} name={[field.name, 'worker', 'total']} rules={[{ required: true }]}><InputNumber min={1} /></Form.Item>
          <Form.Item label={t('team_config.field.model')} name={[field.name, 'worker', 'model']}>
            <ModelAliasSelect form={form} placeholder={t('team_config.placeholder.inherit_global')} allowClear />
          </Form.Item>
          <Form.Item label={t('team_config.field.prompt')} name={[field.name, 'worker', 'prompt']} rules={[{ required: true }]}><TextArea rows={3} /></Form.Item>
          <Form.Item label={t('team_config.field.skill_sync')} name={[field.name, 'worker', 'skill_sync']}>
            <Select options={skillSyncOptions} />
          </Form.Item>
        </>
      )}
    </Card>
  );
}

export function TeamConfigPage() {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const { modal, message: messageApi } = App.useApp();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<TeamFileConfig | null>(null);
  const [originalJson, setOriginalJson] = useState('');
  const [currentJson, setCurrentJson] = useState('');
  const isDark = useIsDark();

  // --- Project list & selection ---
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const CACHE_KEY = `oat-unsaved-${selectedProject || '_default'}`;

  // --- Global model options (from ~/.oat/models.json) ---
  const [globalModelOptions, setGlobalModelOptions] = useState<Array<{ label: string; value: string }>>([]);

  const loadGlobalModels = useCallback(async () => {
    try {
      const res = await fetch('/api/global-models');
      if (!res.ok) return;
      const data = (await res.json()) as { models?: Record<string, string> };
      const models = data.models ?? {};
      setGlobalModelOptions(
        Object.keys(models).map((key) => ({ label: key, value: key }))
      );
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadGlobalModels(); }, [loadGlobalModels]);



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
      const orig = JSON.stringify(data, null, 2);
      setOriginalJson(orig);
      // Restore from localStorage if exists
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        try {
          const cachedObj = JSON.parse(cached);
          form.setFieldsValue(transformToFormValues(cachedObj));
          setCurrentJson(JSON.stringify(cachedObj, null, 2));
        } catch {
          form.setFieldsValue(transformToFormValues(data));
          setCurrentJson(orig);
        }
      } else {
        form.setFieldsValue(transformToFormValues(data));
        setCurrentJson(orig);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [form, configApiUrl]);

  useEffect(() => { void fetchConfig(); }, [fetchConfig]);

  // --- Dirty tracking ---
  const isDirty = useMemo(() => originalJson !== currentJson, [originalJson, currentJson]);

  // Cache to localStorage on change
  useEffect(() => {
    if (!isDirty || !currentJson) return;
    try {
      localStorage.setItem(CACHE_KEY, currentJson);
    } catch { /* quota exceeded, ignore */ }
  }, [currentJson, isDirty, CACHE_KEY]);

  const clearCache = useCallback(() => {
    localStorage.removeItem(CACHE_KEY);
  }, [CACHE_KEY]);

  // --- Navigation guard (route change) ---
  const blocker = useBlocker(isDirty);

  useEffect(() => {
    if (blocker.state === 'blocked') {
      modal.confirm({
        title: t('team_config.unsaved_title'),
        content: t('team_config.unsaved_message'),
        okText: t('team_config.unsaved_leave'),
        cancelText: t('common.cancel'),
        onOk: () => {
          clearCache();
          blocker.proceed();
        },
        onCancel: () => blocker.reset(),
      });
    }
  }, [blocker, t, clearCache]);

  // --- Browser refresh/close guard ---
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) { e.preventDefault(); }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // --- Diff computation ---
  const diffLines = useMemo(() => {
    const origLines = originalJson.split('\n');
    const currLines = currentJson.split('\n');
    // Simple LCS-based diff
    const max = origLines.length + currLines.length;
    const result: Array<{ type: 'add' | 'remove' | 'same'; text: string }> = [];
    // Build a map of common subsequences with a simplified approach
    const lcsTable: number[][] = Array.from({ length: origLines.length + 1 }, () => Array(currLines.length + 1).fill(0));
    for (let i = origLines.length - 1; i >= 0; i--) {
      for (let j = currLines.length - 1; j >= 0; j--) {
        if (origLines[i] === currLines[j]) lcsTable[i][j] = lcsTable[i + 1][j + 1] + 1;
        else lcsTable[i][j] = Math.max(lcsTable[i + 1][j], lcsTable[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < origLines.length || j < currLines.length) {
      if (i < origLines.length && j < currLines.length && origLines[i] === currLines[j]) {
        result.push({ type: 'same', text: origLines[i] });
        i++; j++;
      } else if (j < currLines.length && (i >= origLines.length || lcsTable[i][j + 1] >= lcsTable[i + 1][j])) {
        result.push({ type: 'add', text: currLines[j] });
        j++;
      } else {
        result.push({ type: 'remove', text: origLines[i] });
        i++;
      }
      if (result.length > max + 10) break; // safety
    }
    return result;
  }, [originalJson, currentJson]);

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
      const newJson = JSON.stringify(payload, null, 2);
      setOriginalJson(newJson);
      setCurrentJson(newJson);
      clearCache();
      void messageApi.success(t('team_config.save_success'));

      // --- Sync providers & models to global ~/.oat/models.json ---
      await syncToGlobalModels(payload, t, messageApi, modal);

      // Trigger project restart
      if (selectedProject) {
        try {
          void messageApi.loading({ content: t('team_config.restarting'), key: 'restart', duration: 0 });
          const restartRes = await fetch(`/api/projects/${encodeURIComponent(selectedProject)}/restart`, { method: 'POST' });
          if (!restartRes.ok) {
            const body = (await restartRes.json()) as { error?: string };
            void messageApi.error({ content: body.error ?? 'Restart failed', key: 'restart' });
          } else {
            void messageApi.success({ content: t('team_config.restart_success'), key: 'restart' });
          }
        } catch (e) {
          void messageApi.warning({ content: t('team_config.restart_failed'), key: 'restart' });
        }
      }
    } catch (e) {
      void messageApi.error(`${t('team_config.save_error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // --- Fetch all provider models & sync to global ---
  const [syncing, setSyncing] = useState(false);

  const handleFetchAllModels = async () => {
    setSyncing(true);
    try {
      const providers: Array<{ key?: string; base_url?: string; api_key?: string }> = form.getFieldValue('providers') ?? [];
      if (providers.length === 0) {
        void messageApi.warning(t('team_config.test.no_base_url'));
        return;
      }

      // Fetch models from each provider in parallel
      const allNewModels: Record<string, string> = {};
      const allProviderConfigs: Record<string, unknown> = {};
      const failures: Array<{ name: string; error: string }> = [];

      await Promise.all(
        providers.map(async (prov, idx) => {
          const providerKey = prov.key || `provider-${idx}`;
          const baseUrl = prov.base_url?.replace(/\/+$/, '');
          if (!baseUrl) {
            failures.push({ name: providerKey, error: t('team_config.test.no_base_url') });
            return;
          }
          try {
            const headers: Record<string, string> = {};
            if (prov.api_key) headers['Authorization'] = `Bearer ${prov.api_key}`;
            const res = await fetch(`${baseUrl}/models`, { headers });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const modelList: Array<{ id?: string }> = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
            const ids = modelList.map((m) => m.id ?? '').filter(Boolean);
            for (const id of ids) {
              allNewModels[`${providerKey}/${id}`] = id;
            }
            // Also persist provider config (without api_key for safety — user can choose)
            allProviderConfigs[providerKey] = {
              compatible_type: (prov as Record<string, unknown>).compatible_type ?? 'openai',
              base_url: baseUrl,
            };
          } catch (e) {
            failures.push({ name: providerKey, error: e instanceof Error ? e.message : String(e) });
          }
        }),
      );

      // Fetch current global config
      const globalRes = await fetch('/api/global-models');
      if (!globalRes.ok) throw new Error(`${globalRes.status}`);
      const globalData = (await globalRes.json()) as { providers: Record<string, unknown>; models: Record<string, string> };
      const existingModels = globalData.models ?? {};

      // Compute diff
      const hasExisting = Object.keys(existingModels).length > 0;
      const added = Object.keys(allNewModels).filter((k) => !(k in existingModels));
      const removed = Object.keys(existingModels).filter((k) => !(k in allNewModels));
      const unchanged = Object.keys(allNewModels).filter((k) => k in existingModels);

      // If no existing global config, write directly without diff
      if (!hasExisting && failures.length === 0) {
        const putRes = await fetch('/api/global-models', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: allProviderConfigs, models: allNewModels, replace: true }),
        });
        if (putRes.ok) { void messageApi.success(t('team_config.sync.success')); void loadGlobalModels(); }
        else void messageApi.warning(t('team_config.sync.failed'));
        return;
      }

      const buildDiffContent = () => (
        <div>
          {failures.length > 0 && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={t('team_config.test.failed')}
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {failures.map((f) => (
                    <li key={f.name}><strong>{f.name}</strong>: {f.error}</li>
                  ))}
                </ul>
              }
            />
          )}
          <div style={{ maxHeight: 320, overflow: 'auto', fontSize: 13, lineHeight: '24px' }}>
            {added.map((k) => (
              <div key={k}><Tag color="green">+</Tag> {k}</div>
            ))}
            {removed.map((k) => (
              <div key={k}><Tag color="red">−</Tag> {k}</div>
            ))}
            {unchanged.map((k) => (
              <div key={k} style={{ opacity: 0.45 }}><Tag>&nbsp;</Tag> {k}</div>
            ))}
          </div>
        </div>
      );

      if (added.length === 0 && removed.length === 0 && failures.length === 0) {
        void messageApi.info(t('team_config.sync.success'));
        return;
      }

      if (added.length === 0 && removed.length === 0 && failures.length > 0) {
        // Only failures, no changes to save
        modal.error({
          title: t('team_config.test.failed'),
          content: (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {failures.map((f) => (
                <li key={f.name}><strong>{f.name}</strong>: {f.error}</li>
              ))}
            </ul>
          ),
        });
        return;
      }

      // Has changes — show diff modal
      modal.confirm({
        title: t('team_config.sync.confirm_title'),
        width: 560,
        content: buildDiffContent(),
        okText: t('common.confirm'),
        cancelText: t('common.cancel'),
        onOk: async () => {
          const mergedModels = { ...allNewModels };
          // Keep models from providers that failed (don't remove them)
          const failedPrefixes = failures.map((f) => `${f.name}/`);
          for (const [k, v] of Object.entries(existingModels)) {
            if (failedPrefixes.some((p) => k.startsWith(p))) {
              mergedModels[k] = v;
            }
          }
          const putRes = await fetch('/api/global-models', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providers: { ...globalData.providers, ...allProviderConfigs },
              models: mergedModels,
              replace: true,
            }),
          });
          if (putRes.ok) { void messageApi.success(t('team_config.sync.success')); void loadGlobalModels(); }
          else void messageApi.warning(t('team_config.sync.failed'));
        },
      });
    } catch (e) {
      void messageApi.error(`${t('team_config.sync.failed')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleFormChange = () => {
    try {
      const values = form.getFieldsValue(true);
      const payload = transformFromFormValues(values, config);
      setCurrentJson(JSON.stringify(payload, null, 2));
    } catch {
      // ignore partial form state
    }
  };

  const handleReset = () => {
    form.setFieldsValue(transformToFormValues(config!));
    setCurrentJson(originalJson);
    clearCache();
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
            onChange={(v) => {
              if (isDirty) {
                modal.confirm({
                  title: t('team_config.unsaved_title'),
                  content: t('team_config.unsaved_message'),
                  okText: t('team_config.unsaved_leave'),
                  cancelText: t('common.cancel'),
                  onOk: () => { clearCache(); setSelectedProject(v); },
                });
              } else {
                setSelectedProject(v);
              }
            }}
            options={projectOptions}
            style={{ minWidth: 220 }}
            aria-label={t('observability.select_project')}
          />
        </Space>
        <Space>
          <Button onClick={handleReset}>
            {t('team_config.reset')}
          </Button>
          <Button type="primary" loading={saving} onClick={() => void handleSave()} danger={isDirty && !saving}>
            {saving ? t('team_config.saving') : isDirty ? t('team_config.unsaved_save') : t('team_config.save')}
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
                  key: 'providers',
                  label: t('team_config.section.providers'),
                  children: (
                    <>
                      <Form.List name="providers">
                        {(fields, { add, remove }) => (
                          <>
                            {fields.map((field, index) => (
                              <ProviderCard key={field.key} field={field} index={index} remove={remove} t={t} />
                            ))}
                            <Space size="small">
                              <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />} size="small">{t('action.add_provider')}</Button>
                              <Button icon={<SyncOutlined />} size="small" loading={syncing} onClick={handleFetchAllModels}>{t('team_config.test.button')}</Button>
                            </Space>
                          </>
                        )}
                      </Form.List>
                      <Alert
                        type="info"
                        showIcon
                        message={t('team_config.provider_hint')}
                        style={{ marginTop: 10, marginBottom: 4, fontSize: 13 }}
                      />
                      <Divider plain>{t('team_config.section.models')}</Divider>
                      <Form.List name="modelAliases">
                        {(fields, { add, remove }) => (
                          <>
                            {fields.map((field) => (
                              <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                                <Form.Item name={[field.name, 'alias']} noStyle><Input placeholder={t('team_config.field.alias')} style={{ width: 140 }} /></Form.Item>
                                <Form.Item name={[field.name, 'modelId']} noStyle>
                                <Select
                                  placeholder={t('team_config.field.model_id')}
                                  style={{ width: 260 }}
                                  showSearch
                                  allowClear
                                  options={globalModelOptions}
                                />
                              </Form.Item>
                                <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                              </Space>
                            ))}
                            <Button type="dashed" onClick={() => add()} icon={<PlusOutlined />} size="small">{t('action.add_model_alias')}</Button>
                          </>
                        )}
                      </Form.List>
                      <Divider plain>{t('team_config.field.model')}</Divider>
                      <Form.Item label={t('team_config.field.model')} name="model">
                        <ModelAliasSelect form={form} placeholder={t('team_config.placeholder.select_model')} allowClear />
                      </Form.Item>
                    </>
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
                        <Select options={[{ value: 'local_process', label: t('team_config.option.local_process') }, { value: 'flue', label: t('team_config.option.flue') }]} />
                      </Form.Item>
                      <Form.Item label={t('team_config.field.state_dir')} name={['runtime', 'persistence', 'state_dir']}><Input readOnly /></Form.Item>
                    </>
                  ),
                },
                {
                  key: 'workspace',
                  label: t('team_config.section.workspace'),
                  children: (
                    <>
                      <Form.Item label={t('team_config.field.provider')} name={['workspace', 'provider']}>
                        <Select options={[{ value: 'worktree', label: t('team_config.option.worktree') }, { value: 'shared_clone', label: t('team_config.option.shared_clone') }, { value: 'full_clone', label: t('team_config.option.full_clone') }]} />
                      </Form.Item>
                      <Form.Item label={t('team_config.field.root_dir')} name={['workspace', 'root_dir']}><Input readOnly /></Form.Item>
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
                      <Form.Item label={t('team_config.field.model')} name={['admin', 'model']}>
                        <ModelAliasSelect form={form} placeholder={t('team_config.placeholder.inherit_global')} allowClear />
                      </Form.Item>
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
                          {fields.map((field, idx) => (
                            <TeamCard key={field.key} field={field} index={idx} remove={remove} form={form} t={t} />
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

        {/* Diff Preview */}
        <Card
          title={t('team_config.json_preview')}
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)', minWidth: 0, overflow: 'hidden' }}
          styles={{
            header: { borderBottomColor: 'var(--border-color)', color: 'var(--text-primary)' },
            body: { minWidth: 0, overflow: 'hidden', padding: 0 },
          }}
          extra={isDirty ? <Tag color="orange">{t('team_config.unsaved_tag')}</Tag> : <Tag color="green">{t('team_config.saved_tag')}</Tag>}
        >
          <pre
            className="diff-preview"
            style={{
              maxHeight: 'calc(100vh - 200px)',
              overflow: 'auto',
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              whiteSpace: 'pre',
              margin: 0,
              padding: '12px 16px',
              lineHeight: '20px',
            }}
          >
            {diffLines.map((line, idx) => {
              let bg = 'transparent';
              let color = 'var(--text-primary)';
              let prefix = ' ';
              if (line.type === 'add') {
                bg = isDark ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.10)';
                color = isDark ? '#6ee7b7' : '#047857';
                prefix = '+';
              } else if (line.type === 'remove') {
                bg = isDark ? 'rgba(198,87,70,0.15)' : 'rgba(198,87,70,0.10)';
                color = isDark ? '#f87171' : '#b91c1c';
                prefix = '-';
              }
              return (
                <div
                  key={idx}
                  style={{
                    background: bg,
                    color,
                    paddingLeft: 4,
                    marginLeft: -4,
                    marginRight: -4,
                    paddingRight: 4,
                  }}
                >
                  <span style={{ opacity: 0.5, userSelect: 'none', marginRight: 8, display: 'inline-block', width: 10, textAlign: 'center' }}>{prefix}</span>
                  {line.text}
                </div>
              );
            })}
          </pre>
        </Card>
      </div>
    </div>
  );
}

/* ---- Global model sync ---- */

interface GlobalModelsFile {
  providers: Record<string, unknown>;
  models: Record<string, unknown>;
}

async function syncToGlobalModels(
  payload: TeamFileConfig,
  t: (key: string, opts?: Record<string, unknown>) => string,
  messageApi: ReturnType<typeof App.useApp>['message'],
  modal: ReturnType<typeof App.useApp>['modal'],
): Promise<void> {
  const incomingProviders = payload.providers ?? {};
  const incomingModels = payload.models ?? {};
  // Nothing to sync
  if (Object.keys(incomingProviders).length === 0 && Object.keys(incomingModels).length === 0) return;

  try {
    // Fetch current global config
    const globalRes = await fetch('/api/global-models');
    if (!globalRes.ok) throw new Error(`${globalRes.status}`);
    const globalData = (await globalRes.json()) as GlobalModelsFile;

    // Detect conflicts
    const conflictKeys: string[] = [];
    for (const key of Object.keys(incomingProviders)) {
      if (key in (globalData.providers ?? {})) conflictKeys.push(`providers.${key}`);
    }
    for (const key of Object.keys(incomingModels)) {
      if (key in (globalData.models ?? {})) conflictKeys.push(`models.${key}`);
    }

    const doSync = async () => {
      try {
        const putRes = await fetch('/api/global-models', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: incomingProviders, models: incomingModels }),
        });
        if (!putRes.ok) throw new Error(`${putRes.status}`);
        void messageApi.success(t('team_config.sync.success'));
      } catch {
        void messageApi.warning(t('team_config.sync.failed'));
      }
    };

    if (conflictKeys.length > 0) {
      // Show confirmation modal
      modal.confirm({
        title: t('team_config.sync.confirm_title'),
        content: t('team_config.sync.confirm_content', { keys: conflictKeys.join(', ') }),
        okText: t('common.confirm'),
        cancelText: t('common.cancel'),
        onOk: doSync,
      });
    } else {
      await doSync();
    }
  } catch {
    // Non-blocking: global sync failure shouldn't block project save
    void messageApi.warning(t('team_config.sync.failed'));
  }
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
