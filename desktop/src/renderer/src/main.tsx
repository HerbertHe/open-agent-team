import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './tailwind.css';
import './app.less';
import { App } from './App';
import { I18nProvider, useI18n } from './i18n';

function StartupGate() {
  const { t } = useI18n();
  type StepKey = 'node' | 'oat' | 'docker' | 'services';
  type StepState = { state: 'pending' | 'checking' | 'installing' | 'ready' | 'optional' | 'warning'; detail: string };
  const pending = (): Record<StepKey, StepState> => ({ node: { state: 'pending', detail: t('startup.pending') }, oat: { state: 'pending', detail: t('startup.pending') }, docker: { state: 'pending', detail: t('startup.pending') }, services: { state: 'pending', detail: t('startup.pending') } });
  const [ready, setReady] = useState(false); const [error, setError] = useState<string>(); const [steps, setSteps] = useState<Record<StepKey, StepState>>(pending);
  const updateStep = (key: StepKey, state: StepState['state'], detail: string) => setSteps((current) => ({ ...current, [key]: { state, detail } }));
  const prepare = useCallback(async () => {
    setReady(false); setError(undefined); setSteps(pending());
    try {
      const bridge = window.oatDesktop as typeof window.oatDesktop & { ensureNodeRuntime?: () => Promise<RuntimeStatus>; ensureOatTool?: () => Promise<RuntimeStatus>; getDockerStatus?: () => Promise<DockerHostStatus>; prepareRuntime?: () => Promise<RuntimeStatus>; checkUpdates?: () => Promise<UpdateStatus> };
      updateStep('node', 'checking', t('startup.checkingNode'));
      let runtime = await bridge.getRuntimeStatus();
      if (!runtime.node.compatible) {
        updateStep('node', 'installing', t('startup.installingNode'));
        runtime = typeof bridge.ensureNodeRuntime === 'function' ? await bridge.ensureNodeRuntime() : await bridge.prepareRuntime?.() ?? runtime;
      }
      if (!runtime.node.compatible) throw new Error(t('startup.nodeUnavailable'));
      updateStep('node', 'ready', `${runtime.node.version ?? ''} · ${t('startup.ready')}`);

      updateStep('oat', 'checking', t('startup.checkingOat'));
      runtime = await bridge.getRuntimeStatus();
      if (!runtime.oat.installed) {
        updateStep('oat', 'installing', t('startup.installingOat'));
        runtime = typeof bridge.ensureOatTool === 'function' ? await bridge.ensureOatTool() : await bridge.prepareRuntime?.() ?? runtime;
      }
      if (!runtime.oat.installed) throw new Error(t('startup.oatUnavailable'));
      updateStep('oat', 'ready', `${runtime.oat.version ?? ''} · ${t('startup.ready')}`);

      updateStep('docker', 'checking', t('startup.checkingDocker'));
      if (typeof bridge.getDockerStatus === 'function') {
        const docker = await bridge.getDockerStatus();
        if (!docker.installed) updateStep('docker', 'optional', t('startup.dockerNotInstalled'));
        else if (!docker.daemonRunning) updateStep('docker', 'warning', docker.issue === 'permission_denied' ? t('startup.dockerPermission') : t('startup.dockerStopped'));
        else updateStep('docker', 'ready', `${docker.version ?? docker.cliVersion ?? ''} · ${t('startup.ready')}`);
      } else updateStep('docker', 'optional', t('startup.dockerDeferred'));

      updateStep('services', 'checking', t('startup.services'));
      if (typeof bridge.prepareRuntime === 'function') await bridge.prepareRuntime();
      updateStep('services', 'ready', t('startup.ready'));
      setReady(true);
      if (typeof bridge.checkUpdates === 'function') void bridge.checkUpdates().catch(() => undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [t]);
  useEffect(() => { void prepare(); }, [prepare]);
  if (ready) return <App />;
  const ordered: Array<[StepKey, string]> = [['node', t('startup.node')], ['oat', t('startup.oat')], ['docker', t('startup.docker')], ['services', t('startup.desktopServices')]];
  const completed = ordered.filter(([key]) => ['ready', 'optional', 'warning'].includes(steps[key].state)).length;
  const activeIndex = ordered.findIndex(([key]) => ['checking', 'installing'].includes(steps[key].state));
  const progress = Math.min(96, Math.max(8, completed * 23 + (activeIndex >= 0 ? 12 : 0)));
  return <main className="startup-screen app-drag text-oat-ink"><div className="startup-glow" /><section className="startup-content"><div className="startup-brand"><img src="/logo.svg" className="h-16 w-16" /></div><h1>{t('startup.title')}</h1><p className="startup-subtitle">{t('startup.subtitle')}</p><div className="startup-progress" aria-label={t('startup.title')}><i style={{ width: `${progress}%` }} /></div><div className="startup-steps">{ordered.map(([key, label]) => <article key={key} className={`startup-step ${steps[key].state}`}><i /><span><strong>{label}</strong><small>{steps[key].detail}</small></span></article>)}</div>{error && <div className="startup-error app-no-drag"><strong>{t('startup.failed')}</strong><span>{error}</span><button type="button" onClick={() => void prepare()}>{t('startup.retry')}</button></div>}</section></main>;
}

createRoot(document.querySelector('#app')!).render(<StrictMode><I18nProvider><StartupGate /></I18nProvider></StrictMode>);
