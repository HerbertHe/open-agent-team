import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from './i18n';
import './management-features.css';
import {
  bindAchievements,
  bindChannels,
  bindPlugins,
  bindUsage,
  createControlPlaneApi,
  createOrchestratorApi,
  loadAchievements,
  loadChannels,
  loadPlugins,
  loadUsage,
  renderAchievements,
  renderChannels,
  renderPlugins,
  renderUsage,
  type AchievementState,
  type ChannelState,
  type PluginState,
  type UsageState,
} from './native-features';
import {
  bindAgentResources,
  bindManagement,
  ManagementApi,
  renderAgentResources,
  renderManagement,
  renderSettings,
  type ManagementState,
  type Request,
} from './features/management';
import { createOperationsFeature, type OperationsFeature } from './operations';

type FeatureKind = 'usage' | 'achievements' | 'plugins' | 'channels';
type ManagementKind = 'config' | 'resources' | 'settings';

function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
function toInit(init?: RequestInit): { method?: string; headers?: Record<string, string>; body?: string } | undefined {
  if (!init) return undefined;
  return { method: init.method, headers: init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined, body: typeof init.body === 'string' ? init.body : undefined };
}

function Notice({ value, error }: { value?: string; error?: string }) {
  if (!value && !error) return null;
  return <p className={`feature-host-notice ${error ? 'error' : ''}`}>{error ?? value}</p>;
}

function renderOperationsMarkup(root: HTMLElement, markup: string, preserveTopology: boolean): void {
  if (!preserveTopology) { root.innerHTML = markup; return; }
  const template = document.createElement('template');
  template.innerHTML = markup;
  const currentHost = root.querySelector<HTMLElement>('[data-op-topology-host]');
  const nextHost = template.content.querySelector<HTMLElement>('[data-op-topology-host]');
  if (currentHost && nextHost && currentHost.dataset.topologyKey === nextHost.dataset.topologyKey) {
    const currentNodes = new Map([...currentHost.querySelectorAll<SVGGElement>('[data-op-node-id]')].map((node) => [node.dataset.opNodeId, node]));
    nextHost.querySelectorAll<SVGGElement>('[data-op-node-id]').forEach((nextNode) => {
      const currentNode = currentNodes.get(nextNode.dataset.opNodeId);
      if (!currentNode) return;
      const currentRect = currentNode.querySelector('rect'); const nextRect = nextNode.querySelector('rect');
      if (currentRect && nextRect) {
        currentRect.setAttribute('fill', nextRect.getAttribute('fill') ?? '');
        currentRect.setAttribute('stroke', nextRect.getAttribute('stroke') ?? '');
      }
      for (const selector of ['.op-node-meta', '.op-node-port', '.op-node-preview']) {
        const currentText = currentNode.querySelector(selector); const nextText = nextNode.querySelector(selector);
        if (currentText && nextText) currentText.textContent = nextText.textContent;
      }
    });
    nextHost.replaceWith(currentHost);
  }
  root.replaceChildren(template.content);
}

export function OperationsWorkspace({ kind, project, onBack, onProjectsChanged }: { kind: 'tasks' | 'monitor'; project?: Project; onBack(): void; onProjectsChanged(): Promise<void> }) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const feature = useRef<OperationsFeature | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<{ value?: string; error?: string }>({});
  const rerender = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const current = createOperationsFeature({
      api: <T,>(path: string, init?: RequestInit) => {
        if (!project?.name) return Promise.reject(new Error(t('error.startProject')));
        return window.oatDesktop.requestOrchestrator({ projectName: project.name, path, init: toInit(init) }) as Promise<T>;
      },
      notify: (message, error) => setNotice(error ? { error: message } : { value: message }),
      rerender,
      subscribeObservability: (name) => window.oatDesktop.subscribeObservability(name),
      unsubscribeObservability: () => window.oatDesktop.unsubscribeObservability(),
      onObservabilityEvent: (listener) => window.oatDesktop.onObservabilityEvent(listener),
      onObservabilityStatus: (listener) => window.oatDesktop.onObservabilityStatus(listener),
      tr: t,
    });
    feature.current = current;
    current.setProject(project);
    current.setLive(kind === 'monitor');
    void current.refresh().finally(rerender);
    return () => { current.dispose(); if (feature.current === current) feature.current = undefined; };
  }, [kind, onProjectsChanged, project?.name, project?.port, project?.pid, project?.alive, rerender, t]);

  useLayoutEffect(() => {
    const current = feature.current;
    if (!root.current || !current) return;
    renderOperationsMarkup(root.current, kind === 'tasks' ? current.renderTasks() : current.renderMonitor(), kind === 'monitor');
    current.bind(root.current);
  }, [kind, version]);

  return <section className={`native-feature-workspace ${kind === 'tasks' ? 'operations-task-workspace' : ''}`}><button onClick={onBack} className="feature-back">← {t('workspace.back')}</button><Notice {...notice} /><div ref={root} className={kind === 'tasks' ? 'operations-task-host' : undefined} /></section>;
}

