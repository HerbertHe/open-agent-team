import type { ObservabilityEvent } from './types';

/**
 * 实时日志列表中隐藏的高频、低信息量事件（仍保留在原始 events 中，供状态推导与弹窗等使用）。
 */
export function isTimelineNoiseEvent(ev: ObservabilityEvent): boolean {
  if (ev.source !== 'opencode') return false;
  const t = ev.type;

  if (t === 'session.status') {
    const raw = ev.payload?.opencodeEvent as
      | { properties?: { status?: unknown } }
      | undefined;
    const st = raw?.properties?.status;
    if (st === 'idle') return true;
    if (st && typeof st === 'object' && 'type' in st && (st as { type: string }).type === 'idle') {
      return true;
    }
  }

  if (/heartbeat|heart[-_.]?beat|keep[-_]?alive$/i.test(t)) {
    return true;
  }

  if (t === 'opencode.process.log' || t === 'opencode.local.log') {
    const line = ev.payload?.line;
    if (typeof line === 'string' && /heartbeat|keep[-_]?alive/i.test(line)) {
      return true;
    }
  }

  return false;
}
