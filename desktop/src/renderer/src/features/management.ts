/**
 * Native Desktop control-plane feature: configuration, model registry and
 * Agent Resources.  This module deliberately talks to an Orchestrator over
 * its HTTP API; it contains no external web UI import, iframe or static asset.
 *
 * The imperative renderer in main.ts can mount `renderManagement()` and call
 * `bindManagement()` after each render. Keeping it here makes the feature
 * usable by a future React/Svelte renderer too.
 */

export type ProjectSummary = { name: string; projectName?: string | null; port?: number | null; alive?: boolean };
export type Provider = { compatible_type?: 'openai' | 'anthropic' | string; base_url?: string; api_key?: string };
export type GlobalModels = { providers: Record<string, Provider>; models: Record<string, string> };
type Skill = { source?: string; names?: string[] };
export type Team = {
  name: string; branch_prefix: string;
  leader: { name: string; description: string; model?: string; prompt: string; skills: Skill[]; repos?: string[] };
  worker: { total: number; model?: string; prompt: string; extra_skills: Skill[]; skill_sync?: string };
};
export type TeamConfig = Record<string, unknown> & { project?: { name?: string; repo?: string; base_branch?: string }; teams?: Team[] };
export type ManagementState = {
  projects: ProjectSummary[]; selectedProject?: string; teamConfig?: TeamConfig;
  globalConfig?: Record<string, unknown>; globalModels?: GlobalModels;
};

export type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
export type ProviderModelLister = (input: { baseUrl: string; apiKey?: string }) => Promise<string[]>;

const html = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]!));
const json = (value: unknown) => html(JSON.stringify(value ?? {}, null, 2));
const projectConfigPath = (project?: string) => project ? `/api/projects/${encodeURIComponent(project)}/config` : '/api/team-config';
const teamDraftKey = (project?: string) => `oat-desktop-team-draft:${project || '_default'}`;
const formatJson = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

function draftFor(project: string | undefined, fallback: TeamConfig): string {
  try { return localStorage.getItem(teamDraftKey(project)) || formatJson(fallback); }
  catch { return formatJson(fallback); }
}

function readJson(value: string): TeamConfig | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as TeamConfig : undefined;
  } catch { return undefined; }
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, segment) => value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined, source);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < segments.length - 1; index++) {
    const key = segments[index]; const nextKey = segments[index + 1];
    const container = cursor as Record<string, unknown>;
    const current = container[key];
    if (!current || typeof current !== 'object') container[key] = /^\d+$/.test(nextKey) ? [] : {};
    cursor = container[key] as Record<string, unknown> | unknown[];
  }
  const finalKey = segments.at(-1)!;
  (cursor as Record<string, unknown>)[finalKey] = value;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function skillList(value: unknown): Skill[] {
  return Array.isArray(value) ? value.filter((item): item is Skill => Boolean(item) && typeof item === 'object') : [];
}

function configModelAliases(config: TeamConfig, globalModels?: GlobalModels): string[] {
  const local = Object.keys((getPath(config, 'models') as Record<string, unknown> | undefined) ?? {});
  return [...new Set([...local, ...Object.keys(globalModels?.models ?? {})])];
}

function listInput(label: string, path: string, value: unknown, hint: string, className = ''): string {
  return `<label class="${className}">${label}<input data-config-list="${html(path)}" value="${html(stringList(value).join(', '))}" /><small>${hint}</small></label>`;
}

function skillEditor(label: string, path: string, value: unknown): string {
  const skills = skillList(value);
  return `<section class="config-list-editor span-2"><div class="config-list-heading"><h5>${label}</h5><button type="button" data-add-config-skill="${html(path)}">Add skill</button></div>
    ${skills.map((skill, index) => `<div class="config-skill-row"><label>Source<input data-config-field="${html(`${path}.${index}.source`)}" value="${html(skill.source)}" placeholder="owner/repository or local path" /></label>${listInput('Names', `${path}.${index}.names`, skill.names, 'Comma-separated; leave empty for all skills')}<button type="button" data-remove-config-skill data-skill-path="${html(path)}" data-skill-index="${index}">Remove</button></div>`).join('') || '<p class="hint">No skills configured.</p>'}
  </section>`;
}

function initialTeam(index: number): Team {
  const name = `team-${index + 1}`;
  return {
    name, branch_prefix: `team/${name}`,
    leader: { name: `${name}-lead`, description: '', prompt: '', skills: [] },
    worker: { total: 1, prompt: '', extra_skills: [], skill_sync: 'inherit_and_inject_on_spawn' },
  };
}

function teamCard(team: Team, index: number, models: string[]): string {
  const field = (label: string, path: string, value: unknown, type = 'text') => `<label>${label}<input data-config-field="${path}" type="${type}" value="${html(value)}" ${type === 'number' ? 'min="1"' : ''}/></label>`;
  const modelSelect = (label: string, path: string, selected: string | undefined) => `<label>${label}<select data-config-field="${path}"><option value="">Inherit default</option>${models.map((model) => `<option value="${html(model)}" ${model === selected ? 'selected' : ''}>${html(model)}</option>`).join('')}</select></label>`;
  return `<article class="panel management-team" data-structured-team="${index}">
    <div class="section-heading"><h4>Team ${index + 1}</h4><button type="button" data-remove-config-team="${index}">Remove team</button></div>
    <div class="form-grid">
      ${field('Team identifier', `teams.${index}.name`, team.name)}
      ${field('Branch prefix', `teams.${index}.branch_prefix`, team.branch_prefix)}
      ${field('Leader name', `teams.${index}.leader.name`, team.leader?.name || '')}
      ${modelSelect('Leader model', `teams.${index}.leader.model`, team.leader?.model)}
      <label class="span-2">Leader responsibility<input data-config-field="teams.${index}.leader.description" value="${html(team.leader?.description || '')}" /></label>
      <label class="span-2">Leader prompt<textarea data-config-field="teams.${index}.leader.prompt">${html(team.leader?.prompt || '')}</textarea></label>
      ${listInput('Leader repositories / paths', `teams.${index}.leader.repos`, team.leader?.repos, 'Comma-separated; used by sparse checkout.', 'span-2')}
      ${skillEditor('Leader skills', `teams.${index}.leader.skills`, team.leader?.skills)}
      ${field('Worker count', `teams.${index}.worker.total`, team.worker?.total || 1, 'number')}
      ${modelSelect('Worker model', `teams.${index}.worker.model`, team.worker?.model)}
      <label class="span-2">Worker prompt<textarea data-config-field="teams.${index}.worker.prompt">${html(team.worker?.prompt || '')}</textarea></label>
      <label>Skill sync<select data-config-field="teams.${index}.worker.skill_sync"><option value="inherit_and_inject_on_spawn" ${team.worker?.skill_sync === 'inherit_and_inject_on_spawn' ? 'selected' : ''}>Inherit and inject on spawn</option><option value="manual" ${team.worker?.skill_sync === 'manual' ? 'selected' : ''}>Manual</option></select></label>
      ${skillEditor('Worker extra skills', `teams.${index}.worker.extra_skills`, team.worker?.extra_skills)}
    </div>
  </article>`;
}

