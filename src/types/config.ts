import type { RuntimeModeEnum, WorkspaceProviderTypeEnum } from "./enums";
import type { TeamConfig } from "./team";

export interface TeamFileProvidersConfig {
  /** 直接注入到 opencode 进程的环境变量（明文）。 */
  env?: Record<string, string>;
  /** 环境变量映射：key 为注入名，value 为当前系统中的源环境变量名。 */
  env_from?: Record<string, string>;
  /** OpenAI 兼容网关的便捷配置（会自动映射到 OPENAI_* 环境变量）。 */
  openai_compatible?: {
    /** 对应 OPENAI_BASE_URL */
    base_url?: string;
    /** 对应 OPENAI_API_KEY（不建议明文，建议改用 api_key_env） */
    api_key?: string;
    /** 从当前进程环境变量读取 key（例如 OPENROUTER_API_KEY） */
    api_key_env?: string;
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
  skills: string[];
}

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
    /** 汇总代码的主分支（如 main/master） */
    base_branch: string;
  };
  runtime?: {
    /** 运行时模式：本机进程或 Flue */
    mode?: RuntimeModeEnum;
    opencode?: {
      /** opencode 可执行文件路径或命令名 */
      executable?: string;
    };
    ports?: {
      /** 服务端口起始值 */
      base?: number;
      /** 单机允许的最大 Agent 并发数（近似控制资源） */
      max_agents?: number;
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
  providers: Required<Omit<TeamFileProvidersConfig, "openai_compatible">> & {
    openai_compatible: TeamFileProvidersConfig["openai_compatible"];
  };
  runtime: {
    /** 解析后的运行时模式（必填） */
    mode: RuntimeModeEnum;
    opencode: {
      /** opencode 可执行文件 */
      executable: string;
    };
    ports: {
      /** 端口起始值 */
      base: number;
      /** 并发上限 */
      max_agents: number;
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

