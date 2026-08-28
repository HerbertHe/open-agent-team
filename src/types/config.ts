import type { BaseBranchEnum, DockerNetworkModeEnum, ProviderCompatibleTypeEnum, RuntimeModeEnum, WorkspaceProviderTypeEnum } from "./enums";
import type { TeamConfig, SkillEntry } from "./team";

/** 单个服务商的配置。 */
export interface ProviderConfig {
  /** 兼容类型：openai 或 anthropic */
  compatible_type: ProviderCompatibleTypeEnum;
  /** API 基础地址 */
  base_url?: string;
  /** API 密钥 */
  api_key?: string;
}

/** providers 配置：key 为服务商名称，value 为该服务商的接入配置。 */
export type TeamFileProvidersConfig = Record<string, ProviderConfig>;

export interface MemoryConfig {
  enabled: boolean;
  roles: Array<"admin" | "leader">;
  database?: string;
  l1: {
    maxItems: number;
    completedTaskTtlHours: number;
  };
  l2: {
    maxResults: number;
    retentionDays: number;
  };
  l3: {
    maxPromptItems: number;
    minEvidence: number;
  };
  dream: {
    enabled: boolean;
    idleAfterSeconds: number;
    pollSeconds: number;
    maxEventsPerRun: number;
    cancelOnNewTask: boolean;
  };
}

/**
 * Admin agent 的声明式配置。
 */
export interface TeamFileAdminConfig {
  /** Admin agent 名称 */
  name: string;
  /** Admin 的职责描述（写入提示/约束） */
  description: string;
  /** Admin 使用的模型（可选；不填时继承顶层 model） */
  model?: string;
  /** Admin 的 prompt 内容（支持 loader 读取 .md 文件） */
  prompt: string;
  /** Admin 共享给任务的 skills 列表 */
  skills: SkillEntry[];
  /** Admin 推送渠道账号配置 */
  push_channel?: {
    channel: string;
    account: string;
  };
}

/** 主分支名：仅允许 `main` 或 `master`（与常见 Git 默认分支一致）。 */
export type ProjectBaseBranch = BaseBranchEnum;

/**
 * team.json 的原始结构（runtime/workspace 可选，用 loader 做默认值补齐）。
 */
export interface TeamFileConfig {
  /** JSON Schema reference used by editors and generated project files. */
  $schema?: string;
  /** 全局统一模型（可作为 admin/leader/worker 的默认值） */
  model?: string;
  /** 全局模型供应商接入配置（推荐入口） */
  providers?: TeamFileProvidersConfig;
  /** Admin/Leader persistent memory and idle consolidation. */
  memory?: Partial<MemoryConfig> & {
    l1?: Partial<MemoryConfig["l1"]>;
    l2?: Partial<MemoryConfig["l2"]>;
    l3?: Partial<MemoryConfig["l3"]>;
    dream?: Partial<MemoryConfig["dream"]>;
  };
  project: {
    /** 当前项目名称（用于日志与提示） */
    name: string;
    /** 仓库路径（通常为 `.`） */
    repo: string;
    /** 汇总代码的主分支：仅 `main` 或 `master` */
    base_branch: ProjectBaseBranch;
  };
  runtime?: {
    /** 运行时模式：本机进程或 Flue */
    mode?: RuntimeModeEnum;
    docker?: {
      image: string;
      network?: DockerNetworkModeEnum;
      extra_args?: string[];
    };
    persistence?: {
      /** orchestrator 状态与映射的持久化目录 */
      state_dir?: string;
    };
  };
  workspace?: {
    /** workspace 创建策略：worktree/shared_clone/full_clone */
    provider?: WorkspaceProviderTypeEnum;
    /** workspace 根目录 */
    root_dir?: string;
    git?: {
      /** Git remote 名称；不配置时仅使用本地 Git。 */
      remote?: string;
      /** Remote URL。凭据由 Git credential helper 或 SSH agent 管理。 */
      remote_url?: string;
      /** 最终合并提交使用的本地 Git 身份。 */
      user_name?: string;
      user_email?: string;
      /** 是否允许 Admin 显式推送已合并的 release。 */
      push_enabled?: boolean;
      /** LFS 策略 */
      lfs?: "pull" | "skip" | "allow_pull_deny_change";
    };
    sparse_checkout?: {
      /** 是否启用 sparse-checkout（大仓库降低 workspace 体积） */
      enabled?: boolean;
    };
  };
  /** 模型别名到 model id 的映射 */
  models: Record<string, string>;
  /** Admin agent 配置 */
  admin: TeamFileAdminConfig;
  /** teams 配置（每个 team 拥有 leader/worker） */
  teams: TeamConfig[];
}

/**
 * loader 解析后的最终配置（所有必要字段已补齐）。
 */
export interface ResolvedConfig extends Omit<TeamFileConfig, "runtime" | "workspace"> {
  providers: TeamFileProvidersConfig;
  memory: MemoryConfig;
  runtime: {
    /** 解析后的运行时模式（必填） */
    mode: RuntimeModeEnum;
    /** pi-coding-agent 运行时配置 */
    pi: {
      /** pi agentDir */
      agentDir: string;
    };
    docker?: {
      image: string;
      network: DockerNetworkModeEnum;
      extra_args: string[];
    };
    persistence: {
      /** 状态持久化目录 */
      state_dir: string;
    };
  };
  workspace: {
    /** workspaces 创建策略 */
    provider: WorkspaceProviderTypeEnum;
    /** workspaces 根目录 */
    root_dir: string;
    git: {
      /** remote 名称；undefined 表示 local-only。 */
      remote?: string;
      remote_url?: string;
      user_name?: string;
      user_email?: string;
      push_enabled: boolean;
      lfs: "pull" | "skip" | "allow_pull_deny_change";
    };
    sparse_checkout: {
      /** sparse-checkout 是否启用 */
      enabled: boolean;
    };
  };
}
