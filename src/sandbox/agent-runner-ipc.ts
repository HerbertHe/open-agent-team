/**
 * IPC 消息协议：主进程 ↔ Agent 子进程
 *
 * 设计原则：
 * - 所有消息体必须可 JSON 序列化（Node.js IPC 内部使用 JSON）
 * - tool_call / tool_result 通过 callId 匹配异步请求/响应对
 * - 主进程负责维护工具注册表（execute 函数）；子进程只持有工具元数据（stub）
 */

/** 工具的可序列化元数据（不含 execute 函数）。 */
export type SerializableToolDef = {
  name: string;
  label: string;
  description: string;
  /** TSchema (typebox) 是纯 JSON 对象，可安全跨进程传输。 */
  parameters: unknown;
};

/** 工具调用结果的可序列化载体（对应 pi-coding-agent ToolResult）。 */
export type ToolResultPayload = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

// ─── 主进程 → 子进程 ────────────────────────────────────────────────────────

export type MainToChild =
  | {
      type: "start";
      /** AgentInstanceSpec 的可序列化子集。 */
      spec: {
        id: string;
        role: string;
        name: string;
        branch: string;
        workspacePath: string;
        model: string;
        teamName?: string;
        skills?: string[];
      };
      agentDir: string;
      systemPrompt?: string;
      toolDefs: SerializableToolDef[];
    }
  | { type: "prompt"; text: string }
  | { type: "stop" }
  | {
      type: "tool_result";
      /** 对应 ChildToMain.tool_call 的 callId。 */
      callId: string;
      result?: ToolResultPayload;
      /** 工具执行失败时的错误信息。 */
      error?: string;
    };

// ─── 子进程 → 主进程 ────────────────────────────────────────────────────────

export type ChildToMain =
  | { type: "ready" }
  | {
      type: "agent_event";
      event: Record<string, unknown>;
      /** AgentRoleEnum 字符串，与主进程对齐。 */
      role?: string;
    }
  | {
      type: "tool_call";
      /** 随机生成的唯一 ID，用于匹配对应的 tool_result。 */
      callId: string;
      toolName: string;
      /** pi-coding-agent 内部的 toolCallId，原样透传给 execute 函数。 */
      toolCallId: string;
      params: unknown;
    }
  | { type: "agent_error"; error: string };
