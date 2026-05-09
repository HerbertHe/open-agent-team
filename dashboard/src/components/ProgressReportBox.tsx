import { Card, List, Typography } from 'antd';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ObservabilityEvent } from '../types';

const { Text } = Typography;

function roleFill(role?: string): string {
  if (role === 'admin') return '#722ed1';
  if (role === 'leader') return '#1677ff';
  if (role === 'worker') return '#52c41a';
  return '#8c8c8c';
}

type ProgressItem = {
  agentId: string;
  role?: string;
  ts: string;
  stage?: string;
  message?: string;
};

function pickProgressItems(events: ObservabilityEvent[], limit = 200): ProgressItem[] {
  const out: ProgressItem[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'report_progress') continue;
    if (!e.agentId) continue;
    const stage = e.payload?.['stage'];
    const message = e.payload?.['message'];
    out.push({
      agentId: e.agentId,
      role: e.role,
      ts: e.ts,
      stage: typeof stage === 'string' ? stage : undefined,
      message: typeof message === 'string' ? message : undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function ProgressReportBox(props: { events: ObservabilityEvent[] }) {
  const { t } = useTranslation();
  const items = useMemo(() => pickProgressItems(props.events, 200), [props.events]);

  return (
    <Card
      size="small"
      title={t('progress.title')}
      className="progress-report-card"
      style={{ marginTop: 12 }}
      bodyStyle={{ paddingTop: 8 }}
    >
      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
        {t('progress.hint')}
      </Text>
      <div className="progress-report-list">
        <List
          size="small"
          split={false}
          dataSource={items}
          locale={{ emptyText: t('progress.empty') }}
          renderItem={(it) => (
            <List.Item style={{ padding: '6px 0' }}>
              <div className="progress-report-item" style={{ width: '100%' }}>
                <div className="progress-report-body">
                  <div className="progress-report-header">
                    <Text strong style={{ fontSize: 12 }}>
                      {it.agentId}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {it.ts}
                    </Text>
                  </div>
                  <div className="progress-report-content">
                    {it.stage ? (
                      <Text style={{ fontSize: 12 }}>
                        <Text type="secondary">{t('progress.stage')}</Text> {it.stage}
                      </Text>
                    ) : null}
                    {it.message ? (
                      <pre className="progress-report-message">{it.message}</pre>
                    ) : null}
                  </div>
                </div>
                <div className="progress-report-footer" style={{ background: roleFill(it.role) }}>
                  <span className="progress-report-footer-text">
                    {(it.role ?? 'unknown').toUpperCase()}
                  </span>
                </div>
              </div>
            </List.Item>
          )}
        />
      </div>
    </Card>
  );
}
