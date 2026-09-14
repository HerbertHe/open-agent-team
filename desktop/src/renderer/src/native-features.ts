import "./native-features.css";
import {
  ChannelBindingTargetEnum,
  ChannelConnectionStatusEnum,
  type ChannelAccountStatus,
  type ChannelAgentTarget,
  type ChannelPluginDescriptor,
  type ChannelProjectBinding,
} from "../../shared/channel-types";

/**
 * Native Desktop management and insight feature modules.
 *
 * These functions deliberately use only the local Orchestrator HTTP API.  They
 * They do not import, iframe, or otherwise depend on a separate web bundle.
 * The small vanilla-DOM surface also lets the desktop shell keep its current
 * renderer architecture while individual features remain independently testable.
 */

export type Translator = (key: string, fallback?: string) => string;

export interface DesktopProject {
  name: string;
  projectName?: string | null;
  alive: boolean;
  port?: number | null;
  agents?: Array<{ id: string; role: string; label: string; status: string }>;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  send<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<T>;
}

export type OrchestratorRequester = (projectName: string, path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<unknown>;
export type ControlPlaneRequester = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<unknown>;

export function createOrchestratorApi(project: DesktopProject | undefined, requester: OrchestratorRequester, offlineMessage = "Select a running project"): ApiClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!project?.alive || !project.port) throw new Error(offlineMessage);
    return requester(project.name, path, init ? { method: init.method, headers: init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined, body: typeof init.body === "string" ? init.body : undefined } : undefined) as Promise<T>;
  }
  return {
    get: <T>(path: string) => request<T>(path),
    send: <T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown) => request<T>(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

/**
 * Creates an API client for desktop's control-plane IPC. Unlike a runtime
 * client it deliberately has no liveness gate, so callers can inspect
 * registered/stopped projects through a control-plane endpoint.
 */
export function createControlPlaneApi(requester: ControlPlaneRequester): ApiClient {
  const request = <T>(path: string, init?: RequestInit) => requester(path, init ? {
    method: init.method,
    headers: init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined,
    body: typeof init.body === "string" ? init.body : undefined,
  } : undefined) as Promise<T>;
  return {
    get: <T>(path: string) => request<T>(path),
    send: <T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown) => request<T>(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

export const escapeFeatureHtml = (value: unknown): string => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
const id = (value: string) => encodeURIComponent(value);

// ---- Usage ---------------------------------------------------------------

export type UsageRange = "all" | "30d" | "7d" | "yesterday" | "today";
export interface UsageTimeline { time: string; requests: number; inputTokens: number; outputTokens: number; cost?: number; }
export interface UsageStat {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  totalCost: number;
  timeline: UsageTimeline[];
  byAgent: Array<{ agentId: string; totalTokens: number }>;
  byModel: Array<{ model: string; totalTokens: number }>;
}
export interface UsageState { projects: string[]; selectedProject: string; range: UsageRange; stats?: UsageStat; loading?: boolean; }

export async function loadUsage(api: ApiClient, selectedProject = "all", range: UsageRange = "30d"): Promise<UsageState> {
  const [projects, stats] = await Promise.all([
    api.get<string[]>("/api/usage/projects"),
    api.get<UsageStat>(`/api/usage/stats?project=${id(selectedProject)}&range=${range}&groupBy=${range === "today" || range === "yesterday" ? "hour" : "day"}`),
  ]);
  return { projects, selectedProject, range, stats };
}

const number = (value: number | undefined) => new Intl.NumberFormat().format(value ?? 0);
const compactRows = (items: Array<{ name: string; value: number }>) => items.length ? items.map(item => `<li><span>${escapeFeatureHtml(item.name)}</span><strong>${number(item.value)}</strong></li>`).join("") : "<li class=\"empty\">No data</li>";
const chartColors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#ef4444", "#84cc16"];
const usageLabel = (time: string, range: UsageRange) => (range === "today" || range === "yesterday") ? time.slice(11, 16) || time : time.slice(5, 10) || time;
function donut(items: Array<{ name: string; value: number }>, t: Translator): string {
  if (!items.length || !items.some(item => item.value > 0)) return `<p class="empty">${escapeFeatureHtml(t("usage.no_data", "No data"))}</p>`;
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0) || 1;
  let cursor = 0;
  const segments = items.map((item, index) => {
    const start = cursor;
    cursor += (Math.max(0, item.value) / total) * 100;
    return `${chartColors[index % chartColors.length]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  }).join(", ");
  return `<div class="usage-donut-layout"><div class="usage-donut" style="--usage-segments:${segments}" role="img" aria-label="${escapeFeatureHtml(items.map(item => `${item.name}: ${number(item.value)}`).join(", "))}"><span>${number(total)}<small>tokens</small></span></div><ul class="distribution donut-legend">${items.map((item, index) => `<li><span><i style="--legend-color:${chartColors[index % chartColors.length]}"></i>${escapeFeatureHtml(item.name)}</span><strong>${number(item.value)}</strong></li>`).join("")}</ul></div>`;
}

export function renderUsage(state: UsageState, t: Translator): string {
  const stats = state.stats;
  const ranges: UsageRange[] = ["all", "30d", "7d", "yesterday", "today"];
  const points = stats?.timeline ?? [];
  const maxTokens = Math.max(1, ...points.map(point => point.inputTokens + point.outputTokens));
  const maxRequests = Math.max(1, ...points.map(point => point.requests));
  return `<section class="content desktop-feature usage-feature" aria-busy="${state.loading === true}">
    <div class="section-heading"><div><span class="eyebrow">MODEL ANALYTICS</span><h2>${escapeFeatureHtml(t("usage.title", "Model usage statistics"))}</h2></div><button data-feature-action="usage-reload">${escapeFeatureHtml(t("refresh", "Refresh"))}</button></div>
    <div class="feature-filters"><label>${escapeFeatureHtml(t("usage.project", "Project"))}<select data-usage-project><option value="all">${escapeFeatureHtml(t("usage.all_projects", "All projects"))}</option>${state.projects.map(project => `<option value="${escapeFeatureHtml(project)}" ${project === state.selectedProject ? "selected" : ""}>${escapeFeatureHtml(project)}</option>`).join("")}</select></label><fieldset>${ranges.map(range => `<button type="button" class="${state.range === range ? "selected" : ""}" data-usage-range="${range}">${escapeFeatureHtml(t(`usage.range_${range}`, range))}</button>`).join("")}</fieldset></div>
    ${stats ? `<div class="stats usage-summary"><article><small>${escapeFeatureHtml(t("usage.total_requests", "Requests"))}</small><strong>${number(stats.totalRequests)}</strong></article><article class="usage-input-total"><small>${escapeFeatureHtml(t("usage.total_input_tokens", "Input tokens"))}</small><strong>${number(stats.totalInputTokens)}</strong></article><article class="usage-output-total"><small>${escapeFeatureHtml(t("usage.total_output_tokens", "Output tokens"))}</small><strong>${number(stats.totalOutputTokens)}</strong></article><article><small>${escapeFeatureHtml(t("usage.cache_read_tokens", "Cache read tokens"))}</small><strong>${number(stats.totalCacheReadTokens)}</strong></article><article><small>${escapeFeatureHtml(t("usage.cache_write_tokens", "Cache write tokens"))}</small><strong>${number(stats.totalCacheWriteTokens)}</strong></article><article><small>${escapeFeatureHtml(t("usage.total_cost", "Total cost"))}</small><strong>$${(stats.totalCost ?? 0).toFixed(4)}</strong></article></div>
      <div class="feature-grid"><article class="panel"><h3>${escapeFeatureHtml(t("usage.token_trend", "Token usage trend"))}</h3><div class="chart-legend"><span class="input">${escapeFeatureHtml(t("usage.input_tokens", "Input tokens"))}</span><span class="output">${escapeFeatureHtml(t("usage.output_tokens", "Output tokens"))}</span></div><div class="usage-bars token-bars">${points.map(point => `<div title="${escapeFeatureHtml(`${point.time}: ${number(point.inputTokens)} input, ${number(point.outputTokens)} output`)}"><span class="usage-stack"><i class="input" style="height:${Math.max(0, (point.inputTokens / maxTokens) * 100)}%"></i><i class="output" style="height:${Math.max(0, (point.outputTokens / maxTokens) * 100)}%"></i></span><small>${escapeFeatureHtml(usageLabel(point.time, state.range))}</small></div>`).join("") || `<p class="empty">${escapeFeatureHtml(t("usage.no_data", "No data"))}</p>`}</div></article><article class="panel"><h3>${escapeFeatureHtml(t("usage.request_trend", "Request trend"))}</h3><div class="usage-bars requests">${points.map(point => `<div title="${escapeFeatureHtml(`${point.time}: ${number(point.requests)}`)}"><i style="height:${Math.max(3, (point.requests / maxRequests) * 100)}%"></i><small>${escapeFeatureHtml(usageLabel(point.time, state.range))}</small></div>`).join("") || `<p class="empty">${escapeFeatureHtml(t("usage.no_data", "No data"))}</p>`}</div></article><article class="panel"><h3>${escapeFeatureHtml(t("usage.agent_distribution", "Agent distribution"))}</h3>${donut(stats.byAgent.map(item => ({ name: item.agentId, value: item.totalTokens })), t)}</article><article class="panel"><h3>${escapeFeatureHtml(t("usage.model_distribution", "Model distribution"))}</h3>${donut(stats.byModel.map(item => ({ name: item.model, value: item.totalTokens })), t)}</article></div>` : `<div class="empty">${escapeFeatureHtml(t("usage.no_data", "No data"))}</div>`}
    ${state.loading ? `<div class="feature-loading" role="status" aria-live="polite"><span></span>${escapeFeatureHtml(t("loading", "Loading…"))}</div>` : ""}
  </section>`;
}

export function bindUsage(root: ParentNode, state: UsageState, api: ApiClient, t: Translator, update: (state: UsageState) => void, fail: (error: unknown) => void): void {
  const reload = async () => {
    state.loading = true;
    update(state);
    try { update(await loadUsage(api, state.selectedProject, state.range)); }
    catch (error) { state.loading = false; update(state); fail(error); }
  };
  root.querySelector<HTMLButtonElement>("[data-feature-action=usage-reload]")?.addEventListener("click", reload);
  root.querySelector<HTMLSelectElement>("[data-usage-project]")?.addEventListener("change", event => { state.selectedProject = (event.currentTarget as HTMLSelectElement).value; reload(); });
  root.querySelectorAll<HTMLButtonElement>("[data-usage-range]").forEach(button => button.addEventListener("click", () => { state.range = button.dataset.usageRange as UsageRange; reload(); }));
}

// ---- Achievements --------------------------------------------------------

export interface AchievementConfig { teams?: Array<{ name: string; worker?: { total?: number } }>; }
export interface RecordFile { name: string; content: string; }
export interface AchievementProject { name: string; projectName?: string | null; alive?: boolean; }
export interface AchievementState { projects?: AchievementProject[]; project: string; config?: AchievementConfig; team: string; role: string; changelog: string; dates: string[]; selectedDate: string; records: RecordFile[]; activeRecord?: string; }
export function achievementRoles(config: AchievementConfig | undefined, team: string): string[] { const workers = config?.teams?.find(item => item.name === team)?.worker?.total ?? 0; return ["admin", `${team}-lead`, ...Array.from({ length: workers }, (_, index) => `${team}-worker-${index}`)]; }
export async function loadAchievements(api: ApiClient, project: string, team = "", role = "admin", date = "", suppliedProjects?: AchievementProject[]): Promise<AchievementState> {
  const fetchedProjects = suppliedProjects ?? await api.get<AchievementProject[]>("/api/projects").catch(() => []);
  const projects = fetchedProjects.some(item => item.name === project) ? fetchedProjects : [{ name: project }, ...fetchedProjects];
  const config = await api.get<AchievementConfig>(`/api/projects/${id(project)}/config`);
  const selectedTeam = team || config.teams?.[0]?.name || "";
  const selectedRole = role === "admin" && selectedTeam ? "admin" : role;
  const base = `/api/projects/${id(project)}/workspaces/${id(selectedRole)}`;
  const [change, dateData] = await Promise.all([api.get<{ content?: string }>(`${base}/changelog`), api.get<{ dates?: string[] }>(`${base}/record-dates`)]);
  const selectedDate = date || dateData.dates?.[0] || "";
  const recordData = selectedDate ? await api.get<{ files?: RecordFile[] }>(`${base}/records?date=${id(selectedDate)}`) : { files: [] };
  return { projects, project, config, team: selectedTeam, role: selectedRole, changelog: change.content ?? "", dates: dateData.dates ?? [], selectedDate, records: recordData.files ?? [], activeRecord: recordData.files?.[0]?.name };
}

const safeMarkdownUrl = (value: string): string | undefined => /^(?:https?:\/\/|mailto:|\/|#)/i.test(value.trim()) ? value.trim() : undefined;
function inlineMarkdown(value: string): string {
  const tokens: string[] = [];
  const token = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
  let text = value.replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${escapeFeatureHtml(code)}</code>`));
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+['\"][^)]*['\"])?\)/g, (_match, label: string, href: string) => {
    const safeHref = safeMarkdownUrl(href);
    return safeHref ? token(`<a href="${escapeFeatureHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(label)}</a>`) : label;
  });
  text = escapeFeatureHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? "");
}
const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
const isTableSeparator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
/** Lightweight local syntax treatment for record code fences. It keeps code
 * inert and does not load a highlighter or language grammar in the renderer. */
