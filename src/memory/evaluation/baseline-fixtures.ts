import { AgentRoleEnum } from "../../types/enums";

export type BaselineCorpusItem = {
  key: string;
  agentId: string;
  role: AgentRoleEnum;
  content: string;
  ageHours: number;
};

export type BaselineQuery = {
  id: string;
  agentId: string;
  query: string;
  relevantKeys: string[];
  forbiddenKeys?: string[];
  unauthorizedKeys?: string[];
};

export const BASELINE_CORPUS: BaselineCorpusItem[] = [
  {
    key: "channel-default-route",
    agentId: "admin",
    role: AgentRoleEnum.Admin,
    content: "未绑定的微信通道账号默认交由智能体资源主管处理。",
    ageHours: 9,
  },
  {
    key: "pi-docker-only",
    agentId: "admin",
    role: AgentRoleEnum.Admin,
    content: "Pi 插件仅允许在 Docker 隔离环境启用，本地进程模式必须拒绝加载。",
    ageHours: 8,
  },
  {
    key: "migration-current",
    agentId: "admin",
    role: AgentRoleEnum.Admin,
    content: "数据库迁移必须先获取 advisory lock，避免多个实例并发修改 schema。",
    ageHours: 1,
  },
  {
    key: "migration-obsolete",
    agentId: "admin",
    role: AgentRoleEnum.Admin,
    content: "数据库迁移可以由多个实例并发执行，不需要获取锁。",
    ageHours: 240,
  },
  {
    key: "atlas-release",
    agentId: "admin",
    role: AgentRoleEnum.Admin,
    content: "Atlas 项目的发布分支是 release/atlas，合并前必须运行集成测试。",
    ageHours: 7,
  },
  {
    key: "balance-process-retained",
    agentId: "admin",
    role: AgentRoleEnum.Admin,
    content: "模型返回 402 Insufficient Balance 时，只失败当前任务并保留 Agent 进程。",
    ageHours: 6,
  },
  {
    key: "hive-brand",
    agentId: "admin",
    role: AgentRoleEnum.Admin,
    content: "Desktop 蜂巢动画采用中性蓝灰色，工蜂应沿路径来回飞行。",
    ageHours: 5,
  },
  {
    key: "worker-report-chain",
    agentId: "alpha-worker-0",
    role: AgentRoleEnum.Worker,
    content: "Worker 完成任务后先向 Leader 汇报，Leader 汇总后再报告给 Admin。",
    ageHours: 4,
  },
  {
    key: "beta-private-deployment",
    agentId: "beta-lead",
    role: AgentRoleEnum.Leader,
    content: "Orion 团队使用隔离的私有部署凭据，只允许 beta 团队访问。",
    ageHours: 3,
  },
  {
    key: "unrelated-ui-setting",
    agentId: "admin",
    role: AgentRoleEnum.Admin,
    content: "全局日志设置位于 Desktop 全局设置的日志子菜单。",
    ageHours: 2,
  },
];

const ALL_ADMIN_VISIBLE_KEYS = BASELINE_CORPUS.map((item) => item.key);

export const BASELINE_QUERIES: BaselineQuery[] = [
  {
    id: "english-exact-failure",
    agentId: "admin",
    query: "402 Insufficient Balance Agent process",
    relevantKeys: ["balance-process-retained"],
  },
  {
    id: "english-paraphrase-failure",
    agentId: "admin",
    query: "What happens when model credit is exhausted?",
    relevantKeys: ["balance-process-retained"],
  },
  {
    id: "chinese-exact-channel",
    agentId: "admin",
    query: "微信通道 资源主管",
    relevantKeys: ["channel-default-route"],
  },
  {
    id: "chinese-paraphrase-channel",
    agentId: "admin",
    query: "没有分配聊天账号时由谁接收",
    relevantKeys: ["channel-default-route"],
  },
  {
    id: "entity-release-branch",
    agentId: "admin",
    query: "Atlas release branch",
    relevantKeys: ["atlas-release"],
  },
  {
    id: "failure-pattern-migration",
    agentId: "admin",
    query: "数据库迁移 advisory lock",
    relevantKeys: ["migration-current"],
    forbiddenKeys: ["migration-obsolete"],
  },
  {
    id: "temporal-conflict",
    agentId: "admin",
    query: "数据库迁移可以并发执行吗",
    relevantKeys: ["migration-current"],
    forbiddenKeys: ["migration-obsolete"],
  },
  {
    id: "leader-scope-isolation",
    agentId: "alpha-lead",
    query: "Orion 私有部署凭据",
    relevantKeys: [],
    forbiddenKeys: ["beta-private-deployment"],
    unauthorizedKeys: ["beta-private-deployment"],
  },
  {
    id: "no-result",
    agentId: "admin",
    query: "量子烹饪香蕉温度",
    relevantKeys: [],
    forbiddenKeys: ALL_ADMIN_VISIBLE_KEYS,
  },
];
