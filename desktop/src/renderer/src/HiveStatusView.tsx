import type { CSSProperties } from 'react';
import { useI18n } from './i18n';
import { HiveRoleMark, hiveRoleForAgent, type HiveRole } from './hive-brand';

type HiveAgent = Project['agents'][number];
type HiveTask = { targetAgentId: string; status: string; prompt: string };
type AgentVisualState = 'busy' | 'queued' | 'idle' | 'failed' | 'offline';

function roleLabel(role: HiveRole, t: (key: string) => string) {
  if (role === 'chief') return t('hive.roleChief');
  if (role === 'leader') return t('hive.roleLeader');
  if (role === 'steward') return t('hive.roleSteward');
  if (role === 'contractor') return t('hive.roleContractor');
  return t('hive.roleWorker');
}

function visualState(project: Project | undefined, agent: HiveAgent, tasks: HiveTask[]): AgentVisualState {
  if (!project?.alive || agent.status === 'offline') return 'offline';
  if (agent.status === 'failed') return 'failed';
  if (agent.status === 'running' || tasks.some((task) => task.targetAgentId === agent.id && task.status === 'running')) return 'busy';
  if (tasks.some((task) => task.targetAgentId === agent.id && task.status === 'queued')) return 'queued';
  return 'idle';
}

function stateLabel(state: AgentVisualState, t: (key: string) => string) {
  return t(`hive.state.${state}`);
}

function Bee({ agent, index, total, project, tasks, selected, onSelect }: { agent: HiveAgent; index: number; total: number; project?: Project; tasks: HiveTask[]; selected: boolean; onSelect(): void }) {
  const { t } = useI18n();
  const role = hiveRoleForAgent(agent.role);
  const state = visualState(project, agent, tasks);
  const angle = -100 + (index * 360) / Math.max(total, 1);
  const ring = role === 'chief' ? 166 : role === 'leader' ? 208 : 232 + (index % 2) * 24;
  const style = { '--bee-angle': `${angle}deg`, '--bee-radius': `${ring}px`, '--bee-delay': `${-(index % 7) * 0.31}s` } as CSSProperties;
  const activeTask = tasks.find((task) => task.targetAgentId === agent.id && task.status === 'running') ?? tasks.find((task) => task.targetAgentId === agent.id && task.status === 'queued');
  return <button type="button" className={`hive-bee-slot is-${state} is-${role} ${selected ? 'is-selected' : ''}`} style={style} onClick={onSelect} aria-label={`${agent.label || agent.id}, ${roleLabel(role, t)}, ${stateLabel(state, t)}`}>
    <span className="hive-bee-motion">
      <span className="hive-bee-trail" />
      <span className="hive-bee-body"><HiveRoleMark role={role} /></span>
      <span className="hive-bee-caption"><strong>{agent.label || agent.id}</strong><small>{roleLabel(role, t)} · {stateLabel(state, t)}</small>{activeTask && <em>{activeTask.prompt}</em>}</span>
    </span>
  </button>;
}

export function HiveStatusView({ project, agents, tasks, selectedAgentId, resourceBusy, onSelectAgent }: { project?: Project; agents: HiveAgent[]; tasks: HiveTask[]; selectedAgentId?: string; resourceBusy: boolean; onSelectAgent(id: string): void }) {
  const { t } = useI18n();
  const states = agents.map((agent) => visualState(project, agent, tasks));
  const busy = states.filter((state) => state === 'busy').length;
  const attention = states.filter((state) => state === 'failed' || state === 'offline').length;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const hiveCells = Array.from({ length: 19 }, (_, index) => index);
  return <main className="hive-status-page">
    <section className={`hive-scene ${project?.alive ? 'is-alive' : 'is-offline'}`} aria-label={project?.projectName || project?.name || t('resource.noProjects')}>
      <div className="hive-steward" aria-label={`${t('hive.roleSteward')}, ${resourceBusy ? t('hive.state.busy') : t('hive.state.idle')}`}><span className={resourceBusy ? 'is-busy' : ''}><HiveRoleMark role="steward" /></span><p>{t('hive.roleSteward')}</p></div>
      <div className="hive-orbit hive-orbit-outer" /><div className="hive-orbit hive-orbit-inner" />
      <div className="hive-core">
        <div className="hive-cells">{hiveCells.map((cell) => <i key={cell} className={cell < Math.min(completed, hiveCells.length) ? 'is-filled' : ''} />)}</div>
        <div className="hive-core-label"><small>{t('hive.hive')}</small><strong>{project?.projectName || project?.name || t('resource.noProjects')}</strong><span>{project?.alive ? t('hive.state.online') : t('hive.state.offline')}</span></div>
      </div>
      <div className="hive-bees">{agents.map((agent, index) => <Bee key={agent.id} agent={agent} index={index} total={agents.length} project={project} tasks={tasks} selected={agent.id === selectedAgentId} onSelect={() => onSelectAgent(agent.id)} />)}</div>
      {!agents.length && <div className="hive-empty">{t('hive.noAgents')}</div>}
      <footer className="hive-scene-status"><span><i className="is-online" />{agents.length} {t('hive.agents')}</span><span><i className="is-busy" />{busy} {t('hive.state.busy')}</span><span><i className={attention ? 'is-alert' : 'is-online'} />{attention} {t('hive.attention')}</span><span>{completed}/{tasks.length} {t('hive.tasksComplete')}</span></footer>
    </section>
  </main>;
}
