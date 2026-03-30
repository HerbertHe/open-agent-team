import type { AgentInstanceSpec } from "../types";
import type { RuntimeHandle, RuntimeProvider } from "./interface";
import { t } from "../i18n/i18n";

export class FlueProvider implements RuntimeProvider {
  async start(_spec: AgentInstanceSpec): Promise<RuntimeHandle> {
    throw new Error(t("provider_flue_placeholder"));
  }
  async stop(_agentId: string): Promise<void> {
    return;
  }
  async stopAll(): Promise<void> {
    return;
  }
  async health(_port: number): Promise<boolean> {
    return false;
  }
}
