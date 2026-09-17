# ADR 0002：Agent 私有记忆与文件共享知识

- 状态：已接受（第四批知识运维闭环）
- 日期：2026-09-16

## 决策

1. Admin、Leader、Worker 的记忆均为 Agent 私有资源。Agent 默认只能读取和维护自己的记忆。
2. 团队或项目共享的信息不再使用记忆 `scope` 表达，而进入文件支持的共享知识领域。
3. 共享知识的事实源是项目文件：Agent 显式发布文件，或用户上传文件到配置的知识目录。
4. 记忆和知识使用同一个 `memory.db`，并通过 `semantic_documents` 形成统一的可索引投影。
5. 两者复用 embedding、Zvec collection revision、Outbox、混合检索、熔断、重建和回滚策略；检索必须按资源类型和权限执行服务端过滤。
6. 不再新增中央做梦 Agent。后续由所属 Agent 在受限维护回合中整理自己的记忆；文件解析和索引由无人格后台服务完成。

## 权限矩阵

| 主体 | 自己的记忆 | 其他 Agent 记忆 | 本团队知识 | 项目知识 | 受限知识 |
| --- | --- | --- | --- | --- | --- |
| Worker | 读写 | 禁止 | 读取；发布权限另行配置 | 读取 | 显式授权 |
| Leader | 读写 | 禁止 | 读写 | 读取；发布权限另行配置 | 显式授权 |
| Admin | 读写 | 默认禁止 | 读写 | 读写 | 显式授权 |
| 用户 | 管理与审计 | 管理与审计 | 管理 | 管理 | 管理 |
| 外部 Agent | 禁止长期读取 | 禁止 | 禁止 | 禁止 | 显式能力授权后另议 |

## 数据约束

- `resource_type=memory` 必须同时满足 `visibility=private` 和 `owner_agent_id IS NOT NULL`。
- `resource_type=knowledge` 必须绑定知识源文件，且不能使用 `private` 可见性。
- Worker 事件的记忆所有者必须是 Worker 本身，不能映射给 Leader。
- 原始模型思考和流式 token 不进入记忆或共享知识。
- 私有记忆不能自动晋升为共享知识；共享必须以文件发布或用户上传为边界。

## 第一批兼容策略

- 现有线上读写仍由 Memory Repository 和旧 Memory Zvec 管线提供。
- SQLite v8 建立 Knowledge 与 Semantic 表，并通过触发器把现有记忆同步到 `semantic_documents`。
- 能从 `source_agent_id` 唯一确认的旧 Worker 记忆回迁给 Worker。
- 混合来源或唯一键冲突的旧记录进入 `memory_ownership_quarantine`，不猜测归属。
- 后续批次再由统一 Semantic Outbox 接管向量生产链，并实现文件摄取、知识检索和会话引用。

## 第二批实现边界

- Agent 在任务完成后启动 owner-scoped 维护回合，只领取、抽取、治理和晋升自己的记忆事件；运行记录写入 `maintenance_runs` 并发送显式状态事件。
- `KnowledgeService` 监听项目、团队和上传目录，按内容哈希修订文件，进行确定性分块，并把知识块投影到 `semantic_documents`。
- Knowledge 通过带 lease、重试与 dead-letter 状态的 Semantic Outbox，复用现有 embedding provider 和 active Zvec collection revision。
- 当前兼容窗口仍由旧 Memory Outbox 写入记忆向量，Semantic Outbox 只消费 Knowledge，避免重复向量；统一检索接管后再移除旧通道。
- 第二批先支持文本、Markdown、HTML、JSON/YAML/TOML/XML 与常见源码文件，PDF/DOCX 与检索引用在第三批接入。

## 第三批实现边界

- 任务下发前并行检索 Agent 私有记忆和共享知识；两类上下文使用独立标签，并明确声明检索内容是参考数据而不是新的操作指令。
- Knowledge 检索采用 lexical + Zvec Dense/FTS 的 RRF 合并。Zvec 先按项目、`KNOWLEDGE` 类型和可见性过滤，命中结果再由 SQLite canonical document 执行权限 hydration。
- Admin 可读取项目知识和各团队知识；Leader、Worker 可读取项目知识及所属团队知识；restricted 知识始终要求显式 Agent 授权。
- 每次命中的知识以结构化 `KnowledgeReference` 写入任务快照，并通过 `knowledge.context.injected` 推送；Desktop 在模型思考之前独立展示“参考知识库”。
- 文件摄取新增 PDF 文本提取和 DOCX 原始文本提取；扫描件 PDF 暂不包含 OCR。
- Active Zvec 检索允许 Worker 读取自己的私有记忆，但仍通过 owner filter 和 canonical hydration 阻止读取其他 Agent 记忆。

## 第四批实现边界

- Orchestrator 提供知识运维快照、主动扫描、失败重试和用户上传删除接口；快照统一展示知识源、分块和 Semantic Outbox/索引状态。
- Desktop 增加“共享知识库”管理页。用户可选择文件并指定项目级或团队级范围；Electron 主进程读取本地文件，通过受信 IPC 以二进制流传给 Orchestrator，Renderer 不获取任意文件路径或读取能力。
- 上传文件写入配置的 `knowledge.roots.uploads` 事实源目录，并继续走既有解析、确定性分块、`semantic_documents` 与 Zvec 同步链，不建立旁路存储。
- 项目工作区和 Agent 产出文件在管理页只读；删除操作仅允许 `origin=user_upload` 且 canonical path 位于上传根目录的文件，避免知识管理接口成为任意文件删除能力。
- 团队上传使用 `uploads/teams/<teamId>` 的文件布局并投影为 `visibility=team`；项目上传使用 `uploads/project` 并投影为 `visibility=project`。旧上传根目录下的文件仍按项目知识兼容。
