import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { Card, InputNumber, Button, App, Descriptions, Spin, Typography, Table, Space, Popconfirm, Empty, Tag } from 'antd';
import { SaveOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

interface GlobalConfig {
  language?: string;
  logRetentionDays?: number;
}

interface GlobalModelsData {
  providers: Record<string, { compatible_type?: string; base_url?: string; api_key?: string }>;
  models: Record<string, string>;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { message: messageApi, modal } = App.useApp();
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retentionDays, setRetentionDays] = useState(7);

  // --- Global models state ---
  const [globalModels, setGlobalModels] = useState<GlobalModelsData>({ providers: {}, models: {} });
  const [modelsLoading, setModelsLoading] = useState(true);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/global-config');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as GlobalConfig;
      setConfig(data);
      setRetentionDays(data.logRetentionDays ?? 7);
    } catch {
      messageApi.error(t('settings.save_error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadGlobalModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await fetch('/api/global-models');
      if (!res.ok) return;
      const data = (await res.json()) as GlobalModelsData;
      setGlobalModels({ providers: data.providers ?? {}, models: data.models ?? {} });
    } catch { /* ignore */ }
    finally { setModelsLoading(false); }
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => { void loadGlobalModels(); }, [loadGlobalModels]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/global-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logRetentionDays: retentionDays }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      messageApi.success(t('settings.save_success'));
      setConfig((prev) => prev ? { ...prev, logRetentionDays: retentionDays } : prev);
    } catch {
      messageApi.error(t('settings.save_error'));
    } finally {
      setSaving(false);
    }
  };

  // --- Delete a provider ---
  const handleDeleteProvider = async (providerKey: string) => {
    const updated = { ...globalModels };
    delete updated.providers[providerKey];
    // Also remove all models prefixed with this provider
    const newModels = { ...updated.models };
    for (const key of Object.keys(newModels)) {
      if (key.startsWith(`${providerKey}/`)) {
        delete newModels[key];
      }
    }
    updated.models = newModels;
    try {
      const res = await fetch('/api/global-models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...updated, replace: true }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setGlobalModels(updated);
      messageApi.success(t('settings.models.delete_success'));
    } catch {
      messageApi.error(t('settings.models.delete_error'));
    }
  };

  // --- Delete a model ---
  const handleDeleteModel = async (modelKey: string) => {
    const newModels = { ...globalModels.models };
    delete newModels[modelKey];
    const updated = { ...globalModels, models: newModels };
    try {
      const res = await fetch('/api/global-models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...updated, replace: true }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setGlobalModels(updated);
      messageApi.success(t('settings.models.delete_success'));
    } catch {
      messageApi.error(t('settings.models.delete_error'));
    }
  };

  // --- Clear all global models ---
  const handleClearAll = () => {
    modal.confirm({
      title: t('settings.models.clear_confirm_title'),
      content: t('settings.models.clear_confirm_content'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const res = await fetch('/api/global-models', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providers: {}, models: {}, replace: true }),
          });
          if (!res.ok) throw new Error(`${res.status}`);
          setGlobalModels({ providers: {}, models: {} });
          messageApi.success(t('settings.models.clear_success'));
        } catch {
          messageApi.error(t('settings.models.delete_error'));
        }
      },
    });
  };

  const providerData = Object.entries(globalModels.providers).map(([key, val]) => ({
    key,
    compatible_type: val.compatible_type ?? '—',
    base_url: val.base_url ?? '—',
    has_key: val.api_key ? true : false,
  }));

  const modelData = Object.entries(globalModels.models).map(([key, value]) => ({
    key,
    modelId: key,
    modelName: value,
  }));

  const providerColumns = [
    { title: t('settings.models.provider_name'), dataIndex: 'key', key: 'key', render: (v: string) => <Text strong>{v}</Text> },
    { title: t('settings.models.compatible_type'), dataIndex: 'compatible_type', key: 'type', render: (v: string) => <Tag>{v}</Tag> },
    { title: t('settings.models.base_url'), dataIndex: 'base_url', key: 'url', ellipsis: true },
    { title: 'API Key', key: 'apikey', width: 100, render: (_: unknown, r: typeof providerData[0]) => r.has_key ? <Tag color="green">✓</Tag> : <Tag>—</Tag> },
    {
      title: t('projects.actions'), key: 'actions', width: 80,
      render: (_: unknown, r: typeof providerData[0]) => (
        <Popconfirm title={t('action.confirm_remove')} onConfirm={() => void handleDeleteProvider(r.key)} okText={t('common.confirm')} cancelText={t('common.cancel')}>
          <Button type="text" danger icon={<DeleteOutlined />} size="small" />
        </Popconfirm>
      ),
    },
  ];

  const modelColumns = [
    { title: t('settings.models.model_id'), dataIndex: 'modelId', key: 'modelId', render: (v: string) => <Text copyable={{ text: v }}>{v}</Text> },
    { title: t('settings.models.model_name'), dataIndex: 'modelName', key: 'modelName' },
    {
      title: t('projects.actions'), key: 'actions', width: 80,
      render: (_: unknown, r: typeof modelData[0]) => (
        <Popconfirm title={t('action.confirm_remove')} onConfirm={() => void handleDeleteModel(r.modelId)} okText={t('common.confirm')} cancelText={t('common.cancel')}>
          <Button type="text" danger icon={<DeleteOutlined />} size="small" />
        </Popconfirm>
      ),
    },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <Helmet>
        <title>{`${t('nav.settings')} - Open Agent Team`}</title>
      </Helmet>
      <Title level={3} style={{ color: 'var(--text-primary)', marginBottom: 24 }}>
        {t('settings.title')}
      </Title>

      {/* --- General Settings --- */}
      <Card
        title={t('settings.section.general')}
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          marginBottom: 24,
        }}
        styles={{ header: { borderBottomColor: 'var(--border-color)', color: 'var(--text-primary)' } }}
      >
        <Descriptions
          column={1}
          size="middle"
          labelStyle={{ color: 'var(--text-secondary)', fontWeight: 600 }}
          contentStyle={{ color: 'var(--text-primary)' }}
        >
          <Descriptions.Item label={t('settings.log_retention')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <InputNumber
                min={1}
                max={365}
                value={retentionDays}
                onChange={(v) => setRetentionDays(v ?? 7)}
                style={{ width: 120 }}
                addonAfter={t('settings.days_unit')}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('settings.log_retention_desc')}
              </Text>
            </div>
          </Descriptions.Item>

          {config?.language && (
            <Descriptions.Item label="Language">
              <Text>{config.language}</Text>
            </Descriptions.Item>
          )}
        </Descriptions>

        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            onClick={handleSave}
            style={{
              background: 'var(--primary-color)',
              borderColor: 'var(--primary-color)',
            }}
          >
            {t('settings.save')}
          </Button>
        </div>
      </Card>

      {/* --- Global Model Providers --- */}
      <Card
        title={t('settings.models.providers_title')}
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          marginBottom: 24,
        }}
        styles={{ header: { borderBottomColor: 'var(--border-color)', color: 'var(--text-primary)' } }}
        extra={
          <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => void loadGlobalModels()}>
            {t('header.refresh')}
          </Button>
        }
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          {t('settings.models.providers_desc')}
        </Text>
        <Table
          dataSource={providerData}
          columns={providerColumns}
          pagination={false}
          size="small"
          loading={modelsLoading}
          locale={{ emptyText: <Empty description={t('settings.models.no_providers')} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        />
      </Card>

      {/* --- Global Models --- */}
      <Card
        title={t('settings.models.models_title')}
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
        }}
        styles={{ header: { borderBottomColor: 'var(--border-color)', color: 'var(--text-primary)' } }}
        extra={
          <Space>
            <Button type="link" size="small" danger onClick={handleClearAll} disabled={modelData.length === 0}>
              {t('settings.models.clear_all')}
            </Button>
            <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => void loadGlobalModels()}>
              {t('header.refresh')}
            </Button>
          </Space>
        }
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          {t('settings.models.models_desc')}
        </Text>
        <Table
          dataSource={modelData}
          columns={modelColumns}
          pagination={modelData.length > 20 ? { pageSize: 20 } : false}
          size="small"
          loading={modelsLoading}
          locale={{ emptyText: <Empty description={t('settings.models.no_models')} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        />
      </Card>
    </div>
  );
}
