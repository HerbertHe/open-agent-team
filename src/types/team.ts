import type { WorkerLifecycleEnum, WorkerSkillSyncEnum } from "./enums";

/**
 * Team 配置（Leader 部分）。
 * Leader 负责分解任务、按需要动态创建 Worker，并共享 skills / repos 范围。
 */
export interface TeamConfigLeader {
  /** Leader 在 team 内的唯一名称 */
  name: string;
  /** Leader 的职责描述（用于构建提示词/约束） */
  description: string;
  /** Leader 使用的模型（可选；不填时继承 admin.model 或顶层 model） */
  model?: string;
  /** Leader 的系统/角色提示词内容（支持字符串或文件路径，由 loader 解析） */
  prompt: string;
  /** Leader 与其下属 Worker 共享的 skills 名称列表 */
  skills: string[];
  /** Leader 负责的 repos/paths 白名单（用于 workspace sparse-checkout 或工具权限） */
  repos: string[];
}

/**
 * Team 配置（Worker 部分）。
 * Worker 负责具体实现，并在完成后生成/更新 CHANGELOG.md 并提交合并。
 */
export interface TeamConfigWorker {
  /** 需要在启动时一次性创建的 Worker 数量 */
  total: number;
  /** Worker 使用的模型（可选；不填时继承 leader.model） */
  model?: string;
  /** Worker 的角色提示词，用于指导执行和回报方式 */
  prompt: string;
  /** 额外附加到 Worker 的 skills（在继承 Leader skills 基础上追加） */
  extra_skills?: string[];
  /** Worker 生命周期策略：是否在合并进入 main 后自动回收 */
  lifecycle?: WorkerLifecycleEnum;
  /** Worker 技能同步策略：是否在动态 spawn 时自动注入 */
  skill_sync?: WorkerSkillSyncEnum;
}

/**
 * Team 配置（Leader + Worker）。
 */
export interface TeamConfig {
  /** Team 的名称（用于标识 leader/worker 分组） */
  name: string;
  /** 该 Team 的分支前缀（例如 `team/frontend`） */
  branch_prefix: string;
  /** Leader 配置 */
  leader: TeamConfigLeader;
  /** Worker 配置 */
  worker: TeamConfigWorker;
}