function structuredTeams(config: TeamConfig, models: string[]): string {
  const teams = Array.isArray(config.teams) ? config.teams : [];
  return teams.map((team, index) => teamCard(team, index, models)).join('') || '<p class="hint">No teams yet. Add an independent team to begin.</p>';
}

function configProviders(config: TeamConfig): string {
  const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, Provider>;
  return Object.entries(providers).map(([key, provider]) => `<article class="config-entry-card"><div class="config-list-heading"><h5>${html(key)}</h5><button type="button" data-remove-config-provider="${html(key)}">Remove provider</button></div><div class="form-grid">
    <label>Provider key<input data-config-provider-key="${html(key)}" value="${html(key)}" /></label>
    <label>Protocol<select data-config-provider-field="compatible_type" data-config-provider="${html(key)}"><option value="openai" ${provider.compatible_type !== 'anthropic' ? 'selected' : ''}>OpenAI compatible</option><option value="anthropic" ${provider.compatible_type === 'anthropic' ? 'selected' : ''}>Anthropic</option></select></label>
    <label>Base URL<input data-config-provider-field="base_url" data-config-provider="${html(key)}" value="${html(provider.base_url)}" placeholder="https://api.example.com/v1" /></label>
    <label>API key<input type="password" autocomplete="off" data-config-provider-field="api_key" data-config-provider="${html(key)}" value="${html(provider.api_key)}" /></label>
  </div></article>`).join('') || '<p class="hint">No project providers configured.</p>';
}

function configModelAliasEditor(config: TeamConfig): string {
  const aliases = (config.models && typeof config.models === 'object' ? config.models : {}) as Record<string, unknown>;
  return Object.entries(aliases).map(([alias, model]) => `<div class="config-alias-row"><label>Alias<input data-config-model-alias="${html(alias)}" value="${html(alias)}" /></label><label>Provider model ID<input data-config-model-value="${html(alias)}" value="${html(model)}" placeholder="provider/model-id" /></label><button type="button" data-remove-config-model="${html(alias)}">Remove</button></div>`).join('') || '<p class="hint">No aliases configured.</p>';
}

function renderDiff(original: string, current: string): string {
  if (original === current) return '<span class="hint">No unsaved changes.</span>';
  const before = original.split('\n'); const after = current.split('\n');
  const rows: string[] = []; const count = Math.max(before.length, after.length);
  for (let index = 0; index < count; index++) {
    if (before[index] === after[index]) continue;
    if (before[index] !== undefined) rows.push(`<span class="diff-remove">− ${html(before[index])}</span>`);
    if (after[index] !== undefined) rows.push(`<span class="diff-add">+ ${html(after[index])}</span>`);
  }
  return rows.length ? rows.join('\n') : '<span class="hint">Formatting-only change.</span>';
}

/** API client shared by all native management panels. */
export class ManagementApi {
  constructor(private readonly request: Request, private readonly listProviderModels: ProviderModelLister) {}

