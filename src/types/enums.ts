/**
 * 类型枚举集中定义：避免在代码里到处写死字符串常量。
 */

/**
 * Agent 角色枚举（Admin/Leader/Worker）。
 */
export enum AgentRoleEnum {
  /** Admin：统筹全局、负责最终交付与汇总 */
  Admin = "admin",
  /** Leader：拆解任务、调度 Worker，并汇总团队结果 */
  Leader = "leader",
  /** Worker：执行具体实现任务、提交变更与生成 CHANGELOG */
  Worker = "worker",
}

/**
 * workspace 提供方策略（文件系统/目录隔离实现）。
 */
export enum WorkspaceProviderTypeEnum {
  /** Worktree：基于 git worktree 做独立 workspace（磁盘高效、支持 sparse-checkout） */
  Worktree = "worktree",
  /** SharedClone：各 Agent 使用独立目录但共享 git 对象库（待扩展） */
  SharedClone = "shared_clone",
  /** FullClone：每个 Agent 完整 clone（磁盘更大、最简单但成本高） */
  FullClone = "full_clone",
}

/**
 * 运行时模式（进程运行或 Flue sandbox 运行）。
 */
export enum RuntimeModeEnum {
  /** local_process：在本机以进程内 pi AgentSession SDK 运行（单机方案） */
  LocalProcess = "local_process",
  /** flue：把 agent 执行放入 Flue 的沙箱运行时（CI/云端方案） */
  Flue = "flue",
}

/**
 * Worker 生命周期策略：
 * - EphemeralAfterMergeToMain：合并进入 main 后回收 workspace 与进程
 * - Persistent：不自动回收（用于长期迭代）
 */
export enum WorkerLifecycleEnum {
  /** 合并进入 main 后自动回收：stop 进程并删除 worker workspace */
  EphemeralAfterMergeToMain = "ephemeral_after_merge_to_main",
  /** 不自动回收：worker workspace/进程可长期保留 */
  Persistent = "persistent",
}

/**
 * Worker 技能注入策略：
 * - InheritAndInjectOnSpawn：按 Leader skills 继承，并在生成时注入到新 Worker
 * - Manual：由外部手动配置/注入（非默认）
 */
export enum WorkerSkillSyncEnum {
  /** Worker skills 继承 Leader，并在动态 spawn 时注入新 Worker workspace */
  InheritAndInjectOnSpawn = "inherit_and_inject_on_spawn",
  /** 手动同步：不自动注入，由外部逻辑决定 */
  Manual = "manual",
}

