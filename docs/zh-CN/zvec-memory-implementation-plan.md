# Zvec 增强记忆系统：分步实施方案

> 状态：实施完成（M00～M15 已完成；主动检索保持 opt-in）  
> 方案版本：1.16  
> 制定日期：2026-09-03  
> 最近更新：2026-09-14  
> 适用范围：OAT Orchestrator、Desktop、本地进程与 Docker Agent 运行模式

## 1. 决策摘要

采用“SQLite 权威存储 + Zvec 可重建混合检索索引”的双层架构。

- SQLite 继续保存事件、记忆正文、证据链、状态、权限、版本、遗忘记录和注入审计。
- Zvec 只保存检索所需的标量字段、全文字段和 embedding，是派生索引，不是唯一数据源。
- L1 工作记忆继续按时间读取，不进入向量索引；L2/L3 才进入 Zvec。
- 默认仍使用现有词法检索。Zvec 必须经过兼容性、召回质量、隐私和故障降级验收后才能默认启用。
- 每个项目只有一个 Zvec 写入者。Agent 进程和 Docker 容器不得直接打开 collection。
- embedding 模型、维度或 vector schema 变化时创建新 collection 并重建，不原地修改 vector 字段。
- Embedding Profile 一旦被 Project 引用即按不可变版本管理；模型身份变化通过新 Profile 或显式 `revision` 表达，禁止静默覆盖后继续使用旧向量。
- 重建采用 sibling collection、旧新索引双写和原子切换；构建失败继续使用旧索引或 lexical，不影响 Agent 任务。
- 第一阶段不接入 Mem0、Graphiti、Neo4j 或独立向量数据库服务。

## 2. 官方资料使用规则

后续任何 Zvec 实现或评审任务都必须先执行以下步骤：

1. 读取 <https://zvec.org/llms.txt>，获取当前官方文档索引。
2. 从索引中选择与本次任务直接相关的页面。
3. 使用索引声明的 Markdown 地址读取页面：
   `https://zvec.org/mdx/{lang}/docs/{path}.md`。
4. 只加载必要页面，不能用旧代码片段替代当前文档。
5. 若项目内 Skill、类型声明与当前官方 MDX 冲突，以当前 MDX 和实际安装版本的 TypeScript 类型为准，并在实现记录中写明差异。

本方案制定时读取了以下页面：

