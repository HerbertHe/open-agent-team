import { useCallback, useEffect, useMemo, useState } from 'react';
import IconBookOpen from '~icons/lucide/book-open';
import IconRefresh from '~icons/lucide/refresh-cw';
import IconUpload from '~icons/lucide/upload';
import IconRotateCcw from '~icons/lucide/rotate-ccw';
import IconTrash2 from '~icons/lucide/trash-2';
import { useI18n } from './i18n';

type SourceStatus = 'pending' | 'parsing' | 'indexing' | 'ready' | 'unsupported' | 'failed' | 'deleted';
type KnowledgeSource = { id: string; path: string; mimeType: string; size: number; origin: 'agent_output' | 'user_upload' | 'workspace_file' | 'migration'; status: SourceStatus; version: number; error?: string; updatedAt: string };
type KnowledgeSnapshot = {
  enabled: boolean; roots: { project: string; teams: string; uploads: string }; counts: Record<SourceStatus, number>;
  sourceCount: number; chunkCount: number; index: { pending: number; indexed: number; failed: number; notApplicable: number; deadLetters: number };
  sources: KnowledgeSource[]; generatedAt: string;
};

const requestProject = <T,>(projectName: string, path: string, init?: { method?: string }) => window.oatDesktop.requestOrchestrator({
  projectName, path, init: init ? { method: init.method, headers: { 'Content-Type': 'application/json' } } : undefined,
}) as Promise<T>;
const bytes = (value = 0) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;

