import type { AgentInstanceSpec } from "../types";
import type { RuntimeHandle, RuntimeProvider } from "./interface";

export class DockerProvider implements RuntimeProvider {
  async start(_spec: AgentInstanceSpec): Promise<RuntimeHandle> {
    throw new Error("DockerProvider 暂未启用。当前推荐 local_process 运行时。");
  }
  async stop(_agentId: string): Promise<void> {
    return;
  }
  async health(_port: number): Promise<boolean> {
    return false;
  }
}
