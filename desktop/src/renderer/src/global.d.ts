/// <reference types="unplugin-icons/types/react" />

interface Window {
  oatDesktop: {
    getRuntimeStatus(): Promise<RuntimeStatus>;
    prepareRuntime(): Promise<RuntimeStatus>;
    ensureNodeRuntime(): Promise<RuntimeStatus>;
    ensureOatTool(): Promise<RuntimeStatus>;
    installRuntime(): Promise<RuntimeStatus>;
    updateOat(): Promise<RuntimeStatus>;
    checkUpdates(): Promise<UpdateStatus>;
    installDocker(locale: 'zh-CN' | 'en' | 'fr' | 'ja'): Promise<DockerHostStatus>;
    getDockerStatus(): Promise<DockerHostStatus>;
    startDocker(): Promise<DockerHostStatus>;
    listProjects(): Promise<Project[]>;
    restartProject(name: string): Promise<{ ok: true; newPid?: number }>;
    deleteProject(name: string): Promise<{ ok: true }>;
    listProviderModels(input: { baseUrl: string; apiKey?: string }): Promise<string[]>;
    requestOrchestrator(input: { projectName: string; path: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }): Promise<unknown>;
    requestControlPlane(input: { path: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }): Promise<unknown>;
    subscribeObservability(projectName: string): Promise<void>;
    unsubscribeObservability(): Promise<void>;
    onObservabilityEvent(listener: (payload: { projectName: string; event: unknown }) => void): () => void;
    onObservabilityStatus(listener: (payload: { projectName: string; connected: boolean }) => void): () => void;
  };
}
interface RuntimeStatus { node: { installed: boolean; compatible: boolean; version?: string; source?: string }; oat: { installed: boolean; version?: string; source?: string }; }
interface UpdateStatus { oat: { checked: boolean; latest?: string; available: boolean; error?: string }; desktop: { checked: boolean; latest?: string; available: boolean; error?: string }; }
interface DockerHostStatus { installed: boolean; daemonRunning: boolean; available: boolean; version?: string; cliVersion?: string; issue?: 'not_installed' | 'permission_denied' | 'daemon_unavailable'; error?: string; autoInstallSupported: boolean; }
interface Project { name: string; projectName?: string | null; root: string; port?: number; pid?: number; startedAt?: string | null; alive: boolean; agents: Array<{ id: string; role: string; label: string; status: string }>; }
