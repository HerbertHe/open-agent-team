import type { ResolvedConfig, AgentInstanceSpec } from "../types";
import type { WorkspaceProvider } from "../sandbox/interface";
import { WorktreeWorkspaceProvider } from "../git/worktree-manager";
import { WorkspaceProviderTypeEnum } from "../types";
import { t } from "../i18n/i18n";

export class WorkspaceProviderFactory {
  constructor(private readonly config: ResolvedConfig) {}

  getProvider(): WorkspaceProvider {
    const p = this.config.workspace.provider;
    if (p === WorkspaceProviderTypeEnum.Worktree) return new WorktreeWorkspaceProvider(this.config);

    // 目前实现先覆盖 worktree；其它策略留接口位，便于你后续扩展
    return new (class implements WorkspaceProvider {
      async ensureWorkspace(_spec: AgentInstanceSpec, _sparsePaths: string[]): Promise<{ path: string; branch: string }> {
        throw new Error(t("workspace_provider_unimplemented", { provider: p }));
      }
      async removeWorkspace(_spec: AgentInstanceSpec) {
        return;
      }
    })();
  }
}