  projects(): Promise<ProjectSummary[]> { return this.request<ProjectSummary[]>('/api/projects'); }
  teamConfig(project?: string): Promise<TeamConfig> { return this.request<TeamConfig>(projectConfigPath(project)); }
  saveTeamConfig(project: string | undefined, config: TeamConfig): Promise<unknown> {
    return this.request(projectConfigPath(project), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  }
  restart(project: string): Promise<unknown> {
    return this.request(`/api/projects/${encodeURIComponent(project)}/restart`, { method: 'POST' });
  }
  globalConfig(): Promise<Record<string, unknown>> { return this.request<Record<string, unknown>>('/api/global-config'); }
  saveGlobalConfig(config: Record<string, unknown>): Promise<unknown> {
    return this.request('/api/global-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  }
  globalModels(): Promise<GlobalModels> { return this.request<GlobalModels>('/api/global-models'); }
  saveGlobalModels(models: GlobalModels): Promise<unknown> {
    return this.request('/api/global-models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...models, replace: true }) });
  }
  async removeProvider(key: string): Promise<void> {
    const current = await this.globalModels();
    delete current.providers[key];
    for (const model of Object.keys(current.models)) if (model.startsWith(`${key}/`)) delete current.models[model];
    await this.saveGlobalModels(current);
  }
  async removeModel(key: string): Promise<void> {
    const current = await this.globalModels(); delete current.models[key]; await this.saveGlobalModels(current);
  }

  /**
   * Tests an OpenAI-compatible provider locally and returns discovered model
   * ids. The key is used only for this request and is never persisted here.
   */
  async testProvider(provider: Provider): Promise<string[]> {
    const baseUrl = provider.base_url?.replace(/\/+$/, '');
    if (!baseUrl) throw new Error('Provider base URL is required.');
    return this.listProviderModels({ baseUrl, apiKey: provider.api_key });
  }

  /** Tests and then saves a provider plus its current model list atomically. */
  async testAndSyncProvider(key: string, provider: Provider): Promise<string[]> {
    if (!key.trim()) throw new Error('Provider name is required.');
    const ids = await this.testProvider(provider);
    const current = await this.globalModels();
    current.providers[key] = { compatible_type: provider.compatible_type ?? 'openai', base_url: provider.base_url?.replace(/\/+$/, '') };
    for (const model of Object.keys(current.models)) if (model.startsWith(`${key}/`)) delete current.models[model];
    for (const id of ids) current.models[`${key}/${id}`] = id;
    await this.saveGlobalModels(current);
    return ids;
  }

  /** Persist the aliases and provider declarations from team.json on save,
   * while keeping global registry synchronisation non-blocking. */
  async syncDeclaredModels(config: TeamConfig): Promise<{ conflicts: string[] }> {
    const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, Provider>;
    const models = (config.models && typeof config.models === 'object' ? config.models : {}) as Record<string, string>;
    if (!Object.keys(providers).length && !Object.keys(models).length) return { conflicts: [] };
    const current = await this.globalModels();
    const conflicts = [
      ...Object.keys(providers).filter(key => key in current.providers),
      ...Object.keys(models).filter(key => key in current.models),
    ];
    if (conflicts.length && !confirm(`Update existing global model entries?\n\n${conflicts.join(', ')}`)) return { conflicts };
    await this.request('/api/global-models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers, models }) });
    return { conflicts: [] };
  }

  /**
   * Fetch every provider declared by a team config without changing state.
   * Callers can present the full model diff and obtain confirmation before
   * applying `next`. Failed providers deliberately retain their old models.
   */
  async previewConfigModelSync(config: TeamConfig): Promise<{ next: GlobalModels; added: string[]; removed: string[]; changed: string[]; unchanged: string[]; failed: Array<{ key: string; error: string }> }> {
    const raw = config.providers;
    const entries = Array.isArray(raw)
      ? raw.map((value, index) => [String((value as Record<string, unknown>).key || `provider-${index}`), value] as const)
      : Object.entries((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>);
    const current = await this.globalModels();
    const next: GlobalModels = structuredClone(current);
    const failed: Array<{ key: string; error: string }> = [];
    await Promise.all(entries.map(async ([key, value]) => {
      const provider = value as Provider;
      try {
        const ids = await this.testProvider(provider);
        next.providers[key] = { compatible_type: provider.compatible_type ?? 'openai', base_url: provider.base_url?.replace(/\/+$/, '') };
        for (const model of Object.keys(next.models)) if (model.startsWith(`${key}/`)) delete next.models[model];
        for (const model of ids) next.models[`${key}/${model}`] = model;
      } catch (error) { failed.push({ key, error: error instanceof Error ? error.message : String(error) }); }
    }));
    // team.json aliases are first-class model entries, not merely labels for
    // the form.  Keep them in the global registry so all project selectors
    // resolve exactly the same alias → provider model mapping.
    const aliases = (config.models && typeof config.models === 'object' ? config.models : {}) as Record<string, unknown>;
    for (const [alias, model] of Object.entries(aliases)) {
      if (alias.trim() && typeof model === 'string' && model.trim()) next.models[alias] = model;
    }
    const before = Object.keys(current.models);
    const after = Object.keys(next.models);
    const added = after.filter(key => !before.includes(key));
    const removed = before.filter(key => !after.includes(key));
    const changed = after.filter(key => before.includes(key) && next.models[key] !== current.models[key]);
    const unchanged = after.filter(key => before.includes(key) && next.models[key] === current.models[key]);
    return { next, added, removed, changed, unchanged, failed };
  }
}

/** Build a validated-shape team.json from the HR interview. */
export function buildResourcesConfig(values: {
  projectName: string; repo: string; baseBranch: string; model: string; protocol: 'openai' | 'anthropic';
  runtime: 'docker' | 'local_process'; dockerImage?: string; dockerNetwork?: string; teams: Array<{ name: string; responsibility: string; workers: number; repos?: string }>;
}): TeamConfig {
  const providerName = values.model.split('/')[0] || values.protocol;
  return {
    model: 'default', models: { default: values.model }, providers: { [providerName]: { compatible_type: values.protocol } },
    project: { name: values.projectName, repo: values.repo, base_branch: values.baseBranch },
    runtime: { mode: values.runtime, ...(values.runtime === 'docker' ? { docker: { image: values.dockerImage || 'node:22-bookworm', network: values.dockerNetwork || 'bridge', extra_args: [] } } : {}), persistence: { state_dir: '.oat/state' } },
    workspace: { provider: 'worktree', root_dir: 'workspaces', git: { remote: 'origin', lfs: 'pull' }, sparse_checkout: { enabled: true } },
    admin: { name: 'admin', description: 'Project administrator.', prompt: 'Manage staffing, status and release approval. Do not implement Worker tasks.', skills: [] },
    teams: values.teams.map((team) => ({
      name: team.name, branch_prefix: `team/${team.name}`,
      leader: { name: `${team.name}-lead`, description: team.responsibility, prompt: `Lead ${team.name}: plan independent work, review branches, integrate approved changes, and submit releases.`, skills: [], repos: (team.repos || '').split(',').map((item) => item.trim()).filter(Boolean) },
      worker: { total: Math.max(1, Number(team.workers) || 1), prompt: `Worker for ${team.name}: implement, self-test, and submit-review. Never merge directly.`, extra_skills: [], skill_sync: 'inherit_and_inject_on_spawn' },
    })),
  };
}

/** HTML for the three native desktop panels. All data attributes are bound below. */
export function renderManagement(state: ManagementState): string {
  const projectOptions = state.projects.map((project) => `<option value="${html(project.name)}" ${project.name === state.selectedProject ? 'selected' : ''}>${html(project.projectName ? `${project.projectName} (${project.name})` : project.name)}${project.alive ? ' · online' : ''}</option>`).join('');
  const providers = Object.entries(state.globalModels?.providers ?? {}).map(([key, provider]) => `<tr><td>${html(key)}</td><td>${html(provider.compatible_type || 'openai')}</td><td>${html(provider.base_url || '—')}</td><td>${provider.api_key ? 'configured' : '—'}</td><td><button data-remove-provider="${html(key)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="5">No providers configured.</td></tr>';
  const models = Object.entries(state.globalModels?.models ?? {}).map(([key, name]) => `<tr><td><code>${html(key)}</code></td><td>${html(name)}</td><td><button data-remove-model="${html(key)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="3">No models registered.</td></tr>';
  const teamDraft = draftFor(state.selectedProject, state.teamConfig ?? {});
  const draftConfig = readJson(teamDraft) ?? state.teamConfig ?? {};
  const modelAliases = configModelAliases(draftConfig, state.globalModels);
  const dockerRuntimeLocked = getPath(state.teamConfig ?? {}, 'runtime.mode') === 'docker';
  const retention = Number(state.globalConfig?.logRetentionDays ?? 7);
  const retentionDays = Number.isFinite(retention) ? Math.min(365, Math.max(1, retention)) : 7;
  return `<section class="content management" data-management-root>
    <div class="section-heading"><div><span class="eyebrow">DECLARATIVE CONTROL</span><h2>Configuration & models</h2></div><button data-management-refresh>Refresh</button></div>
    <article class="panel"><h3>Project team configuration <span class="draft-state" data-team-draft-state></span></h3><p class="hint">Choose any registered project, including an offline one. Structured fields preserve unexposed team.json settings; use Advanced JSON for the full document.</p><label>Project <select data-team-project>${projectOptions}</select></label>
      <div class="management-actions"><button type="button" data-add-config-team>Add independent team</button><button type="button" data-apply-team-json>Reload structured fields from JSON</button><button type="button" data-discard-team-draft>Discard local draft</button></div>
      <section class="config-section"><div class="config-section-heading"><h4>Models & providers</h4><p class="hint">Project aliases are used by every model selector below. Provider keys, URLs and test-only credentials remain in team.json.</p></div>
        <div class="config-entry-list" data-config-providers>${configProviders(draftConfig)}</div>
        <div class="management-actions"><button type="button" data-add-config-provider>Add provider</button><button type="button" data-fetch-config-models>Fetch & sync all models</button></div>
        <div class="model-sync-preview" data-model-sync-preview aria-live="polite"></div>
        <div class="config-list-editor"><div class="config-list-heading"><h5>Model aliases</h5><button type="button" data-add-config-model>Add alias</button></div><div data-config-model-aliases>${configModelAliasEditor(draftConfig)}</div></div>
      </section>
      <section class="config-section"><div class="config-section-heading"><h4>Project, runtime & workspace</h4></div><div class="form-grid management-structured-fields">
        <label>Project name<input data-config-field="project.name" value="${html(getPath(draftConfig, 'project.name'))}" /></label>
        <label>Repository path<input data-config-field="project.repo" value="${html(getPath(draftConfig, 'project.repo'))}" /></label>
        <label>Base branch<input data-config-field="project.base_branch" value="${html(getPath(draftConfig, 'project.base_branch'))}" /></label>
        <label>Default model<select data-config-field="model"><option value="">Choose a model</option>${modelAliases.map((model) => `<option value="${html(model)}" ${model === getPath(draftConfig, 'model') ? 'selected' : ''}>${html(model)}</option>`).join('')}</select></label>
        <label>Runtime mode<select data-config-field="runtime.mode"><option value="local_process" ${getPath(draftConfig, 'runtime.mode') !== 'docker' ? 'selected' : ''} ${dockerRuntimeLocked ? 'disabled' : ''}>Local process</option><option value="docker" ${getPath(draftConfig, 'runtime.mode') === 'docker' ? 'selected' : ''}>Docker sandbox</option></select><small class="hint">${dockerRuntimeLocked ? 'Docker isolation is permanently required for this project.' : 'Migration to Docker is one-way and restarts the project.'}</small></label>
        <label>State directory<input data-config-field="runtime.persistence.state_dir" value="${html(getPath(draftConfig, 'runtime.persistence.state_dir'))}" placeholder=".oat/state" /></label>
        <label>Docker image<input data-config-field="runtime.docker.image" value="${html(getPath(draftConfig, 'runtime.docker.image'))}" placeholder="node:22-bookworm" /></label>
        <label>Docker network<select data-config-field="runtime.docker.network"><option value="bridge" ${getPath(draftConfig, 'runtime.docker.network') !== 'none' && getPath(draftConfig, 'runtime.docker.network') !== 'host' ? 'selected' : ''}>bridge</option><option value="none" ${getPath(draftConfig, 'runtime.docker.network') === 'none' ? 'selected' : ''}>none</option><option value="host" ${getPath(draftConfig, 'runtime.docker.network') === 'host' ? 'selected' : ''}>host</option></select></label>
        ${listInput('Docker extra arguments', 'runtime.docker.extra_args', getPath(draftConfig, 'runtime.docker.extra_args'), 'Comma-separated arguments.')}
        <label>Workspace provider<select data-config-field="workspace.provider"><option value="worktree" ${getPath(draftConfig, 'workspace.provider') !== 'shared_clone' && getPath(draftConfig, 'workspace.provider') !== 'full_clone' ? 'selected' : ''}>Worktree</option><option value="shared_clone" ${getPath(draftConfig, 'workspace.provider') === 'shared_clone' ? 'selected' : ''}>Shared clone</option><option value="full_clone" ${getPath(draftConfig, 'workspace.provider') === 'full_clone' ? 'selected' : ''}>Full clone</option></select></label>
        <label>Workspace root<input data-config-field="workspace.root_dir" value="${html(getPath(draftConfig, 'workspace.root_dir'))}" placeholder="workspaces" /></label>
        <label>Git remote<input data-config-field="workspace.git.remote" value="${html(getPath(draftConfig, 'workspace.git.remote'))}" placeholder="origin" /></label>
        <label>Git remote URL<input data-config-field="workspace.git.remote_url" value="${html(getPath(draftConfig, 'workspace.git.remote_url'))}" placeholder="git@host:owner/repo.git" /></label>
        <label>Git user name<input data-config-field="workspace.git.user_name" value="${html(getPath(draftConfig, 'workspace.git.user_name'))}" /></label>
        <label>Git user email<input data-config-field="workspace.git.user_email" value="${html(getPath(draftConfig, 'workspace.git.user_email'))}" /></label>
        <label class="checkbox-field">Enable Admin remote push<input type="checkbox" data-config-field="workspace.git.push_enabled" ${getPath(draftConfig, 'workspace.git.push_enabled') === true ? 'checked' : ''} /></label>
        <label>Git LFS<select data-config-field="workspace.git.lfs"><option value="pull" ${getPath(draftConfig, 'workspace.git.lfs') !== 'skip' && getPath(draftConfig, 'workspace.git.lfs') !== 'allow_pull_deny_change' ? 'selected' : ''}>pull</option><option value="skip" ${getPath(draftConfig, 'workspace.git.lfs') === 'skip' ? 'selected' : ''}>skip</option><option value="allow_pull_deny_change" ${getPath(draftConfig, 'workspace.git.lfs') === 'allow_pull_deny_change' ? 'selected' : ''}>allow pull, deny change</option></select></label>
        <label class="checkbox-field">Sparse checkout<input type="checkbox" data-config-field="workspace.sparse_checkout.enabled" ${getPath(draftConfig, 'workspace.sparse_checkout.enabled') !== false ? 'checked' : ''} /></label>
      </div></section>
      <section class="config-section"><div class="config-section-heading"><h4>Administrator</h4></div><div class="form-grid management-structured-fields">
        <label>Admin name<input data-config-field="admin.name" value="${html(getPath(draftConfig, 'admin.name'))}" /></label>
        <label>Admin model<select data-config-field="admin.model"><option value="">Inherit default</option>${modelAliases.map((model) => `<option value="${html(model)}" ${model === getPath(draftConfig, 'admin.model') ? 'selected' : ''}>${html(model)}</option>`).join('')}</select></label>
        <label class="span-2">Admin description<input data-config-field="admin.description" value="${html(getPath(draftConfig, 'admin.description'))}" /></label>
        <label class="span-2">Admin prompt<textarea data-config-field="admin.prompt">${html(getPath(draftConfig, 'admin.prompt'))}</textarea></label>
        <div class="span-2" data-admin-skills>${skillEditor('Admin skills', 'admin.skills', getPath(draftConfig, 'admin.skills'))}</div>
      </div></section>
      <div class="management-teams" data-structured-teams>${structuredTeams(draftConfig, modelAliases)}</div>
      <details class="management-advanced"><summary>Advanced JSON and change preview</summary><textarea class="json-editor" data-team-config spellcheck="false">${html(teamDraft)}</textarea><pre class="config-diff" data-team-diff>${renderDiff(formatJson(state.teamConfig ?? {}), teamDraft)}</pre></details>
      <div class="inline-form"><button class="primary" data-save-team>Save team configuration</button><button data-restart-project ${state.selectedProject ? '' : 'disabled'}>Restart selected project</button></div></article>
    <article class="panel"><h3>Global OAT settings</h3><p class="hint">Keep logs for a bounded number of days. Other shared settings remain available in Advanced JSON.</p><div class="inline-form management-retention"><label>Log retention days <input data-retention-days type="number" min="1" max="365" value="${retentionDays}" /></label><button class="primary" data-save-retention>Save retention</button></div><details class="management-advanced"><summary>Advanced global configuration</summary><textarea class="json-editor" data-global-config spellcheck="false">${json(state.globalConfig)}</textarea><button class="primary" data-save-global>Save global configuration</button></details></article>
    <article class="panel"><h3>Global model registry</h3><p class="hint">Test a provider before synchronising its model list. The test key is sent only to that provider and is not stored by this screen.</p><form class="form-grid" data-provider-form><label>Provider name<input required name="key" placeholder="openai" /></label><label>Protocol<select name="compatible_type"><option value="openai">OpenAI compatible</option><option value="anthropic">Anthropic</option></select></label><label class="span-2">Base URL<input required name="base_url" placeholder="https://api.example.com/v1" /></label><label class="span-2">API key (test only)<input name="api_key" type="password" autocomplete="off" /></label><button class="primary">Test, discover, and save models</button></form><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Protocol</th><th>Base URL</th><th>Key</th><th></th></tr></thead><tbody>${providers}</tbody></table></div><div class="table-wrap"><table><thead><tr><th>Model alias</th><th>Provider model</th><th></th></tr></thead><tbody>${models}</tbody></table></div><button data-clear-models>Clear model registry</button></article>
  </section>`;
}

/** Settings is intentionally a first-class page, rather than an advanced JSON
 * editor hidden under Team Config. */
export function renderSettings(state: ManagementState): string {
  const retention = Number(state.globalConfig?.logRetentionDays ?? 7);
  const days = Number.isFinite(retention) ? Math.min(365, Math.max(1, retention)) : 7;
  const providers = Object.entries(state.globalModels?.providers ?? {}).map(([key, provider]) => `<tr><td>${html(key)}</td><td>${html(provider.compatible_type || 'openai')}</td><td>${html(provider.base_url || '—')}</td><td>${provider.api_key ? 'configured' : '—'}</td><td><button data-remove-provider="${html(key)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="5">No providers configured.</td></tr>';
  const models = Object.entries(state.globalModels?.models ?? {}).map(([key, name]) => `<tr><td><code>${html(key)}</code></td><td>${html(name)}</td><td><button data-copy-model="${html(key)}">Copy</button><button data-remove-model="${html(key)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="3">No models registered.</td></tr>';
  return `<section class="content management settings-management" data-management-root>
    <div class="section-heading"><div><span class="eyebrow">GLOBAL CONTROL</span><h2>Settings</h2></div><button data-management-refresh>Refresh</button></div>
    <article class="panel"><h3>Log retention</h3><p class="hint">Keep observability logs from 1 to 365 days.</p><div class="inline-form management-retention"><label>Log retention days <input data-retention-days type="number" min="1" max="365" value="${days}" /></label><button class="primary" data-save-retention>Save retention</button></div></article>
    <article class="panel"><h3>Global model registry</h3><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Protocol</th><th>Base URL</th><th>Key</th><th>Actions</th></tr></thead><tbody>${providers}</tbody></table></div><div class="table-wrap"><table><thead><tr><th>Model alias</th><th>Provider model</th><th>Actions</th></tr></thead><tbody>${models}</tbody></table></div><button class="danger" data-clear-models>Clear all providers and models</button></article>
    <article class="panel"><h3>Advanced global configuration</h3><textarea class="json-editor" data-global-config spellcheck="false">${json(state.globalConfig)}</textarea><button class="primary" data-save-global>Save global configuration</button></article>
  </section>`;
}

type Notify = (message: string, error?: boolean) => void;
type Reload = () => Promise<void> | void;
let removeUnloadGuard: (() => void) | undefined;

/** Bind user interactions after `renderManagement`. Returns no global listeners. */
export function bindManagement(root: ParentNode, state: ManagementState, api: ManagementApi, reload: Reload, notify: Notify): void {
  const one = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const teamEditor = one<HTMLTextAreaElement>('[data-team-config]');
  const originalTeamJson = formatJson(state.teamConfig ?? {});
  const modelAliases = () => configModelAliases(currentConfigOrState(), state.globalModels);
  const cacheKey = teamDraftKey(state.selectedProject);
  const dirty = () => Boolean(teamEditor && teamEditor.value !== originalTeamJson);
  const updateDraftUi = () => {
    if (!teamEditor) return;
    const stateNode = one<HTMLElement>('[data-team-draft-state]');
    if (stateNode) stateNode.textContent = dirty() ? 'Unsaved draft' : 'Saved';
    const diff = one<HTMLElement>('[data-team-diff]');
    if (diff) diff.innerHTML = renderDiff(originalTeamJson, teamEditor.value);
    try { if (dirty()) localStorage.setItem(cacheKey, teamEditor.value); else localStorage.removeItem(cacheKey); } catch { /* localStorage may be unavailable */ }
  };
  const writeConfig = (config: TeamConfig) => { if (teamEditor) { teamEditor.value = formatJson(config); updateDraftUi(); } };
  const currentConfig = (): TeamConfig | undefined => {
    const parsed = readJson(teamEditor?.value || '');
    if (!parsed) notify('JSON format is invalid.', true);
    return parsed;
  };
  const currentConfigOrState = (): TeamConfig => readJson(teamEditor?.value || '') ?? state.teamConfig ?? {};
  const refreshStructured = (config: TeamConfig) => {
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-config-field]').forEach((input) => {
      const value = getPath(config, input.dataset.configField!);
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement) input.value = value == null ? '' : String(value);
    });
    const teams = one<HTMLElement>('[data-structured-teams]');
    if (teams) teams.innerHTML = structuredTeams(config, modelAliases());
    const providers = one<HTMLElement>('[data-config-providers]');
    if (providers) providers.innerHTML = configProviders(config);
    const aliases = one<HTMLElement>('[data-config-model-aliases]');
    if (aliases) aliases.innerHTML = configModelAliasEditor(config);
    const adminSkills = one<HTMLElement>('[data-admin-skills]');
    if (adminSkills) adminSkills.innerHTML = skillEditor('Admin skills', 'admin.skills', getPath(config, 'admin.skills'));
    root.querySelectorAll<HTMLSelectElement>('select[data-config-field]').forEach((select) => {
      const path = select.dataset.configField;
      if (path !== 'model' && !path?.endsWith('.model')) return;
      const value = String(getPath(config, path) ?? '');
      const placeholder = path === 'model' ? 'Choose a model' : 'Inherit default';
      select.innerHTML = `<option value="">${placeholder}</option>${modelAliases().map((alias) => `<option value="${html(alias)}" ${alias === value ? 'selected' : ''}>${html(alias)}</option>`).join('')}`;
    });
  };
  const parse = (selector: string): Record<string, unknown> | undefined => {
    try { return JSON.parse(one<HTMLTextAreaElement>(selector)?.value || '{}') as Record<string, unknown>; }
    catch { notify('JSON format is invalid.', true); return undefined; }
  };
  removeUnloadGuard?.();
  const unloadGuard = (event: BeforeUnloadEvent) => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unloadGuard);
  removeUnloadGuard = () => window.removeEventListener('beforeunload', unloadGuard);
  updateDraftUi();
  one<HTMLButtonElement>('[data-management-refresh]')?.addEventListener('click', () => void reload());
  one<HTMLSelectElement>('[data-team-project]')?.addEventListener('change', async (event) => {
    const select = event.currentTarget as HTMLSelectElement;
    if (dirty() && !confirm('Keep this unsaved local draft and switch projects?')) { select.value = state.selectedProject || ''; return; }
    state.selectedProject = select.value || undefined;
    try { state.teamConfig = await api.teamConfig(state.selectedProject); await reload(); } catch (error) { notify(String(error), true); }
  });
  teamEditor?.addEventListener('input', updateDraftUi);
  const updateStructuredField = (input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
    const path = input.dataset.configField;
    if (!path) return;
    const config = currentConfig(); if (!config) return;
    const value = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked
      : input.type === 'number' ? Math.max(1, Number(input.value) || 1) : input.value || undefined;
    setPath(config, path, value);
    writeConfig(config);
  };
  root.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (input.matches('[data-config-provider-field]')) {
      const config = currentConfig(); if (!config) return;
      const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, Provider>;
      const provider = providers[input.dataset.configProvider!];
      if (provider) { provider[input.dataset.configProviderField! as keyof Provider] = input.value || undefined; writeConfig(config); }
      return;
    }
    if (input.matches('[data-config-model-value]')) {
      const config = currentConfig(); if (!config) return;
      const aliases = (config.models && typeof config.models === 'object' ? config.models : {}) as Record<string, string>;
      aliases[input.dataset.configModelValue!] = input.value; config.models = aliases; writeConfig(config); return;
    }
    if (!input.matches('[data-config-field]')) return;
    updateStructuredField(input);
  });
  root.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (input.matches('[data-config-provider-field]') || input.matches('[data-config-model-value]')) {
      input.dispatchEvent(new Event('input', { bubbles: true })); return;
    }
    if (input.matches('[data-config-list]')) {
      const config = currentConfig(); if (!config) return;
      setPath(config, input.dataset.configList!, input.value.split(',').map((item) => item.trim()).filter(Boolean));
      writeConfig(config); return;
    }
    if (input.matches('[data-config-provider-key]')) {
      const config = currentConfig(); if (!config) return;
      const oldKey = input.dataset.configProviderKey!;
      const newKey = input.value.trim();
      const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, Provider>;
      if (!newKey || (newKey !== oldKey && providers[newKey])) { notify('Provider names must be unique and non-empty.', true); input.value = oldKey; return; }
      if (newKey !== oldKey) { providers[newKey] = providers[oldKey]; delete providers[oldKey]; config.providers = providers; writeConfig(config); refreshStructured(config); }
      return;
    }
    if (input.matches('[data-config-model-alias]')) {
      const config = currentConfig(); if (!config) return;
      const oldAlias = input.dataset.configModelAlias!;
      const newAlias = input.value.trim();
      const aliases = (config.models && typeof config.models === 'object' ? config.models : {}) as Record<string, string>;
      if (!newAlias || (newAlias !== oldAlias && aliases[newAlias])) { notify('Model aliases must be unique and non-empty.', true); input.value = oldAlias; return; }
      if (newAlias !== oldAlias) { aliases[newAlias] = aliases[oldAlias]; delete aliases[oldAlias]; config.models = aliases; writeConfig(config); refreshStructured(config); }
      return;
    }
    if (!input.matches('[data-config-field]')) return;
    updateStructuredField(input);
  });
  root.addEventListener('click', async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-add-config-provider], [data-remove-config-provider], [data-add-config-model], [data-remove-config-model], [data-add-config-skill], [data-remove-config-skill], [data-fetch-config-models]');
    if (!button) return;
    const config = currentConfig(); if (!config) return;
    if (button.hasAttribute('data-add-config-provider')) {
      const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, Provider>;
      let index = Object.keys(providers).length + 1; let key = `provider-${index}`;
      while (providers[key]) key = `provider-${++index}`;
      providers[key] = { compatible_type: 'openai', base_url: '' }; config.providers = providers; writeConfig(config); refreshStructured(config); return;
    }
    if (button.dataset.removeConfigProvider) {
      const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, Provider>;
      delete providers[button.dataset.removeConfigProvider]; config.providers = providers; writeConfig(config); refreshStructured(config); return;
    }
    if (button.hasAttribute('data-add-config-model')) {
      const aliases = (config.models && typeof config.models === 'object' ? config.models : {}) as Record<string, string>;
      let index = Object.keys(aliases).length + 1; let alias = `model-${index}`;
      while (aliases[alias]) alias = `model-${++index}`;
      aliases[alias] = ''; config.models = aliases; writeConfig(config); refreshStructured(config); return;
    }
    if (button.dataset.removeConfigModel) {
      const aliases = (config.models && typeof config.models === 'object' ? config.models : {}) as Record<string, string>;
      delete aliases[button.dataset.removeConfigModel]; config.models = aliases; writeConfig(config); refreshStructured(config); return;
    }
    if (button.dataset.addConfigSkill) {
      const path = button.dataset.addConfigSkill; const skills = skillList(getPath(config, path));
      skills.push({ source: '', names: [] }); setPath(config, path, skills); writeConfig(config); refreshStructured(config); return;
    }
    if (button.hasAttribute('data-remove-config-skill')) {
      const path = button.dataset.skillPath!; const skills = skillList(getPath(config, path));
      skills.splice(Number(button.dataset.skillIndex), 1); setPath(config, path, skills); writeConfig(config); refreshStructured(config); return;
    }
    if (button.hasAttribute('data-fetch-config-models')) {
      try {
        const result = await api.previewConfigModelSync(config);
        const details = [
          ...result.added.map((model) => `+ ${model}`), ...result.removed.map((model) => `− ${model}`),
          ...result.changed.map((model) => `~ ${model}: ${state.globalModels?.models[model] ?? 'unknown'} → ${result.next.models[model]}`),
          ...result.unchanged.map((model) => `  ${model}`), ...result.failed.map(({ key, error }) => `! ${key}: ${error}`),
        ];
        const preview = one<HTMLElement>('[data-model-sync-preview]');
        if (preview) preview.innerHTML = `<strong>Model sync preview</strong><pre>${html(details.join('\n') || 'No registry changes.')}</pre>`;
        if (!result.added.length && !result.removed.length && !result.changed.length) {
          notify(result.failed.length ? `No models changed. ${result.failed.length} provider failure(s) retained.` : 'Model registry is already up to date.', result.failed.length > 0);
          return;
        }
        const summary = [`Add: ${result.added.length}`, `Remove: ${result.removed.length}`, `Changed: ${result.changed.length}`, `Unchanged: ${result.unchanged.length}`, result.failed.length ? `Failures retained: ${result.failed.length}` : ''].filter(Boolean).join('\n');
        if (!confirm(`Apply this model registry update?\n\n${summary}\n\nReview the complete diff displayed above before confirming.`)) return;
        await api.saveGlobalModels(result.next);
        notify(`Model registry synchronised: ${result.added.length} added, ${result.removed.length} removed, ${result.changed.length} changed${result.failed.length ? `; ${result.failed.length} provider failure(s) retained` : ''}.`, result.failed.length > 0);
        await reload();
      } catch (error) { notify(`Model sync failed: ${String(error)}`, true); }
    }
  });
  root.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-add-config-team], [data-remove-config-team], [data-apply-team-json], [data-discard-team-draft]');
    if (!button) return;
    const config = currentConfig(); if (!config) return;
    if (button.hasAttribute('data-add-config-team')) {
      const teams = Array.isArray(config.teams) ? config.teams : []; teams.push(initialTeam(teams.length)); config.teams = teams; writeConfig(config); refreshStructured(config);
    } else if (button.dataset.removeConfigTeam !== undefined) {
      const teams = Array.isArray(config.teams) ? config.teams : [];
      if (teams.length <= 1) { notify('At least one team is required.', true); return; }
      teams.splice(Number(button.dataset.removeConfigTeam), 1); config.teams = teams; writeConfig(config); refreshStructured(config);
    } else if (button.hasAttribute('data-apply-team-json')) refreshStructured(config);
    else if (button.hasAttribute('data-discard-team-draft')) {
      if (!confirm('Discard this local draft and restore the last saved configuration?')) return;
      try { localStorage.removeItem(cacheKey); } catch { /* ignore */ }
      if (teamEditor) teamEditor.value = originalTeamJson;
      refreshStructured(state.teamConfig ?? {}); updateDraftUi();
    }
  });
  one<HTMLButtonElement>('[data-save-team]')?.addEventListener('click', async () => {
    const config = parse('[data-team-config]'); if (!config) return;
    try {
      await api.saveTeamConfig(state.selectedProject, config);
      try {
        const result = await api.syncDeclaredModels(config);
        notify(result.conflicts.length ? 'Team configuration saved; global model update was skipped.' : 'Team configuration and global model registry saved.');
      } catch (error) { notify(`Team configuration saved, but global model sync failed: ${String(error)}`, true); }
      try { localStorage.removeItem(cacheKey); } catch { /* ignore */ }
      if (state.selectedProject) {
        try { await api.restart(state.selectedProject); notify('Project restart requested.'); }
        catch (error) { notify(`Configuration saved, but restart failed: ${String(error)}`, true); }
      }
      await reload();
    } catch (error) { notify(String(error), true); }
  });
  one<HTMLButtonElement>('[data-restart-project]')?.addEventListener('click', async () => {
    if (!state.selectedProject || !confirm(`Restart ${state.selectedProject}? Running tasks may be interrupted.`)) return;
    try { await api.restart(state.selectedProject); notify('Project restart requested.'); } catch (error) { notify(String(error), true); }
  });
  one<HTMLButtonElement>('[data-save-global]')?.addEventListener('click', async () => {
    const config = parse('[data-global-config]'); if (!config) return;
    try { await api.saveGlobalConfig(config); notify('Global configuration saved.'); await reload(); } catch (error) { notify(String(error), true); }
  });
  one<HTMLButtonElement>('[data-save-retention]')?.addEventListener('click', async () => {
    const field = one<HTMLInputElement>('[data-retention-days]');
    const days = Number(field?.value);
    if (!Number.isInteger(days) || days < 1 || days > 365) { notify('Log retention must be a whole number from 1 to 365 days.', true); return; }
    const config = { ...(state.globalConfig ?? {}), logRetentionDays: days };
    try { await api.saveGlobalConfig(config); state.globalConfig = config; notify('Log retention saved.'); await reload(); } catch (error) { notify(String(error), true); }
  });
  one<HTMLFormElement>('[data-provider-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement));
    try { const ids = await api.testAndSyncProvider(String(values.key), values as unknown as Provider); notify(`Connected. Found ${ids.length} model(s).`); await reload(); } catch (error) { notify(String(error), true); }
  });
  root.querySelectorAll<HTMLButtonElement>('[data-remove-provider]').forEach((button) => button.addEventListener('click', async () => {
    const key = button.dataset.removeProvider!; if (!confirm(`Remove ${key} and its models?`)) return;
    try { await api.removeProvider(key); notify('Provider removed.'); await reload(); } catch (error) { notify(String(error), true); }
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-remove-model]').forEach((button) => button.addEventListener('click', async () => {
    try { await api.removeModel(button.dataset.removeModel!); notify('Model removed.'); await reload(); } catch (error) { notify(String(error), true); }
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-copy-model]').forEach((button) => button.addEventListener('click', async () => {
    const value = button.dataset.copyModel; if (!value) return;
    try { await navigator.clipboard.writeText(value); notify('Model alias copied.'); } catch { notify('Unable to access the clipboard.', true); }
  }));
  one<HTMLButtonElement>('[data-clear-models]')?.addEventListener('click', async () => {
    if (!confirm('Clear every global provider and model?')) return;
    try { await api.saveGlobalModels({ providers: {}, models: {} }); notify('Model registry cleared.'); await reload(); } catch (error) { notify(String(error), true); }
  });
}

