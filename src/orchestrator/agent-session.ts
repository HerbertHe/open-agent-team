import { createOpencodeClient } from "@opencode-ai/sdk";
import type { AgentInstanceSpec } from "../types";

export interface SessionHandle {
  sessionId: string;
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf("/");
  if (idx < 0) return { providerID: "anthropic", modelID: model };
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

export class AgentSession {
  private client: any;

  constructor(private readonly baseUrl: string) {}

  async connect(): Promise<void> {
    this.client = createOpencodeClient({ baseUrl: this.baseUrl });
  }

  async createSession(title: string): Promise<SessionHandle> {
    const s = await this.client.session.create({ body: { title } });
    return { sessionId: s.id };
  }

  async sendPrompt(spec: AgentInstanceSpec, sessionId: string, prompt: string, extra?: { agent?: string }): Promise<void> {
    const model = splitModel(spec.model);
    const agentName = extra?.agent ?? spec.name;
    await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        agent: agentName,
        model: { providerID: model.providerID, modelID: model.modelID },
        parts: [{ type: "text", text: prompt }],
      },
    });
  }
}

