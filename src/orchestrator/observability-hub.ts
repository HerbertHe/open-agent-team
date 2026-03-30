import type { ObservabilityEvent } from "../types/observability";

const DEFAULT_AGENT_LOG_CAP = 4000;
const DEFAULT_GLOBAL_LOCAL_CAP = 2500;

/**
 * 内存有界环形缓冲 + 多订阅者；用于 Dashboard SSE 与编排/OpenCode 事件汇聚。
 */
export class ObservabilityHub {
  private buffer: ObservabilityEvent[] = [];
  private readonly maxSize: number;
  private readonly subscribers = new Set<(e: ObservabilityEvent) => void>();
  /** 各 Agent 的 OpenCode 进程 stdout/stderr / spawn 退出信息（供 GET 快照与弹窗） */
  private readonly agentProcessLogs = new Map<string, string[]>();
  private readonly maxLogLinesPerAgent: number;
  /** OpenCode 写入 ~/.local/share/opencode/log 的全局日志行（所有 Agent 弹窗可附带同一份） */
  private globalLocalShareLines: string[] = [];
  private readonly maxGlobalLocalLines: number;

  constructor(
    maxSize = 1500,
    maxLogLinesPerAgent = DEFAULT_AGENT_LOG_CAP,
    maxGlobalLocalLines = DEFAULT_GLOBAL_LOCAL_CAP
  ) {
    this.maxSize = maxSize;
    this.maxLogLinesPerAgent = maxLogLinesPerAgent;
    this.maxGlobalLocalLines = maxGlobalLocalLines;
  }

  emit(
    event: Omit<ObservabilityEvent, "ts"> & { ts?: string },
    options?: { skipBuffer?: boolean }
  ): void {
    const full: ObservabilityEvent = {
      ...event,
      ts: event.ts ?? new Date().toISOString(),
    };
    if (!options?.skipBuffer) {
      this.buffer.push(full);
      if (this.buffer.length > this.maxSize) {
        this.buffer.splice(0, this.buffer.length - this.maxSize);
      }
    }
    for (const sub of this.subscribers) {
      try {
        sub(full);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  snapshot(): ObservabilityEvent[] {
    return [...this.buffer];
  }

  appendAgentProcessLog(agentId: string, line: string): void {
    let arr = this.agentProcessLogs.get(agentId);
    if (!arr) {
      arr = [];
      this.agentProcessLogs.set(agentId, arr);
    }
    arr.push(line);
    if (arr.length > this.maxLogLinesPerAgent) {
      arr.splice(0, arr.length - this.maxLogLinesPerAgent);
    }
  }

  getAgentProcessLogs(agentId: string): string[] {
    return [...(this.agentProcessLogs.get(agentId) ?? [])];
  }

  appendGlobalLocalLog(line: string): void {
    this.globalLocalShareLines.push(line);
    if (this.globalLocalShareLines.length > this.maxGlobalLocalLines) {
      this.globalLocalShareLines.splice(0, this.globalLocalShareLines.length - this.maxGlobalLocalLines);
    }
  }

  getGlobalLocalLogs(): string[] {
    return [...this.globalLocalShareLines];
  }

  getAgentLogBundle(agentId: string): { process: string[]; localShare: string[] } {
    return {
      process: this.getAgentProcessLogs(agentId),
      localShare: this.getGlobalLocalLogs(),
    };
  }

  /** 返回取消订阅函数 */
  subscribe(cb: (e: ObservabilityEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }
}
