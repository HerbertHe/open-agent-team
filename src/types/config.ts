import type { RuntimeModeEnum, WorkspaceProviderTypeEnum } from "./enums";
import type { TeamConfig, SkillEntry } from "./team";

/** 单个服务商的配置。 */
export interface ProviderConfig {
  /** 兼容类型：openai 或 anthropic */
  compatible_type: "openai" | "anthropic";
  /** API 基础地址 */
  base_url?: string;
  /** API 密钥 */
  api_key?: string;
}

/** providers 配置：key 为服务商名称，value 为该服务商的接入配置。 */
export type TeamFileProvidersConfig = Record<string, ProviderConfig>;

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
}

/** 主分支名：仅允许 `main` 或 `master`（与常见 Git 默认分支一致）。 */
export type ProjectBaseBranch = "main" | "master";

/**
 * team.json 的原始结构（runtime/workspace 可选，用 loader 做默认值补齐）。
 */
export interface TeamFileConfig {
  /** 全局统一模型（可作为 admin/leader/worker 的默认值） */
  model?: string;
  /** 全局模型供应商接入配置（推荐入口） */
  providers?: TeamFileProvidersConfig;
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
    /** workspace 是否持久化（不销毁） */
    persistent?: boolean;
    git?: {
      /** git remote 名称 */
      remote?: string;
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
  runtime: {
    /** 解析后的运行时模式（必填） */
    mode: RuntimeModeEnum;
    /** pi-coding-agent 运行时配置 */
    pi: {
      /** pi agentDir */
      agentDir: string;
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
    /** workspace 持久化开关 */
    persistent: boolean;
    git: {
      /** remote 名称 */
      remote: string;
      lfs: "pull" | "skip" | "allow_pull_deny_change";
    };
    sparse_checkout: {
      /** sparse-checkout 是否启用 */
      enabled: boolean;
    };
  };
}
