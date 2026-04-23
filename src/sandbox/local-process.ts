/**
 * 基于 child_process.fork() 的 Agent 进程提供者。
 *
 * 每个 Agent 运行在独立的 Node.js 子进程中，通过 IPC 通道与主进程通信。
 * 子进程运行 agent-runner.ts（开发）或编译后的 agent-runner.js（生产）。
 *
 * 崩溃隔离：OS 进程级。子进程崩溃不影响主进程或其他 Agent 子进程，
 * 触发 onAgentError 回调后由上层 Agent 决定处理策略（TaskManager.handleAgentCrash）。
 */

import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentInstanceSpec, AgentRoleEnum } from "../types";
import type { RuntimeHandle, RuntimeProvider } from "./interface";
import { defineTool, getAgentDir } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  MainToChild,
  ChildToMain,
  SerializableToolDef,
  ToolResultPayload,
} from "./agent-runner-ipc";

// ─── 公共类型（与外部调用者兼容）──────────────────────────────────────────────

export type AgentEventLine = {
  agentId: string;
  event: AgentSessionEvent;
  role?: AgentRoleEnum;
};

export type AgentErrorInfo = {
  agentId: string;
  role?: AgentRoleEnum;
  error: Error;
};

// ─── 内部类型 ────────────────────────────────────────────────────────────────

/** 工具 execute 函数的签名（主进程侧执行）。 */
type ToolExecuteFn = (
  toolCallId: string,
  params: unknown,
) => Promise<ToolResultPayload>;

/** 对 defineTool 返回值的最小结构期望（用于提取元数据和 execute 函数）。 */
type ToolLike = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResultPayload>;
};

type StartOptions = {
  systemPrompt?: string;
  customTools?: ReturnType<typeof defineTool>[];
};

type ChildEntry = {
  child: ChildProcess;
  spec: AgentInstanceSpec;
  /** 原始 startOptions，用于 resetSession 重建子进程。 */
  startOptions: StartOptions;
  /** key = tool name，值 = 主进程侧 execute 函数。 */
  toolRegistry: Map<string, ToolExecuteFn>;
};

// ─── 运行时路径解析 ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 解析 agent-runner 的可执行路径。
 * - 当前文件为 .ts（tsx 开发模式）→ 用 tsx 运行 agent-runner.ts
 * - 当前文件为 .js（tsup 编译产物）→ 直接 fork agent-runner.js
 */
function resolveRunnerExec(): { execPath: string | undefined; runnerPath: string } {
  const isTsSource = __filename.endsWith(".ts");
  if (isTsSource) {
    const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const runnerTs = path.join(__dirname, "agent-runner.ts");
    return { execPath: tsxBin, runnerPath: runnerTs };
  }
  const runnerJs = path.join(__dirname, "agent-runner.js");
  return { execPath: undefined, runnerPath: runnerJs };
}

// ─── 工具辅助 ─────────────────────────────────────────────────────────────────

function extractToolMeta(tool: ReturnType<typeof defineTool>): SerializableToolDef {
  const t = tool as unknown as ToolLike;
  return { name: t.name, label: t.label, description: t.description, parameters: t.parameters };
}

function extractToolExecute(tool: ReturnType<typeof defineTool>): [string, ToolExecuteFn] {
  const t = tool as unknown as ToolLike;
  return [t.name, t.execute.bind(t)];
}

// ─── PiSessionProvider ────────────────────────────────────────────────────────

/**
 * Agent 进程提供者。对外接口与原进程内实现完全兼容，
 * 内部用 child_process.fork() 替换 createAgentSession()。
 */
export class PiSessionProvider implements RuntimeProvider {
  private readonly entries = new Map<string, ChildEntry>();
  private readonly agentDir: string;

  constructor(
    agentDir?: string,
    private readonly onAgentEvent?: (info: AgentEventLine) => void,
    private readonly onAgentError?: (info: AgentErrorInfo) => void,
  ) {
    this.agentDir = agentDir ?? getAgentDir();
  }

