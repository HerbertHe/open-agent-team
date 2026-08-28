import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationMessageRoleEnum,
  ResourceOperationStatusEnum,
  ProjectRuntimeModeEnum,
  ResourceProposalStatusEnum,
  ResourceRequiredActionEnum,
  type ResourceAgentReply,
  type ResourceHistoryMessage,
} from '../shared/resource-types.js';

type JsonRecord = Record<string, unknown>;
type GlobalModels = { providers: Record<string, unknown>; models: Record<string, unknown> };
type DraftInput = {
  projectName: string;
  repo?: string;
  modelAlias: string;
  runtimeMode: ProjectRuntimeModeEnum;
  dockerImage?: string;
  teams: Array<{ name: string; responsibility: string; workers: number; repos?: string[] }>;
};
export type ResourceProposal = {
  id: string;
  status: ResourceProposalStatusEnum;
  projectName: string;
  config: JsonRecord;
  createdAt: string;
};

export interface ResourceSupervisorHost {
  globalConfig(): Promise<JsonRecord>;
  globalModels(): Promise<GlobalModels>;
  inventory(): Promise<JsonRecord>;
  draft(input: DraftInput): Promise<{ projectName: string; config: JsonRecord }>;
  apply(proposal: ResourceProposal): Promise<{ requiredAction: ResourceRequiredActionEnum; message: string }>;
}

const SYSTEM_PROMPT = `You are the Open Agent Team Resource Manager, a global HR-like Agent for project staffing.
Your duties are to report current project and Agent capacity, design project/team structures, and create schema-valid project configuration proposals.

Hard permissions:
- You may read resource inventory and create configuration proposals.
- You MUST NOT start, stop, or restart local processes, project teams, Docker Engine, Docker containers, or Agents.
- You have no shell or arbitrary filesystem tool.
- Applying a proposal is performed only by the host after an explicit human UI confirmation; never claim that a proposal was applied before the tool result says so.
- After a project is created, tell the human to start it. After a running project's config changes, tell the human to click “Restart project team”.
- Never expose API keys or credentials.

For resource questions, call list_project_resources before answering. For creation requests, call draft_project_configuration, summarize the proposed teams and validation result, and ask the user to confirm using the UI confirmation action. Answer in the user's language.`;

export enum ResourceManagerToolNameEnum {
  ListProjectResources = 'list_project_resources',
  DraftProjectConfiguration = 'draft_project_configuration',
}

export const RESOURCE_MANAGER_TOOL_NAMES = Object.freeze(Object.values(ResourceManagerToolNameEnum));

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
}

function textOfAssistant(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== 'assistant' || !Array.isArray(value.content)) return undefined;
  const text = value.content
    .filter((block): block is { type: 'text'; text: string } => Boolean(block) && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('');
  return text.trim() || undefined;
}

export class ResourceSupervisor {
  private session?: { prompt(text: string): Promise<void>; abort(): Promise<void>; dispose(): void };
  private activeModel?: string;
  private promptTail: Promise<unknown> = Promise.resolve();
  private lastAssistantText = '';
  private latestProposalId?: string;
  private readonly proposals = new Map<string, ResourceProposal>();

  constructor(private readonly host: ResourceSupervisorHost) {}

  private historyPath(): string {
    return join(homedir(), '.oat', 'resource-agent', 'history.jsonl');
  }