function highlightCode(source: string, language: string): string {
  let value = escapeFeatureHtml(source);
  const common = (text: string) => text
    .replace(/(&quot;[^&]*?&quot;|'[^']*?')/g, '<span class="token-string">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="token-number">$1</span>');
  if (/^(?:json|jsonc)$/i.test(language)) return common(value).replace(/(&quot;[^&]*?&quot;)(?=\s*:)/g, '<span class="token-key">$1</span>');
  if (/^(?:ts|tsx|js|jsx|javascript|typescript)$/i.test(language)) return common(value).replace(/\b(const|let|var|function|return|async|await|if|else|for|while|class|interface|type|import|from|export|new|throw)\b/g, '<span class="token-keyword">$1</span>');
  if (/^(?:sh|bash|zsh|shell)$/i.test(language)) return common(value).replace(/(^|\s)(#.*)$/gm, '$1<span class="token-comment">$2</span>');
  return value;
}
function markdown(content: string): string {
  const lines = content.replace(/\r/g, "").split("\n");
  const blocks: string[] = [];
  let index = 0;
  const isBlockStart = (line: string) => /^(?:#{1,6}\s+|```|>\s?|[-*+]\s+|\d+[.)]\s+|\|)/.test(line) || /^\s*$/.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      const language = fence[1] || "text";
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(`<pre class="markdown-code"><code class="language-${escapeFeatureHtml(language)}" data-language="${escapeFeatureHtml(language)}">${highlightCode(code.join("\n"), language)}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { const level = heading[1].length; blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); index++; continue; }
    if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) { blocks.push("<hr>"); index++; continue; }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push(`<blockquote>${markdown(quote.join("\n"))}</blockquote>`);
      continue;
    }
    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1])) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(tableCells(lines[index++]));
      blocks.push(`<div class="markdown-table-wrap"><table><thead><tr>${headers.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_header, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const pattern = unordered ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) { const match = lines[index].match(pattern); if (!match) break; items.push(`<li>${inlineMarkdown(match[1])}</li>`); index++; }
      blocks.push(`<${unordered ? "ul" : "ol"}>${items.join("")}</${unordered ? "ul" : "ol"}>`);
      continue;
    }
    const paragraph: string[] = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) paragraph.push(lines[index++]);
    blocks.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
  }
  return blocks.join("");
}
export function renderAchievements(state: AchievementState, t: Translator): string {
  const teams = state.config?.teams ?? [];
  const roles = achievementRoles(state.config, state.team);
  const projects = state.projects?.length ? state.projects : [{ name: state.project }];
  const active = state.records.find(file => file.name === state.activeRecord) ?? state.records[0];
  return `<section class="content desktop-feature achievements-feature"><div class="section-heading"><div><span class="eyebrow">PROJECT HISTORY</span><h2>${escapeFeatureHtml(t("achievements.title", "Project achievements"))}</h2></div><button data-feature-action="achievement-reload">${escapeFeatureHtml(t("refresh", "Refresh"))}</button></div><div class="feature-filters"><label>${escapeFeatureHtml(t("achievements.project", "Project"))}<select data-achievement-project>${projects.map(item => `<option value="${escapeFeatureHtml(item.name)}" ${item.name === state.project ? "selected" : ""}>${escapeFeatureHtml(item.projectName || item.name)}${item.alive === false ? ` (${escapeFeatureHtml(t("project.stopped", "Stopped"))})` : ""}</option>`).join("")}</select></label><label>${escapeFeatureHtml(t("achievements.team", "Team"))}<select data-achievement-team>${teams.map(item => `<option value="${escapeFeatureHtml(item.name)}" ${item.name === state.team ? "selected" : ""}>${escapeFeatureHtml(item.name)}</option>`).join("")}</select></label><label>${escapeFeatureHtml(t("achievements.role", "Role"))}<select data-achievement-role>${roles.map(item => `<option value="${escapeFeatureHtml(item)}" ${item === state.role ? "selected" : ""}>${escapeFeatureHtml(item)}</option>`).join("")}</select></label><label>${escapeFeatureHtml(t("achievements.date", "Date"))}<select data-achievement-date>${state.dates.map(item => `<option value="${escapeFeatureHtml(item)}" ${item === state.selectedDate ? "selected" : ""}>${escapeFeatureHtml(item)}</option>`).join("")}</select></label></div><div class="feature-grid achievement-grid"><article class="panel markdown"><h3>CHANGELOG</h3>${state.changelog ? markdown(state.changelog) : `<p class="empty">${escapeFeatureHtml(t("achievements.no_changelog", "No CHANGELOG found"))}</p>`}</article><article class="panel"><h3>${escapeFeatureHtml(t("achievements.records", "Records"))}</h3>${state.records.length ? `<div class="record-tabs">${state.records.map(record => `<button data-record="${escapeFeatureHtml(record.name)}" class="${record.name === active?.name ? "selected" : ""}">${escapeFeatureHtml(record.name)}</button>`).join("")}</div><div class="record-content">${active?.name.endsWith(".md") ? markdown(active.content) : `<pre>${escapeFeatureHtml(active?.content)}</pre>`}</div>` : `<p class="empty">${escapeFeatureHtml(t("achievements.no_records", "No records found"))}</p>`}</article></div></section>`;
}
export function bindAchievements(root: ParentNode, state: AchievementState, api: ApiClient, t: Translator, update: (state: AchievementState) => void, fail: (error: unknown) => void): void {
  const reload = () => loadAchievements(api, state.project, state.team, state.role, state.selectedDate, state.projects).then(update).catch(fail);
  root.querySelector<HTMLButtonElement>("[data-feature-action=achievement-reload]")?.addEventListener("click", reload);
  root.querySelector<HTMLSelectElement>("[data-achievement-project]")?.addEventListener("change", event => { state.project = (event.currentTarget as HTMLSelectElement).value; state.team = ""; state.role = "admin"; state.selectedDate = ""; loadAchievements(api, state.project, "", "admin", "", state.projects).then(update).catch(fail); });
  root.querySelector<HTMLSelectElement>("[data-achievement-team]")?.addEventListener("change", event => { state.team = (event.currentTarget as HTMLSelectElement).value; state.role = "admin"; state.selectedDate = ""; reload(); });
  root.querySelector<HTMLSelectElement>("[data-achievement-role]")?.addEventListener("change", event => { state.role = (event.currentTarget as HTMLSelectElement).value; state.selectedDate = ""; reload(); });
  root.querySelector<HTMLSelectElement>("[data-achievement-date]")?.addEventListener("change", event => { state.selectedDate = (event.currentTarget as HTMLSelectElement).value; reload(); });
  root.querySelectorAll<HTMLButtonElement>("[data-record]").forEach(button => button.addEventListener("click", () => { state.activeRecord = button.dataset.record; update(state); }));
}

// ---- Plugins -------------------------------------------------------------

export interface PluginSchemaProperty { title?: string; description?: string; type?: string; enum?: unknown[]; default?: unknown; format?: string; writeOnly?: boolean; }
export interface PluginConfigSchema { properties?: Record<string, PluginSchemaProperty>; required?: string[]; [key: string]: unknown; }
export interface PluginManifest extends Omit<ChannelPluginDescriptor, "channelConfigs"> { configSchema?: PluginConfigSchema; channelConfigs: Record<string, { schema?: PluginConfigSchema; uiHints?: Record<string, { label?: string; placeholder?: string; help?: string; sensitive?: boolean }>; label?: string; description?: string }>; }
export interface PluginState { plugins: PluginManifest[]; query: string; selectedPlugin?: string; }
export async function loadPlugins(api: ApiClient, query = ""): Promise<PluginState> { return { plugins: await api.get<PluginManifest[]>("/api/plugins"), query }; }
const bundled = (plugin: PluginManifest) => plugin.bundled === true || plugin.id === "openclaw-slack" || plugin.id === "openclaw-discord";
export function renderPlugins(state: PluginState, t: Translator): string {
  const filtered = state.plugins.filter(plugin => `${plugin.id} ${plugin.name ?? ""} ${plugin.description ?? ""}`.toLowerCase().includes(state.query.toLowerCase()));
  const selected = state.plugins.find(plugin => plugin.id === state.selectedPlugin);
  const schema = selected?.configSchema ? JSON.stringify(selected.configSchema, null, 2) : "";
  return `<section class="content desktop-feature plugins-feature"><div class="section-heading"><div><span class="eyebrow">EXTENSIONS</span><h2>${escapeFeatureHtml(t("plugins.title", "Plugin management"))}</h2></div><button data-feature-action="plugins-reload">${escapeFeatureHtml(t("refresh", "Refresh"))}</button></div><div class="stats"><article><small>${escapeFeatureHtml(t("plugins.installed", "Installed plugins"))}</small><strong>${state.plugins.length}</strong></article><article><small>${escapeFeatureHtml(t("plugins.system_status", "System status"))}</small><strong>${escapeFeatureHtml(t("plugins.status_healthy", "Healthy"))}</strong></article></div><form class="panel inline-form" data-plugin-install><input name="packageName" required placeholder="${escapeFeatureHtml(t("plugins.install_placeholder", "npm package name"))}"><button class="primary">${escapeFeatureHtml(t("plugins.install", "Install plugin"))}</button></form><input class="feature-search" data-plugin-search value="${escapeFeatureHtml(state.query)}" placeholder="${escapeFeatureHtml(t("plugins.search_placeholder", "Search plugins"))}"><div class="cards">${filtered.map(plugin => `<article class="panel"><div><span class="tag">${escapeFeatureHtml(bundled(plugin) ? t("plugins.bundled_tag", "Bundled") : t("plugins.npm_tag", "NPM"))}</span><h3>${escapeFeatureHtml(plugin.name ?? plugin.id)}</h3><p>${escapeFeatureHtml(plugin.description ?? t("plugins.no_description", "No description"))}</p></div><footer><small>v${escapeFeatureHtml(plugin.version ?? "—")}</small><button data-plugin-details="${escapeFeatureHtml(plugin.id)}">${escapeFeatureHtml(t("plugins.details", "Details"))}</button></footer></article>`).join("") || `<p class="empty">${escapeFeatureHtml(t("plugins.no_plugins", "No plugins installed"))}</p>`}</div>${selected ? `<div class="feature-dialog-backdrop" data-plugin-dialog-close><section class="panel feature-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-detail-title" data-plugin-dialog><header><div><span class="tag">${escapeFeatureHtml(bundled(selected) ? t("plugins.bundled_tag", "Bundled") : t("plugins.npm_tag", "NPM"))}</span><h3 id="plugin-detail-title">${escapeFeatureHtml(selected.name ?? selected.id)}</h3></div><button aria-label="${escapeFeatureHtml(t("close", "Close"))}" data-plugin-dialog-close>×</button></header><p>${escapeFeatureHtml(selected.description ?? t("plugins.no_description", "No description"))}</p><dl class="plugin-meta"><div><dt>${escapeFeatureHtml(t("plugins.meta_id", "ID"))}</dt><dd><code>${escapeFeatureHtml(selected.id)}</code></dd></div><div><dt>${escapeFeatureHtml(t("plugins.meta_version", "Version"))}</dt><dd>v${escapeFeatureHtml(selected.version ?? "—")}</dd></div></dl>${schema ? `<h4>${escapeFeatureHtml(t("plugins.schema", "Configuration schema"))}</h4><pre class="plugin-schema">${escapeFeatureHtml(schema)}</pre>` : ""}<footer>${bundled(selected) ? `<small>${escapeFeatureHtml(t("plugins.bundled_protected", "Bundled plugins cannot be uninstalled."))}</small>` : `<button class="danger" data-plugin-uninstall="${escapeFeatureHtml(selected.id)}">${escapeFeatureHtml(t("plugins.uninstall", "Uninstall"))}</button>`}</footer></section></div>` : ""}</section>`;
}
export function bindPlugins(root: ParentNode, state: PluginState, api: ApiClient, t: Translator, update: (state: PluginState) => void, fail: (error: unknown) => void): void {
  const reload = () => loadPlugins(api, state.query).then(update).catch(fail);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  root.querySelector<HTMLButtonElement>("[data-feature-action=plugins-reload]")?.addEventListener("click", reload);
  root.querySelector<HTMLFormElement>("[data-plugin-install]")?.addEventListener("submit", event => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const packageName = String(new FormData(form).get("packageName") ?? "").trim(); if (packageName && confirm(`Install and run ${packageName}? Channel plugins execute code in the OAT Desktop main process. Only continue if you trust the publisher and version.`)) api.send("/api/plugins/install", "POST", { packageName, trusted: true }).then(reload).catch(fail); });
  root.querySelector<HTMLInputElement>("[data-plugin-search]")?.addEventListener("input", event => {
    state.query = (event.currentTarget as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => update(state), 300);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-plugin-details]").forEach(button => button.addEventListener("click", () => { state.selectedPlugin = button.dataset.pluginDetails; update(state); }));
  root.querySelectorAll<HTMLElement>("[data-plugin-dialog-close]").forEach(element => element.addEventListener("click", event => { if (event.target === element || element instanceof HTMLButtonElement) { state.selectedPlugin = undefined; update(state); } }));
  root.querySelectorAll<HTMLButtonElement>("[data-plugin-uninstall]").forEach(button => button.addEventListener("click", () => { const pluginId = button.dataset.pluginUninstall; const plugin = state.plugins.find(item => item.id === pluginId); if (pluginId && plugin && !bundled(plugin) && confirm(`${t("plugins.uninstall", "Uninstall")} ${pluginId}?`)) api.send("/api/plugins/uninstall", "POST", { pluginId }).then(() => { state.selectedPlugin = undefined; reload(); }).catch(fail); }));
}

// ---- Channels ------------------------------------------------------------

export interface GlobalConfig { channels?: Record<string, { accounts?: Record<string, Record<string, unknown>> }> }
export interface ChannelProject { name: string; projectName?: string | null; alive?: boolean; agents?: Array<{ id: string; role: string; label: string; status: string }> }
export interface ChannelState { plugins: PluginManifest[]; bindings: ChannelProjectBinding[]; projects: ChannelProject[]; targets: ChannelAgentTarget[]; statuses: ChannelAccountStatus[]; selectedPlugin?: string; selectedChannel?: string; qr?: { image: string; sessionKey: string; accountId: string; allowFrom: string[]; status: "wait" | "scanned" | "confirmed" | "expired" }; }
interface ChannelLifecycle {
  generation: number;
  starting?: boolean;
  poller?: { sessionKey: string; stopped: boolean; timer?: ReturnType<typeof setTimeout>; stop(): void };
}
const channelLifecycles = new WeakMap<ChannelState, ChannelLifecycle>();
export async function loadChannels(api: ApiClient): Promise<ChannelState> {
  const [plugins, bindings, projects, targets, statuses] = await Promise.all([
    api.get<PluginManifest[]>("/api/channel-plugins"),
    api.get<ChannelProjectBinding[]>("/api/channel-bindings"),
    api.get<ChannelProject[]>("/api/projects"),
    api.get<ChannelAgentTarget[]>("/api/channel-agent-targets"),
    api.get<ChannelAccountStatus[]>("/api/channel-status"),
  ]);
  return { plugins, bindings, projects, targets, statuses, selectedPlugin: plugins[0]?.id, selectedChannel: plugins[0]?.channels[0] };
}
const isWeixin = (channelId: string) => channelId === "weixin" || channelId.endsWith("weixin");
function allChannelAccounts(state: ChannelState): Array<{ plugin: PluginManifest; channelId: string; account: string }> {
  return state.plugins.flatMap(plugin => plugin.channels.flatMap(channelId => [...new Set(plugin.accounts ?? [])].map(account => ({ plugin, channelId, account }))));
}
function schemaDefault(prop: PluginSchemaProperty): string { return typeof prop.default === "string" || typeof prop.default === "number" ? String(prop.default) : ""; }
const allowFromField = () => `<label>Allowed sender IDs<textarea name="allowFrom" required placeholder='["user-id"]'>[]</textarea><small>Inbound messages are accepted only from these channel-scoped sender IDs. Use ["*"] only for an intentionally public account.</small></label>`;
function schemaFields(plugin: PluginManifest | undefined, channelId: string): string {
  const config = plugin?.channelConfigs[channelId];
  const properties = Object.entries(config?.schema?.properties ?? {});
  if (!properties.length && config?.schema) return `<label>Channel configuration JSON<textarea name="__rawConfig" required placeholder="{}">{}</textarea></label>`;
  const fields = properties.map(([name, prop]) => {
    const hint = config?.uiHints?.[name];
    const required = config?.schema?.required?.includes(name) ? "required" : "";
    const label = escapeFeatureHtml(hint?.label ?? prop.title ?? name);
    const description = escapeFeatureHtml(prop.description ?? "");
    if (Array.isArray(prop.enum)) return `<label>${label}<select name="${escapeFeatureHtml(name)}" ${required} title="${description}">${prop.enum.map(value => { const option = String(value); return `<option value="${escapeFeatureHtml(option)}" ${option === schemaDefault(prop) ? "selected" : ""}>${escapeFeatureHtml(option)}</option>`; }).join("")}</select></label>`;
    if (prop.type === "boolean") return `<label class="checkbox-field"><input name="${escapeFeatureHtml(name)}" type="checkbox" ${prop.default === true ? "checked" : ""}>${label}</label>`;
    if (prop.type === "object" || prop.type === "array") return `<label>${label}<textarea name="${escapeFeatureHtml(name)}" data-json-channel-field="${escapeFeatureHtml(prop.type)}" ${required} placeholder="${description}">${escapeFeatureHtml(prop.default === undefined ? prop.type === "array" ? "[]" : "{}" : JSON.stringify(prop.default, null, 2))}</textarea></label>`;
    const inputType = hint?.sensitive || prop.writeOnly ? "password" : prop.type === "number" || prop.type === "integer" ? "number" : "text";
    return `<label>${label}<input name="${escapeFeatureHtml(name)}" type="${inputType}" value="${escapeFeatureHtml(schemaDefault(prop))}" ${required} placeholder="${escapeFeatureHtml(hint?.placeholder ?? prop.description ?? "")}"></label>`;
  }).join("");
  return `${fields}${properties.some(([name]) => name === "allowFrom") ? "" : allowFromField()}`;
}
export function renderChannels(state: ChannelState, t: Translator): string {
  const accounts = allChannelAccounts(state);
  const selected = state.plugins.find(plugin => plugin.id === state.selectedPlugin) ?? state.plugins[0];
  const selectedChannel = selected?.channels.includes(state.selectedChannel ?? "") ? state.selectedChannel! : selected?.channels[0] ?? "";
  const projectAdmins = state.targets.filter(target => target.target === ChannelBindingTargetEnum.ProjectAdmin);
  const targetOptions = (binding?: ChannelProjectBinding) => {
    const legacy = binding?.target === ChannelBindingTargetEnum.TeamAdmin ? `<option selected disabled>${escapeFeatureHtml(t("channels.legacy_team_binding", "Legacy Team binding — choose a Project Admin to migrate"))}</option>` : "";
    const resource = `<option value="${ChannelBindingTargetEnum.ResourceSupervisor}" ${!binding || binding.target === ChannelBindingTargetEnum.ResourceSupervisor ? "selected" : ""}>${escapeFeatureHtml(t("channels.resource_supervisor", "Agent Resource Supervisor (default)"))}</option>`;
    const admins = projectAdmins.map(target => { const value = `agent:${JSON.stringify([target.target, target.projectName, target.agentId])}`; const selected = binding?.projectName === target.projectName && binding.targetAgentId === target.agentId; return `<option value="${escapeFeatureHtml(value)}" ${selected ? "selected" : ""}>${escapeFeatureHtml(`${target.projectLabel} / ${target.label}${target.online ? "" : " (offline)"}`)}</option>`; }).join("");
    return `${legacy}${resource}${admins}`;
  };
  return `<section class="content desktop-feature channels-feature"><div class="section-heading"><div><span class="eyebrow">CHANNEL CONNECTIONS</span><h2>${escapeFeatureHtml(t("channels.title", "Channels"))}</h2><p class="feature-help">${escapeFeatureHtml(t("channels.default_route", "Unassigned accounts route to the Agent Resource Supervisor."))}</p></div><button data-feature-action="channels-reload">${escapeFeatureHtml(t("refresh", "Refresh"))}</button></div><div class="feature-grid"><article class="panel"><h3>${escapeFeatureHtml(t("channels.configured_card_title", "Configured accounts"))}</h3><div class="table-wrap"><table><thead><tr><th>${escapeFeatureHtml(t("channels.col_plugin", "Channel"))}</th><th>${escapeFeatureHtml(t("channels.col_account", "Account"))}</th><th>${escapeFeatureHtml(t("channels.connection", "Connection"))}</th><th>${escapeFeatureHtml(t("channels.col_status", "Assigned agent"))}</th><th></th></tr></thead><tbody>${accounts.map(({ plugin, channelId, account }) => { const binding = state.bindings.find(item => item.channelId === channelId && item.accountId === account && item.enabled); const status = state.statuses.find(item => item.channelId === channelId && item.accountId === account); const stateValue = status?.status ?? ChannelConnectionStatusEnum.NotConfigured; return `<tr><td>${escapeFeatureHtml(plugin.channelConfigs[channelId]?.label ?? plugin.name ?? channelId)}</td><td><code>${escapeFeatureHtml(account)}</code></td><td><span class="tag channel-status-${escapeFeatureHtml(stateValue)}" title="${escapeFeatureHtml(status?.error ?? "")}">${escapeFeatureHtml(t(`channels.status_${stateValue}`, stateValue))}</span></td><td><select data-channel-binding="${escapeFeatureHtml(JSON.stringify([channelId, account]))}">${targetOptions(binding)}</select></td><td><button data-channel-remove="${escapeFeatureHtml(JSON.stringify([channelId, account]))}">${escapeFeatureHtml(t("delete", "Remove"))}</button></td></tr>`; }).join("") || `<tr><td colspan="5" class="empty">${escapeFeatureHtml(t("channels.no_accounts", "No accounts"))}</td></tr>`}</tbody></table></div></article><article class="panel"><h3>${escapeFeatureHtml(t("plugins.add_account", "Add account"))}</h3><form data-channel-add class="form-grid"><label>${escapeFeatureHtml(t("channels.select_plugin", "Plugin"))}<select name="pluginId" data-channel-plugin>${state.plugins.map(plugin => `<option value="${escapeFeatureHtml(plugin.id)}" ${plugin.id === selected?.id ? "selected" : ""}>${escapeFeatureHtml(plugin.name ?? plugin.id)}</option>`).join("")}</select></label><label>${escapeFeatureHtml(t("channels.channel", "Channel"))}<select name="channelId" data-channel-id>${(selected?.channels ?? []).map(channelId => `<option value="${escapeFeatureHtml(channelId)}">${escapeFeatureHtml(selected?.channelConfigs[channelId]?.label ?? channelId)}</option>`).join("")}</select></label><label>${escapeFeatureHtml(t("channels.account_id", "Account ID"))}<input name="accountId" required value="default"></label>${isWeixin(selectedChannel) ? `${allowFromField()}<button type="button" class="primary" data-wechat-start>${escapeFeatureHtml(t("channels.wechat_scan", "Scan QR to login"))}</button>` : `${schemaFields(selected, selectedChannel)}<button class="primary">${escapeFeatureHtml(t("save", "Save account"))}</button>`}</form>${state.qr ? `<div class="qr-login"><img src="${escapeFeatureHtml(state.qr.image)}" alt="WeChat login QR code"><p>${escapeFeatureHtml(t(`channels.wechat_${state.qr.status}`, state.qr.status))}</p></div>` : ""}</article></div></section>`;
}
function normalizeQrImage(value: string): string {
  // A channel is allowed to return an inline QR image, raw base64, or HTTPS.
  // Do not inject arbitrary URL schemes into Electron's renderer.
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) return value;
  if (/^[A-Za-z0-9+/=]{100,}$/.test(value)) return `data:image/png;base64,${value}`;
  if (/^https:\/\//i.test(value)) return value;
  throw new Error("The local WeChat plugin returned an unsafe QR image URL.");
}
export function bindChannels(root: ParentNode, state: ChannelState, controlApi: ApiClient, channelApi: ApiClient, t: Translator, update: (state: ChannelState) => void, fail: (error: unknown) => void): () => void {
  const lifecycle = channelLifecycles.get(state) ?? { generation: 0 };
  channelLifecycles.set(state, lifecycle);
  const stopPoller = () => {
    lifecycle.poller?.stop();
    lifecycle.poller = undefined;
  };
  const cancelLogin = async (clearQr = true): Promise<void> => {
    lifecycle.generation++;
    stopPoller();
    const pending = state.qr && state.qr.status !== "confirmed" && state.qr.status !== "expired";
    if (clearQr) state.qr = undefined;
    if (pending) await channelApi.send("/api/channels/weixin/login-cancel", "POST", {}).catch(() => undefined);
  };
  const reload = async () => {
    await cancelLogin();
    try { update(await loadChannels(controlApi)); }
    catch (error) { fail(error); }
  };
  const ensurePolling = (sessionKey: string, generation = lifecycle.generation): void => {
    const existing = lifecycle.poller;
    if (existing && !existing.stopped && existing.sessionKey === sessionKey) return;
    stopPoller();
    const poller = {
      sessionKey,
      stopped: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; },
    };
    lifecycle.poller = poller;
    const schedule = (delay: number, action: () => void) => {
      if (poller.stopped || lifecycle.generation !== generation) return;
      poller.timer = setTimeout(() => { poller.timer = undefined; if (!poller.stopped && lifecycle.generation === generation) action(); }, delay);
    };
    const poll = async (): Promise<void> => {
      if (poller.stopped || lifecycle.generation !== generation || state.qr?.sessionKey !== sessionKey) return;
      try {
        const result = await channelApi.send<{ status?: string; connected?: boolean }>("/api/channels/weixin/login-wait", "POST", { sessionKey, accountId: state.qr.accountId, allowFrom: state.qr.allowFrom });
        if (poller.stopped || lifecycle.generation !== generation || state.qr?.sessionKey !== sessionKey) return;
        const confirmed = result.connected || ["confirmed", "confirmed_redirect", "binded_redirect"].includes(result.status ?? "");
        state.qr.status = confirmed ? "confirmed" : result.status === "scanned" || result.status === "expired" ? result.status : "wait";
        update(state);
        if (state.qr.status === "confirmed") schedule(300, reload);
        else if (state.qr.status !== "expired") schedule(0, () => void poll());
      } catch {
        schedule(3000, () => void poll());
      }
    };
    void poll();
  };
  const startQr = async () => {
    if (lifecycle.starting) return;
    lifecycle.starting = true;
    const hadPendingLogin = Boolean(state.qr && state.qr.status !== "confirmed" && state.qr.status !== "expired");
    lifecycle.generation++;
    const generation = lifecycle.generation;
    stopPoller();
    if (hadPendingLogin) await channelApi.send("/api/channels/weixin/login-cancel", "POST", {}).catch(() => undefined);
    if (lifecycle.generation !== generation) { lifecycle.starting = false; return; }
    try {
      const accountId = root.querySelector<HTMLInputElement>("[data-channel-add] [name=accountId]")?.value.trim() || "default";
      const allowFrom = JSON.parse(root.querySelector<HTMLTextAreaElement>("[data-channel-add] [name=allowFrom]")?.value || "[]") as string[];
      if (!Array.isArray(allowFrom) || !allowFrom.every(value => typeof value === "string") || !allowFrom.length) throw new Error("At least one allowed sender ID is required.");
      const result = await channelApi.send<{ qrcodeUrl?: string; qrDataUrl?: string; sessionKey?: string }>("/api/channels/weixin/login-start", "POST", { accountId, allowFrom });
      if (lifecycle.generation !== generation) { await channelApi.send("/api/channels/weixin/login-cancel", "POST", {}).catch(() => undefined); return; }
      const image = result.qrcodeUrl ?? result.qrDataUrl;
      if (!image || !result.sessionKey) throw new Error("The local WeChat plugin did not return a QR login session.");
      state.qr = { image: normalizeQrImage(image), sessionKey: result.sessionKey, accountId, allowFrom, status: "wait" };
      ensurePolling(result.sessionKey, generation);
      update(state);
    } catch (error) {
      if (lifecycle.generation === generation) {
        lifecycle.generation++;
        stopPoller();
        state.qr = undefined;
        await channelApi.send("/api/channels/weixin/login-cancel", "POST", {}).catch(() => undefined);
        fail(error);
      }
    } finally { lifecycle.starting = false; }
  };
  root.querySelector<HTMLButtonElement>("[data-feature-action=channels-reload]")?.addEventListener("click", () => { void reload(); });
  root.querySelector<HTMLSelectElement>("[data-channel-plugin]")?.addEventListener("change", event => { state.selectedPlugin = (event.currentTarget as HTMLSelectElement).value; state.selectedChannel = state.plugins.find(item => item.id === state.selectedPlugin)?.channels[0]; void cancelLogin().then(() => update(state)); });
  root.querySelector<HTMLSelectElement>("[data-channel-id]")?.addEventListener("change", event => { state.selectedChannel = (event.currentTarget as HTMLSelectElement).value; void cancelLogin().then(() => update(state)); });
  root.querySelectorAll<HTMLButtonElement>("[data-wechat-start]").forEach(button => button.addEventListener("click", startQr));
  root.querySelector<HTMLFormElement>("[data-channel-add]")?.addEventListener("submit", event => {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const pluginId = String(form.get("pluginId"));
      const channelId = String(form.get("channelId"));
      const accountId = String(form.get("accountId")).trim();
      const plugin = state.plugins.find(item => item.id === pluginId);
      if (!plugin || !channelId || !accountId || isWeixin(channelId)) return;
      const credentials: Record<string, unknown> = {};
      const rawConfig = form.get("__rawConfig");
      if (typeof rawConfig === "string" && rawConfig.trim()) Object.assign(credentials, JSON.parse(rawConfig));
      for (const [key, schema] of Object.entries(plugin.channelConfigs[channelId]?.schema?.properties ?? {})) {
        if (schema.type === "boolean") credentials[key] = Array.isArray(schema.enum) ? String(form.get(key)) === "true" : form.has(key);
        else if (schema.type === "object" || schema.type === "array") {
          const value = String(form.get(key) ?? "").trim();
          if (value) credentials[key] = JSON.parse(value);
        }
        else if (schema.type === "number" || schema.type === "integer") {
          const value = form.get(key);
          if (value !== null && String(value).trim() !== "") credentials[key] = Number(value);
        } else {
          const value = form.get(key);
          if (value !== null) credentials[key] = value;
        }
      }
      if (!("allowFrom" in credentials)) {
        const allowFrom = JSON.parse(String(form.get("allowFrom") ?? "[]"));
        if (!Array.isArray(allowFrom) || !allowFrom.every(value => typeof value === "string") || !allowFrom.length) throw new Error("At least one allowed sender ID is required.");
        credentials.allowFrom = allowFrom;
      }
      controlApi.send("/api/channels/accounts", "POST", { channelId, accountId, config: credentials }).then(reload).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
  root.querySelectorAll<HTMLSelectElement>("[data-channel-binding]").forEach(select => select.addEventListener("change", () => {
    const [channelId, accountId] = JSON.parse(select.dataset.channelBinding ?? "[]") as string[];
    const bindings = state.bindings.filter(item => item.channelId !== channelId || item.accountId !== accountId);
    if (select.value.startsWith("agent:")) {
      const [target, projectName, targetAgentId] = JSON.parse(select.value.slice("agent:".length)) as [ChannelBindingTargetEnum, string, string];
      bindings.push({ id: crypto.randomUUID(), channelId, accountId, target, projectName, targetAgentId, enabled: true });
    }
    controlApi.send("/api/channel-bindings", "PUT", { bindings }).then(reload).catch(fail);
  }));
  const removeAccount = async (channelId: string, account: string) => {
    await controlApi.send(`/api/channels/${id(channelId)}/accounts/${id(account)}`, "DELETE");
    await reload();
  };
  root.querySelectorAll<HTMLButtonElement>("[data-channel-remove]").forEach(button => button.addEventListener("click", () => { const [channelId, account] = JSON.parse(button.dataset.channelRemove ?? "[]") as string[]; if (channelId && account && confirm(`${t("delete", "Remove")} ${account}?`)) removeAccount(channelId, account).catch(fail); }));
  if (state.qr && state.qr.status !== "confirmed" && state.qr.status !== "expired") ensurePolling(state.qr.sessionKey);
  return () => { void cancelLogin(false); };
}
