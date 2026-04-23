import type { AgentInstanceSpec, AgentRoleEnum } from "../types";
import type { RuntimeHandle, RuntimeProvider } from "./interface";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession as PiAgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

export type AgentEventLine = { agentId: string; event: AgentSessionEvent; role?: AgentRoleEnum };

function splitModel(model: string): { provider: string; modelId: string } {
  const idx = model.indexOf("/");
  if (idx < 0) return { provider: "anthropic", modelId: model };
  return { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
}

/** 每个 AgentSession 的内部条目：同时管理会话对象、重建所需的元数据、事件取消订阅函数。 */
type SessionEntry = {
  session: PiAgentSession;
  spec: AgentInstanceSpec;
  options?: { systemPrompt?: string; customTools?: ReturnType<typeof defineTool>[] };
  unsubscribe: () => void;
};

/**
 * 基于 @mariozechner/pi-coding-agent SDK 的 Agent 会话提供者。
 * 以进程内 AgentSession 管理各 Agent 的生命周期与通信。
 */
export class PiSessionProvider implements RuntimeProvider {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly agentDir: string;

  constructor(
    agentDir?: string,
    private readonly onAgentEvent?: (info: AgentEventLine) => void,
  ) {
    this.agentDir = agentDir ?? getAgentDir();
  }

  /**
   * 为指定 Agent 创建 pi AgentSession。
   * customTools 由调用方（Orchestrator/TaskManager）提供，包含编排工具的直接调用逻辑。
   */
  async start(
    spec: AgentInstanceSpec,
    options?: {
      systemPrompt?: string;
      customTools?: ReturnType<typeof defineTool>[];
    },
  ): Promise<RuntimeHandle> {
    const { provider, modelId } = splitModel(spec.model);
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = modelRegistry.find(provider, modelId) ?? undefined;
    if (!model) {
      throw new Error(
        `Model not found in registry: provider="${provider}" modelId="${modelId}" (agentId=${spec.id}). ` +
          `Check team.json model config and pi agentDir credentials (${this.agentDir}).`,
      );
    }

    const loader = new DefaultResourceLoader({
      cwd: spec.workspacePath,
      agentDir: this.agentDir,
      systemPromptOverride: options?.systemPrompt ? () => options.systemPrompt! : undefined,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: spec.workspacePath,
      agentDir: this.agentDir,
      model,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      customTools: options?.customTools ?? [],
      resourceLoader: loader,
    });

    const unsubscribe = session.subscribe((event) => {
      this.onAgentEvent?.({ agentId: spec.id, event, role: spec.role });
    });

    this.entries.set(spec.id, { session, spec, options, unsubscribe });
    return { agentId: spec.id };
  }

  async stop(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (entry) {
      try { entry.unsubscribe(); } catch { /* noop */ }
      try { entry.session.dispose(); } catch { /* noop */ }
      this.entries.delete(agentId);
    }
  }

  async stopAll(): Promise<void> {
    for (const agentId of [...this.entries.keys()]) {
      await this.stop(agentId);
    }
  }

  async health(_agentId: string): Promise<boolean> {
    return true;
  }

  getSession(agentId: string): PiAgentSession | undefined {
    return this.entries.get(agentId)?.session;
  }

  /** 向指定 Agent 发送 prompt（返回 Promise 在消息被接受后 resolve）。 */
  async sendPrompt(agentId: string, text: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) {
      throw new Error(`PiSessionProvider: session not found for agentId=${agentId}`);
    }
    await entry.session.prompt(text);
  }

  /**
   * 重置 Agent 会话：dispose 旧 session 并以相同配置创建新 session（清空对话历史）。
   * 用于 Worker 任务完成后清除上下文，避免历史污染下一次任务。
   */
  async resetSession(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    const { spec, options } = entry;
    await this.stop(agentId);
    await this.start(spec, options);
  }
}
