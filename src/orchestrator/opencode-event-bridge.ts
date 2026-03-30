import { createOpencodeClient } from "@opencode-ai/sdk";
import type { AgentRuntimeState } from "../types";
import { ObservabilityHub } from "./observability-hub";

/** OpenCode 事件里 session 可能出现在 properties.sessionID / sessionId 或顶层 */
function eventSessionIds(ev: unknown): string[] {
  const out: string[] = [];
  if (!ev || typeof ev !== "object") return out;
  const o = ev as Record<string, unknown>;
  for (const k of ["sessionID", "sessionId"]) {
    const v = o[k];
    if (typeof v === "string") out.push(v);
  }
  const props = o.properties;
  if (props && typeof props === "object") {
    const p = props as Record<string, unknown>;
    for (const k of ["sessionID", "sessionId"]) {
      const v = p[k];
      if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

function eventType(ev: unknown): string {
  if (ev && typeof ev === "object" && "type" in ev && typeof (ev as { type: unknown }).type === "string") {
    return (ev as { type: string }).type;
  }
  return "unknown";
}

/**
 * 订阅各 Agent 对应 OpenCode 进程的 /event SSE，写入 ObservabilityHub。
 * 按 agentId 持有 AbortController，便于在 Worker/Leader 被清理或进程退出时取消订阅。
 */
export class OpencodeEventBridge {
  private readonly abortByAgent = new Map<string, AbortController>();

  constructor(private readonly hub: ObservabilityHub) {}

  subscribeAgent(state: AgentRuntimeState): void {
    const { spec, sessionId } = state;
    this.unsubscribeAgent(spec.id);
    const abort = new AbortController();
    this.abortByAgent.set(spec.id, abort);
    const baseUrl = `http://127.0.0.1:${spec.port}`;
    const client = createOpencodeClient({ baseUrl });

    void (async () => {
      try {
        const result = await client.event.subscribe({ signal: abort.signal });
        for await (const ev of result.stream) {
          const sids = eventSessionIds(ev);
          if (sids.length > 0 && !sids.includes(sessionId)) {
            continue;
          }
          const t = eventType(ev);
          this.hub.emit({
            source: "opencode",
            type: t,
            agentId: spec.id,
            role: spec.role,
            sessionId,
            payload: { opencodeEvent: ev as Record<string, unknown> },
          });
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          this.hub.emit({
            source: "orchestrator",
            type: "opencode.bridge.error",
            agentId: spec.id,
            role: spec.role,
            sessionId,
            payload: { error: String(e) },
          });
        }
      }
    })();
  }

  /** Worker/Leader 从编排中移除或进程即将停止时调用，避免孤儿 SSE 连接。 */
  unsubscribeAgent(agentId: string): void {
    const a = this.abortByAgent.get(agentId);
    if (!a) return;
    try {
      a.abort();
    } catch {
      /* noop */
    }
    this.abortByAgent.delete(agentId);
  }

  disposeAll(): void {
    for (const id of [...this.abortByAgent.keys()]) {
      this.unsubscribeAgent(id);
    }
  }
}
