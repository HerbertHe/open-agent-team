/**
 * 模型调用用量追踪器。
 *
 * 监听 ObservabilityHub 事件，从 pi.message_end（assistant 角色）中提取 token usage，
 * 持久化到 ~/.oat/usage/<projectName>/<YYYY-MM-DD>.jsonl。
 * 提供按项目、时间范围聚合查询的方法。
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ObservabilityHub } from "./observability-hub";
import { logger } from "../utils/logger";

export interface UsageRecord {
  ts: string;
  projectName: string;
  agentId: string;
  agentRole: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface AggregatedStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCost: number;
  /** 按时间分组的数据（用于折线/柱状图） */
  timeline: Array<{
    time: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  /** 按 agent 分组的数据（用于饼图） */
  byAgent: Array<{ agentId: string; totalTokens: number; requests: number }>;
  /** 按 model 分组的数据（用于饼图） */
  byModel: Array<{ model: string; totalTokens: number; requests: number }>;
}

export type TimeRange = "all" | "30d" | "7d" | "yesterday" | "today";

export class UsageTracker {
  private readonly usageDir: string;
  private unsubscribe?: () => void;

  constructor(
    private readonly projectName: string,
    private readonly modelResolver?: (agentId: string, role: string) => string
  ) {
    this.usageDir = path.join(os.homedir(), ".oat", "usage", projectName);
  }

