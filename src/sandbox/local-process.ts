import { spawn } from "node:child_process";
import type { AgentInstanceSpec } from "../types";
import type { RuntimeHandle, RuntimeProvider } from "./interface";

export class LocalProcessProvider implements RuntimeProvider {
  private readonly handles = new Map<string, { handle: RuntimeHandle; kill: () => void }>();

  constructor(private readonly executable: string) {}

  async start(spec: AgentInstanceSpec): Promise<RuntimeHandle> {
    const child = spawn(
      this.executable,
      ["serve", "--port", String(spec.port), "--hostname", "127.0.0.1"],
      { cwd: spec.workspacePath, stdio: "ignore", detached: false }
    );
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
