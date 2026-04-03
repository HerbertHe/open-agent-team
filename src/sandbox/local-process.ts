import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { AgentInstanceSpec } from "../types";
import type { RuntimeHandle, RuntimeProvider } from "./interface";

export type ProcessLogLine = { agentId: string; line: string; stream: "stdout" | "stderr" };

function attachLineStream(
  stream: Readable | null,
  streamName: "stdout" | "stderr",
  agentId: string,
  onLine: (info: ProcessLogLine) => void
): void {
  if (!stream) return;
  let buf = "";
  stream.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      onLine({ agentId, line, stream: streamName });
    }
  });
  stream.on("end", () => {
    if (buf.trim()) {
      onLine({ agentId, line: buf, stream: streamName });
    }
  });
}

export class LocalProcessProvider implements RuntimeProvider {
  private readonly handles = new Map<string, { handle: RuntimeHandle; kill: () => void }>();

  constructor(
    private readonly executable: string,
    private readonly injectedEnv: Record<string, string> = {},
    private readonly onProcessLog?: (info: ProcessLogLine) => void
  ) {}

  async start(spec: AgentInstanceSpec): Promise<RuntimeHandle> {
    // 默认使用 DEBUG，便于在 dashboard/日志中追踪执行过程。
    const logLevel = "DEBUG";

    const child = spawn(
      this.executable,
      [
        "serve",
        "--port",
        String(spec.port),
        "--hostname",
        "127.0.0.1",
        "--print-logs",
        "--log-level",
        logLevel,
      ],
      {
        cwd: spec.workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: { ...process.env, ...this.injectedEnv },
      }
    );
    if (this.onProcessLog) {
      attachLineStream(child.stdout, "stdout", spec.id, this.onProcessLog);
      attachLineStream(child.stderr, "stderr", spec.id, this.onProcessLog);
    }
    child.on("error", (err: Error) => {
      this.onProcessLog?.({
        agentId: spec.id,
        line: `spawn error: ${err.message}`,
        stream: "stderr",
      });
    });
    child.on("exit", (code, signal) => {
      this.onProcessLog?.({
        agentId: spec.id,
        line: `process exited: code=${code ?? "null"} signal=${signal ?? "null"}`,
        stream: "stderr",
      });
    });
    const handle: RuntimeHandle = { agentId: spec.id, port: spec.port, pid: child.pid };
    this.handles.set(spec.id, {
      handle,
      kill: () => {
        if (!child.killed) child.kill("SIGTERM");
      },
    });
    return handle;
  }

  async stop(agentId: string): Promise<void> {
    this.handles.get(agentId)?.kill();
    this.handles.delete(agentId);
  }

  /** 仅终止本 Provider 实例通过 {@link start} 注册的子进程，不会按名称扫描或结束其它 opencode 进程。 */
  async stopAll(): Promise<void> {
    for (const { kill } of this.handles.values()) {
      try {
        kill();
      } catch {
        /* ignore */
      }
    }
    this.handles.clear();
  }

  async health(port: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/global/health`, {
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