/**
 * HR-style multi-team interview. `data-resource-team` cards can be added and
 * removed without rerendering; this keeps user-entered answers intact.
 */
export function renderAgentResources(projects: ProjectSummary[], selectedProject?: string): string {
  const options = projects.map((project) => `<option value="${html(project.name)}" ${project.name === selectedProject ? 'selected' : ''}>${html(project.projectName || project.name)}</option>`).join('');
  return `<section class="content resources" data-resources-root>
    <div class="section-heading"><div><span class="eyebrow">AGENT RESOURCES</span><h2>Build a project organisation</h2></div></div>
    <p class="hint">The HR interview creates an Admin, independent team Leaders, and self-testing Workers. Workers deliver review requests; Leaders alone review and merge.</p>
    <form class="panel form-grid" data-resources-form>
      <label>Save to registered project<select name="targetProject">${options}<option value="">Current/default project</option></select></label>
      <label>Project name<input name="projectName" required placeholder="checkout-service" /></label>
      <label class="span-2">Repository path<input name="repo" required value="." /></label>
      <label>Production branch<select name="baseBranch"><option>main</option><option>master</option></select></label>
      <label>Default model<input name="model" required value="openai/gpt-4o-mini" /></label>
      <label>Provider protocol<select name="protocol"><option value="openai">OpenAI compatible</option><option value="anthropic">Anthropic</option></select></label>
      <label>Runtime<select name="runtime"><option value="docker">Docker sandbox</option><option value="local_process">Local process</option></select></label>
      <label>Docker image<input name="dockerImage" value="node:22-bookworm" /></label>
      <label>Docker network<select name="dockerNetwork"><option value="bridge">bridge</option><option value="none">none</option><option value="host">host</option></select></label>
      <div class="span-2" data-resource-teams><article class="panel" data-resource-team><div class="section-heading"><h3>Team</h3><button type="button" data-remove-resource-team>Remove</button></div><label>Team identifier<input name="teamName" required value="platform" /></label><label>Worker count<input name="workers" required type="number" min="1" value="2" /></label><label>Allowed repositories / paths (comma separated)<input name="repos" /></label><label>Leader responsibility<textarea name="responsibility" required>Plan independent work, review branches, integrate approved changes, and submit releases.</textarea></label></article></div>
      <button type="button" data-add-resource-team>Add another independent team</button><button class="primary">Generate and save organisation</button>
    </form>
  </section>`;
}

