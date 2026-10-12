import { useEffect, useState } from 'react';

type ProgramView = {
  program: { id: string; goal: string; status: string; revision: number; execution_epoch: number };
  accounts: unknown[]; packages: unknown[]; dependencies: unknown[]; timeline: unknown[];
  uncertainty: { effects: number; reservations: number; attempts: number };
  latestSnapshot?: { id: string; created_at: string };
};

export function ProgramExecutionWorkspace({ projectName, request, onBack }: {
  projectName: string;
  request<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  onBack(): void;
}) {
  const [programs, setPrograms] = useState<ProgramView[]>([]); const [selected, setSelected] = useState<string>();
  const [error, setError] = useState(''); const [resumeReport, setResumeReport] = useState<any>();
  const load = () => request<ProgramView[]>(`/api/experimental/programs?projectId=${encodeURIComponent(projectName)}`).then((items) => {
    setPrograms(items); setSelected((value) => value && items.some((item) => item.program.id === value) ? value : items[0]?.program.id);
  }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  useEffect(() => { void load(); }, [projectName]);
  const view = programs.find((item) => item.program.id === selected);
  const interrupt = async (mode: 'graceful' | 'immediate' | 'cancel_closeout') => {
    if (!view) return;
    if (mode !== 'graceful' && !window.confirm(mode === 'immediate' ? '立即终止可能留下不确定外部操作，确认继续？' : '取消并收尾将结束执行，确认继续？')) return;
    try { await request(`/api/experimental/programs/${encodeURIComponent(view.program.id)}/interrupt`, { method: 'POST', body: { controlRequestId: `ui-${Date.now()}`, mode, reason: 'desktop_user_request', expectedRevision: view.program.revision, requestedAt: new Date().toISOString() } }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const dryRun = async () => {
    if (!view?.latestSnapshot) return;
    try { setResumeReport(await request(`/api/experimental/programs/${encodeURIComponent(view.program.id)}/resume-dry-run`, { method: 'POST', body: { snapshotId: view.latestSnapshot.id } })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const resume = async () => {
    if (!view || !resumeReport || !window.confirm('按此 dry-run 报告恢复执行？恢复会创建新的执行 epoch。')) return;
    try { await request(`/api/experimental/programs/${encodeURIComponent(view.program.id)}/resume`, { method: 'POST', body: { requestId: `ui-resume-${Date.now()}`, expectedRevision: view.program.revision, report: resumeReport, confirmed: true, now: new Date().toISOString() } }); setResumeReport(undefined); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <div className="oat-scrollbar min-h-0 flex-1 overflow-auto p-6"><button className="mb-4 text-sm" onClick={onBack}>← 返回</button>
    <div className="flex items-center justify-between"><div><p className="text-micro font-bold tracking-widest text-amber-700">实验性功能</p><h1 className="text-xl font-semibold">预算长程任务</h1></div><button onClick={() => void load()} className="rounded border px-3 py-2 text-xs">刷新</button></div>
    {error && <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="mt-5 grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]"><nav className="space-y-2">{programs.map((item) => <button key={item.program.id} onClick={() => setSelected(item.program.id)} className={`w-full rounded border p-3 text-left text-sm ${selected === item.program.id ? 'border-amber-500 bg-amber-50' : ''}`}><strong className="block truncate">{item.program.goal}</strong><small>{item.program.status}</small></button>)}{!programs.length && <p className="text-sm text-stone-500">暂无 Program。</p>}</nav>
      {view && <section className="space-y-5"><div className="rounded border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{view.program.goal}</h2><p className="text-xs text-stone-500">{view.program.status} · revision {view.program.revision}</p></div><div className="flex flex-wrap gap-2"><button className="rounded bg-amber-600 px-3 py-2 text-xs text-white" onClick={() => void interrupt('graceful')}>优雅暂停并保存快照</button><button className="rounded bg-red-600 px-3 py-2 text-xs text-white" onClick={() => void interrupt('immediate')}>立即终止并保存快照</button><button className="rounded border border-red-600 px-3 py-2 text-xs text-red-700" onClick={() => void interrupt('cancel_closeout')}>取消并收尾</button></div></div>
        {(view.uncertainty.effects + view.uncertainty.reservations + view.uncertainty.attempts) > 0 && <p className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-800">存在不确定状态：effect {view.uncertainty.effects} / reservation {view.uncertainty.reservations} / attempt {view.uncertainty.attempts}。系统不会显示“安全停止”。</p>}
        {view.latestSnapshot && <div className="mt-3 flex gap-2"><button className="rounded border px-3 py-2 text-xs" onClick={() => void dryRun()}>恢复 dry-run</button>{resumeReport && <button disabled={resumeReport.blockingDrift?.length > 0} className="rounded bg-oat-ink px-3 py-2 text-xs text-white disabled:opacity-40" onClick={() => void resume()}>确认恢复</button>}</div>}{resumeReport && <pre className="mt-3 overflow-auto rounded bg-stone-50 p-3 text-xs">{JSON.stringify(resumeReport, null, 2)}</pre>}</div>
        <div className="grid gap-4 md:grid-cols-2"><div className="rounded border bg-white p-4"><h3 className="font-semibold">预算账户</h3><pre className="mt-2 overflow-auto text-xs">{JSON.stringify(view.accounts, null, 2)}</pre></div><div className="rounded border bg-white p-4"><h3 className="font-semibold">DAG / Work Packages</h3><pre className="mt-2 overflow-auto text-xs">{JSON.stringify({ packages: view.packages, dependencies: view.dependencies }, null, 2)}</pre></div></div>
        <div className="rounded border bg-white p-4"><h3 className="font-semibold">审计时间线</h3><pre className="mt-2 overflow-auto text-xs">{JSON.stringify(view.timeline, null, 2)}</pre></div></section>}
    </div></div>;
}
