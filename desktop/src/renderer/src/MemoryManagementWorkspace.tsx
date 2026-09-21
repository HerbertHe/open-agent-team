import { useCallback, useEffect, useMemo, useState } from 'react';
import IconBrain from '~icons/lucide/brain';
import IconRefresh from '~icons/lucide/refresh-cw';
import IconDatabase from '~icons/lucide/database';
import IconShieldCheck from '~icons/lucide/shield-check';
import IconTriangleAlert from '~icons/lucide/triangle-alert';
import IconFileText from '~icons/lucide/file-text';
import IconDownload from '~icons/lucide/download';
import { useI18n } from './i18n';

type IndexValidation = { expectedCount: number; indexedCount: number; missingIds: string[]; mismatchedIds: string[]; staleIds: string[]; pendingOutbox: number; processingOutbox: number; deadLetters: number; errors: string[] };
type CollectionStatus = {
  collectionRevision: string; embeddingRevision: string; embeddingProfile?: string; embeddingModel?: string; dimensions?: number;
  index?: string; state: string; documentCount: number; diskBytes: number; completeness: number; createdAt: string;
  migration?: { status: string; totalItems: number; pauseReason?: string; error?: string; updatedAt: string };
  validation: IndexValidation;
};
type OperationJob = { id: string; operation: string; collectionRevision: string; status: string; startedAt: string; completedAt?: string; error?: string; result?: { status?: string } };
type MemoryItem = { id: string; level: string; kind: string; content: string; summary: string; status: string; agentId: string; teamId?: string; confidence: number; trustLevel?: number; updatedAt: string; contradictionIds?: string[]; sourceEventIds?: string[]; sources?: Array<{ eventId: string; agentId?: string; role: string; eventType: string; createdAt: string }> };
type MemorySnapshot = {
  generatedAt: string; projectId: string; enabled: boolean; health: string; warnings: Array<{ code: string; message: string }>;
  configured: { backend: string; embeddingProfile?: string; embeddingState: string; embeddingReason?: string; embeddingRevision?: string; dimensions?: number; collectionRevision?: string };
  activeCollectionRevision?: string;
  overview: { counts: Record<string, number>; pendingEvents: number; retrieval?: { mode: string; effectiveBackend: string; circuitState: string; fallbackCount: number; lastFallbackReason?: string; lastSuccessAt?: string } };
  collections: CollectionStatus[];
  estimate?: { itemCount: number; embeddingRequests: number; estimatedEmbeddingTokens: number; rawVectorBytes: number; sqliteBytes: number; retainedCollectionBytes: number; estimatedNewCollectionBytes: number; temporaryOverheadBytes: number; safetyFactor: number; minimumPeakBytes: number; availableDiskBytes: number; diskSufficient: boolean };
  operation?: OperationJob;
  retrievalRuns: Array<{ id: string; agentId: string; backend: string; selectedIds: string[]; latencyMs: number; fallbackReason?: string; createdAt: string }>;
  accessAudits: Array<{ id: string; action: string; decision: string; actorId: string; actorRole: string; requestedProjectId: string; reason: string; createdAt: string }>;
};
type ProfileImpact = { profile: string; globalDefault: boolean; projects: Array<{ projectName: string; displayName?: string; source: string; backend: string; alive: boolean }> };
type MarkdownView = { projectId: string; agentId: string; generatedAt: string; files: Array<{ path: string; content: string }> };