  /**
   * 启动 Agent 子进程。执行顺序：
   * 1. fork agent-runner
   * 2. 注册 "ready" 一次性监听器
   * 3. 发送 "start" IPC 消息（包含工具元数据）
   * 4. 等待 "ready"（60s 超时）
   * 5. 绑定持久 IPC 事件处理器
   */
  async start(spec: AgentInstanceSpec, options?: StartOptions): Promise<RuntimeHandle> {
    const customTools = options?.customTools ?? [];
    const toolDefs: SerializableToolDef[] = customTools.map(extractToolMeta);
    const toolRegistry = new Map<string, ToolExecuteFn>(customTools.map(extractToolExecute));

    const { execPath, runnerPath } = resolveRunnerExec();

    if (!existsSync(runnerPath)) {
      throw new Error(
        `agent-runner not found at ${runnerPath}. ` +
          `Run \`pnpm build\` first, or ensure tsx is in node_modules/.bin for development.`,
      );
    }

    const child = fork(runnerPath, [], {
      execPath,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: process.env,
    });

    // 子进程 stdout/stderr 转接父进程（保留可见性）
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);

    const entry: ChildEntry = {
      child,
      spec,
      startOptions: options ?? {},
      toolRegistry,
    };
    this.entries.set(spec.id, entry);

    // 步骤 2：先注册 ready 监听，步骤 3：再发送 start，步骤 4：等待 ready
    // 注意顺序：监听必须在 send 之前，否则 ready 可能在监听器注册前到达
    const readyPromise = this.waitForReady(spec.id, child);
    child.send({
      type: "start",
      spec: {
        id: spec.id,
        role: spec.role as string,
        name: spec.name,
        branch: spec.branch,
        workspacePath: spec.workspacePath,
        model: spec.model,
        teamName: spec.teamName,
        skills: spec.skills,
      },
      agentDir: this.agentDir,
      systemPrompt: options?.systemPrompt,
      toolDefs,
    } as MainToChild);

    try {
      await readyPromise;
    } catch (err) {
      // 启动失败：清理 entry，并强制终止已 fork 的子进程防止孤儿进程
      this.entries.delete(spec.id);
      try { child.kill("SIGKILL"); } catch { /* 子进程可能已自行退出 */ }
      throw err;
    }

    // 步骤 5：ready 后绑定持久事件处理器
    this.bindChildEvents(spec.id, child, spec);

