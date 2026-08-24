import fs from "node:fs/promises";
import path from "node:path";
import type { ObservabilityEvent } from "../types/observability";

const DEFAULT_AGENT_LOG_CAP = 4000;
const DEFAULT_GLOBAL_LOCAL_CAP = 2500;

/**
 * 内存有界环形缓冲 + 多订阅者 + 磁盘日志持久化。
 * 用于 Desktop SSE 与编排/pi Agent 事件汇聚。
 */
export class ObservabilityHub {
  private buffer: ObservabilityEvent[] = [];
  private readonly maxSize: number;
  private readonly subscribers = new Set<(e: ObservabilityEvent) => void>();
  /** 各 Agent 的附加日志行（供 GET 快照与弹窗） */
  private readonly agentProcessLogs = new Map<string, string[]>();
  private readonly maxLogLinesPerAgent: number;
  private globalLocalShareLines: string[] = [];
  private readonly maxGlobalLocalLines: number;

  /** agentId → disk log write stream info */
  private readonly diskLoggers = new Map<string, { logsDir: string; agentId: string }>();

  constructor(
    maxSize = 1500,
    maxLogLinesPerAgent = DEFAULT_AGENT_LOG_CAP,
    maxGlobalLocalLines = DEFAULT_GLOBAL_LOCAL_CAP
  ) {
    this.maxSize = maxSize;
    this.maxLogLinesPerAgent = maxLogLinesPerAgent;
    this.maxGlobalLocalLines = maxGlobalLocalLines;
  }

  /**
   * 为指定 Agent 启用磁盘日志，写入 <workspacePath>/logs/<agentId>-<date>.jsonl
   */
  enableDiskLogger(workspacePath: string, agentId: string): void {
    const logsDir = path.join(workspacePath, "logs");
    this.diskLoggers.set(agentId, { logsDir, agentId });
  }

  /**
   * 禁用指定 Agent 的磁盘日志
   */
  disableDiskLogger(agentId: string): void {
    this.diskLoggers.delete(agentId);
  }

  private async writeToDisk(agentId: string, event: ObservabilityEvent): Promise<void> {
    const info = this.diskLoggers.get(agentId);
    if (!info) return;

    const date = event.ts.slice(0, 10); // YYYY-MM-DD
    const fileName = `${agentId}-${date}.jsonl`;
    const filePath = path.join(info.logsDir, fileName);

    try {
      await fs.mkdir(info.logsDir, { recursive: true });
      await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // Disk write failures should not break the event pipeline
    }
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

    // Disk persistence for agent events
    if (full.agentId && this.diskLoggers.has(full.agentId)) {
      void this.writeToDisk(full.agentId, full);
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