const requestProject = <T,>(projectName: string, path: string, init?: { method?: string; body?: unknown }) => window.oatDesktop.requestOrchestrator({
  projectName, path,
  init: init ? { method: init.method, headers: { 'Content-Type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) } : undefined,
}) as Promise<T>;
const requestControl = <T,>(path: string) => window.oatDesktop.requestControlPlane({ path }) as Promise<T>;
const bytes = (value = 0) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(1)} GB`;
const time = (value?: string) => value ? new Date(value).toLocaleString() : '—';

export function MemoryManagementWorkspace({ project, projects }: { project?: Project; projects: Project[] }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(project?.name ?? projects[0]?.name ?? '');
  const activeProject = useMemo(() => projects.find((item) => item.name === selected), [projects, selected]);
  const [snapshot, setSnapshot] = useState<MemorySnapshot>();
  const [candidates, setCandidates] = useState<MemoryItem[]>([]);
  const [disputed, setDisputed] = useState<MemoryItem[]>([]);
  const [impact, setImpact] = useState<ProfileImpact>();
  const [viewAgent, setViewAgent] = useState(project?.agents[0]?.id ?? '');
  const [markdownView, setMarkdownView] = useState<MarkdownView>();
  const [viewFile, setViewFile] = useState('MEMORY.md');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [lifecycleResult, setLifecycleResult] = useState<string>();

  useEffect(() => { if (project?.name && projects.some((item) => item.name === project.name)) setSelected(project.name); }, [project?.name, projects]);
  useEffect(() => {
    const agents = activeProject?.agents ?? [];
    if (!agents.some(({ id }) => id === viewAgent)) setViewAgent(agents[0]?.id ?? '');
  }, [activeProject?.agents, viewAgent]);
  const load = useCallback(async () => {
    if (!activeProject?.alive) { setSnapshot(undefined); setCandidates([]); setDisputed([]); setImpact(undefined); return; }
    try {
      const [next, nextCandidates, nextDisputed] = await Promise.all([
        requestProject<MemorySnapshot>(activeProject.name, '/memory/operations'),
        requestProject<MemoryItem[]>(activeProject.name, '/memory?status=candidate&limit=50'),
        requestProject<MemoryItem[]>(activeProject.name, '/memory?status=disputed&limit=50'),
      ]);
      setSnapshot(next); setCandidates(nextCandidates); setDisputed(nextDisputed); setError(undefined);
      if (next.configured.embeddingProfile) {
        setImpact(await requestControl<ProfileImpact>(`/api/embedding-profile-impact?profile=${encodeURIComponent(next.configured.embeddingProfile)}`));
      } else setImpact(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [activeProject?.alive, activeProject?.name]);
  useEffect(() => {
    void load();
    if (!activeProject?.alive) return;
    const timer = window.setInterval(() => void load(), snapshot?.operation?.status === 'running' ? 2_000 : 8_000);
    return () => window.clearInterval(timer);
  }, [activeProject?.alive, load, snapshot?.operation?.status]);
  const loadMarkdownView = useCallback(async () => {
    if (!activeProject?.alive || !viewAgent) { setMarkdownView(undefined); return; }
    try {
      const next = await requestProject<MarkdownView>(activeProject.name, `/memory/views?agentId=${encodeURIComponent(viewAgent)}`);
      setMarkdownView(next);
      setViewFile((current) => next.files.some(({ path }) => path === current) ? current : next.files[0]?.path ?? 'MEMORY.md');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [activeProject?.alive, activeProject?.name, viewAgent]);
  useEffect(() => { void loadMarkdownView(); }, [loadMarkdownView]);

  const operate = async (operation: 'rebuild' | 'pause' | 'resume' | 'activate' | 'rollback', revision?: string) => {
    if (!activeProject?.alive || busy) return;
    const estimate = snapshot?.estimate;
    const detail = operation === 'rebuild' && estimate
      ? `${t('memoryOps.rebuildConfirm')}\n\n${estimate.itemCount} items · ${estimate.estimatedEmbeddingTokens} tokens · ${bytes(estimate.minimumPeakBytes)} peak · ${estimate.embeddingRequests} embedding batches`
      : `${t(`memoryOps.${operation}Confirm`)}\n\n${revision ?? ''}`;
    if (operation !== 'pause' && !window.confirm(detail)) return;
    setBusy(`${operation}:${revision ?? 'new'}`); setError(undefined);
    try {
      const path = operation === 'rebuild' ? '/memory/index/rebuild' : `/memory/index/${revision}/${operation}`;
      await requestProject(activeProject.name, path, { method: 'POST', body: operation === 'pause' ? {} : { confirm: true } });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const govern = async (item: MemoryItem, action: 'confirm' | 'forget' | 'edit-confirm') => {
    if (!activeProject?.alive || busy) return;
    let body: unknown = action === 'confirm' ? { confirmedBy: 'desktop-user' } : {};
    if (action === 'edit-confirm') {
      const text = window.prompt(t('memoryOps.editCandidatePrompt'), item.summary);
      if (!text?.trim()) return;
      body = { text: text.trim(), kind: item.kind, confirmedBy: 'desktop-user' };
    } else if (!window.confirm(t(action === 'confirm' ? 'memoryOps.confirmFactConfirm' : 'memory.forgetConfirm'))) return;
    setBusy(`${action}:${item.id}`);
    try { await requestProject(activeProject.name, `/memory/${encodeURIComponent(item.id)}/${action}`, { method: 'POST', body }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const cleanupLifecycle = async () => {
    if (!activeProject?.alive || busy || !window.confirm(t('memoryOps.cleanupConfirm'))) return;
    setBusy('lifecycle-cleanup'); setLifecycleResult(undefined);
    try {
      const result = await requestProject<{ removedDailyEvents: number; removedCompletedScratchpadItems: number; expiredCandidates: number }>(activeProject.name, '/memory/lifecycle/cleanup', { method: 'POST', body: {} });
      setLifecycleResult(`${result.removedDailyEvents} daily · ${result.removedCompletedScratchpadItems} scratchpad · ${result.expiredCandidates} candidates`);
      await load(); await loadMarkdownView();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const exportMarkdown = async () => {
    if (!activeProject || !viewAgent || busy) return;
    setBusy('export-markdown'); setError(undefined);
    try { await window.oatDesktop.exportMemoryMarkdown({ projectName: activeProject.name, agentId: viewAgent }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const collectionAction = (collection: CollectionStatus): 'pause' | 'resume' | 'activate' | 'rollback' | undefined => {
    if (snapshot?.operation?.status === 'running' && snapshot.operation.collectionRevision === collection.collectionRevision) return 'pause';
    if (collection.migration?.status === 'paused' || collection.state === 'failed') return 'resume';
    if (collection.state === 'ready') return 'activate';
    if (collection.state === 'retired') return 'rollback';
    if (collection.migration?.status === 'backfilling' || collection.migration?.status === 'validating') return 'pause';
    return undefined;
  };
  const governed = [...candidates, ...disputed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return <section className="memory-ops-workspace">
    <header className="memory-ops-header"><span className="memory-ops-mark"><IconBrain /></span><div><p>MEMORY CONTROL</p><h1>{t('memoryOps.title')}</h1><small>{t('memoryOps.subtitle')}</small></div><label>{t('memoryOps.project')}<select value={selected} onChange={(event) => setSelected(event.target.value)}>{projects.map((item) => <option key={item.name} value={item.name}>{item.projectName || item.name}{item.alive ? '' : ` · ${t('status.offline')}`}</option>)}</select></label><button onClick={() => void load()} disabled={!activeProject?.alive || Boolean(busy)}><IconRefresh />{t('memory.refresh')}</button></header>
    {error && <p className="memory-ops-error">{error}</p>}
    {!activeProject ? <div className="memory-ops-empty">{t('resource.noProjects')}</div> : !activeProject.alive ? <div className="memory-ops-empty">{t('memoryOps.startProject')}</div> : !snapshot ? <div className="memory-ops-empty">{t('loading')}</div> : <>
      <div className="memory-ops-summary">
        <article><span>{t('memoryOps.health')}</span><strong className={`health-${snapshot.health}`}>{t(`memoryOps.health.${snapshot.health}`)}</strong><small>{snapshot.overview.retrieval?.effectiveBackend ?? snapshot.configured.backend}</small></article>
        <article><span>{t('memoryOps.activeRevision')}</span><strong title={snapshot.activeCollectionRevision}>{snapshot.activeCollectionRevision ?? '—'}</strong><small>{snapshot.configured.embeddingProfile ?? t('memoryOps.noEmbedding')}</small></article>
        <article><span>{t('memoryOps.sync')}</span><strong>{snapshot.collections.reduce((sum, item) => sum + item.validation.pendingOutbox + item.validation.processingOutbox, 0)} / {snapshot.collections.reduce((sum, item) => sum + item.validation.deadLetters, 0)}</strong><small>{t('memoryOps.pendingDead')}</small></article>
        <article><span>{t('memoryOps.memoryCount')}</span><strong>{Object.values(snapshot.overview.counts).reduce((sum, count) => sum + count, 0)}</strong><small>L1 {snapshot.overview.counts.L1 ?? 0} · L2 {snapshot.overview.counts.L2 ?? 0} · L3 {snapshot.overview.counts.L3 ?? 0}</small></article>
      </div>
      {snapshot.warnings.length > 0 && <article className="memory-ops-warnings"><h2><IconTriangleAlert />{t('memoryOps.attention')}</h2>{snapshot.warnings.map((warning) => <p key={warning.code}><code>{warning.code}</code>{warning.message}</p>)}</article>}
      <article className="memory-ops-card"><div className="memory-ops-card-heading"><div><h2>{t('memoryOps.rebuild')}</h2><p>{t('memoryOps.rebuildHint')}</p></div><button className="primary" disabled={Boolean(busy) || snapshot.operation?.status === 'running' || !snapshot.estimate?.diskSufficient || snapshot.configured.embeddingState !== 'ready'} onClick={() => void operate('rebuild')}>{busy === 'rebuild:new' ? t('memoryOps.scheduling') : t('memoryOps.buildNew')}</button></div>
        <div className="memory-ops-estimate"><span>{t('memoryOps.target')}<strong>{snapshot.configured.collectionRevision ?? '—'}</strong></span><span>{t('memoryOps.profile')}<strong>{snapshot.configured.embeddingProfile ?? '—'} · {snapshot.configured.dimensions ?? '—'}d</strong></span><span>{t('memoryOps.embeddingCost')}<strong>{snapshot.estimate?.estimatedEmbeddingTokens ?? 0} tokens · {snapshot.estimate?.embeddingRequests ?? 0} batches</strong></span><span>{t('memoryOps.peakDisk')}<strong>{bytes(snapshot.estimate?.minimumPeakBytes)}</strong></span><span>{t('memoryOps.availableDisk')}<strong className={snapshot.estimate?.diskSufficient === false ? 'is-danger' : ''}>{bytes(snapshot.estimate?.availableDiskBytes)}</strong></span></div>
        {impact && <p className="memory-ops-impact">{t('memoryOps.profileImpact')}: {impact.projects.map((item) => item.displayName || item.projectName).join(', ') || '—'}{impact.globalDefault ? ` · ${t('memoryOps.globalDefault')}` : ''}</p>}
        {snapshot.operation && <p className={`memory-ops-job is-${snapshot.operation.status}`}><strong>{snapshot.operation.operation}</strong> · {snapshot.operation.collectionRevision} · {snapshot.operation.status}{snapshot.operation.error ? ` · ${snapshot.operation.error}` : ''}</p>}
      </article>
      <article className="memory-ops-card"><div className="memory-ops-card-heading"><div><h2>{t('memoryOps.collections')}</h2><p>{t('memoryOps.collectionsHint')}</p></div><IconDatabase /></div>{snapshot.collections.length ? <div className="memory-ops-table"><div className="memory-ops-row labels"><span>{t('memoryOps.revision')}</span><span>{t('memoryOps.state')}</span><span>{t('memoryOps.completeness')}</span><span>{t('memoryOps.queue')}</span><span>{t('memoryOps.disk')}</span><span>{t('memoryOps.actions')}</span></div>{snapshot.collections.map((collection) => { const action = collectionAction(collection); return <div className="memory-ops-row" key={collection.collectionRevision}><span><strong>{collection.collectionRevision}</strong><small>{collection.embeddingProfile ?? '—'} · {collection.dimensions ?? '—'}d · {collection.index ?? '—'}</small></span><span><b className={`state-${collection.state}`}>{collection.migration?.status ?? collection.state}</b><small>{collection.migration?.pauseReason || collection.migration?.error || time(collection.createdAt)}</small></span><span><strong>{Math.round(collection.completeness * 100)}%</strong><small>{collection.validation.indexedCount}/{collection.validation.expectedCount}</small></span><span><strong>{collection.validation.pendingOutbox + collection.validation.processingOutbox}</strong><small>{collection.validation.deadLetters} dead</small></span><span>{bytes(collection.diskBytes)}</span><span>{action ? <button disabled={Boolean(busy)} className={action === 'rollback' ? 'danger' : ''} onClick={() => void operate(action, collection.collectionRevision)}>{t(`memoryOps.${action}`)}</button> : '—'}</span></div>; })}</div> : <p className="memory-ops-none">{t('memoryOps.noCollections')}</p>}</article>
      <article className="memory-ops-card"><div className="memory-ops-card-heading"><div><h2>{t('memoryOps.governance')}</h2><p>{t('memoryOps.governanceHint')}</p></div><div><button disabled={Boolean(busy)} onClick={() => void cleanupLifecycle()}>{t('memoryOps.cleanup')}</button><IconShieldCheck /></div></div>{lifecycleResult && <p className="memory-ops-impact">{t('memoryOps.cleanupResult')}: {lifecycleResult}</p>}{governed.length ? <div className="memory-ops-governance">{governed.map((item) => <div key={item.id}><span><b>{item.status}</b>{item.level} · {item.kind} · {item.agentId}</span><strong>{item.summary}</strong><small>{t('memory.confidence')} {Math.round(item.confidence * 100)}% · {time(item.updatedAt)}</small><details><summary>{t('memoryOps.evidence')}</summary><p>{item.content}</p>{item.sources?.map((source) => <small key={source.eventId}>{source.eventType} · {source.role} · {source.agentId ?? '—'} · {time(source.createdAt)}</small>)}{item.contradictionIds?.length ? <small>{t('memoryOps.conflicts')}: {item.contradictionIds.join(', ')}</small> : null}</details><footer><button disabled={Boolean(busy)} onClick={() => void govern(item, 'confirm')}>{t('memory.confirm')}</button><button disabled={Boolean(busy)} onClick={() => void govern(item, 'edit-confirm')}>{t('memoryOps.editConfirm')}</button><button className="danger" disabled={Boolean(busy)} onClick={() => void govern(item, 'forget')}>{t('memory.forget')}</button></footer></div>)}</div> : <p className="memory-ops-none">{t('memoryOps.noGovernance')}</p>}</article>
      <article className="memory-ops-card memory-markdown-view"><div className="memory-ops-card-heading"><div><h2><IconFileText />{t('memoryOps.markdownView')}</h2><p>{t('memoryOps.markdownViewHint')}</p></div><div className="memory-markdown-actions"><select value={viewAgent} onChange={(event) => setViewAgent(event.target.value)}>{activeProject.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label || agent.id} · {agent.role}</option>)}</select><button disabled={!viewAgent || Boolean(busy)} onClick={() => void exportMarkdown()}><IconDownload />{t('memoryOps.exportMarkdown')}</button></div></div>{markdownView?.files.length ? <><nav className="memory-markdown-files">{markdownView.files.map((file) => <button className={file.path === viewFile ? 'active' : ''} key={file.path} onClick={() => setViewFile(file.path)}>{file.path}</button>)}</nav><pre>{markdownView.files.find(({ path }) => path === viewFile)?.content ?? ''}</pre></> : <p className="memory-ops-none">{t('memoryOps.noMarkdownView')}</p>}</article>
      <div className="memory-ops-two"><article className="memory-ops-card"><h2>{t('memoryOps.retrievalTrace')}</h2><p>{t('memoryOps.traceHint')}</p><div className="memory-ops-feed">{snapshot.retrievalRuns.slice(0, 12).map((run) => <div key={run.id}><span>{run.backend} · {run.agentId}</span><strong>{run.selectedIds.length} selected · {run.latencyMs.toFixed(1)} ms</strong><small className={run.fallbackReason ? 'is-danger' : ''}>{run.fallbackReason || time(run.createdAt)}</small></div>)}</div></article><article className="memory-ops-card"><h2>{t('memoryOps.accessAudit')}</h2><p>{t('memoryOps.auditHint')}</p><div className="memory-ops-feed">{snapshot.accessAudits.slice(0, 12).map((audit) => <div key={audit.id}><span>{audit.action} · {audit.actorRole}</span><strong className={audit.decision === 'denied' ? 'is-danger' : ''}>{audit.decision} · {audit.actorId}</strong><small>{audit.reason} · {time(audit.createdAt)}</small></div>)}</div></article></div>
    </>}
  </section>;
}