export function KnowledgeManagementWorkspace({ project, projects, selectedTeam }: { project?: Project; projects: Project[]; selectedTeam?: string }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(project?.name ?? projects[0]?.name ?? '');
  const activeProject = useMemo(() => projects.find((item) => item.name === selected), [projects, selected]);
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot>();
  const [target, setTarget] = useState<'project' | 'team'>(selectedTeam && selectedTeam !== 'Admin' ? 'team' : 'project');
  const [teamId, setTeamId] = useState(selectedTeam && selectedTeam !== 'Admin' ? selectedTeam : '');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { if (project?.name && projects.some((item) => item.name === project.name)) setSelected(project.name); }, [project?.name, projects]);
  const load = useCallback(async () => {
    if (!activeProject?.alive) { setSnapshot(undefined); return; }
    try { setSnapshot(await requestProject<KnowledgeSnapshot>(activeProject.name, '/knowledge/operations')); setError(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [activeProject?.alive, activeProject?.name]);
  useEffect(() => { void load(); if (!activeProject?.alive) return; const timer = window.setInterval(() => void load(), 8_000); return () => window.clearInterval(timer); }, [activeProject?.alive, load]);
  const upload = async () => {
    if (!activeProject?.alive || busy || (target === 'team' && !teamId.trim())) return;
    setBusy('upload'); setError(undefined);
    try { await window.oatDesktop.uploadKnowledge({ projectName: activeProject.name, ...(target === 'team' ? { teamId: teamId.trim() } : {}) }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const operate = async (source: KnowledgeSource, operation: 'retry' | 'delete') => {
    if (!activeProject?.alive || busy) return;
    if (operation === 'delete' && !window.confirm(t('knowledgeOps.deleteConfirm'))) return;
    setBusy(`${operation}:${source.id}`); setError(undefined);
    try { await requestProject(activeProject.name, `/knowledge/sources/${encodeURIComponent(source.id)}${operation === 'retry' ? '/retry' : ''}`, { method: operation === 'retry' ? 'POST' : 'DELETE' }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const scan = async () => {
    if (!activeProject?.alive || busy) return; setBusy('scan'); setError(undefined);
    try { setSnapshot(await requestProject<KnowledgeSnapshot>(activeProject.name, '/knowledge/scan', { method: 'POST' })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const sources = snapshot?.sources.filter((source) => source.status !== 'deleted') ?? [];
  return <section className="memory-ops-workspace knowledge-ops-workspace">
    <header className="memory-ops-header"><span className="memory-ops-mark"><IconBookOpen /></span><div><p>KNOWLEDGE CONTROL</p><h1>{t('knowledgeOps.title')}</h1><small>{t('knowledgeOps.subtitle')}</small></div><label>{t('memoryOps.project')}<select value={selected} onChange={(event) => setSelected(event.target.value)}>{projects.map((item) => <option key={item.name} value={item.name}>{item.projectName || item.name}{item.alive ? '' : ` · ${t('status.offline')}`}</option>)}</select></label><button onClick={() => void load()} disabled={!activeProject?.alive || Boolean(busy)}><IconRefresh />{t('memory.refresh')}</button></header>
    {error && <p className="memory-ops-error">{error}</p>}
    {!activeProject ? <div className="memory-ops-empty">{t('resource.noProjects')}</div> : !activeProject.alive ? <div className="memory-ops-empty">{t('knowledgeOps.startProject')}</div> : !snapshot ? <div className="memory-ops-empty">{t('loading')}</div> : <>
      <div className="memory-ops-summary"><article><span>{t('knowledgeOps.sources')}</span><strong>{snapshot.sourceCount}</strong><small>{snapshot.counts.ready} {t('knowledgeOps.ready')}</small></article><article><span>{t('knowledgeOps.chunks')}</span><strong>{snapshot.chunkCount}</strong><small>{snapshot.index.indexed} {t('knowledgeOps.indexed')}</small></article><article><span>{t('knowledgeOps.sync')}</span><strong>{snapshot.index.pending}</strong><small>{snapshot.index.failed + snapshot.index.deadLetters} {t('knowledgeOps.failed')}</small></article><article><span>{t('knowledgeOps.uploadRoot')}</span><strong title={snapshot.roots.uploads}>{snapshot.roots.uploads}</strong><small>{t('knowledgeOps.fileBacked')}</small></article></div>
      <article className="memory-ops-card"><div className="memory-ops-card-heading"><div><h2>{t('knowledgeOps.upload')}</h2><p>{t('knowledgeOps.uploadHint')}</p></div><IconUpload /></div><div className="knowledge-upload-controls"><label>{t('knowledgeOps.visibility')}<select value={target} onChange={(event) => setTarget(event.target.value as 'project' | 'team')}><option value="project">{t('knowledgeOps.project')}</option><option value="team">{t('knowledgeOps.team')}</option></select></label>{target === 'team' && <label>{t('knowledgeOps.teamId')}<input value={teamId} onChange={(event) => setTeamId(event.target.value)} placeholder="alpha" /></label>}<button type="button" className="primary" onClick={() => void upload()} disabled={Boolean(busy) || (target === 'team' && !teamId.trim())}><IconUpload />{busy === 'upload' ? t('knowledgeOps.uploading') : t('knowledgeOps.chooseFiles')}</button><button type="button" onClick={() => void scan()} disabled={Boolean(busy)}><IconRefresh />{busy === 'scan' ? t('knowledgeOps.scanning') : t('knowledgeOps.scan')}</button></div></article>
      <article className="memory-ops-card"><div className="memory-ops-card-heading"><div><h2>{t('knowledgeOps.library')}</h2><p>{t('knowledgeOps.libraryHint')}</p></div><IconBookOpen /></div>{sources.length ? <div className="knowledge-source-list">{sources.map((source) => <div key={source.id}><div className="min-w-0"><strong title={source.path}>{source.path}</strong><small>{source.origin} · v{source.version} · {bytes(source.size)} · {new Date(source.updatedAt).toLocaleString()}</small>{source.error && <em title={source.error}>{source.error}</em>}</div><b className={`state-${source.status}`}>{source.status}</b><footer>{['failed', 'unsupported'].includes(source.status) && <button type="button" onClick={() => void operate(source, 'retry')} disabled={Boolean(busy)}><IconRotateCcw />{t('knowledgeOps.retry')}</button>}{source.origin === 'user_upload' && <button type="button" className="danger" onClick={() => void operate(source, 'delete')} disabled={Boolean(busy)}><IconTrash2 />{t('knowledgeOps.delete')}</button>}</footer></div>)}</div> : <p className="memory-ops-none">{t('knowledgeOps.none')}</p>}</article>
    </>}
  </section>;
}
