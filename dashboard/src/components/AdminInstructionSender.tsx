import { useCallback, useState } from 'react';
import { Card, message as antdMessage } from 'antd';
import { Sender } from '@ant-design/x';
import { useTranslation } from 'react-i18next';

export function AdminInstructionSender() {
  const { t } = useTranslation();
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
      antdMessage.success(t('sender.success'));
      setValue('');
    } catch (e) {
      antdMessage.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [t]);

  return (
    <Card size="small" title={t('sender.title')} className="admin-sender-card">
      <Sender
        placeholder={t('sender.placeholder')}
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
