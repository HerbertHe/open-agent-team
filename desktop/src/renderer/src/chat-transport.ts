import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

export type ChatTarget = {
  projectName?: string;
  alive: boolean;
  isAdmin: boolean;
  agentId?: string;
  agentLabel?: string;
  onTaskQueued?(task: { id: string; targetAgentId: string; prompt: string; status: string }): void;
};

function textFrom(message: UIMessage | undefined): string {
  return message?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? '';
}

export function response(text: string): ReadableStream<UIMessageChunk> {
  const id = `task-${crypto.randomUUID()}`;
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: 'text-start', id });
      controller.enqueue({ type: 'text-delta', id, delta: text });
      controller.enqueue({ type: 'text-end', id });
      controller.close();
    },
  });
}

/**
 * AI SDK transport backed by the trusted Electron preload bridge. It deliberately
 * does not use fetch: every task request is authorized and executed in main.
 */
export class IpcTaskTransport implements ChatTransport<UIMessage> {
  constructor(private readonly target: () => ChatTarget) {}

  async sendMessages({ messages, abortSignal }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]): Promise<ReadableStream<UIMessageChunk>> {
    const current = this.target();
    const prompt = textFrom(messages.at(-1));
    if (!current.projectName || !current.agentId || !current.alive) throw new Error('Start a project and select its Admin agent before sending work.');
    if (!current.isAdmin) throw new Error('Only the project Admin agent accepts new tasks. This agent is report-only.');
    if (abortSignal?.aborted) throw new DOMException('The task request was cancelled.', 'AbortError');
    const task = await window.oatDesktop.requestOrchestrator({
      projectName: current.projectName,
      path: '/tasks',
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetAgentId: current.agentId, prompt }) },
    }) as { id: string; targetAgentId: string; prompt: string; status: string };
    current.onTaskQueued?.(task);
    // The chat surface renders the queued task and its live execution events.
    // Do not add a second, generic assistant message for the same action.
    return response('');
  }

  async reconnectToStream(): Promise<null> { return null; }
}

/** A separate AI SDK conversation for the local Agentic Resources steward. */
export class ResourceAgentTransport implements ChatTransport<UIMessage> {
  async sendMessages({ messages }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]): Promise<ReadableStream<UIMessageChunk>> {
    const prompt = textFrom(messages.at(-1));
    return response(`Resource Agent recorded your request: “${prompt}”. Open project configuration to update teams, Agents, providers, or workspace permissions.`);
  }

  async reconnectToStream(): Promise<null> { return null; }
}
