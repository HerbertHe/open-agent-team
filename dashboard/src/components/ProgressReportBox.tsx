import { Button, Card, List, Modal, Typography } from 'antd';
import { useMemo, useState } from 'react';
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
  // latest first
  return out;
}

export function ProgressReportBox(props: { events: ObservabilityEvent[] }) {
  const items = useMemo(() => pickProgressItems(props.events, 200), [props.events]);
  const [open, setOpen] = useState(false);

  const list = (
    <div className="progress-report-list">
      <List
        size="small"
        split={false}
        dataSource={items}
        locale={{ emptyText: '暂无汇报' }}
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
                      <Text type="secondary">阶段</Text> {it.stage}
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
  );

  return (
    <Card
      size="small"
      title="进度汇报"
      className="progress-report-card"
      extra={
        <Button
          size="small"
          onClick={() => setOpen(true)}
          aria-label="全屏查看进度汇报"
        >
          全屏
        </Button>
      }
      style={{ marginTop: 12 }}
      bodyStyle={{ paddingTop: 8 }}
    >
      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
        Leader/Worker/Admin 可通过工具 <Text code>report-progress</Text> 汇报文本（时间线将按最新优先展示）。
      </Text>
      {list}

      <Modal
        title="进度汇报（全屏）"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width="100vw"
        style={{ top: 0, padding: 0, maxWidth: '100vw' }}
        className="progress-report-fullscreen-modal"
      >
        <div className="progress-report-modal-body">{list}</div>
      </Modal>
    </Card>
  );
}

