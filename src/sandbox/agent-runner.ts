/**
 * Agent 子进程入口（由 PiSessionProvider 通过 child_process.fork() 启动）。
 *
 * 生命周期：
 *   1. 父进程发送 { type: "start", spec, agentDir, systemPrompt, toolDefs }
 *   2. 子进程创建 pi AgentSession，向父进程回报 { type: "ready" }
 *   3. 父进程发送 { type: "prompt", text } → session.prompt(text)
 *   4. 工具调用：session 调用 stub → 子进程发送 tool_call → 父进程执行并回传 tool_result
 *   5. session 事件通过 { type: "agent_event" } 实时广播给父进程
 *   6. 父进程发送 { type: "stop" } → session.dispose() → process.exit(0)
 *
 * 错误隔离：
 *   - uncaughtException / unhandledRejection 均发送 agent_error 后以 code=1 退出
 *   - 父进程监听子进程的 "exit" 事件，非正常退出时触发崩溃通知链
 */

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type {
  MainToChild,
  ChildToMain,
  SerializableToolDef,
  ToolResultPayload,
} from "./agent-runner-ipc";
import readline from "node:readline";
import path from "node:path";
import { ProviderCompatibleTypeEnum } from "../types";
import { normalizeDeepSeekReplaySignatures, type DeepSeekReplayApi } from "./deepseek-compat";

// ─── 状态 ───────────────────────────────────────────────────────────────────

let agentSession: { prompt: (t: string) => Promise<void>; dispose: () => void } | null = null;
let stopping = false;
let fatalErrorReported = false;
/** 防止父进程重复发送 "start" 导致 session 被覆盖或并发初始化 */
let startReceived = false;

/**
 * Prompt 串行队列：确保同一时刻只有一个 session.prompt() 在执行。
 *
 * 背景：父进程可能在 Agent 处理任务期间发送额外的 prompt（如崩溃通知、进度查询），
 * pi-coding-agent SDK 的 session.prompt() 不保证可重入，并发调用可能导致状态损坏。
 * 用简单的 Promise 链实现无锁串行队列。
 */
let promptQueue: Promise<void> = Promise.resolve();

/** key = callId，value = 等待父进程 tool_result 的 Promise 控制器。 */
const pendingToolResults = new Map<
  string,
  { resolve: (v: ToolResultPayload) => void; reject: (e: Error) => void }
>();

// ─── IPC 辅助 ───────────────────────────────────────────────────────────────

function send(msg: ChildToMain): void {
  if (process.send) process.send(msg);
  else process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handleToolResult(callId: string, result?: ToolResultPayload, error?: string): void {
  const pending = pendingToolResults.get(callId);
  if (!pending) return;
  pendingToolResults.delete(callId);
  if (error) {
    pending.reject(new Error(error));
  } else if (result) {
    pending.resolve(result);
  } else {
    pending.reject(new Error(`tool_result for callId=${callId} has neither result nor error`));
  }
}

function isDeepSeekThinkingModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes("deepseek") && (
    normalized.includes("reasoner") ||
    /(?:^|[-_/])r1(?:[-_/]|$)/.test(normalized) ||
    /deepseek[-_/]?v(?:3(?:\.\d+)?|4)/.test(normalized)
  );
}

function terminalAgentError(event: Record<string, unknown>): string | undefined {
  if (event.type !== "agent_end" || event.willRetry !== false || !Array.isArray(event.messages)) return undefined;
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (!message || typeof message !== "object") continue;
    const assistant = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    if (assistant.role !== "assistant") continue;
    if (assistant.stopReason !== "error") return undefined;
    return typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
      ? assistant.errorMessage
      : "Agent session ended with an unrecoverable model error";
  }
  return undefined;
}

// ─── Stub 工具构建 ───────────────────────────────────────────────────────────

/**
 * 将可序列化的工具元数据转换为 pi-coding-agent defineTool 形式的 stub。
 * stub 的 execute 通过 IPC 向父进程请求执行，并等待 tool_result 返回。
 */
function buildStubTools(toolDefs: SerializableToolDef[]): ReturnType<typeof defineTool>[] {
  return toolDefs.map((def) =>
    defineTool({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters as TSchema,
      execute: async (toolCallId: string, params: unknown): Promise<ToolResultPayload> => {
        const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise<ToolResultPayload>((resolve, reject) => {
          pendingToolResults.set(callId, { resolve, reject });
          send({ type: "tool_call", callId, toolName: def.name, toolCallId, params });
        });
      },
    }),
  );
}

// ─── 启动 ───────────────────────────────────────────────────────────────────

