import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ObservabilityHub } from "./observability-hub";

/** OpenCode 文档：日志在 ~/.local/share/opencode/log（Windows：%USERPROFILE%\.local\share\opencode\log） */
export function getOpencodeLocalLogDir(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "log");
}

function lineMentionsPort(line: string, port: number): boolean {
  const p = String(port);
  if (line.includes(`127.0.0.1:${p}`) || line.includes(`localhost:${p}`)) return true;
  if (line.includes(`:${p}`) && /\d/.test(line)) {
    const re = new RegExp(`:${p}(?:\\D|$)`);
    if (re.test(line)) return true;
  }
  if (new RegExp(`\\bport\\s*[=:]\\s*${p}\\b`, "i").test(line)) return true;
  if (line.includes(` ${p} `) || line.endsWith(` ${p}`)) return true;
  return false;
}

/**
 * 轮询 tail ~/.local/share/opencode/log/*.log，写入 hub 全局缓冲与 SSE（不写入主时间线 buffer）。
 */
export class OpencodeLocalLogWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly filePositions = new Map<string, number>();
  private ticking = false;

  constructor(
    private readonly hub: ObservabilityHub,
    private readonly getAgentPorts: () => Array<{ agentId: string; port: number }>
  ) {}

  start(intervalMs = 1500): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tickSafe(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tickSafe(): void {
    if (this.ticking) return;
    this.ticking = true;
    void this.tick().finally(() => {
      this.ticking = false;
    });
  }

  private async tick(): Promise<void> {
    const dir = getOpencodeLocalLogDir();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries
      .filter((e) => e.isFile() && String(e.name).endsWith(".log"))
      .map((e) => path.join(dir, String(e.name)));
    for (const fp of files) {
      await this.tailFile(fp);
    }
  }

  private async tailFile(fp: string): Promise<void> {
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(fp);
    } catch {
      return;
    }
    let pos = this.filePositions.get(fp);
    if (pos === undefined) {
      this.filePositions.set(fp, st.size);
      return;
    }
    if (pos > st.size) pos = 0;
    if (pos === st.size) return;
    const len = st.size - pos;
    const buf = Buffer.alloc(len);
    const fh = await fs.open(fp, "r");
    try {
      await fh.read(buf, 0, len, pos);
    } finally {
      await fh.close();
    }
    this.filePositions.set(fp, st.size);
    const text = buf.toString("utf8");
    const base = path.basename(fp);
    const ports = this.getAgentPorts();
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line.trim()) continue;
      const prefixed = `[.local/log/${base}] ${line}`;
      this.hub.appendGlobalLocalLog(prefixed);
      const matched = ports.filter(({ port }) => lineMentionsPort(line, port));
      const agentId = matched.length === 1 ? matched[0].agentId : undefined;
      this.hub.emit(
        {
          source: "opencode",
          type: "opencode.local.log",
          agentId,
          payload: { line: prefixed, file: base },
        },
        { skipBuffer: true }
      );
    }
  }
}
