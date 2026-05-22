import { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import {
  Card,
  Button,
  App,
  Spin,
  Typography,
  Space,
  Select,
  Form,
  Row,
  Col,
  Table,
  Tag,
  Popconfirm,
  Modal,
  Input,
  InputNumber,
  Switch
} from 'antd';
import {
  ReloadOutlined,
  BellOutlined,
  PlusOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
  QrcodeOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  configSchema?: any;
  accounts?: string[];
}

interface TeamConfig {
  project?: {
    name: string;
  };
  admin?: {
    name: string;
    push_channel?: {
      channel: string;
      account: string;
    };
  };
}

export function ChannelsPage() {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [teamConfig, setTeamConfig] = useState<TeamConfig | null>(null);

  // Modal states
  const [modalOpen, setModalOpen] = useState(false);
  const [addAccountForm] = Form.useForm();
  const [selectedPlugin, setSelectedPlugin] = useState<PluginManifest | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // WeChat scan-to-login states
  const [qrLoading, setQrLoading] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [weixinSession, setWeixinSession] = useState<string | null>(null);
  const [loginStatus, setLoginStatus] = useState<'wait' | 'scanned' | 'confirmed' | 'expired'>('wait');
  const activeWeixinFlow = useRef<string | null>(null);

  // WeChat scanning logic
  const startWechatLogin = async () => {
    setQrLoading(true);
    setQrUrl(null);
    setWeixinSession(null);
    setLoginStatus('wait');
    try {
      const res = await fetch('/api/channels/weixin/login-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (!res.ok) throw new Error(`Status: ${res.status}`);
      const data = await res.json();
      const qr = data.qrcodeUrl || data.qrDataUrl;
      if (qr) {
        // If it's a data image URI, use it directly.
        // If it's a raw base64 string, prefix it.
        // If it starts with http:// or https://, use it as a direct URL fallback.
        // If it is a text link or anything else, we do NOT use qrserver anymore.
        let finalQr = qr;
        if (qr.startsWith('data:image/')) {
          finalQr = qr;
        } else if (/^[a-zA-Z0-9+/=]{100,}$/.test(qr)) {
          finalQr = `data:image/png;base64,${qr}`;
        } else if (qr.startsWith('http://') || qr.startsWith('https://')) {
          finalQr = qr;
        } else {
          throw new Error("Invalid QR data format returned by server.");
        }
        setQrUrl(finalQr);
      }
      if (data.sessionKey) {
        setWeixinSession(data.sessionKey);
        activeWeixinFlow.current = data.sessionKey;
        void pollWechatStatus(data.sessionKey);
      }
    } catch (e: any) {
      messageApi.error(`Failed to start WeChat login: ${e.message}`);
    } finally {
      setQrLoading(false);
    }
  };

  const pollWechatStatus = async (sessionKey: string) => {
    if (activeWeixinFlow.current !== sessionKey) return;
    
    try {
      const res = await fetch('/api/channels/weixin/login-wait', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey })
      });
      
      if (activeWeixinFlow.current !== sessionKey) return;

      if (!res.ok) {
        // network or server error, wait a moment and retry
        setTimeout(() => void pollWechatStatus(sessionKey), 3000);
        return;
      }

      const data = await res.json();
      if (activeWeixinFlow.current !== sessionKey) return;

      if (data.status === 'scanned') {
        setLoginStatus('scanned');
        void pollWechatStatus(sessionKey);
      } else if (data.status === 'confirmed' || data.connected) {
        setLoginStatus('confirmed');
        messageApi.success(t('channels.wechat_confirmed'));
        setModalOpen(false);
        void loadData();
      } else if (data.status === 'expired') {
        setLoginStatus('expired');
      } else {
        void pollWechatStatus(sessionKey);
      }
    } catch (e) {
      if (activeWeixinFlow.current === sessionKey) {
        setTimeout(() => void pollWechatStatus(sessionKey), 3000);
      }
    }
  };

  // Trigger login start when modal is opened with WeChat, or selection changes to WeChat
  useEffect(() => {
    if (modalOpen && selectedPlugin && isWeixin(selectedPlugin.id)) {
      void startWechatLogin();
    } else {
      // 弹窗关闭或切换插件时，清除后端的暂存二维码文件
      if (activeWeixinFlow.current) {
        void fetch('/api/channels/weixin/login-cancel', { method: 'POST' }).catch(() => {});
      }
      activeWeixinFlow.current = null;
      setQrUrl(null);
      setQrLoading(false);
      setWeixinSession(null);
    }
  }, [modalOpen, selectedPlugin]);

  // WeChat Scan Panel Component
  const renderWechatScanPanel = () => {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 12px',
        textAlign: 'center'
      }}>
        <style dangerouslySetInnerHTML={{ __html: `
          .glass-qr-container {
            position: relative;
            width: 220px;
            height: 220px;
            padding: 12px;
            border-radius: 12px;
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            margin-bottom: 20px;
            transition: all 0.3s ease;
          }
          .refresh-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(4px);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: #fff;
            cursor: pointer;
            z-index: 20;
            transition: all 0.3s ease;
          }
          .refresh-overlay:hover {
            background: rgba(0, 0, 0, 0.8);
          }
        ` }} />

        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ fontSize: '14px' }}>
            {t('channels.wechat_scan_tip')}
          </Text>
        </div>

        <div className="glass-qr-container">
          {qrLoading ? (
            <Spin size="large" />
          ) : qrUrl ? (
            <>
              <img 
                src={qrUrl} 
                alt="WeChat Login QR Code" 
                style={{ 
                  width: '100%', 
                  height: '100%', 
                  objectFit: 'contain',
                  borderRadius: '8px',
                  opacity: loginStatus === 'expired' ? 0.3 : 1,
                  transition: 'opacity 0.3s ease'
                }} 
              />

              {loginStatus === 'expired' && (
                <div className="refresh-overlay" onClick={startWechatLogin}>
                  <ReloadOutlined style={{ fontSize: '32px', marginBottom: '8px', color: 'rgba(255,255,255,0.85)' }} />
                  <span style={{ fontSize: '13px', fontWeight: 500 }}>{t('channels.wechat_refresh_qr')}</span>
                </div>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: 'var(--text-secondary)' }}>
              <QrcodeOutlined style={{ fontSize: '48px', marginBottom: '8px' }} />
              <Text type="secondary">{t('channels.wechat_waiting_scan')}</Text>
            </div>
          )}
        </div>

        <div style={{ marginTop: 8 }}>
          {loginStatus === 'wait' && (
            <Tag color="warning" icon={<SyncOutlined spin />} style={{ padding: '4px 12px', borderRadius: '20px', fontSize: '13px' }}>
              {t('channels.wechat_waiting_scan')}
            </Tag>
          )}
          {loginStatus === 'scanned' && (
            <Tag color="processing" icon={<SyncOutlined spin />} style={{ padding: '4px 12px', borderRadius: '20px', fontSize: '13px' }}>
              {t('channels.wechat_scanned')}
            </Tag>
          )}
          {loginStatus === 'confirmed' && (
            <Tag color="success" icon={<CheckCircleOutlined />} style={{ padding: '4px 12px', borderRadius: '20px', fontSize: '13px' }}>
              {t('channels.wechat_confirmed')}
            </Tag>
          )}
          {loginStatus === 'expired' && (
            <Tag color="error" icon={<CloseCircleOutlined />} style={{ padding: '4px 12px', borderRadius: '20px', fontSize: '13px' }}>
              {t('channels.wechat_expired')}
            </Tag>
          )}
        </div>
      </div>
    );
  };

  // Load all plugins (to scan configured accounts) and the active team configuration
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Fetch plugins
      const pluginsRes = await fetch('/api/plugins');
      if (!pluginsRes.ok) throw new Error(`Plugins API: ${pluginsRes.status}`);
      const pluginsData = (await pluginsRes.json()) as PluginManifest[];
      setPlugins(pluginsData);

      // 2. Fetch team config
      const configRes = await fetch('/api/team-config');
      if (!configRes.ok) throw new Error(`Config API: ${configRes.status}`);
      const configData = (await configRes.json()) as TeamConfig;
      setTeamConfig(configData);
    } catch (e: any) {
      messageApi.error(`Failed to load channel configurations: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Save the push mapping in team.json
  const handleSaveMapping = async (mappedChannel: string) => {
    if (!teamConfig) return;
    setSaving(true);
    try {
      const updatedConfig = { ...teamConfig };
      if (!updatedConfig.admin) {
        updatedConfig.admin = { name: 'Admin', prompt: 'You are the project administrator.' };
      }

      if (mappedChannel === 'disabled' || !mappedChannel) {
        delete updatedConfig.admin.push_channel;
      } else {
        const [channel, account] = mappedChannel.split(':');
        updatedConfig.admin.push_channel = { channel, account };
      }

      const res = await fetch('/api/team-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedConfig)
      });

      if (!res.ok) throw new Error(`Status: ${res.status}`);

      messageApi.success(t('channels.save_success'));
      setTeamConfig(updatedConfig);
    } catch (e: any) {
      messageApi.error(`${t('channels.save_error')}${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Remove specific account
  const handleRemoveAccount = async (channelId: string, accountId: string) => {
    try {
      const res = await fetch('/api/global-config/remove-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, accountId })
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || `${res.status}`);
      }
      messageApi.success(t('common.success'));
      void loadData();
    } catch (e: any) {
      messageApi.error(`${t('common.error')}: ${e.message}`);
    }
  };

  // Save new account credential form
  const handleAddAccountSubmit = async (values: any) => {
    if (!selectedPlugin) return;

    // Generate unique account ID automatically based on plugin ID and a short UUID
    const suffix = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().split('-')[0]
      : Math.random().toString(36).substring(2, 10);
    const baseName = selectedPlugin.id.replace(/^openclaw-/, '');
    const accountId = `${baseName}-${suffix}`;

    const { pluginId, ...credentialData } = values;

    setSubmitting(true);
    try {
      // 1. Fetch existing global config
      const configRes = await fetch('/api/global-config');
      if (!configRes.ok) throw new Error('Failed to load global config');
      const globalConfig = await configRes.json();

      // 2. Initialize structures if missing
      const channels = globalConfig.channels || {};
      const channelConfig = channels[selectedPlugin.id] || { accounts: {} };
      channelConfig.accounts = channelConfig.accounts || {};
      channelConfig.accounts[accountId] = credentialData;
      channels[selectedPlugin.id] = channelConfig;

      // 3. Save merged global config
      const saveRes = await fetch('/api/global-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels })
      });

      if (!saveRes.ok) throw new Error('Failed to save config');

      messageApi.success(t('common.success'));
      setModalOpen(false);
      addAccountForm.resetFields();
      setSelectedPlugin(null);
      void loadData();
    } catch (e: any) {
      messageApi.error(`${t('common.error')}: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const isWeixin = (pluginId: string) => {
    return pluginId === 'openclaw-weixin' || pluginId.endsWith('weixin');
  };

  const renderSchemaFields = (schema: any) => {
    if (!schema || !schema.properties) return <Text type="secondary">{t('plugins.no_params_required')}</Text>;

    return Object.entries(schema.properties).map(([key, prop]: [string, any]) => {
      const isRequired = schema.required && schema.required.includes(key);
      const label = prop.title || key;

      return (
        <Form.Item
          key={key}
          name={key}
          label={label}
          extra={prop.description}
          valuePropName={prop.type === 'boolean' ? 'checked' : 'value'}
          rules={[{ required: isRequired, message: `${label} is required` }]}
        >
          {prop.type === 'boolean' ? (
            <Switch />
          ) : prop.type === 'number' ? (
            <InputNumber style={{ width: '100%' }} />
          ) : (
            <Input placeholder={prop.description || ''} />
          )}
        </Form.Item>
      );
    });
  };

  // Build options list for selection
  // Format: "pluginId:accountId"
  const allAccounts = plugins.reduce<{ channel: string; account: string; pluginName: string }[]>((acc, plugin) => {
    if (plugin.accounts && plugin.accounts.length > 0) {
      plugin.accounts.forEach(accName => {
        acc.push({
          channel: plugin.id,
          account: accName,
          pluginName: plugin.name || plugin.id
        });
      });
    }
    return acc;
  }, []);

  const tableData = allAccounts.map((item, idx) => ({
    key: `${item.channel}-${item.account}-${idx}`,
    channel: item.channel,
    pluginName: item.pluginName,
    account: item.account,
    isMapped: teamConfig?.admin?.push_channel?.channel === item.channel && teamConfig?.admin?.push_channel?.account === item.account
  }));

  const columns = [
    {
      title: t('channels.col_plugin'),
      dataIndex: 'pluginName',
      key: 'pluginName',
      render: (v: string, record: any) => (
        <Space>
          <Text strong style={{ color: 'var(--text-primary)' }}>{v}</Text>
          <Tag style={{ fontSize: '11px' }}>{record.channel}</Tag>
        </Space>
      )
    },
    {
      title: t('channels.col_account'),
      dataIndex: 'account',
      key: 'account',
      render: (v: string) => <Tag color="blue">{v}</Tag>
    },
    {
      title: t('channels.col_status'),
      key: 'status',
      width: 250,
      render: (_: unknown, record: any) => (
        <Space size={12}>
          <Switch
            checked={record.isMapped}
            loading={saving}
            onChange={(checked) => {
              const val = checked ? `${record.channel}:${record.account}` : 'disabled';
              void handleSaveMapping(val);
            }}
          />
          {record.isMapped && (
            <Tag color="green" icon={<BellOutlined />} style={{ margin: 0 }}>
              {t('channels.active_recipient')}
            </Tag>
          )}
        </Space>
      )
    },
    {
      title: t('channels.col_action'),
      key: 'action',
      width: 120,
      render: (_: unknown, record: any) => (
        <Popconfirm
          title={t('channels.delete_confirm')}
          onConfirm={() => handleRemoveAccount(record.channel, record.account)}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
        >
          <Button danger size="small" type="text" icon={<DeleteOutlined />}>
            {t('action.remove')}
          </Button>
        </Popconfirm>
      )
    }
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <>
      <Helmet>
        <title>{`${t('nav.channels')} - Open Agent Team`}</title>
      </Helmet>

      <div>
        {/* Title Block */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Title level={3} style={{ color: 'var(--text-primary)', margin: 0 }}>
            {t('channels.title')}
          </Title>
          <Button
            type="default"
            icon={<ReloadOutlined />}
            onClick={loadData}
          >
            {t('header.refresh')}
          </Button>
        </div>

        <Row gutter={[24, 24]}>
          {/* Project Push Channels & Accounts Card */}
          <Col xs={24}>
            <Card
              title={
                <Space>
                  <BellOutlined style={{ color: 'var(--primary-color)' }} />
                  <span>{t('channels.configured_card_title')}</span>
                </Space>
              }
              extra={
                <Button
                  type="primary"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    addAccountForm.resetFields();
                    const firstPlugin = plugins.length > 0 ? plugins[0] : null;
                    setSelectedPlugin(firstPlugin);
                    if (firstPlugin) {
                      addAccountForm.setFieldsValue({ pluginId: firstPlugin.id });
                    }
                    setModalOpen(true);
                  }}
                >
                  {t('plugins.add_account')}
                </Button>
              }
              style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
              styles={{ header: { borderBottomColor: 'var(--border-color)', color: 'var(--text-primary)' } }}
            >
              <Table
                dataSource={tableData}
                columns={columns}
                pagination={false}
                size="middle"
                locale={{
                  emptyText: t('channels.no_accounts')
                }}
              />
            </Card>
          </Col>
        </Row>
      </div>

      {/* Add Account Modal */}
      <Modal
        title={t('plugins.setup_account')}
        open={modalOpen}
        maskClosable={false}
        keyboard={false}
        onCancel={() => {
          if (!submitting) {
            setModalOpen(false);
          }
        }}
        onOk={() => addAccountForm.submit()}
        confirmLoading={submitting}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        width={480}
        destroyOnClose
        footer={selectedPlugin && isWeixin(selectedPlugin.id) ? null : undefined}
      >
        <Form
          layout="vertical"
          form={addAccountForm}
          onFinish={handleAddAccountSubmit}
          style={{ marginTop: 20 }}
        >
          <Form.Item
            name="pluginId"
            label={t('channels.select_plugin')}
            rules={[{ required: true, message: t('channels.select_plugin_required') }]}
          >
            <Select
              placeholder={t('channels.select_plugin_placeholder')}
              onChange={(val) => {
                const found = plugins.find(p => p.id === val);
                setSelectedPlugin(found || null);
              }}
            >
              {plugins.map(p => (
                <Select.Option key={p.id} value={p.id}>
                  {p.name || p.id}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          {selectedPlugin && (
            <>
              {!isWeixin(selectedPlugin.id) && (
                <>
                  <Title level={5} style={{ marginTop: '24px', marginBottom: '16px' }}>
                    {t('plugins.config_schema')}
                  </Title>
                  {renderSchemaFields(selectedPlugin.configSchema)}
                </>
              )}

              {isWeixin(selectedPlugin.id) && renderWechatScanPanel()}
            </>
          )}
        </Form>
      </Modal>
    </>
  );
}