async function handleStart(msg: Extract<MainToChild, { type: "start" }>): Promise<void> {
  const { spec, agentDir, systemPrompt, toolDefs } = msg;

  try {
    const slashIdx = spec.model.indexOf("/");
    const provider = slashIdx < 0 ? "anthropic" : spec.model.slice(0, slashIdx);
    const modelId = slashIdx < 0 ? spec.model : spec.model.slice(slashIdx + 1);
    const deepSeekThinking = provider === ProviderCompatibleTypeEnum.OpenAI && isDeepSeekThinkingModel(modelId);

    // pi-coding-agent 0.84 exposes the asynchronous ModelRuntime factory;
    // AuthStorage is intentionally internal to the SDK and is no longer a
    // public export. Keep credentials and model declarations scoped per Agent.
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    const modelRegistry = new ModelRegistry(modelRuntime);

    const openaiProxyCompat = {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens" as const,
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: deepSeekThinking,
      thinkingFormat: deepSeekThinking ? "deepseek" as const : "openai" as const,
      supportsStrictMode: false,
    };

    const customOpenAIProvider = provider === ProviderCompatibleTypeEnum.OpenAI && process.env.OPENAI_BASE_URL
      ? ProviderCompatibleTypeEnum.OpenAI
      : undefined;

    if (customOpenAIProvider && process.env.OPENAI_BASE_URL) {
      const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      // Register the concrete proxy model, not only a provider base URL. This
      // keeps its reasoning and compatibility metadata in pi's canonical model
      // catalog for every automatic continuation after a tool call.
      modelRegistry.registerProvider(customOpenAIProvider, {
        name: "OAT OpenAI-compatible proxy",
        baseUrl: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
        api: "openai-completions",
        models: [{
          id: modelId,
          name: modelId,
          api: "openai-completions",
          reasoning: deepSeekThinking,
          input: ["text"],
          cost: defaultCost,
          contextWindow: 128000,
          maxTokens: 16384,
          compat: openaiProxyCompat,
        }],
      });
    }

    // 先从 SDK 内置 registry 查找模型；若不存在且用户配置了 OPENAI_BASE_URL（兼容网关），则允许任意新模型 ID。
    // 这等价于“动态注册”一个 openai-completions 模型，避免 registry 白名单导致新模型无法使用。
    let model: any = modelRegistry.find(customOpenAIProvider ?? provider, modelId) ?? undefined;
    if (!model && provider === ProviderCompatibleTypeEnum.OpenAI && process.env.OPENAI_BASE_URL) {
      const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      model = {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: ProviderCompatibleTypeEnum.OpenAI,
        baseUrl: process.env.OPENAI_BASE_URL,
        reasoning: deepSeekThinking,
        input: ["text"],
        cost: defaultCost,
        contextWindow: 128000,
        maxTokens: 16384,
        headers: undefined,
        compat: openaiProxyCompat,
      };
    }

    // openai-compatible 代理通常仅支持标准 Chat Completions API，
    // 而内置 openai 模型使用 openai-responses（Responses API）+ 官方专属 compat 设定。
    // 当用户通过 OPENAI_BASE_URL 指定了自定义端点时：
    //   1. 降级 API 类型为 openai-completions
    //   2. 覆盖 compat 为通用代理兼容配置，避免发送 store / developer role /
    //      max_completion_tokens / reasoning_effort 等不被支持的参数
    if (model && process.env.OPENAI_BASE_URL && provider === ProviderCompatibleTypeEnum.OpenAI) {
      model = {
        ...model,
        api: "openai-completions" as typeof model.api,
        reasoning: deepSeekThinking || model.reasoning,
        compat: openaiProxyCompat,
      };
    }
    // DeepSeek reasoning responses use the Chat Completions `reasoning_content`
    // field. Some registry entries are declared as Responses models even when
    // they are routed through a DeepSeek-compatible endpoint; allowing those
    // entries through would make pi parse the literal field name as JSON and
    // crash on the next turn (`Unexpected token 'r'`).
    if (model && deepSeekThinking && provider === ProviderCompatibleTypeEnum.OpenAI) {
      model = {
        ...model,
        api: "openai-completions" as typeof model.api,
        reasoning: true,
        compat: openaiProxyCompat,
      };
    }
    if (!model) {
      send({
        type: "agent_error",
        error:
          `Model not found in registry: provider="${provider}" modelId="${modelId}" ` +
          `(agentId=${spec.id}). Check team.json model config and pi agentDir credentials.`,
      });
      process.exit(1);
      return;
    }
    // Keep replay signatures compatible with the protocol selected above. The
    // SDK gives `thinkingSignature` incompatible meanings in Chat Completions
    // and Responses, so sanitize both directions before the message is reused.
    const deepSeekReplayApi = deepSeekThinking && (
      model.api === "openai-completions" || model.api === "openai-responses"
    ) ? model.api as DeepSeekReplayApi : undefined;

    const loader = new DefaultResourceLoader({
      cwd: spec.workspacePath,
      agentDir,
      systemPromptOverride: systemPrompt ? () => systemPrompt : undefined,
    });
    await loader.reload();

    const customTools = buildStubTools(toolDefs);

    const { session } = await createAgentSession({
      cwd: spec.workspacePath,
      agentDir,
      model,
      // Reuse the runtime where the proxy model was registered. AgentSession
      // resolves request auth again after tool results; without this, it builds
      // a fresh default runtime and can silently switch DeepSeek back to the
      // Responses API on the continuation turn.
      modelRuntime,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      customTools,
      resourceLoader: loader,
    });

    agentSession = session;

    session.subscribe((event: Record<string, unknown>) => {
      if (deepSeekReplayApi) normalizeDeepSeekReplaySignatures(event, deepSeekReplayApi);
      send({ type: "agent_event", event, role: spec.role });

      // 检测 SDK 级别的致命错误事件：上报后立即退出
      // 必须退出以确保父进程的崩溃状态与子进程实际状态一致；
      // 若不退出，父进程已将该 Agent 标记为崩溃，但子进程仍能接收后续 prompt，
      // 导致任务重复分配或崩溃通知去重失效。
      // 注意：stopping = true 时跳过，避免 session.dispose() 内部触发 error 事件导致
      // 子进程以 code=1 退出，从而被父进程误判为崩溃（应由 stop 流程以 code=0 正常退出）。
      const ev = event as { type?: string; error?: unknown };
      const settledError = terminalAgentError(event);
      if (!stopping && !fatalErrorReported && ((ev.type === "error" && ev.error !== undefined) || settledError)) {
        fatalErrorReported = true;
        const errMsg = settledError ?? (ev.error instanceof Error ? ev.error.message : String(ev.error));
        send({ type: "agent_error", error: errMsg });
        // Let the IPC message flush before exit. The parent then marks the
        // running workflow failed through its normal crash path.
        setImmediate(() => process.exit(1));
      }
    });

    send({ type: "ready" });
  } catch (err) {
    send({
      type: "agent_error",
      error: `Session startup failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }
}

// ─── IPC 消息处理 ────────────────────────────────────────────────────────────

process.on("message", (rawMsg: unknown) => {
  handleMessage(rawMsg);
});

function handleMessage(rawMsg: unknown): void {
  const msg = rawMsg as MainToChild;

  if (msg.type === "start") {
    if (startReceived) return; // 防止重复初始化
    startReceived = true;
    void handleStart(msg);
    return;
  }

  if (msg.type === "prompt") {
    if (agentSession && !stopping) {
      const text = msg.text;
      // 将当前 prompt 追加到串行队列末尾，避免并发调用 session.prompt()
      promptQueue = promptQueue.then(() => {
        if (stopping || !agentSession) return;
        return agentSession.prompt(text).catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          send({ type: "agent_error", error: `prompt() failed: ${errMsg}` });
          // 状态不可恢复：退出子进程，让父进程通过 exit 事件触发崩溃通知链
          process.exit(1);
        });
      });
    }
    return;
  }

  if (msg.type === "stop") {
    stopping = true;
    if (agentSession) {
      try { agentSession.dispose(); } catch { /* noop */ }
    }
    // 拒绝所有仍在等待的 tool_result，防止子进程退出时挂起
    for (const [callId, pending] of pendingToolResults) {
      pending.reject(new Error(`Agent stopped before tool_result arrived (callId=${callId})`));
    }
    pendingToolResults.clear();
    process.exit(0);
    return;
  }

  if (msg.type === "tool_result") {
    handleToolResult(msg.callId, msg.result, msg.error);
    return;
  }
}

// Docker runs this entrypoint without Node IPC. The identical protocol travels
// over newline-delimited JSON on stdio, while stdout is reserved for protocol.
if (!process.send) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    try { handleMessage(JSON.parse(line)); }
    catch { send({ type: "agent_error", error: "Invalid JSONL control message" }); }
  });
}

// ─── 全局错误保障 ─────────────────────────────────────────────────────────────

process.on("uncaughtException", (err: Error) => {
  send({ type: "agent_error", error: `Uncaught exception: ${err.message}` });
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  send({ type: "agent_error", error: `Unhandled rejection: ${msg}` });
  process.exit(1);
});
