import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, InputNumber, Button, message, Descriptions, Spin, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

interface GlobalConfig {
  language?: string;
  logRetentionDays?: number;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retentionDays, setRetentionDays] = useState(7);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/global-config');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as GlobalConfig;
      setConfig(data);
      setRetentionDays(data.logRetentionDays ?? 7);
    } catch {
      message.error(t('settings.save_error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/global-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logRetentionDays: retentionDays }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      message.success(t('settings.save_success'));
      setConfig((prev) => prev ? { ...prev, logRetentionDays: retentionDays } : prev);
    } catch {
      message.error(t('settings.save_error'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <Title level={3} style={{ color: 'var(--text-primary)', marginBottom: 24 }}>
        {t('settings.title')}
      </Title>

      <Card
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
        }}
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
                addonAfter={t('settings.log_retention').includes('天') ? '天' : 'days'}
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
    </div>
  );
}
