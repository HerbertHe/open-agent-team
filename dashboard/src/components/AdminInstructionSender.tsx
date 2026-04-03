import { useCallback, useState } from 'react';
import { Card, Typography, message as antdMessage } from 'antd';
import { Sender } from '@ant-design/x';

const { Paragraph } = Typography;

export function AdminInstructionSender() {
  const [loading, setLoading] = useState(false);
  const onSubmit = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!prompt) return;
    setLoading(true);
    try {
      const r = await fetch('/tool/admin_instruction', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `${r.status} ${r.statusText}`);
      antdMessage.success('已下发到 Admin');
    } catch (e) {
      antdMessage.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Card size="small" title="向 Admin 下发指令" className="admin-sender-card">
      <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12, marginTop: 0 }}>
        使用 Ant Design X 的 Sender 组件：内容经 orchestrator 发送到 Admin 的 OpenCode session（前缀{' '}
        <Typography.Text code>DASHBOARD_INSTRUCTION</Typography.Text>
        ）。开发模式下通过 Vite 代理访问 <Typography.Text code>/tool/admin_instruction</Typography.Text>。
      </Paragraph>
      <Sender
        placeholder="输入要交给 Admin 的任务或补充说明…（Shift+Enter 发送）"
        loading={loading}
        onSubmit={onSubmit}
        submitType="shiftEnter"
        autoSize={{ minRows: 2, maxRows: 6 }}
      />
    </Card>
  );
}