- [AI-Friendly](https://zvec.org/mdx/en/docs/db/ai-friendly.md)
- [Data Modeling](https://zvec.org/mdx/en/docs/db/concepts/data-modeling.md)
- [Collection Schema](https://zvec.org/mdx/en/docs/db/collections/create/schema.md)
- [Open Collection](https://zvec.org/mdx/en/docs/db/collections/open.md)
- [Optimize](https://zvec.org/mdx/en/docs/db/collections/optimize.md)
- [Schema Evolution](https://zvec.org/mdx/en/docs/db/collections/schema-evolution.md)
- [Upsert](https://zvec.org/mdx/en/docs/db/data-operations/upsert.md)
- [Delete](https://zvec.org/mdx/en/docs/db/data-operations/delete.md)
- [Filter Query](https://zvec.org/mdx/en/docs/db/data-operations/query/filter.md)
- [Hybrid Query](https://zvec.org/mdx/en/docs/db/data-operations/query/hybrid.md)
- [Full-Text Search](https://zvec.org/mdx/en/docs/db/data-operations/query/fts.md)
- [Embedding](https://zvec.org/mdx/en/docs/db/embedding.md)
- [Vector Embedding](https://zvec.org/mdx/en/docs/db/concepts/vector-embedding.md)
- [Reranker](https://zvec.org/mdx/en/docs/db/reranker.md)
- [Node.js Build](https://zvec.org/mdx/en/docs/db/build/node.md)

项目已安装 Zvec 官方 Agent Skill：

```text
.agents/skills/zvec/
```

安装来源：`zvec-ai/zvec-agent-skills` 的 `skills/zvec`，安装时上游 HEAD 为
`afc3d613b30458475dca7d211df668a80446a062`。后续升级 Skill 时必须先审阅差异，并同步更新此版本记录。

官方 Skill 用于 API、Schema 和索引选型参考；本方案负责 OAT 特有的数据权威性、权限、任务拆分、迁移和验收约束。

### 已知文档差异

安装的官方 Skill 中存在“可动态增删 vector 字段”的表述，但 2026-09-03 当前官方 Schema Evolution MDX 明确标记增删 vector 字段暂不支持。因此本项目必须采用新 collection 重建策略。实现时还必须用锁定版本的 TypeScript 声明和最小可运行测试确认实际 API，不能照抄 Skill 示例。

M01 实测还确认 `@zvec/zvec` 0.7.0 没有显式 flush API，因此方案中后续步骤出现的“flush”均应解释为完成 batch status 检查、关闭 collection 并以重开读取验证 durability，而不是调用不存在的方法。详见 [ADR-0001](./adr/0001-zvec-node-electron-compatibility.md)。

M02/M03 实施时保持 Zvec 默认不参与运行：`MemoryService` 通过接口组合 SQLite repository、lexical retriever 与 no-op index。M06-A 已把 SQLite 权威 schema 升级到 `user_version=3`；没有具体 collection identity 时不再生成虚构的 `target_index='default'` 任务。由 collection registry 注册真实 revision 后，repository 才会为 active L2/L3 建立 membership 和可消费任务。delete 消息继续使用稳定 tombstone hash，重复忘记不会制造重复删除任务。

M04 根据当前官方文档确认：Zvec 的现成 Embedding 扩展主要面向 Python，OAT 的 Node/Electron 路径由独立 `EmbeddingProvider` 生成向量。聊天模型与 Embedding Profile 分开注册；Profile 为全局资源，Project 只保存引用，Zvec collection schema 和 manifest 必须从解析后的引用派生。

方案 1.4 补充模型演进约束：dense vector 的维度是 Zvec Schema 固定属性，模型变化即使维度相同也可能改变语义空间。远端服务还可能在相同 model/deployment 名称下替换权重，因此仅比较模型名和维度不足以保证兼容；Profile 必须支持由管理员递增的显式 `revision`，所有兼容性判断以冻结后的 identity 为准。

M05-A 已完成纯 Node.js/TypeScript 身份与文件生命周期基础，不导入或打开 `@zvec/zvec` collection：Profile `revision` 默认兼容旧配置；manifest 冻结无密钥的 Embedding 快照；文件 registry 与 `active.json` 使用同目录临时文件、file sync、原子 rename 和 `0600` 权限写入；Project 目录使用 slug + SHA-256 后缀，collection 目录只接受 revision。实际 Zvec Schema 核验、create/open/close 属于 M05-B。

M05-B 已使用 `@zvec/zvec` 0.7.0 Node SDK 实现真实 collection 生命周期。所有同步原生 API 都在单个共享 Worker Thread 内执行，`ZVecInitialize` 在 Worker 中只调用一次；主线程只执行异步 RPC 和 manifest/registry 预检。固定 Schema 使用 Jieba FTS、权限/状态倒排字段、时间范围字段及 FP32/COSINE Dense Vector。实测 Node binding 的 `enableRangeOptimization` 省略时回读为 `true`，因此实现对普通倒排字段显式写 `false`，只对三个时间字段写 `true`。

M06-A/M06-B 已实现多 revision 同步状态与显式消费器。SQLite 保存 collection registry、每条 memory 对每个 revision 的 membership，以及带 owner/expiry 的 outbox lease；过期 lease 可被新 worker 回收。Index Worker 仅接受与 collection 冻结 identity 一致的全局 Embedding Provider，批量生成向量后调用 Node SDK `upsertSync`/`deleteSync`，逐条检查 status，并在 close/reopen + fetch 验证后才提交 outbox checkpoint。可重试错误使用指数退避，非重试错误或超过上限进入 dead letter；索引失败被隔离在 worker 结果中，不向 Agent 任务抛出。生产调度器会在 Project 启动时立即消费 active collection 的增量 Outbox，此后每 5 秒执行单飞批次；生命周期迁移期间自动让路，停机等待在途批次。默认 lexical 行为仍不变。

M07-A/M07-B 已完成可恢复重建生命周期。SQLite `user_version=4` 新增持久化 migration 状态、snapshot watermark、暂停/失败原因和进度基数；全局低优先级队列默认串行，不允许同一 Project 重复排队。重建创建 sibling collection，active/building/ready revision 同步接收 canonical 变更，目标必须在 outbox 零积压、membership/hash 一致、文档数一致、向量维度一致、抽样 fetch 一致且 optimize 完成后才能 ready。激活以原子替换 `active.json` 为提交点，提交后把旧 active 收敛为 retained retired；重启可根据 pointer 完成未结束的元数据收敛。402 会持久化为 paused，只有显式 resume 才重试 dead letter。显式 rollback 会先把 retained collection 重新追平再切换；显式 cleanup 同时检查 active pointer、生命周期和保留期后才调用 Node SDK `destroySync`。索引目录丢失时可按 SQLite 权威数据以相同 identity 全量重建。

M08 已实现只读 Shadow 混合检索。`shadow=true` 且 backend 为 `zvec_fts`/`zvec_hybrid` 时，`MemoryService` 惰性解析 active pointer 和 manifest，并通过 Node SDK 只读打开 collection；Hybrid 额外解析全局 Embedding Profile 并校验 identity，FTS-only 不需要 query embedding。Dense 与 Jieba FTS 按 Zvec API 限制分别查询，再和 SQLite exact 结果做 RRF、SQLite 回表二次鉴权与治理重排。影子结果只写入 `memory_retrieval_runs`，实际 prompt 仍严格使用 lexical 结果。无 active collection、Hybrid 的 Embedding 缺失/不匹配、查询超时、collection 损坏和 filter 拒绝均只记录脱敏降级原因，不阻塞 Agent。由于 Zvec 0.7.0 未提供有文档保证的字符串转义语法，filter 的动态字符串只接受不含引号和控制字符的值；不可表示值 fail closed，并由应用层权限校验承担最终边界。

M09 已实现真实 Node SDK 的确定性评测器，使用同一 M00 corpus 比较 lexical、dense、FTS、hybrid、hybrid+governance，输出 Recall@5、MRR、中文/改写 Recall、错误注入率、越权命中、P50/P95 和 Prompt token 估算。CI G2 固定门禁要求总体、中文和改写召回分别至少提升 0.20/0.40/0.50，越权为零、错误率不恶化、P95 不超过 100ms、平均 token 不超过 lexical 的 1.25 倍。确定性语义 fixture 下 `hybrid_governance` 通过门禁；这只证明检索管线，不替代 M10 对实际 Embedding Profile 的项目级评测。完整结果见 [M09 评测报告](./memory-retrieval-evaluation-m09.md)。

M10 已实现受控主动检索。Project 必须选择 Zvec backend，同时由 `~/.oat/oat.json` 的全局开关和精确 `project.name` 白名单双重授权；不支持通配符。`shadow=true` 始终优先。主动模式保留 SQLite 时间序 L1，仅用 Zvec 替换 L2/L3；整体超时或失败自动 lexical 回退，并由连续失败熔断、冷却和单次半开探测限制故障放大。部分检索路由降级时保留其他安全路由结果，并在 `/memory/overview` 与 Desktop 暴露实际 backend、熔断、回退计数和脱敏原因。提示预算按 L1、L3、L2 顺序执行。完整操作见 [M10 运行手册](./memory-active-retrieval-m10.md)。

M11 已实现可选结构化 `MemoryExtractor`。Project 通过独立模型引用选择 OpenAI-compatible 或 Anthropic 提取模型；请求使用 strict JSON Schema/强制 tool schema，响应还必须通过本地严格 Zod 校验。输入字符、输出 token、单事件事实数、超时和跨轮尝试次数均有上限。模型输出经过确定性 scope/trust 治理：内部 Admin 最大 project、Leader 最大 team，Channel/A2A 强制 private 且 trust 分别不高于 40/30。事实只写为非索引 L2 `candidate`，保留事件来源、模型和 extraction version，不召回、不注入、不自动晋升 L3。无可用模型时保持原确定性沉淀。详见 [M11 运行手册](./memory-structured-extraction-m11.md)。

M12 已实现确定性候选治理。subject/predicate/object 完全一致的候选合并来源并按 `sourceType + sourceAgent + task` 计算独立证据；同一 subject/predicate 的不同 object 建立双向 `contradicts`，旧 active 仍是唯一当前事实但注入时带冲突警告。配置有效期在激活前执行，过期候选直接转为历史。可用全局 Embedding Profile 只生成 `semantic_duplicate` 审查建议，不能覆盖或激活事实。可信内部候选达到两个独立证据后可激活，trust 低于 80 或包含 Channel/A2A 来源不会自动激活；L3 自动晋升还要求 trust 至少 90、无冲突及足够独立证据。用户可确认候选，确认新冲突事实时旧 active 原子转为 superseded，并保留 supersedes/contradicts 历史。详见 [M12 运行手册](./memory-governance-m12.md)。

M13 已实现统一 `MemoryActor/MemoryPolicy`。Admin 读取当前项目的 project/team/global 记忆但不能读取其他主体的 private；Leader 默认只读本团队、本人 private 和项目内 global，project scope 必须由服务端显式授予；正式 Worker 与 A2A 外部 Worker 均无长期记忆读取权。外部 Worker 只能提交 trust 不高于 30 的 private candidate，无法写 canonical memory。Zvec 标量 filter 与 SQLite 回表使用同一 Actor，后者是最终授权边界。资源主管通过带启动期 capability 的在线项目 Orchestrator 只读端点进行联邦搜索，离线项目不直读 SQLite/Zvec，无令牌请求 fail closed。schema v7 的 `memory_access_audit` 记录读取、注入、候选写入、治理及人工修改的允许/拒绝结果。详见 [M13 运行手册](./memory-access-control-m13.md)。

M14 已实现 Desktop「全局设置 → 记忆管理」和服务端 `MemoryOperations` 门面。页面按 Project 汇总检索回退、Embedding/collection identity、active pointer、pending/dead letter、完整度、磁盘估算、后台进度、retrieval trace 与访问审计；重建、继续、激活和回滚采用后台 job，并由前后端双重确认。重建在服务端检查保守磁盘预算，暂停在 batch 边界生效。已引用 Embedding Profile 禁止原地修改或删除，Desktop 会区分显式引用、继承全局默认和显式禁用的 Project 并预览影响。页面和 API 不返回 secret、完整 prompt 或 vector，现有 Agent 页面交互保持不变。详见 [M14 运行手册](./memory-desktop-operations-m14.md)。

M15 已完成发布实现与默认值评审。Windows Desktop 从不兼容的 ia32 改为 x64；当前 CI 只构建 macOS arm64 与 Windows x64 App，不构建 Linux App。受支持的 binding 作为精确 optional dependency 固定。跨 Project 重建增加 `~/.oat/locks` 跨进程租约，峰值磁盘预算纳入 sibling collection、索引放大和 25% 临时空间。新增带 SQLite integrity/SHA-256/Project 校验的在线备份与停机恢复命令，恢复时保留旧数据库并隔离 Zvec 派生目录。发布检查固化版本、许可证、架构和 asar 约束。由于签名/公证和各生产 Profile 的项目级评测仍需外部证据，评审结论是保持 lexical 默认与 Zvec opt-in。详见 [M15 发布评审](./memory-release-m15.md)。

## 3. 当前实现基线

当前 `MemoryService` 已具备：

- 项目级 SQLite 数据库；
- WAL、外键、busy timeout；
- L1/L2/L3 记忆；
- Admin/Leader/Worker 事件归属；
- 基础脱敏和长度限制；
- 空闲“做梦”整理；
- `candidate/active/superseded/disputed/forgotten` 状态；
- 注入审计、手动晋升和遗忘 API；
- active collection 的常驻增量 Index Worker、单飞调度、失败隔离和优雅停机；
- 检索失败不影响当前任务的基本能力。

当前主要不足：

1. 语义相似只生成审查建议，不能在无人确认时合并或覆盖事实。
2. 生产 Embedding Profile 仍需逐 Project 运行质量评测。
3. macOS x64 缺少 Zvec 0.7.0 binding，签名/公证及其他目标平台 packaged smoke 仍需以发布 CI 产物为准，因此主动检索保持 opt-in。

## 4. 目标架构

```text
Observability events / task reports / user decisions
                       │
                       ▼
              Capture + redaction
                       │
             SQLite transaction
          ┌────────────┴────────────┐
          ▼                         ▼
  canonical memory rows       memory_index_outbox
  evidence / ACL / version           │
                                      ▼
                           EmbeddingProvider
                                      │
                                      ▼
                           single Index Worker
                                      │
                                      ▼
                         Zvec project collection

Prompt ──► query embedding ──► ACL/filter ──► Dense + FTS recall
                                                │
                                                ▼
                                RRF + governance reranking
                                                │
                                                ▼
                              dedupe + token budget + audit
                                                │
                                                ▼
                                           Agent prompt
```

### 4.1 组件边界

```ts
interface MemoryRepository {
  get(id: string): MemoryRecord | undefined;
  list(query: MemoryListQuery): MemoryRecord[];
  saveCandidate(input: MemoryCandidate): MemoryRecord;
  transition(id: string, transition: MemoryTransition): MemoryRecord;
  enqueueIndexMutation(mutation: MemoryIndexMutation): void;
}

interface MemoryIndex {
  open(): Promise<void>;
  upsert(records: IndexedMemory[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  search(query: MemoryIndexQuery): Promise<MemoryIndexHit[]>;
  stats(): Promise<MemoryIndexStats>;
  close(): Promise<void>;
}

interface EmbeddingProvider {
  readonly identity: { provider: string; model: string; dimensions: number };
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

interface MemoryExtractor {
  extract(events: MemoryEventInput[]): Promise<MemoryCandidate[]>;
}

interface MemoryRetriever {
  retrieve(input: MemoryRetrievalInput): Promise<MemoryRetrievalResult>;
}

interface MemoryPolicy {
  canRead(actor: MemoryActor, memory: MemoryRecord): boolean;
  canWriteCanonical(actor: MemoryActor, candidate: MemoryCandidate): boolean;
  rank(actor: MemoryActor, query: string, hits: MemoryHit[]): MemoryHit[];
}
```

`MemoryService` 负责协调，不直接依赖 `@zvec/zvec` 的具体类型。

## 5. 数据设计

### 5.1 SQLite 仍为权威数据源

在现有表基础上增量迁移，禁止删除已有数据库：

```text
memory_items 新增：
- schema_version INTEGER
- scope TEXT                 private/team/project/global
- trust_level INTEGER        0..100
- subject TEXT NULL
- predicate TEXT NULL
- object_json TEXT NULL
- valid_from TEXT NULL
- valid_to TEXT NULL
- supersedes_id TEXT NULL
- contradiction_ids TEXT     JSON array
- content_hash TEXT
- extraction_model TEXT NULL
- extraction_version TEXT NULL
- independent_evidence_count INTEGER
- governance_version TEXT NULL
- confirmed_at/confirmed_by TEXT NULL
- index_state TEXT            pending/indexed/failed/not_applicable

memory_index_outbox：
- id TEXT PRIMARY KEY
- memory_id TEXT NOT NULL
- operation TEXT              upsert/delete
- target_index TEXT           具体 collection_revision，禁止使用逻辑名 default
- content_hash TEXT
- attempts INTEGER
- next_attempt_at TEXT
- status TEXT                 pending/processing/completed/dead_letter
- error TEXT NULL
- created_at/updated_at TEXT
- UNIQUE(memory_id, operation, content_hash, target_index)

memory_index_memberships：
- memory_id TEXT NOT NULL
- collection_revision TEXT NOT NULL
- content_hash TEXT NOT NULL
- embedding_revision TEXT NULL
- status TEXT                 pending/indexed/failed/deleted
- indexed_at TEXT NULL
- error TEXT NULL
- PRIMARY KEY(memory_id, collection_revision)

memory_index_registry：
- collection_revision TEXT PRIMARY KEY
- project_id TEXT NOT NULL
- embedding_revision TEXT NULL
- state TEXT                  building/ready/active/retired/failed
- path TEXT NOT NULL
- snapshot_watermark TEXT NULL
- document_count INTEGER
- created_at/ready_at/activated_at/retired_at TEXT NULL

memory_retrieval_runs：
- id, agent_id, query, scope_json
- backend, embedding_identity
- candidate_ids, selected_ids
- latency_ms, fallback_reason
- created_at

memory_feedback：
- id, retrieval_run_id, memory_id
- signal                     used/ignored/helpful/harmful/stale
- task_id, created_at

memory_relations：
- source_memory_id
- relation                   supersedes/contradicts/depends_on/applies_to/verified_by
- target_memory_id
- valid_from/valid_to
- confidence
- source_event_id

memory_candidate_matches：
- candidate_memory_id / target_memory_id
- match_type                 exact_duplicate/semantic_duplicate/conflict
- score / status             suggested/accepted/rejected
- governance_version / created_at

memory_governance_runs：
- candidate_memory_id / canonical_memory_id
- action / independent_evidence_count / auto_promoted_l3
- semantic_identity / semantic_error / governance_version / created_at

memory_access_audit：
- action / decision / reason
- actor_id / actor_role / actor_employment
- actor_project_id / actor_team_id / requested_project_id
- memory_ids / metadata_json / created_at
```

迁移必须幂等；老数据先按 `scope=project`、来源 trust 和索引状态完成兼容迁移，M13 再把 schema v2 且带 team 的 Leader L2/L3 默认归属修正为 `scope=team`；结构化 schema v3 的显式 scope 不改写。`memory_items.index_state` 仅保留为汇总状态，双索引迁移期间每个 collection 的真实状态以 `memory_index_memberships` 为准，避免同一记忆在旧索引已完成、在新索引仍待处理时被一个字段错误覆盖。

### 5.2 Zvec collection

每个项目、每个 collection identity 使用独立 collection。Zvec 不支持跨 collection 查询，因此第一阶段不把一个项目拆成 L2/L3 两个 collection，也暂不拆分 FTS 与 Dense collection。模型迁移期间同一 Project 最多同时存在一个 `active` 和一个 `building` collection。

建议目录：

```text
<state_dir>/memory/zvec/
  <project-id-safe>/
    collections/
      <collection-revision>/
        collection files...
        oat-index-manifest.json
    active.json
```

`active.json` 只保存当前激活的 `collectionRevision`，必须通过同目录临时文件写入、同步并原子 rename；collection 目录名不得直接使用未经清洗的 provider、model 或 Project 输入。

建议 Schema：

| 字段 | 类型 | 索引 | 说明 |
| --- | --- | --- | --- |
| `content` | STRING | FTS | 摘要与可检索正文 |
| `project_id` | STRING | INVERT | 强制项目过滤 |
| `owner_agent_id` | STRING | INVERT | Agent 范围 |
| `team_id` | STRING nullable | INVERT | Team 范围 |
| `scope` | STRING | INVERT | private/team/project/global |
| `level` | STRING | INVERT | 仅 L2/L3 |
| `kind` | STRING | INVERT | fact/decision/procedure 等 |
| `status` | STRING | INVERT | 只召回 active/disputed |
| `trust_level` | INT32 | INVERT | 来源信任等级 |
| `valid_from_ms` | INT64 | INVERT + range | 生效时间 |
| `valid_to_ms` | INT64 nullable | INVERT + range | 失效时间 |
| `updated_at_ms` | INT64 | INVERT + range | 时间衰减 |
| `salience` | FLOAT | 无 | 应用层重排 |
| `confidence` | FLOAT | 无 | 应用层重排 |
| `content_hash` | STRING | INVERT | 索引幂等与漂移检测 |
| `dense_embedding` | VECTOR_FP32 | FLAT 初始；规模达标后评估 HNSW | 语义召回 |

重要约束：

- 文档 `id` 必须等于 SQLite `memory_items.id`。
- Zvec 中不保存完整证据正文、凭据或唯一副本。
- 所有过滤字段建立倒排索引；过滤表达式必须由白名单 builder 生成，禁止拼接外部字符串。
- embedding 维度必须与 Schema 完全一致。
- 文档 embedding 和查询 embedding 必须来自完全相同的 `embeddingRevision`；相同维度不代表语义空间兼容。
- 只有 API key、timeout、batch size、重试次数等运行参数变化时才允许复用 collection。
- 模型、显式 revision、endpoint、dimensions 或 normalization 变化时必须创建 sibling collection 并重新 embedding 全部 active L2/L3。
- metric 或 vector schema 变化必须重建 vector index；即使 Zvec 支持原地替换索引，生产迁移默认仍使用 sibling collection 以保留回滚能力。
- 初期真实规模预计小于 100k，按官方 Skill 建议优先 FLAT 以获得精确基线；只有评测证明需要时才迁移到 HNSW。
- `ZVecInitialize()` 在索引所有者进程中只调用一次，并且发生在打开 collection 前。
- 每批写入必须检查每个 status，不能把批量调用未抛异常视为全部成功。
- 不在每条写入后执行 optimize；按未优化数量、空闲窗口和延迟指标触发。

### 5.3 Index manifest

`oat-index-manifest.json` 至少记录：

```json
{
  "formatVersion": 1,
  "projectId": "example",
  "collectionRevision": "sha256-prefix",
  "embeddingRevision": "sha256-prefix",
  "embedding": {
    "profile": "memory-v2",
    "provider": "openai-compatible",
    "model": "example-embedding-model",
    "dimensions": 768,
    "normalization": "provider-default",
    "revision": "2026-09-03"
  },
  "metric": "cosine",
  "schemaVersion": 1,
  "indexProjectionVersion": 1,
  "state": "building",
  "documentCount": 0,
  "createdAt": "ISO-8601",
  "readyAt": null,
  "lastRebuildAt": "ISO-8601"
}
```

身份分为三层：

```text
embeddingRevision
  = kind + provider + endpoint + model + dimensions + normalization + explicitRevision

collectionRevision
  = embeddingRevision + metric + index + vectorSchemaVersion + indexProjectionVersion

runtimeRevision
  = timeout + batchSize + maxAttempts
```

API key 不进入任何 revision；`runtimeRevision` 变化不触发重建。打开索引前必须同时验证实际 Zvec Schema、manifest 和当前解析配置；不一致时禁止混写，转入新索引重建或 lexical。manifest 写入不得包含 API key。

## 6. 写入、遗忘和恢复协议

### 6.1 写入

1. 捕获事件并脱敏。
2. SQLite 事务内写入记忆或候选。
3. 同一事务写入 outbox。
4. 单写者按批次领取 outbox。
5. 生成 embedding。
6. 调用 Zvec upsert 并逐项检查 status。
7. 成功后将 outbox 和对应 `memory_index_memberships` 标记完成，并更新汇总 `index_state`。
8. 失败指数退避；超过阈值进入 dead letter，但不得阻塞 Agent 当前任务。

### 6.2 遗忘

1. SQLite 先把记忆标记为 `forgotten` 并产生 delete outbox。
2. 检索 SQL 和 Zvec filter 都立即排除该状态。
3. 异步删除 Zvec 文档。
4. 删除失败不恢复记忆可见性。
5. 保留最小审计 tombstone，不在日志记录正文。

### 6.3 索引损坏或漂移

- Zvec 打不开、manifest 不匹配或文档 checksum 漂移时，检索自动降级为 SQLite 词法模式。
- 创建 sibling 临时 collection，从 SQLite active L2/L3 全量重建。
- 完成数量、随机抽样和查询烟测后原子切换目录指针。
- 旧 collection 延迟清理，清理必须由显式维护流程执行。
- Agent 任务不能因为 Zvec 不可用而失败。

### 6.4 Embedding 模型与维度迁移

变更分类：

| 变更 | 重新 embedding | 新建 collection | 处理 |
| --- | --- | --- | --- |
| API key、timeout、batch size、max attempts | 否 | 否 | 仅刷新运行配置 |
| model 或显式 revision | 是 | 是 | 全量重建，维度相同也不能复用旧向量 |
| dimensions | 是 | 是，强制 | 旧 vector schema 不兼容 |
| endpoint 或 normalization | 是 | 是 | 默认视为向量空间变化 |
| metric、vector schema、投影版本 | 视投影而定 | 是 | 可复用向量时允许跳过远端 embedding，但仍建 sibling collection |
| FLAT/HNSW 参数 | 否 | 默认是 | 保守使用 sibling collection；未来可在独立优化任务中评估原地换索引 |

在线迁移协议：

1. 解析并冻结目标 Profile，生成新的 `embeddingRevision` 和 `collectionRevision`；运行中不再读取该 Profile 的可变字段。
2. 在 registry 创建状态为 `building` 的 sibling collection；同一 Project 同时最多允许一个 building revision。
3. 记录 SQLite 全量快照 watermark，为全部 active L2/L3 创建指向新 revision 的 backfill outbox。
4. watermark 之后的 upsert/delete 同时投递 active 与 building revision；旧新 collection 都只有同一个串行写入所有者。
5. 验证文档数量、content hash、embedding 维度、随机抽样和固定查询 smoke；任一校验失败则标记 `failed`，不切换。
6. 先让新 collection 达到 watermark 后零积压，再通过 `active.json` 与 registry 原子切换 active revision。
7. 切换后新写入只投递新 revision；旧 collection 标记 `retired` 并保留可配置回滚期。
8. 清理必须检查 active pointer、打开句柄和回滚期限，由显式维护动作执行，不允许重建任务自行删除旧目录。

失败与降级规则：

- 目标 Profile 缺失、402、持续 429、维度校验失败或重建中断：停止或暂停新索引，不终止 Agent；继续查询旧 active collection，无法生成旧模型查询向量时降级 lexical。
- 用户显式关闭 Dense：立即停止 dense 查询和新 embedding，旧 collection 只进入保留期，不立即删除。
- Profile 被多个 Project 引用：为每个 Project 创建独立重建任务，使用全局低优先级队列限流，禁止同时无上限重建。
- 相同 model/deployment 名称背后的权重静默变化无法自动可靠识别；必须通过 Profile `revision` 变化显式触发迁移。
- 不允许使用新模型生成的查询向量访问旧 collection，也不允许因为维度相同而跳过模型迁移。

## 7. Embedding 设计

第一阶段定义接口，不把 embedding 绑定到 Zvec Python 扩展。

支持顺序：

1. `disabled`：只使用 FTS/当前词法检索。
2. `openai-compatible`：独立 embedding endpoint/model 配置。
3. `local`：后续引入本地模型，必须单独评估安装体积、首次下载、CPU/Metal 占用和离线许可。

要求：

- 文档与查询必须使用同一模型、维度和规范化策略。
- 批处理、超时、限流和重试必须有边界。
- API key 不进入 SQLite、Zvec、日志、manifest 或可观测事件。
- 402、429、网络错误只使索引任务重试或检索回退，不能终止 Agent 进程。
- 测试使用确定性 FakeEmbeddingProvider，不能调用外部 API。
- 更换模型时双索引构建，完成后切换；不在原 collection 混合 embedding。

### 7.1 重建资源预算

每次重建开始前计算并展示估算值：

```text
待处理条数 = active L2 + active L3
Embedding 请求数约 = ceil(待处理条数 / batchSize)
Embedding token 成本约 = 全部待索引文本 token 总量
向量裸数据字节约 = 待处理条数 × dimensions × 4
迁移磁盘峰值约 = SQLite + 旧 collection + 新 collection + 临时开销
```

以上估算不包含 HNSW 图、FTS、倒排索引和文件系统放大。全局调度器必须限制并发 Project 数、Embedding QPS、CPU、内存和临时磁盘占用；正常任务的模型调用优先级高于历史重建。

## 8. 结构化提取与记忆治理

向量索引上线不依赖 LLM 提取。先索引现有 L2/L3，稳定后再增加提取器。

提取器只输出候选：

```text
fact / decision / preference / procedure / failure_pattern / constraint
subject / predicate / object
summary / searchable_text
valid_from / valid_to
confidence / proposed_scope
source_event_ids
```

治理规则：

- LLM 不决定访问权限；scope 由确定性策略收紧。
- 用户明确决定、代码/测试证据、Admin/Leader 汇报具有不同 trust level。
- Channel 输入和外部 A2A Worker 输出默认低信任。
- 外部 Worker 不能直接写 canonical memory，只能产生候选证据。
- 语义相似只用于生成“可能重复/冲突”候选，不能自动覆盖旧事实。
- `supersedes` 必须保留旧版本及有效期。
- L3 晋升要求人工确认或多个独立成功证据，不能只看重复文本次数。

## 9. 检索与提示注入

### 9.1 权限先于相似度

过滤顺序：

1. `project_id`；
2. `status`；
3. 当前时间的有效期；
4. actor 可见 scope；
5. team/owner；
6. trust threshold；
7. 才执行向量和全文召回。

角色默认值：

- Admin：项目范围，读取项目及下属团队聚合记忆。
- Leader：本团队以及显式授权的项目记忆。
- Worker：不拥有长期索引读取权，只由 Orchestrator 注入当前任务最小上下文。
- 外部 A2A Worker：与 Worker 相同，且来源标记 `external`。
- 资源主管：只能通过项目 Orchestrator 的受控搜索 API 联邦读取；不能直接绕过项目权限打开 collection。

### 9.2 混合召回

建议流水线：

```text
Dense top 30 + FTS top 30 + exact identifiers
                    │
                    ▼
                 RRF 融合
                    │
                    ▼
confidence + salience + trust + recency + task affinity
                    │
                    ▼
冲突折叠 + 相似去重 + 每来源/类型上限
                    │
                    ▼
token budget 裁剪，通常保留 5~10 条
```

最终排序必须在 OAT 应用层完成，以便执行权限、时间和治理规则。Zvec score 不能直接成为是否注入的唯一标准。

### 9.3 回退

- embedding 超时：FTS + SQLite 词法。
- Zvec 查询失败：SQLite 词法。
- FTS 无结果：dense 结果仍可使用。
- dense 无结果：FTS 结果仍可使用。
- 两者都无结果：仅注入 L1，不能阻塞 prompt。

所有回退原因进入 `memory_retrieval_runs`，但不记录秘密或完整用户正文。

## 10. 配置

全局 Provider、聊天模型与 Embedding Profile 保存在 `~/.oat/models.json`：

```json
{
  "providers": {
    "openai": {
      "compatible_type": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "..."
    }
  },
  "models": {
    "coding-default": "gpt-5"
  },
  "embeddingProfiles": {
    "memory-default": {
      "kind": "openai-compatible",
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "normalization": "provider-default",
      "revision": "2026-09-03",
      "timeoutMs": 15000,
      "batchSize": 32,
      "maxAttempts": 3
    }
  }
}
```

全局默认引用保存在 `~/.oat/oat.json`：

```json
{
  "memoryDefaults": {
    "embeddingProfile": "memory-default"
  }
}
```

Project 的 `team.json` 只选择检索模式和 Profile 引用；显式 `null` 可覆盖并禁用全局默认：

```json
{
  "memory": {
    "enabled": true,
    "roles": ["admin", "leader"],
    "embeddingRef": "memory-default",
    "retrieval": {
      "backend": "lexical",
      "fallback": "lexical",
      "shadow": false,
      "candidateLimit": 30,
      "maxResults": 8,
      "maxPromptTokens": 1800
    },
    "zvec": {
      "path": "memory/zvec",
      "index": "flat",
      "metric": "cosine",
      "readOnlyFallback": true,
      "batchSize": 64,
      "maxAttempts": 8,
      "optimizePendingThreshold": 100000
    }
  }
}
```

`zvec` 内禁止重复声明 provider、model、dimensions、normalization 或 revision。它们全部由 `embeddingRef` 解析。`revision` 是管理员控制的模型内容版本：当远端服务在相同 model/deployment 名称下替换权重时必须递增；它不是 API 版本或修改时间。

被 Project 引用的 Profile 按不可变版本资源处理。Desktop 不允许直接覆盖其 `provider/model/dimensions/normalization/revision` 后静默保存，而应引导复制为新名称（例如 `memory-v2`）、展示受影响 Project 数量，并明确提示会重新生成全部 active L2/L3 向量。仅凭据和运行参数允许原地修改。删除 Profile 前必须检查当前引用、building migration 和 retained collection。

安全默认值是 `backend=lexical`、无 `embeddingRef`，且 `extraction.enabled=false`。`zvec_hybrid` 缺少有效 Profile 时自动解析为 lexical；`zvec_fts` 不需要 Dense Embedding。提取功能即使开启，在缺少有效模型/Provider 时也保持旧的确定性沉淀。配置错误不得阻止 Agent 任务执行。

## 11. Desktop、Docker 和并发约束

- Zvec 运行在项目 Orchestrator 的索引所有者中，不运行在 Admin/Leader/Worker 容器中。
- Agent 只能通过 `MemoryService` 获得已裁剪上下文，不暴露 Zvec 工具。
- 使用单独 Worker Thread 或等价串行执行器承载同步原生 API，避免阻塞 Orchestrator/Electron 事件循环。
- 一个 project collection 只有一个可写句柄；跨进程共享只能使用只读打开方式。
- Desktop 打包必须验证 macOS arm64/x64、Windows x64、Linux x64/arm64 预构建二进制；验证 asar unpack、签名、公证和 packaged app 实际加载。
- `@zvec/zvec` 不得在 Renderer 中导入。
- Docker Agent 模式不改变 collection 所有权，容器也不挂载索引目录。
- 内存和查询线程配置要有上限，不能让多个项目按 CPU 核数各自无限扩张。
- 一个全局 Embedding Profile 的变化可能影响多个 Project；资源主管维护 `profile -> projects` 引用关系，并把各 Project 重建放入全局低优先级队列，默认串行或受控小并发。

## 12. API、可观测性和运维

建议新增或扩展：

```text
GET  /memory/overview
  增加 backend/indexHealth/pendingOutbox/deadLetters/indexedItems/
       embeddingRevision/collectionRevision/indexCompleteness/lastRebuild/
       fallbackCount/migrationState/migrationProgress

POST /memory/index/rebuild
POST /memory/index/migrations/:revision/pause
POST /memory/index/migrations/:revision/resume
POST /memory/index/migrations/:revision/activate
POST /memory/index/migrations/:revision/rollback
POST /memory/index/retry-dead-letter
GET  /memory/retrieval-runs
POST /memory/:id/dispute
POST /memory/:id/confirm
```

重建、清理和 dead-letter 重试必须是明确的人类动作或受控维护任务。默认页面只展示状态，不自动执行破坏性修复。

关键指标：

- capture、extract、embed、upsert、query、rerank 延迟；
- pending/dead-letter 数量；
- index completeness 和文档数量漂移；
- active/building/retired revision、backfill watermark、双写积压和预计剩余时间；
- 每次重建的条数、token、请求、磁盘峰值与 402/429 暂停原因；
- dense/FTS/lexical 命中数量；
- fallback 次数；
- 注入条数与 token；
- stale/harmful feedback；
- 每种 scope 的拒绝数量。

## 13. 可在单个 AI 窗口完成的实施步骤

### 执行规则

每次 AI 实现任务只执行下列一个步骤：

1. 开始时读取本方案、当前 `memory-architecture.md`、官方 Zvec Skill 和本步骤需要的官方 MDX。
2. 检查前置步骤的实际代码和测试，不只相信进度表。
3. 不提前实现下一步骤。
4. 不修改无关脏文件。
5. 完成测试、构建和 `git diff --check`。
6. 更新本文件的进度表、决策和偏差说明。
7. 交付时列出修改文件、验证结果、遗留风险和下一步骤编号。

单个步骤应控制在约 3～8 个核心文件、1 个明确行为变化和一组可独立运行的测试内。如果发现范围扩大，继续拆分，不在同一窗口硬做。

### M00：建立基线与评测夹具

目标：冻结现有行为，为后续检索变化提供比较基线。

范围：

- 增加中英文记忆检索 fixture；
- 覆盖改写、实体、失败模式、时间冲突、越权查询和无结果查询；
- 记录当前 lexical Recall@K、MRR、错误注入率和延迟；
- 不引入 Zvec，不修改线上检索。

验收：fixture 可重复执行；测试不调用网络；当前基线数据写入测试报告。

回滚：仅删除新增 fixture 和评测脚本。

### M01：Zvec Node/Electron 兼容性 Spike

目标：在投入架构改造前验证原生依赖可交付。

范围：

- 根据最新 `llms.txt` 和 Node Build MDX 锁定一个确切版本；
- 临时创建、关闭、重开 collection；
- 验证 upsert、fetch、filter、vector query、FTS、flush、进程重启恢复；
- 验证 batch status；
- 验证开发运行、核心构建、Desktop unpackaged/packaged 加载；
- 建立 CI 平台矩阵或明确记录暂不能验证的平台。

验收门 G1：当前开发平台 packaged app 可加载；不支持的平台不会默认发布 Zvec；生成 ADR，记录包版本、ABI、二进制大小和打包配置。

失败处理：将方案保留为后端接口设计，停止后续 Zvec 步骤，评估 sqlite-vec 或 Qdrant；不得用跳过 packaged 测试的方式通过。

### M02：抽象 MemoryRepository 与 MemoryRetriever

目标：把现有 SQLite/lexical 行为放入接口，零行为变化。

范围：

- 提取 repository、retriever 和 no-op index 接口；
- `MemoryService` 改为组合接口；
- 现有 API、数据库路径、结果顺序和提示格式保持兼容。

验收：现有 memory tests 全部通过；增加契约测试；基线指标与 M00 一致。

回滚：恢复 `MemoryService` 直接实现，不涉及数据迁移。

### M03：SQLite Schema v2 与 Outbox

目标：建立可恢复索引同步基础，不启动实际索引。

范围：新增字段、outbox、retrieval run、feedback、relation 表；实现幂等迁移；现有 active L2/L3 生成 pending backfill。

验收：空库、旧库、重复启动、迁移中断恢复测试通过；不丢失原记录；默认行为仍为 lexical。

回滚：代码回退时忽略新增表/字段，不删除数据。

### M04：EmbeddingProvider 接口

目标：独立完成 embedding 生命周期，不接 Zvec。

范围：

- `disabled`、确定性 fake、openai-compatible provider；
- batching、timeout、限流、重试分类；
- identity 与维度校验；
- secret redaction；
- 402/429/网络失败不影响 Agent prompt。

验收：纯单元测试覆盖维度错误、部分失败、超时、限流和密钥泄漏扫描；默认 disabled。

回滚：配置保持 disabled，接口可保留。

### M05：Zvec Collection Schema 与生命周期

目标：实现 `ZvecMemoryIndex` 的创建、打开、关闭、manifest 和 stats。

分两个 AI 窗口执行：

- **M05-A Identity 与 registry**：给 Profile 增加显式 `revision`；实现 `embeddingRevision`、`collectionRevision`、manifest schema、目录安全编码、registry 与 active pointer；不创建真实 collection。
- **M05-B Zvec 生命周期**：实现 `ZvecMemoryIndex` 创建、打开、关闭和 stats；单写者；实际 Schema/manifest/identity 校验；FLAT + COSINE；FTS/倒排字段；Worker Thread 边界；仍不接生产检索。

验收：Profile 模型内容字段变化一定产生新 embedding revision，运行参数和 API key 变化不产生；临时目录集成测试覆盖首次创建、重开、重复初始化、manifest/实际 Schema 冲突、维度冲突、同维不同模型冲突、只读打开和关闭；任何冲突都不打开写句柄；事件循环延迟有上限。

回滚：删除临时索引即可，SQLite 不受影响。

### M06：Outbox Index Worker

目标：把 active L2/L3 稳定同步到 Zvec。

分两个 AI 窗口执行：

- **M06-A 多索引同步状态（已完成）**：增加 `memory_index_memberships`、`memory_index_registry`、lease 字段和幂等 v3 迁移；移除不可消费的 `target_index='default'`，仅使用具体 collection revision；提供注册 target、按 revision backfill、membership 查询和租约式 outbox API，但不自动启动 worker。
- **M06-B Index Worker（已完成）**：实现 claim、lease 回收、批量 embed/upsert/delete、逐 status 检查、指数退避、dead letter 和关闭重开 durability 验证；逐 revision 更新 membership；Embedding identity 不匹配时拒绝启动；Zvec 写句柄继续受单 writer lease 保护。

验收：同一 memory 可同时表现为旧 revision `indexed`、新 revision `pending`；同内容可分别投递到两个 target；崩溃前后幂等；重复消息无副作用；遗忘立即不可见；部分 batch 失败可重试；Agent 任务不被索引失败中断。

回滚：停止 worker，检索仍为 lexical。

### M07：索引重建与模型迁移

目标：证明 Zvec 完全可重建。

分两个 AI 窗口执行：

- **M07-A 重建与追赶（已完成）**：按冻结 manifest 检测 identity；创建 sibling collection；重建前估算条数、Embedding batch/token、向量裸数据、SQLite/retained collection 与最低峰值空间；在 SQLite 事务内记录 snapshot watermark 并生成全量 backfill；active/building/ready 多 revision 同步；全局低优先级串行队列和单 Project 单 building 约束；目录丢失时清空派生同步状态并从 SQLite 重建。
- **M07-B 校验、切换与回滚（已完成）**：校验数量、content hash、维度、抽样 fetch、index completeness 和目标零积压；以 `active.json` 为提交点原子切换；重启后收敛 ready/active/retired 状态；402 持久化暂停并显式恢复；retired collection 追平后可回滚；保留期结束且非 active 时才允许 `destroySync` 清理。

验收：删除 Zvec 目录后可恢复；中断重建不破坏现用索引；模型变化但同维度也不会复用或混写；维度变化不会打开旧 Schema 写入；watermark 前后写入不丢失；切换时不存在未追平 outbox；多个 Project 共用 Profile 时受全局并发限制；重建期间 prompt 正常；失败可继续旧索引或 lexical。

回滚：切回旧 collection 或 lexical。

### M08：Shadow 混合检索（已完成）

目标：执行 Zvec 检索但不改变注入结果。

范围（已实现）：生成 query embedding；构造 fail-closed 安全 filters；Dense、FTS、exact 三路召回；RRF；SQLite 回表二次鉴权、时效/信任/去重/多样性治理重排；写脱敏 retrieval run；实际 prompt 仍使用 lexical。生产组合按 active pointer 惰性只读打开 collection，不在启动阶段引入 Zvec 可用性依赖。

验收：结果可对比；恶意 filter 值无法改变权限；Zvec 错误自动回退；检索日志不含秘密。

回滚：`shadow=false`，worker 可继续建索引。

### M09：评测与检索调参（已完成）

目标：使用 M00 fixture 决定是否启用，而不是凭感觉调权重。

范围（已实现）：比较 lexical、dense、FTS、hybrid、hybrid+governance；输出 Recall@5、MRR、中文/改写召回、错误注入率、越权命中、P50/P95 和 token 开销。使用真实 Zvec collection 与 Node SDK，Embedding 为可重复的语义 fixture；生产模型必须在 M10 放量前另行重跑。

验收门 G2：中文与改写查询显著优于 lexical；越权命中为 0；错误注入率不恶化；P95 达到项目设定阈值。阈值必须在实现步骤中用真实基线确认并固化。

回滚：不进入 M10，继续 shadow。

### M10：受控启用 Hybrid Retriever（已完成）

目标：让少量项目实际使用 Zvec 检索。

范围（已实现）：全局 feature flag + 精确 Project 白名单双重授权；shadow 优先；token budget；有界等待；lexical fallback；连续失败熔断、冷却与半开恢复；L1 仍按时间读取；API/Desktop 运行状态。

验收：Zvec 目录被锁、损坏、删除、embedding 超时等情况下任务仍能执行；UI/API 明确显示回退状态。

回滚：配置切回 lexical，无需迁移 SQLite。

### M11：结构化 MemoryExtractor（已完成）

目标：从事件生成事实原子，但只进入 candidate。

范围（已实现）：OpenAI-compatible strict JSON Schema 与 Anthropic 强制 tool schema；本地严格二次校验；独立模型选择；输入、输出、事实数、超时和尝试次数上限；确定性 scope/trust 收紧；来源、模型和 extraction version；只写非索引 candidate；不开启自动 L3。

验收：结构非法不写入；prompt injection 不改变 schema/policy；Channel/A2A 来源默认低信任；无模型时保持现状。

回滚：`extraction.enabled=false`，已有 candidate 保留但不召回。

### M12：冲突、版本与晋升（已完成）

目标：建立事实演化而不是相似文本堆积。

范围（已实现）：exact candidate 合并；semantic duplicate 审查建议；supersedes/contradicts 历史关系；valid time；独立证据计数；人工确认；可信来源、无冲突约束下的 L2 激活和 L3 新晋升规则。

验收：新配置不会和旧配置同时作为当前事实注入；冲突记忆带警告；历史查询仍可审计；外部来源不能自动晋升。

回滚：停止自动治理，仅保留 candidate 和人工操作。

### M13：角色、项目和外部 Worker 权限（已完成）

目标：正式固化多 Agent 记忆访问控制。

范围（已实现）：服务端构造的 MemoryActor/Policy；project/team/private/global；Zvec 预过滤 + SQLite 强制复核；资源主管按授权在线 Project 联邦搜索；离线 Project fail closed；A2A external trust/candidate 限制；读取、注入、治理和人工修改审计。

验收门 G3：覆盖 Admin、Leader、Worker、外部 Worker、离线项目和跨项目测试；所有越权 fixture 均为 0 命中。

回滚：关闭 global/federated，只保留当前项目边界。

### M14：Desktop 管理与可观测性（已完成）

目标：让用户能理解和控制记忆，而不是暴露数据库细节。

范围（已实现）：索引健康、embedding/collection revision、pending/dead letter、fallback、retrieval trace 与访问审计；Profile 不可变版本与受影响 Project 预览；重建成本估算、后台进度、暂停、重试、切换、回滚；确认/争议/忘记；UI/API 不暴露 secret/vector。

验收：正常、降级、重建、dead-letter、模型不匹配、同名模型 revision 变化和磁盘不足状态都有明确提示；修改已引用 Profile 会引导创建新版本；危险动作需要确认；不改变现有 Agent 页面交互。

回滚：隐藏新管理区，后端继续运行。

### M15：发布、文档与默认值评审（已完成，保持 opt-in）

目标：决定是否从 opt-in 提升为默认能力。

范围（已实现）：受支持平台打包矩阵与 packaged smoke；升级/降级边界；SQLite 权威数据备份恢复；索引/临时放大后的峰值预算；跨 Orchestrator 重建租约；Embedding token/batch 成本估算；核心许可证门禁；用户文档和运维手册。

验收门 G4：G1/G2/G3 全部通过；连续运行和故障注入通过；默认开启必须有单独产品决策。否则保持 opt-in。

## 14. 进度表

| 步骤 | 状态 | 前置 | 交付记录 |
| --- | --- | --- | --- |
| M00 基线与 fixture | complete | 无 | [基线报告](./memory-lexical-baseline.md)、`src/memory/evaluation/`、`src/memory/memory-retrieval-baseline.test.ts` |
| M01 Node/Electron Spike | complete | M00 | [ADR-0001](./adr/0001-zvec-node-electron-compatibility.md)、`src/memory/zvec-compatibility-smoke.ts`、`src/memory/zvec-compatibility-smoke.test.ts` |
| M02 接口抽象 | complete | M00 | `src/memory/memory-repository.ts`、`src/memory/memory-retriever.ts`、`src/memory/memory-contracts.test.ts` |
| M03 SQLite v2/Outbox | complete | M02 | `src/memory/memory-migration.test.ts`、`src/memory/memory-repository.ts` |
| M04 EmbeddingProvider | complete | M02 | `src/memory/embedding-provider.ts`、`src/memory/embedding-provider.test.ts`、`src/models/global-models.ts` |
| M05-A Identity/Registry | complete | M01、M04 | `src/memory/zvec-index-identity.ts`、`src/memory/zvec-index-registry.ts`、`src/memory/zvec-index-identity.test.ts` |
| M05-B Zvec 生命周期 | complete | M05-A、M02 | `src/memory/zvec-memory-index.ts`、`src/memory/zvec-memory-index-worker.ts`、`src/memory/zvec-memory-index-contract.ts`、`src/memory/zvec-memory-index.test.ts` |
| M06-A 多索引同步状态 | complete | M03、M05-A | `src/memory/memory-repository.ts`、`src/memory/memory-migration.test.ts`、`src/memory/memory-index-worker.test.ts` |
| M06-B Index Worker | complete | M04、M05-B、M06-A | `src/memory/memory-index-worker.ts`、`src/memory/zvec-memory-index.ts`、`src/memory/zvec-memory-index-worker.ts`、`src/memory/memory-index-worker.test.ts` |
| M07-A 重建与追赶 | complete | M06-B | `src/memory/zvec-index-migration.ts`、`src/memory/memory-repository.ts`、`src/memory/zvec-index-migration.test.ts` |
| M07-B 切换与回滚 | complete | M07-A | `src/memory/zvec-index-migration.ts`、`src/memory/zvec-memory-index.ts`、`src/memory/zvec-memory-index-worker.ts`、`src/memory/zvec-index-migration.test.ts` |
| M08 Shadow 检索 | complete | M06-B、M07-B | `src/memory/zvec-shadow-memory-index.ts`、`src/memory/zvec-memory-index-worker.ts`、`src/memory/memory-repository.ts`、`src/memory/zvec-shadow-memory-index.test.ts` |
| M09 评测调参 | complete | M08 | [M09 评测报告](./memory-retrieval-evaluation-m09.md)、`src/memory/evaluation/zvec-retrieval-evaluation.ts`、`src/memory/memory-retrieval-evaluation.test.ts` |
| M10 受控启用 | complete | M07-B、M09 | [M10 运行手册](./memory-active-retrieval-m10.md)、`src/memory/memory-retriever.ts`、`src/memory/memory-active-retriever.test.ts`、`src/memory/memory-service.test.ts`、`src/utils/oat-config.ts` |
| M11 结构化提取 | complete | M10 | [M11 运行手册](./memory-structured-extraction-m11.md)、`src/memory/memory-extractor.ts`、`src/memory/memory-extractor.test.ts`、`src/memory/memory-repository.ts` |
| M12 冲突与晋升 | complete | M11 | [M12 运行手册](./memory-governance-m12.md)、`src/memory/memory-governor.ts`、`src/memory/memory-governor.test.ts`、`src/memory/memory-repository.ts` |
| M13 权限与外部 Worker | complete | M10、M12 | [M13 运行手册](./memory-access-control-m13.md)、`src/memory/memory-policy.ts`、`src/memory/memory-federation.ts`、`src/memory/memory-policy.test.ts` |
| M14 Desktop 管理 | complete | M07-B、M10、M13 | [M14 运行手册](./memory-desktop-operations-m14.md)、`src/memory/memory-operations.ts`、`desktop/src/renderer/src/MemoryManagementWorkspace.tsx`、`src/memory/memory-operations.test.ts` |
| M15 发布评审 | complete | G1、G2、G3、M14 | [M15 发布评审](./memory-release-m15.md)、`src/memory/memory-backup.ts`、`scripts/verify-zvec-release.mjs`、`.github/workflows/daily-release.yml` |

状态只能使用 `planned / in_progress / complete / blocked / superseded`。每个实现步骤结束时更新一行，并链接主要代码或测试。

## 15. 每次 AI 实现任务模板

```text
实现 docs/zh-CN/zvec-memory-implementation-plan.md 中的 Mxx，且只实现该步骤。

开始前：
1. 读取当前方案和 docs/zh-CN/memory-architecture.md；
2. 读取 .agents/skills/zvec/SKILL.md；
3. 读取 https://zvec.org/llms.txt；
4. 按本步骤从索引读取必要的官方 Markdown；
5. 检查前置步骤代码和测试是否真实完成。

要求：
- SQLite 始终是权威数据源；
- Zvec 失败不得阻塞 Agent 任务；
- 不修改无关脏文件；
- 不提前实现后续步骤；
- 完成相关单测、集成测试、类型检查、构建和 git diff --check；
- 更新方案进度表和偏差记录；
- 汇报修改文件、验证结果、风险和建议的下一步骤。
```

## 16. 全局完成标准

只有同时满足以下条件，Zvec 记忆能力才算完整：

1. SQLite 可在没有 Zvec 的情况下独立启动和查询。
2. Zvec 索引可从 SQLite 完整重建。
3. embedding 失败、索引损坏和原生模块加载失败不会导致 Agent 任务失败。
4. 忘记、争议和替代状态在所有检索路径即时生效。
5. Admin/Leader/Worker/A2A 外部 Worker 权限测试没有越权命中。
6. 中文、改写、实体和失败模式查询有可量化提升。
7. 模型同维升级、维度变化和同名 deployment 显式 revision 变化均经过 sibling collection 重建，不发生跨 embedding space 混写或混查。
8. 重建期间写入可追赶、切换可回滚；多个 Project 共用 Profile 时不会突破全局并发、成本和磁盘预算。
9. Desktop 打包产物在支持平台能加载原生模块。
10. 旧数据库升级幂等，降级不会破坏 canonical memory。
11. 日志、Zvec、manifest 和检索审计均不含 API key 等秘密。
12. 用户可以看到当前检索后端、健康状态、回退和重建进度。

## 17. 明确不在本轮范围内

- 用 Zvec 取代 SQLite；
- 让 Agent 直接操作 Zvec 或获得数据库工具；
- 默认将所有原始对话写入长期记忆；
- 自动把相似记忆当成事实并覆盖旧记录；
- 第一阶段接入 Graphiti/Neo4j；
- 在未经评测前默认启用 LLM 提取、远程 embedding 或 Zvec；
- 跨项目绕过 Orchestrator 权限直接搜索 collection。
