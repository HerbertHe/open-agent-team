import type { AgentInstanceSpec } from "../types";
import type { RuntimeHandle, RuntimeProvider } from "./interface";

export class FlueProvider implements RuntimeProvider {
  async start(_spec: AgentInstanceSpec): Promise<RuntimeHandle> {
    throw new Error("FlueProvider 为可选项，当前仓库仅提供接口占位。");
  }
  async stop(_agentId: string): Promise<void> {
    return;
  }
  async health(_port: number): Promise<boolean> {
    return false;
  }
}