const resourceTeam = (sequence: number) => `<article class="panel" data-resource-team><div class="section-heading"><h3>Team ${sequence}</h3><button type="button" data-remove-resource-team>Remove</button></div><label>Team identifier<input name="teamName" required value="team-${sequence}" /></label><label>Worker count<input name="workers" required type="number" min="1" value="2" /></label><label>Allowed repositories / paths (comma separated)<input name="repos" /></label><label>Leader responsibility<textarea name="responsibility" required>Plan independent work, review branches, integrate approved changes, and submit releases.</textarea></label></article>`;

export function bindAgentResources(root: ParentNode, api: ManagementApi, notify: Notify, afterSave?: Reload): void {
  const form = root.querySelector<HTMLFormElement>('[data-resources-form]');
  if (!form) return;
  const teams = form.querySelector<HTMLElement>('[data-resource-teams]')!;
  const bindRemove = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('[data-remove-resource-team]')?.addEventListener('click', () => {
    if (teams.querySelectorAll('[data-resource-team]').length === 1) { notify('At least one team is required.', true); return; }
    card.remove();
  });
  teams.querySelectorAll<HTMLElement>('[data-resource-team]').forEach(bindRemove);
  form.querySelector<HTMLButtonElement>('[data-add-resource-team]')?.addEventListener('click', () => {
    const wrapper = document.createElement('div'); wrapper.innerHTML = resourceTeam(teams.querySelectorAll('[data-resource-team]').length + 1);
    const card = wrapper.firstElementChild as HTMLElement; teams.append(card); bindRemove(card);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const scalar = Object.fromEntries(new FormData(form));
    const draft = {
      projectName: String(scalar.projectName || ''), repo: String(scalar.repo || '.'), baseBranch: String(scalar.baseBranch || 'main'), model: String(scalar.model || ''), protocol: String(scalar.protocol || 'openai') as 'openai' | 'anthropic', runtime: String(scalar.runtime || 'docker') as 'docker' | 'local_process', dockerImage: String(scalar.dockerImage || ''), dockerNetwork: String(scalar.dockerNetwork || ''),
      teams: [...teams.querySelectorAll<HTMLElement>('[data-resource-team]')].map((card) => {
        const data = new FormData(); card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((input) => data.set(input.name, input.value));
        return { name: String(data.get('teamName') || ''), responsibility: String(data.get('responsibility') || ''), workers: Number(data.get('workers') || 1), repos: String(data.get('repos') || '') };
      }),
    };
    if (!draft.projectName || !draft.model || draft.teams.some((team) => !team.name || !team.responsibility)) { notify('Complete the required project and team fields.', true); return; }
    try { await api.saveTeamConfig(String(scalar.targetProject || '') || undefined, buildResourcesConfig(draft)); notify('Organisation configuration saved. Restart the project to apply it.'); await afterSave?.(); }
    catch (error) { notify(String(error), true); }
  });
}