    return { agentId: spec.id };
  }

  /**
   * 等待子进程发送 "ready" 或 "agent_error"（60s 超时）。
   * 使用一次性监听器，resolve/reject 后自动移除。
   */
  private waitForReady(agentId: string, child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutMs = 60_000;
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Agent ${agentId} startup timed out after ${timeoutMs / 1000}s. ` +
              `Check model config and network connectivity.`,
          ),
        );
      }, timeoutMs);

      const onMessage = (rawMsg: unknown) => {
        const msg = rawMsg as ChildToMain;
        if (msg.type === "ready") {
          cleanup();
          resolve();
        } else if (msg.type === "agent_error") {
          cleanup();
          reject(new Error(`Agent ${agentId} startup error: ${msg.error}`));
        }
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `Agent ${agentId} exited (code=${code}, signal=${signal}) before sending "ready"`,
          ),
        );
      };

      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };

      child.on("message", onMessage);
      child.on("exit", onExit);
    });
  }

  /**
   * 绑定持久性 IPC 事件处理器（仅在 "ready" 确认后调用）：
   * - agent_event → onAgentEvent 回调
   * - tool_call   → 在主进程执行工具，返回 tool_result
   * - agent_error → onAgentError 回调（崩溃通知链起点）
   * - exit        → 非正常退出时触发 onAgentError
   */
  private bindChildEvents(
    agentId: string,
    child: ChildProcess,
    spec: AgentInstanceSpec,
  ): void {
    child.on("message", (rawMsg: unknown) => {
      const msg = rawMsg as ChildToMain;
      const entry = this.entries.get(agentId);

      if (msg.type === "agent_event") {
        this.onAgentEvent?.({
          agentId,
          event: msg.event as unknown as AgentSessionEvent,
          role: spec.role,
        });
        return;
      }

      if (msg.type === "tool_call") {
        const execute = entry?.toolRegistry.get(msg.toolName);
        if (!execute) {
          try {
            child.send({
              type: "tool_result",
              callId: msg.callId,
              error: `Tool "${msg.toolName}" not registered for agentId=${agentId}`,
            } as MainToChild);
          } catch { /* 子进程已退出，忽略 */ }
          return;
        }
        // 在主进程执行工具（拥有完整的 TaskManager 上下文）
        // 注意：工具执行期间子进程可能崩溃，需用 try-catch 防止 child.send() 抛出导致 unhandledRejection
        execute(msg.toolCallId, msg.params)
          .then((result) => {
            try {
              child.send({ type: "tool_result", callId: msg.callId, result } as MainToChild);
            } catch { /* 子进程已退出，忽略发送失败 */ }
          })
          .catch((err: unknown) => {
            try {
              child.send({
                type: "tool_result",
                callId: msg.callId,
                error: err instanceof Error ? err.message : String(err),
              } as MainToChild);
            } catch { /* 子进程已退出，忽略发送失败 */ }
          });
        return;
      }

      if (msg.type === "agent_error") {
        // 若 entry 已不在 entries 中，说明 stop() 已主动移除该 Agent（正常关闭流程）。
        // session.dispose() 可能同步触发 subscribe error 回调并向父进程发送 agent_error，
        // 不加此判断会产生虚假崩溃通知，导致 leader 收到错误的 WORKER_CRASH，
        // 且后续真实崩溃的通知被 crashedAgents 去重逻辑误压制。
        if (!this.entries.has(agentId)) return;
        this.onAgentError?.({
          agentId,
          role: spec.role,
          error: new Error(msg.error),
        });
        return;
      }
    });

    child.on("exit", (code, signal) => {
      // 已被 stop() 正常移除时不误报
      if (!this.entries.has(agentId)) return;

      const isGracefulExit = code === 0;
      if (!isGracefulExit) {
        this.onAgentError?.({
          agentId,
          role: spec.role,
          error: new Error(
            `Agent ${agentId} process crashed (code=${code}, signal=${signal})`,
          ),
        });
      }
      this.entries.delete(agentId);
    });

    child.on("error", (err) => {
      // stop() 先删除 entry 再等待子进程退出，此窗口内若 IPC 管道报错不应误报崩溃
      if (!this.entries.has(agentId)) return;
      this.onAgentError?.({ agentId, role: spec.role, error: err });
    });
  }

  async stop(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) return;

    // 先从 entries 移除，防止 "exit" 事件触发 onAgentError
    this.entries.delete(agentId);

    try {
      entry.child.send({ type: "stop" } as MainToChild);
    } catch { /* 子进程可能已提前退出 */ }

    // 若子进程已退出（exitCode 非 null），无需等待直接返回
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
      return;
    }

    // 给子进程 2s 优雅退出时间，超时后强制 SIGKILL
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        try { entry.child.kill("SIGKILL"); } catch { /* noop */ }
        resolve();
      }, 2_000);

      entry.child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
  }

  async stopAll(): Promise<void> {
    for (const agentId of [...this.entries.keys()]) {
      await this.stop(agentId);
    }
  }

  async health(agentId: string): Promise<boolean> {
    const entry = this.entries.get(agentId);
    if (!entry) return false;
    return entry.child.exitCode === null && entry.child.signalCode === null;
  }

  /**
   * 向指定 Agent 发送 prompt（非阻塞 IPC 消息，立即返回）。
   * 子进程通过 session.prompt() 异步执行；Agent 完成后调用 notify-complete 工具回报。
   */
  async sendPrompt(agentId: string, text: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) {
      throw new Error(`PiSessionProvider: no process found for agentId=${agentId}`);
    }
    // 子进程退出后，父进程的 exit 事件（macrotask）可能还未触发 entries.delete，
    // 此时 child.send() 会同步抛出 "write after end"（IPC channel 已关闭）。
    // 用 try-catch 将其转换为可预期的 Error，让调用方统一处理。
    try {
      entry.child.send({ type: "prompt", text } as MainToChild);
    } catch (err) {
      throw new Error(
        `PiSessionProvider: failed to send prompt to agentId=${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 重置 Agent 会话：停止旧子进程并以相同配置重新 fork（清空对话历史）。
   * 用于 Worker 在重新派发任务前进行上下文隔离。
   */
  async resetSession(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    const { spec, startOptions } = entry;
    await this.stop(agentId);
    await this.start(spec, startOptions);
  }
}
