var e=`# 三级 Agent 记忆架构设计

> 状态：设计评审通过前的提案（不代表现有行为）  
> 目标：以可审计、可检索、受权限控制的记忆系统替代仅依赖 \`CHANGELOG.md\` 的协作上下文传递。

## 1. 背景与问题

当前系统通过 \`CHANGELOG.md\`、daily records 和运行时可观测事件保留工作过程。它们应继续作为交付记录与原始证据，但不适合作为唯一记忆机制：

- Agent 重启后无法快速恢复任务目标、已执行测试和未决风险；
- Leader 无法可靠地在任务创建前发现文件、模块或接口的冲突；
- 重要架构决策、review 结论与临时日志混在一起，难以按范围、时间和可信度检索；
- LLM 的推断没有来源、版本和审核状态时，容易被错误地当作事实复用。

本设计将 CHANGELOG 由“协作总线”调整为 L3 的原始证据之一。

## 2. 设计原则

1. **分层而非单一日志。** 热上下文、共享事实和长期档案使用不同的生命周期与检索路径。
2. **证据优先。** 高层记忆必须回链到任务、Git commit、测试、review 或可观测事件。
3. **最小权限。** Worker 只能提出记忆；Leader review 后才能提升团队记忆；Admin 才可发布项目级事实。
4. **范围隔离。** 记忆按 \`task → agent → team → project → global\` 分级，默认不跨 team 泄露。
5. **可替换后端。** 业务层只依赖 \`MemoryProvider\`，SQLite/FTS、向量库和图数据库均为可插拔实现。
6. **上下文预算可控。** 永远注入的内容必须有严格 token 上限，深层历史只按需检索。

## 3. 总体架构

\`\`\`text
                          ┌──────────────────────────────────────┐
                          │          MemoryService API           │
                          │ context / search / propose / review  │
                          │ claim / conflict-check / archive     │
                          └───────────────────┬──────────────────┘
                                              │
       ┌──────────────────────────────────────┼──────────────────────────────────────┐
       │                                      │                                      │
┌──────▼──────┐                       ┌───────▼────────┐                     ┌───────▼─────────┐
│ L1 热缓存    │                       │ L2 协作记忆     │                     │ L3 长期档案       │
│ Agent+Task  │                       │ SQLite + FTS5  │                     │ 文件/事件+向量   │
│ RAM / TTL   │                       │ WAL / 结构化   │                     │ 可选时间知识图   │
└──────┬──────┘                       └───────┬────────┘                     └───────┬─────────┘
       │                                      │                                      │
 当前任务与会话                     任务、团队、项目事实                  CHANGELOG、records、
 测试结果、阻塞项                   决策、资源声明、review               diff、事件、归档摘要
\`\`\`

### 3.1 L1：任务热缓存

**用途：** 当前 Agent 在当前任务内的短期工作记忆，优先为提示注入提供内容。

| 项目 | 设计 |
| --- | --- |
| 作用域 | \`agentId + taskId + sessionId\` |
| 后端 | 单 Orchestrator 首版使用进程内 \`Map\`；多实例部署时可替换为 Redis |
| 生命周期 | 任务开始创建；完成后保留短 TTL；会话重启时由 L2 摘要恢复 |
| 容量 | 每任务 1,000–2,000 tokens，LRU/MRU 淘汰 |
| 内容 | 任务目标、验收标准、已读/拟改文件、命令与测试结果、阻塞项、下一步、检索结果 |

L1 不是持久事实库。它仅允许通过工具写入，并校验 \`agentId\`、\`taskId\` 与当前运行队列的关联。

### 3.2 L2：结构化协作记忆

**用途：** 持久保存可共享、可审核的项目协作状态；这是首期实现的核心。

默认位置：\`<runtime.persistence.state_dir>/memory.sqlite\`。使用 SQLite 的 WAL 模式和 FTS5；单机、本地开发及恢复场景均无需额外服务。

主要记录：

- \`task_context\`：目标、范围、依赖、验收标准、阶段、关联 worktree；
- \`resource_claims\`：文件、目录、模块、API、数据库表和迁移声明；
- \`memory_items\`：事实、决策、风险、经验、测试证据和 review；
- \`review_records\`：Worker 自测交接和 Leader review 结论；
- \`memory_versions\`：更正、废弃和替代关系；
- \`memory_links\`：与任务、commit、CHANGELOG 段落、records 和事件的证据链接。

### 3.3 L3：长期档案与语义检索

**用途：** 保存完整历史，支持低频的跨任务、跨会话检索，不直接塞入每轮上下文。

首版存档来源为 CHANGELOG、daily records、任务事件、工具摘要、Git diff/commit、review 和已归档的 L2 版本。检索采用：

\`\`\`text
BM25 / FTS + 向量相似度 + scope 权重 + 时效衰减 + 可信度 + review 状态
\`\`\`

向量后端应可替换：本地实现可从 SQLite/文件索引开始，规模扩大后接 Qdrant。仅在需要“某事实在何时成立”“跨任务多跳关系”时才引入 Graphiti 一类的时间知识图。

## 4. 统一记忆模型

\`\`\`ts
type MemoryScope = "task" | "agent" | "team" | "project" | "global";
type MemoryKind = "fact" | "decision" | "risk" | "test_evidence" | "review" | "lesson";
type MemoryStatus = "proposed" | "reviewed" | "active" | "superseded" | "archived";

interface MemoryItem {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  kind: MemoryKind;
  content: string;
  structuredPayload?: Record<string, unknown>;
  confidence: number; // 0..1
  status: MemoryStatus;
  sourceRefs: Array<{ type: "task" | "commit" | "test" | "event" | "file"; id: string }>;
  createdBy: string;
  reviewedBy?: string;
  validFrom: string;
  validTo?: string;
  expiresAt?: string;
  supersedes?: string;
  version: number;
}
\`\`\`

任何被更正的记忆均创建新版本并标记旧版本为 \`superseded\`，禁止覆盖历史。

## 5. 角色、写入与提升流程

\`\`\`text
Worker：实现 + 自测
  └─ 写 L1 测试结果 / 向 L2 提交 proposed handoff
       └─ notify-complete
            └─ Leader review
                 ├─ 不通过：创建后续实现任务
                 └─ 通过：提升为 team reviewed/active，并归档至 L3
                      └─ Admin 可提升为 project 级决策或经验
\`\`\`

规则：

- Worker 不可直接创建 \`team\`、\`project\` 的 \`active\` 事实；
- 记忆提升必须引用至少一个证据；
- Leader 不得在仍有 Worker 任务排队或运行时完成 review；
- 自动 LLM 提取仅产生 \`proposed\` 内容，不能跳过审核；
- \`expiresAt\` 到期或置信度衰减的内容不自动删除，而是从默认检索中降权。

## 6. 与任务队列的集成

在创建任务前增加 L2 只读门禁：

\`\`\`text
create task
  → memory-check-conflicts(taskSpec)
  → 查询 active resource_claims、task_context 与显式 conflictKey
  → 无冲突：创建任务、登记 resource claim、初始化 L1
  → 有冲突：拒绝、串行化，或要求重新拆分为 truly independent 任务
\`\`\`

\`conflictKey\` 保留为人工声明的互斥键，但不应是唯一保护手段。任务规范应声明预期变更资源，例如路径、模块、API、迁移和测试目标。Leader 只能对真正无共享实现、文件和测试依赖的多任务派发设置 \`independent: true\`。

## 7. 工具与 HTTP 接口

建议在现有任务工具旁新增：

| 工具 | 责任 |
| --- | --- |
| \`memory-context-get\` | 按 token 预算读取 L1 + 已批准 L2 上下文 |
| \`memory-search\` | 对 L2/L3 做范围过滤的混合检索 |
| \`memory-propose\` | Worker/Leader 提交待审核记忆和证据 |
| \`memory-promote\` | Leader/Admin 审核并提升记忆状态 |
| \`memory-supersede\` | 使旧结论失效并链接替代项 |
| \`memory-claim-resources\` | 为任务登记受影响资源 |
| \`memory-check-conflicts\` | 在创建任务前检查资源、依赖与互斥键 |
| \`memory-forget\` | 基于审计原因归档或删除合法数据 |

所有工具应有同等的 REST API，Desktop 可用其展示 L1 活跃摘要、L2 review/资源占用、L3 检索结果和证据版本链。

## 8. Desktop 设计

新增三个页面或 Tab：

1. **当前上下文（L1）**：Agent、任务、TTL、当前摘要、测试状态、阻塞项；
2. **协作记忆（L2）**：待 review 条目、已批准决策、资源占用、冲突与任务依赖；
3. **记忆档案（L3）**：检索、来源证据、时间范围、版本/废弃链和删除审计。

原有任务看板应显示与任务关联的 L1/L2 状态，而不是只显示队列状态。

## 9. 分期实现

### Phase 0：契约与审计

- 定义 \`MemoryProvider\`、数据模型、权限规则和事件类型；
- 新增 migrations、备份和恢复策略；
- 保持 CHANGELOG 行为不变。

### Phase 1：L1 + L2（MVP）

- 实现内存热缓存、SQLite WAL、FTS5 和结构化 resource claims；
- 将任务创建前冲突检查接入现有队列；
- 接入 Worker self-test handoff 与 Leader review 提升流程。

### Phase 2：L3 检索

- 对 CHANGELOG、records、任务事件和 Git 证据建立归档；
- 实现关键词/向量混合检索、重排、来源展示和上下文预算；
- 增加 Desktop 记忆检索与审计视图。

### Phase 3：可选时间知识图

- 仅在跨任务时序、实体关联和多跳检索成为明确瓶颈时评估 Graphiti；
- 不改变业务工具契约，只新增 L3 Provider。

## 10. 验收指标

- Agent 重启后可恢复任务目标、测试结果和未决风险；
- 冲突任务在创建前可被拦截，并记录拦截原因；
- 每条项目级决策均可追溯到 task、review、commit、测试或事件；
- L1 提示注入不超过预设 token 预算；
- L3 检索结果总能展示来源、时间、置信度和审核状态；
- CHANGELOG 仍是人可读交付记录，但不再承担唯一记忆职责。

## 11. 开源项目参考

- [Letta / MemGPT](https://github.com/letta-ai/letta)：核心 memory blocks、recall 与 archival memory；其 [MemFS](https://github.com/letta-ai/letta-docs-md/blob/main/concepts/memfs/index.md) 说明了 Git 可审计记忆的价值。
- [Mem0](https://github.com/mem0ai/mem0/blob/main/docs/open-source/overview.mdx)：自托管记忆 API、抽取与检索；其 [Graph Memory](https://github.com/mem0ai/mem0/blob/main/docs/platform/features/graph-memory.mdx) 可作为混合检索与实体关联参考。
- [LangGraph Persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)：thread-scoped checkpoint 与跨线程 store 的清晰边界，适合作为 L1/L2 概念参考。
- [Graphiti](https://github.com/getzep/graphiti)：实时增量的时间知识图，适合可选的 L3 时序增强。
- [OpenMemory](https://github.com/CaviraOSS/OpenMemory/blob/main/docs/mcp.md)：通过 MCP 暴露存、查、列记忆工具的接口设计参考。

## 12. 非目标

- 首期不替换 pi-coding-agent runtime；
- 首期不强制部署 Redis、Qdrant、Neo4j 或 Graphiti；
- 不把任何未审核 LLM 推断当作项目事实；
- 不删除现有 CHANGELOG、records 或 observability 日志。
`;export{e as default};