  /**
   * 连接 ObservabilityHub，开始监听 pi agent 事件。
   *
   * ObservabilityHub 发出的事件结构：
   *   { ts, source: "pi", type: "pi.message_end", agentId, role, payload: { piEvent: { type: "message_end", message: { role, usage, ... } } } }
   */
  attach(hub: ObservabilityHub): void {
    this.unsubscribe = hub.subscribe((event) => {
      if (event.type !== "pi.message_end") return;

      const piEvent = (event.payload as Record<string, unknown>)?.piEvent as
        | {
            type?: string;
            message?: {
              role?: string;
              usage?: {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
                cost?: { total?: number };
              };
            };
          }
        | undefined;

      if (
        piEvent?.message?.role === "assistant" &&
        piEvent.message.usage
      ) {
        const usage = piEvent.message.usage;
        const record: UsageRecord = {
          ts: event.ts,
          projectName: this.projectName,
          agentId: event.agentId ?? "unknown",
          agentRole: (event.role as string) ?? "unknown",
          model: this.modelResolver?.(event.agentId ?? "unknown", (event.role as string) ?? "unknown") ?? "unknown",
          inputTokens: usage.input ?? 0,
          outputTokens: usage.output ?? 0,
          cacheReadTokens: usage.cacheRead ?? 0,
          cacheWriteTokens: usage.cacheWrite ?? 0,
          cost: usage.cost?.total ?? 0,
        };
        void this.writeRecord(record);
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async writeRecord(record: UsageRecord): Promise<void> {
    try {
      await fs.mkdir(this.usageDir, { recursive: true });
      const date = record.ts.slice(0, 10); // YYYY-MM-DD
      const filePath = path.join(this.usageDir, `${date}.jsonl`);
      await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
    } catch (err) {
      logger.warn("Usage record write failed", { error: String(err) });
    }
  }

  /** 读取指定日期范围内的所有记录 */
  async readRecords(startDate: string, endDate: string): Promise<UsageRecord[]> {
    const records: UsageRecord[] = [];
    try {
      const files = await fs.readdir(this.usageDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const fileDate = file.replace(".jsonl", "");
        if (fileDate < startDate || fileDate > endDate) continue;
        const content = await fs.readFile(path.join(this.usageDir, file), "utf8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            records.push(JSON.parse(line) as UsageRecord);
          } catch { /* skip malformed lines */ }
        }
      }
    } catch { /* directory may not exist */ }
    return records;
  }

  /** 获取聚合统计数据 */
  async getStats(range: TimeRange, groupBy: "day" | "hour" = "day"): Promise<AggregatedStats> {
    const { startDate, endDate } = getDateRange(range);
    const records = await this.readRecords(startDate, endDate);
    return aggregateRecords(records, groupBy, range);
  }

  /** 获取所有有用量数据的项目列表（静态方法，扫描 ~/.oat/usage/） */
  static async listProjects(): Promise<string[]> {
    const usageRoot = path.join(os.homedir(), ".oat", "usage");
    try {
      const entries = await fs.readdir(usageRoot, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** 跨项目聚合统计 */
  static async getAllProjectsStats(range: TimeRange, groupBy: "day" | "hour" = "day"): Promise<AggregatedStats> {
    const projects = await UsageTracker.listProjects();
    const allRecords: UsageRecord[] = [];
    const { startDate, endDate } = getDateRange(range);
    for (const project of projects) {
      const tracker = new UsageTracker(project);
      const records = await tracker.readRecords(startDate, endDate);
      allRecords.push(...records);
    }
    return aggregateRecords(allRecords, groupBy, range);
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getDateRange(range: TimeRange): { startDate: string; endDate: string } {
  const now = new Date();
  switch (range) {
    case "today":
      return { startDate: formatDate(now), endDate: formatDate(now) };
    case "yesterday": {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { startDate: formatDate(d), endDate: formatDate(d) };
    }
    case "7d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return { startDate: formatDate(d), endDate: formatDate(now) };
    }
    case "30d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      return { startDate: formatDate(d), endDate: formatDate(now) };
    }
    case "all":
    default:
      return { startDate: "2020-01-01", endDate: "2099-12-31" };
  }
}

function aggregateRecords(records: UsageRecord[], groupBy: "day" | "hour", range: TimeRange): AggregatedStats {
  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCost = 0;

  const timeMap = new Map<string, { requests: number; inputTokens: number; outputTokens: number }>();
  const agentMap = new Map<string, { totalTokens: number; requests: number }>();
  const modelMap = new Map<string, { totalTokens: number; requests: number }>();

  // 根据 range 预填充 0 数据
  const pad = (n: number) => n.toString().padStart(2, "0");
  const now = new Date();
  if (groupBy === "hour") {
    // 补齐 24 小时
    const targetDates = [new Date(now)];
    if (range === "yesterday") {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      targetDates[0] = y;
    }
    for (const targetDate of targetDates) {
      const localDate = `${targetDate.getFullYear()}-${pad(targetDate.getMonth() + 1)}-${pad(targetDate.getDate())}`;
      for (let i = 0; i < 24; i++) {
        timeMap.set(`${localDate}T${pad(i)}:00`, { requests: 0, inputTokens: 0, outputTokens: 0 });
      }
    }
  } else if (range === "7d" || range === "30d") {
    // 补齐天数
    const days = range === "7d" ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const localDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      timeMap.set(localDate, { requests: 0, inputTokens: 0, outputTokens: 0 });
    }
  }

  for (const r of records) {
    totalRequests++;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCacheReadTokens += r.cacheReadTokens;
    totalCacheWriteTokens += r.cacheWriteTokens;
    totalCost += r.cost;

    // 时间分组 (使用本地时区)
    const d = new Date(r.ts);
    const localDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timeKey = groupBy === "hour"
      ? `${localDate}T${pad(d.getHours())}:00`
      : localDate;
    const tm = timeMap.get(timeKey) ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
    tm.requests++;
    tm.inputTokens += r.inputTokens;
    tm.outputTokens += r.outputTokens;
    timeMap.set(timeKey, tm);

    // Agent 分组
    const am = agentMap.get(r.agentId) ?? { totalTokens: 0, requests: 0 };
    am.totalTokens += r.inputTokens + r.outputTokens;
    am.requests++;
    agentMap.set(r.agentId, am);

    // Model 分组
    const mm = modelMap.get(r.model) ?? { totalTokens: 0, requests: 0 };
    mm.totalTokens += r.inputTokens + r.outputTokens;
    mm.requests++;
    modelMap.set(r.model, mm);
  }

  const timeline = Array.from(timeMap.entries())
    .map(([time, data]) => ({ time, ...data }))
    .sort((a, b) => a.time.localeCompare(b.time));

  const byAgent = Array.from(agentMap.entries())
    .map(([agentId, data]) => ({ agentId, ...data }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const byModel = Array.from(modelMap.entries())
    .map(([model, data]) => ({ model, ...data }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalCost,
    timeline,
    byAgent,
    byModel,
  };
}