  private async appendHistory(role: ConversationMessageRoleEnum, text: string): Promise<void> {
    const message: ResourceHistoryMessage = { id: crypto.randomUUID(), role, text, createdAt: new Date().toISOString() };
    await fs.mkdir(join(homedir(), '.oat', 'resource-agent'), { recursive: true });
    await fs.appendFile(this.historyPath(), `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async history(): Promise<ResourceHistoryMessage[]> {
    let raw = '';
    try { raw = await fs.readFile(this.historyPath(), 'utf8'); } catch { return []; }
    return raw.split('\n').filter(Boolean).slice(-100).flatMap((line) => {
      try {
        const value = JSON.parse(line) as ResourceHistoryMessage;
        return Object.values(ConversationMessageRoleEnum).includes(value.role) && typeof value.text === 'string' ? [value] : [];
      } catch { return []; }
    });
  }

  private async createSession(configuredModel: string) {
    const catalog = await this.host.globalModels();
    const mapped = catalog.models[configuredModel];
    const modelRef = typeof mapped === 'string' && mapped.trim() ? mapped.trim() : configuredModel;
    const fullRef = modelRef.includes('/') ? modelRef : configuredModel.includes('/') ? configuredModel : modelRef;
    const slash = fullRef.indexOf('/');
    if (slash < 1) throw new Error(`Resource Manager model ${configuredModel} does not resolve to provider/model.`);
    const provider = fullRef.slice(0, slash);
    const modelId = fullRef.slice(slash + 1);
    const agentDir = join(homedir(), '.pi', 'agent');
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    const providerConfig = catalog.providers[provider];
    if (providerConfig && typeof providerConfig === 'object') {
      const raw = providerConfig as { compatible_type?: unknown; base_url?: unknown; api_key?: unknown };
      const api = raw.compatible_type === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
      registry.registerProvider(provider, {
        name: `OAT Resource Manager ${provider}`,
        baseUrl: typeof raw.base_url === 'string' ? raw.base_url : undefined,
        apiKey: typeof raw.api_key === 'string' ? raw.api_key : undefined,
        api,
        models: [{
          id: modelId,
          name: modelId,
          api,
          reasoning: modelId.toLowerCase().includes('reason'),
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        }],
      });
    }
    const model = registry.find(provider, modelId);
    if (!model) throw new Error(`Resource Manager model not found: ${provider}/${modelId}`);

    const workspace = join(homedir(), '.oat', 'resource-agent', 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, systemPromptOverride: () => SYSTEM_PROMPT });
    await loader.reload();
    const inventoryTool = defineTool({
      name: ResourceManagerToolNameEnum.ListProjectResources,
      label: 'List project resources',
      description: 'Read the current global project, team, Agent, task, and capacity inventory.',
      parameters: Type.Object({}),
      execute: async () => toolResult(await this.host.inventory()),
    });
    const draftTool = defineTool({
      name: ResourceManagerToolNameEnum.DraftProjectConfiguration,
      label: 'Draft project configuration',
      description: 'Create and schema-validate a project/team configuration proposal. This does not write files or start processes.',
      parameters: Type.Object({
        projectName: Type.String({ minLength: 1 }),
        repo: Type.Optional(Type.String()),
        modelAlias: Type.String({ minLength: 1 }),
        runtimeMode: Type.Union([Type.Literal(ProjectRuntimeModeEnum.LocalProcess), Type.Literal(ProjectRuntimeModeEnum.Docker)]),
        dockerImage: Type.Optional(Type.String()),
        teams: Type.Array(Type.Object({
          name: Type.String({ minLength: 1 }),
          responsibility: Type.String({ minLength: 1 }),
          workers: Type.Integer({ minimum: 1 }),
          repos: Type.Optional(Type.Array(Type.String())),
        }), { minItems: 1 }),
      }),
      execute: async (_toolCallId, params) => {
        const drafted = await this.host.draft(params as DraftInput);
        const proposal: ResourceProposal = {
          id: `resource-proposal-${crypto.randomUUID()}`,
          status: ResourceProposalStatusEnum.WaitingConfirmation,
          projectName: drafted.projectName,
          config: drafted.config,
          createdAt: new Date().toISOString(),
        };
        this.proposals.set(proposal.id, proposal);
        this.latestProposalId = proposal.id;
        return toolResult({ proposalId: proposal.id, status: proposal.status, config: proposal.config, message: 'Waiting for explicit human UI confirmation. No process will be started.' });
      },
    });
    const created = await createAgentSession({
      cwd: workspace,
      agentDir,
      model,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      customTools: [inventoryTool, draftTool],
      resourceLoader: loader,
    });
    created.session.subscribe((event: Record<string, unknown>) => {
      if (event.type !== 'message_end') return;
      const text = textOfAssistant(event.message);
      if (text) this.lastAssistantText = text;
    });
    this.session = created.session;
    this.activeModel = configuredModel;
  }

  private async ensureSession(): Promise<void> {
    const config = await this.host.globalConfig();
    const resource = config.resource_agent;
    const model = resource && typeof resource === 'object' && typeof (resource as { model?: unknown }).model === 'string'
      ? (resource as { model: string }).model.trim()
      : '';
    if (!model) throw new Error('Configure a Resource Manager model in Settings before starting a conversation.');
    if (this.session && this.activeModel === model) return;
    this.session?.dispose();
    this.session = undefined;
    await this.createSession(model);
  }

  async send(text: string): Promise<ResourceAgentReply> {
    const run = async (): Promise<ResourceAgentReply> => {
      await this.appendHistory(ConversationMessageRoleEnum.User, text);
      await this.ensureSession();
      this.latestProposalId = undefined;
      this.lastAssistantText = '';
      await this.session!.prompt(text);
      const reply: ResourceAgentReply = {
        text: this.lastAssistantText || '资源主管已完成处理，但模型没有返回可显示的汇报。',
        status: this.latestProposalId ? ResourceOperationStatusEnum.WaitingConfirmation : ResourceOperationStatusEnum.Completed,
        requiredAction: this.latestProposalId ? ResourceRequiredActionEnum.None : ResourceRequiredActionEnum.None,
        proposalId: this.latestProposalId,
      };
      await this.appendHistory(ConversationMessageRoleEnum.Assistant, reply.text);
      return reply;
    };
    const result = this.promptTail.then(run, run);
    this.promptTail = result.catch(() => undefined);
    return result;
  }

  async confirm(proposalId: string): Promise<ResourceAgentReply> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== ResourceProposalStatusEnum.WaitingConfirmation) throw new Error('The resource proposal is missing or no longer awaiting confirmation.');
    proposal.status = ResourceProposalStatusEnum.Confirmed;
    try {
      const applied = await this.host.apply(proposal);
      proposal.status = ResourceProposalStatusEnum.Applied;
      const reply = { text: applied.message, status: ResourceOperationStatusEnum.Completed, requiredAction: applied.requiredAction, proposalId };
      await this.appendHistory(ConversationMessageRoleEnum.Assistant, reply.text);
      return reply;
    } catch (error) {
      proposal.status = ResourceProposalStatusEnum.Failed;
      throw error;
    }
  }

  async cancel(): Promise<void> {
    await this.session?.abort();
  }

  dispose(): void {
    this.session?.dispose();
    this.session = undefined;
  }
}