export function NativeFeatureWorkspace({ kind, project, projects, onBack }: { kind: FeatureKind; project?: Project; projects: Project[]; onBack(): void }) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const controlApi = useMemo(() => createControlPlaneApi((path, init) => window.oatDesktop.requestControlPlane({ path, init })), []);
  const projectApi = useMemo(() => createOrchestratorApi(project, (name, path, init) => window.oatDesktop.requestOrchestrator({ projectName: name, path, init }), t('error.startProject')), [project, t]);
  const [state, setState] = useState<UsageState | AchievementState | PluginState | ChannelState>();
  const [error, setError] = useState<string>();
  const update = useCallback((next: UsageState | AchievementState | PluginState | ChannelState) => { setState(structuredClone(next)); setError(undefined); }, []);
  const fail = useCallback((reason: unknown) => setError(errorText(reason)), []);

  const load = useCallback(async () => {
    if ((kind === 'achievements' || kind === 'channels') && !project?.name) throw new Error(t('error.startProject'));
    if (kind === 'usage') return loadUsage(controlApi, 'all', '30d');
    if (kind === 'achievements') return loadAchievements(controlApi, project!.name, '', 'admin', '', projects);
    if (kind === 'plugins') return loadPlugins(controlApi);
    return loadChannels(controlApi, project!.name);
  }, [controlApi, kind, project, projects, t]);

  useEffect(() => { setState(undefined); setError(undefined); void load().then(update).catch(fail); }, [fail, load, update]);
  useLayoutEffect(() => {
    if (!root.current || !state) return;
    const translator = (key: string, fallback?: string) => { const translated = t(key); return translated === key && fallback ? fallback : translated; };
    if (kind === 'usage') { root.current.innerHTML = renderUsage(state as UsageState, translator); bindUsage(root.current, state as UsageState, controlApi, translator, update, fail); return; }
    if (kind === 'achievements') { root.current.innerHTML = renderAchievements(state as AchievementState, translator); bindAchievements(root.current, state as AchievementState, controlApi, translator, update, fail); return; }
    if (kind === 'plugins') { root.current.innerHTML = renderPlugins(state as PluginState, translator); bindPlugins(root.current, state as PluginState, controlApi, translator, update, fail); return; }
    root.current.innerHTML = renderChannels(state as ChannelState, translator);
    return bindChannels(root.current, state as ChannelState, controlApi, projectApi, translator, update, fail);
  }, [controlApi, fail, kind, projectApi, state, t, update]);

  return <section className="native-feature-workspace"><button onClick={onBack} className="feature-back">← {t('workspace.back')}</button><Notice error={error} /><div ref={root}>{!state && !error ? t('loading') : null}</div></section>;
}

export function ManagementWorkspace({ kind, project, projects, selectedTeam, onBack, onProjectsChanged }: { kind: ManagementKind; project?: Project; projects: Project[]; selectedTeam?: string; onBack(): void; onProjectsChanged(): Promise<void> }) {
  const { t, language, setLanguage, theme, setTheme } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ManagementState>({ projects, selectedProject: project?.name, selectedTeam });
  const [notice, setNotice] = useState<{ value?: string; error?: string }>({});
  const request = useCallback<Request>((path, init) => window.oatDesktop.requestControlPlane({ path, init: toInit(init) }) as Promise<never>, []);
  const api = useMemo(() => new ManagementApi(request, (input) => window.oatDesktop.listProviderModels(input)), [request]);
  const selectedProject = project?.name;
  const reload = useCallback(async () => {
    const nextProjects = await api.projects();
    const active = selectedProject && nextProjects.some((item) => item.name === selectedProject) ? selectedProject : undefined;
    const [teamConfig, globalConfig, globalModels] = await Promise.all([active ? api.teamConfig(active) : Promise.resolve({}), api.globalConfig(), api.globalModels()]);
    setState({ projects: nextProjects, selectedProject: active, selectedTeam, teamConfig, globalConfig, globalModels });
  }, [api, selectedProject, selectedTeam]);

  useEffect(() => { setState((current) => ({ ...current, projects, selectedProject, selectedTeam })); void reload().catch((reason) => setNotice({ error: errorText(reason) })); }, [projects, reload, selectedProject, selectedTeam]);
  useLayoutEffect(() => {
    if (!root.current) return;
    if (kind === 'resources') {
      root.current.innerHTML = renderAgentResources(state.projects, state.selectedProject, state.globalModels, t);
      bindAgentResources(root.current, api, (message, error) => setNotice(error ? { error: message } : { value: message }), async () => { await reload(); await onProjectsChanged(); }, t);
      return;
    }
    root.current.innerHTML = kind === 'settings' ? renderSettings(state, t) : renderManagement(state, t);
    bindManagement(root.current, state, api, async () => { await reload(); await onProjectsChanged(); }, (message, error) => setNotice(error ? { error: message } : { value: message }), t);
  }, [api, kind, onProjectsChanged, reload, state]);

  return <section className="native-feature-workspace"><button onClick={onBack} className="feature-back">← {t('workspace.back')}</button><Notice {...notice} />{kind === 'settings' && <section className="panel desktop-preferences"><h3>{t('settings.general')}</h3><div className="form-grid"><label>{t('app.language')}<select value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}><option value="zh-CN">简体中文</option><option value="en">English</option><option value="fr">Français</option><option value="ja">日本語</option></select></label><label>{t('app.theme')}<select value={theme} onChange={(event) => setTheme(event.target.value as typeof theme)}><option value="system">{t('theme.system')}</option><option value="light">{t('theme.light')}</option><option value="dark">{t('theme.dark')}</option></select></label></div></section>}<div ref={root} /></section>;
}
