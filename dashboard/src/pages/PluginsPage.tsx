import { useCallback, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import {
  Card,
  Button,
  App,
  Spin,
  Typography,
  Empty,
  Tag,
  Input,
  Modal,
  Row,
  Col,
  Statistic
} from 'antd';
import {
  DeleteOutlined,
  SettingOutlined,
  CloudDownloadOutlined,
  CheckCircleOutlined,
  FolderOpenOutlined,
  SearchOutlined
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  configSchema?: any;
}

export function PluginsPage() {
  const { t } = useTranslation();
  const { message: messageApi, modal: modalApi } = App.useApp();

  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installPackage, setInstallPackage] = useState('');
  const [selectedPlugin, setSelectedPlugin] = useState<PluginManifest | null>(null);

  // Modal states
  const [modalOpen, setModalOpen] = useState(false);
  const [installFormVisible, setInstallFormVisible] = useState(false);

  // Search and filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce search query
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  // Filtered plugins memo
  const filteredPlugins = useMemo(() => {
    const query = debouncedQuery.toLowerCase().trim();
    if (!query) return plugins;
    return plugins.filter(
      p =>
        (p.name || '').toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query) ||
        (p.description || '').toLowerCase().includes(query)
    );
  }, [plugins, debouncedQuery]);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/plugins');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as PluginManifest[];
      setPlugins(data);
    } catch {
      messageApi.error(t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [messageApi, t]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  // Install NPM package plugin
  const handleInstall = async () => {
    if (!installPackage.trim()) {
      messageApi.warning(t('plugins.install_placeholder'));
      return;
    }
    setInstalling(true);
    try {
      const res = await fetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageName: installPackage.trim() })
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || `${res.status}`);
      }
      messageApi.success(t('common.success'));
      setInstallPackage('');
      setInstallFormVisible(false);
      void loadPlugins();
    } catch (e: any) {
      messageApi.error(`${t('common.error')}: ${e.message}`);
    } finally {
      setInstalling(false);
    }
  };

  // Uninstall plugin
  const handleUninstall = async (pluginId: string) => {
    try {
      const res = await fetch('/api/plugins/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId })
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || `${res.status}`);
      }
      messageApi.success(t('common.success'));
      if (selectedPlugin?.id === pluginId) {
        setModalOpen(false);
      }
      void loadPlugins();
    } catch (e: any) {
      messageApi.error(`${t('common.error')}: ${e.message}`);
    }
  };

  // Helper: check if plugin is bundled/built-in
  const isBundled = (pluginId: string) => {
    return pluginId === 'openclaw-slack' || pluginId === 'openclaw-discord';
  };

  return (
    <>
      <Helmet>
        <title>{`${t('nav.plugins')} - Open Agent Team`}</title>
      </Helmet>

      <div>
        {/* Title Section */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Title level={3} style={{ color: 'var(--text-primary)', margin: 0 }}>
            {t('plugins.title')}
          </Title>
          <Button
            type="primary"
            icon={<CloudDownloadOutlined />}
            onClick={() => setInstallFormVisible(true)}
          >
            {t('plugins.install')}
          </Button>
        </div>

        {/* Stats Row */}
        <Row gutter={[16, 16]} style={{ marginBottom: '20px' }}>
          <Col xs={24} sm={12}>
            <Card
              style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
              styles={{ body: { padding: '12px 16px' } }}
            >
              <Statistic
                title={<span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('plugins.installed')}</span>}
                value={plugins.length}
                valueStyle={{ fontSize: '18px', fontWeight: 600 }}
                prefix={<SettingOutlined style={{ color: 'var(--primary-color)', fontSize: '14px', marginRight: '6px' }} />}
              />
            </Card>
          </Col>
          <Col xs={24} sm={12}>
            <Card
              style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
              styles={{ body: { padding: '12px 16px' } }}
            >
              <Statistic
                title={<span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('plugins.system_status')}</span>}
                value={t('plugins.status_healthy')}
                valueStyle={{ fontSize: '18px', fontWeight: 600, color: 'var(--success-color)' }}
                prefix={<CheckCircleOutlined style={{ color: 'var(--success-color)', fontSize: '14px', marginRight: '6px' }} />}
              />
            </Card>
          </Col>
        </Row>
        {/* Search Bar */}
        <div style={{ marginBottom: '20px' }}>
          <Input
            placeholder={t('plugins.search_placeholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            allowClear
            prefix={<SearchOutlined style={{ color: 'var(--text-secondary)' }} />}
            style={{
              background: 'var(--bg-card)',
              borderColor: 'var(--border-color)',
              color: 'var(--text-primary)',
              borderRadius: '8px',
              padding: '8px 12px',
            }}
          />
        </div>

        {/* Plugin Grid */}
        <Spin spinning={loading} size="large">
          {plugins.length === 0 ? (
            <Empty description={t('plugins.no_plugins')} style={{ padding: '64px 0' }} />
          ) : filteredPlugins.length === 0 ? (
            <Empty description={t('plugins.no_results')} style={{ padding: '64px 0' }} />
          ) : (
            <Row gutter={[16, 16]}>
              {filteredPlugins.map(plugin => {
                const isPackaged = isBundled(plugin.id);
                return (
                  <Col xs={24} sm={12} md={8} key={plugin.id}>
                    <Card
                      hoverable
                      style={{
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        background: 'var(--bg-card)',
                        borderColor: 'var(--border-color)',
                      }}
                      styles={{ body: { padding: '16px', width: '100%', display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'space-between' } }}
                    >
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                          <Text strong style={{ fontSize: '16px' }}>{plugin.name || plugin.id}</Text>
                          <Tag color={isPackaged ? 'blue' : 'purple'} style={{ margin: 0 }}>
                            {isPackaged ? t('plugins.bundled_tag') : t('plugins.npm_tag')}
                          </Tag>
                        </div>
                        <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ fontSize: '13px', minHeight: '40px', marginBottom: 0 }}>
                          {plugin.description || t('plugins.no_description')}
                        </Paragraph>
                      </div>
                      <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text type="secondary" style={{ fontSize: '12px' }}>v{plugin.version}</Text>
                        <Button
                          type="text"
                          size="small"
                          shape="circle"
                          icon={<SettingOutlined style={{ fontSize: '14px', color: 'var(--text-secondary)' }} />}
                          onClick={() => {
                            setSelectedPlugin(plugin);
                            setModalOpen(true);
                          }}
                        />
                      </div>
                    </Card>
                  </Col>
                );
              })}
            </Row>
          )}
        </Spin>

        {/* Dynamic Plugin Details Modal */}
        <Modal
          title={selectedPlugin?.name || selectedPlugin?.id}
          open={modalOpen}
          onCancel={() => setModalOpen(false)}
          footer={
            selectedPlugin && !isBundled(selectedPlugin.id) ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  type="primary"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    modalApi.confirm({
                      title: t('plugins.uninstall'),
                      content: t('plugins.uninstall_confirm'),
                      okText: t('common.yes'),
                      cancelText: t('common.no'),
                      okButtonProps: { danger: true, type: 'primary' },
                      onOk: () => handleUninstall(selectedPlugin.id),
                    });
                  }}
                >
                  {t('plugins.uninstall')}
                </Button>
              </div>
            ) : null
          }
        >
          {selectedPlugin && (
            <div style={{ padding: '12px 0' }}>
              <div style={{ marginBottom: '16px' }}>
                <Title level={5} style={{ marginTop: 0 }}>{t('plugins.description_label')}</Title>
                <Paragraph style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
                  {selectedPlugin.description || t('plugins.no_description')}
                </Paragraph>
              </div>
              <div style={{ background: 'var(--bg-hover)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', alignItems: 'center' }}>
                  <Text type="secondary" style={{ fontSize: '13px' }}>{t('plugins.meta_id')}</Text>
                  <Text strong style={{ fontSize: '13px' }}>{selectedPlugin.id}</Text>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text type="secondary" style={{ fontSize: '13px' }}>{t('plugins.meta_version')}</Text>
                  <Tag color="blue" style={{ margin: 0 }}>v{selectedPlugin.version}</Tag>
                </div>
              </div>
            </div>
          )}
        </Modal>

        {/* Install Plugin Modal */}
        <Modal
          title={t('plugins.install')}
          open={installFormVisible}
          onCancel={() => !installing && setInstallFormVisible(false)}
          footer={[
            <Button key="cancel" disabled={installing} onClick={() => setInstallFormVisible(false)}>
              {t('common.cancel')}
            </Button>,
            <Button
              key="submit"
              type="primary"
              loading={installing}
              icon={<CloudDownloadOutlined />}
              onClick={handleInstall}
            >
              {t('plugins.install_btn')}
            </Button>
          ]}
        >
          <div style={{ padding: '12px 0' }}>
            <Paragraph>
              {t('plugins.install_desc')}
            </Paragraph>
            <Input
              placeholder={t('plugins.install_placeholder')}
              value={installPackage}
              onChange={e => setInstallPackage(e.target.value)}
              onPressEnter={handleInstall}
              disabled={installing}
              prefix={<FolderOpenOutlined />}
            />
            <Text type="secondary" style={{ display: 'block', marginTop: '8px', fontSize: '12px' }}>
              {t('plugins.install_example')}
            </Text>
          </div>
        </Modal>
      </div>
    </>
  );
}
