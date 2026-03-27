import type { AgentRoleEnum } from "./enums";

/**
 * 一个具体 Agent 实例在运行时的描述（由 Orchestrator 生成）。
 */
export interface AgentInstanceSpec {
  /** 运行时唯一 id（用于在 orchestrator 内部建立映射） */
  id: string;
  /** 角色枚举：admin/leader/worker */
  role: AgentRoleEnum;
  /** 属于哪个 team（worker/leader 会用到） */
  teamName?: string;
  /** OpenCode agent 名称（用于 markdown agent 文件名/上下文） */
  name: string;
  /** Agent 绑定的 git 分支（worker/leader 分别用各自分支策略） */
  branch: string;
  /** Agent 的 workspace 根目录（独立文件系统隔离） */
  workspacePath: string;
  /** OpenCode server 端口（单机多进程时必需） */
  port: number;
  /** Agent 的模型（可以是模型别名，在 loader 中解析） */
  model: string;
  /** 当前 Agent 可用的 skills 名称列表（将注入到 workspace） */
  skills: string[];
}

