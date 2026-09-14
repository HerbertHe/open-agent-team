import type { SVGProps } from 'react';

export type HiveRole = 'worker' | 'leader' | 'chief' | 'steward' | 'contractor';

export function hiveRoleForAgent(role: string): HiveRole {
  if (/(?:a2a|external|contractor|outsourc)/i.test(role)) return 'contractor';
  if (role.toLowerCase().includes('admin')) return 'chief';
  if (/(?:^|[-_\s])(?:lead|leader)(?:$|[-_\s])|leader/i.test(role)) return 'leader';
  return 'worker';
}

type MarkProps = SVGProps<SVGSVGElement> & { role: HiveRole };

/** Geometric role marks derived from the canonical OAT bee rather than replacing the app logo. */
export function HiveRoleMark({ role, className, ...props }: MarkProps) {
  return <svg viewBox="0 0 64 64" className={`hive-role-mark hive-role-mark-${role} ${className ?? ''}`} fill="none" aria-hidden="true" {...props}>
    {role === 'steward' && <g className="hive-role-orbit" stroke="currentColor" strokeWidth="2">
      <path d="M8 22 15 18l7 4v8l-7 4-7-4Z" opacity=".42" />
      <path d="m42 22 7-4 7 4v8l-7 4-7-4Z" opacity=".42" />
      <path d="m25 48 7-4 7 4v8l-7 4-7-4Z" opacity=".42" />
    </g>}
    {role === 'chief' && <g className="hive-role-crown" fill="currentColor">
      <path d="m20 11 5-3 5 3v6l-5 3-5-3Z" opacity=".75" />
      <path d="m29 6 3-2 3 2v4l-3 2-3-2Z" />
      <path d="m34 11 5-3 5 3v6l-5 3-5-3Z" opacity=".75" />
    </g>}
    {role === 'leader' && <path className="hive-role-chevron" d="m25 14 7-5 7 5-7 4Z" fill="currentColor" />}
    <g className="hive-role-wings" fill="currentColor">
      <path d={role === 'worker' || role === 'contractor' ? 'M25 23 11 17 5 22l4 13 16-5Z' : 'M25 23 9 14 3 20l6 17 16-7Z'} opacity=".68" />
      <path d={role === 'worker' || role === 'contractor' ? 'm39 23 14-6 6 5-4 13-16-5Z' : 'm39 23 16-9 6 6-6 17-16-7Z'} opacity=".68" />
    </g>
    <path className="hive-role-head" d="m23 20 9-5 9 5v10l-9 5-9-5Z" fill="currentColor" />
    <path className="hive-role-core" d="m22 34 10-6 10 6v11L32 51 22 45Z" fill="currentColor" opacity=".82" />
    <path className="hive-role-tail" d="m27 52 5-3 5 3-5 8Z" fill="currentColor" opacity=".68" />
    {role === 'leader' && <path d="M25 38h14M27 43h10" stroke="var(--hive-wax, #fbf6e9)" strokeWidth="2" strokeLinecap="round" opacity=".78" />}
    {role === 'chief' && <path d="m27 39 5-3 5 3v6l-5 3-5-3Z" fill="var(--hive-honey, #c98b2b)" />}
    {role === 'steward' && <path d="m27 39 5-3 5 3v6l-5 3-5-3Z" fill="var(--hive-honey, #c98b2b)" />}
    {role === 'contractor' && <path d="M45 39h8v8h-8m-26-8h-8v8h8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />}
  </svg>;
}

export function HiveProjectMark({ alive, className = '' }: { alive: boolean; className?: string }) {
  return <span className={`hive-project-mark ${alive ? 'is-alive' : 'is-offline'} ${className}`} aria-hidden="true">
    <svg viewBox="0 0 28 28" fill="none">
      <path d="m7 4 7-4 7 4v8l-7 4-7-4Z" />
      <path d="m0 16 7-4 7 4v8l-7 4-7-4Z" opacity=".52" />
      <path d="m14 16 7-4 7 4v8l-7 4-7-4Z" opacity=".72" />
    </svg>
    <i />
  </span>;
}
