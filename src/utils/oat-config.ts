import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface OatGlobalConfig {
  language?: string;
  logRetentionDays?: number;
  resource_agent?: {
    model?: string;
  };
  channels?: Record<
    string,
    {
      accounts: Record<string, Record<string, any>>;
    }
  >;
}

const OAT_CONFIG_DIR = path.join(os.homedir(), ".oat");
const OAT_CONFIG_FILE = path.join(OAT_CONFIG_DIR, "oat.json");

/**
 * 读取 ~/.oat/oat.json 全局配置。
 * 文件不存在或解析失败时返回空对象。
 */
export async function loadOatConfig(): Promise<OatGlobalConfig> {
  try {
    const raw = await fs.readFile(OAT_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as OatGlobalConfig;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * 合并写入 ~/.oat/oat.json（只覆盖传入的字段，保留其他字段）。
 */
export async function saveOatConfig(
  updates: Partial<OatGlobalConfig>,
): Promise<void> {
  const existing = await loadOatConfig();
  const merged = { ...existing, ...updates };
  await fs.mkdir(OAT_CONFIG_DIR, { recursive: true });
  await fs.writeFile(OAT_CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
}

/**
 * 获取日志保留天数（默认 3 天）。
 */
export async function getLogRetentionDays(): Promise<number> {
  const config = await loadOatConfig();
  const days = config.logRetentionDays;
  if (typeof days === "number" && days > 0) return days;
  return 3;
}
