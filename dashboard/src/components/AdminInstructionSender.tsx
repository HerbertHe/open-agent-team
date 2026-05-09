import { useCallback, useState } from 'react';
import { Card, message as antdMessage } from 'antd';
import { Sender } from '@ant-design/x';

export function AdminInstructionSender() {
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState('');
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
      setValue('');
    } catch (e) {
      antdMessage.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Card size="small" title="向 Admin 下发指令" className="admin-sender-card">
      <Sender
        placeholder="输入要交给 Admin 的任务或补充说明…（Shift+Enter 发送）"
        loading={loading}
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        submitType="shiftEnter"
        autoSize={{ minRows: 2, maxRows: 6 }}
      />
    </Card>
  );
}
