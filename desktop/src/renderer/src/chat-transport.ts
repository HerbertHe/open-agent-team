import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import type { ResourceAgentReply } from '../../shared/resource-types';

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
  constructor(private readonly onReply?: (reply: ResourceAgentReply) => void) {}

  async sendMessages({ messages, abortSignal }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]): Promise<ReadableStream<UIMessageChunk>> {
    const prompt = textFrom(messages.at(-1));
    if (abortSignal?.aborted) throw new DOMException('The Resource Manager request was cancelled.', 'AbortError');
    const requestId = crypto.randomUUID();
    const partId = `resource-${requestId}`;
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        let streamed = '';
        let closed = false;
        const reasoningParts = new Set<string>();
        const close = () => { if (!closed) { closed = true; for (const id of reasoningParts) controller.enqueue({ type: 'reasoning-end', id }); controller.enqueue({ type: 'text-end', id: partId }); controller.close(); } };
        controller.enqueue({ type: 'text-start', id: partId });
        const unsubscribe = window.oatDesktop.onResourceAgentEvent((payload) => {
          if (payload.requestId !== requestId || closed) return;
          const event = payload.event;
          const assistantEvent = event.assistantMessageEvent && typeof event.assistantMessageEvent === 'object' ? event.assistantMessageEvent as Record<string, unknown> : undefined;
          if (event.type === 'message_update' && assistantEvent?.type === 'text_delta' && typeof assistantEvent.delta === 'string') {
            streamed += assistantEvent.delta;
            controller.enqueue({ type: 'text-delta', id: partId, delta: assistantEvent.delta });
          }
          if (event.type === 'message_update' && ['thinking_start', 'thinking_delta', 'thinking_end'].includes(String(assistantEvent?.type))) {
            const reasoningId = `${partId}:reasoning:${typeof assistantEvent?.contentIndex === 'number' ? assistantEvent.contentIndex : 0}`;
            if (!reasoningParts.has(reasoningId)) { reasoningParts.add(reasoningId); controller.enqueue({ type: 'reasoning-start', id: reasoningId }); }
            if (assistantEvent?.type === 'thinking_delta' && typeof assistantEvent.delta === 'string') controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: assistantEvent.delta });
            if (assistantEvent?.type === 'thinking_end') { controller.enqueue({ type: 'reasoning-end', id: reasoningId }); reasoningParts.delete(reasoningId); }
          }
        });
        const cancel = () => { unsubscribe(); void window.oatDesktop.cancelResourceAgent(); close(); };
        abortSignal?.addEventListener('abort', cancel, { once: true });
        void window.oatDesktop.sendResourceAgentMessage(prompt, requestId).then((reply) => {
          if (closed) return;
          this.onReply?.(reply);
          if (!streamed && reply.text) controller.enqueue({ type: 'text-delta', id: partId, delta: reply.text });
          close();
        }).catch((error: unknown) => {
          if (!closed) controller.error(error);
        }).finally(() => {
          unsubscribe();
          abortSignal?.removeEventListener('abort', cancel);
        });
      },
    });
  }

  async reconnectToStream(): Promise<null> { return null; }
}
