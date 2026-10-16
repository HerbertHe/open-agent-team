var e=`# 预算约束长程任务：可执行任务拆分

> 状态：实验性实施 Backlog；所有能力默认关闭。
>
> 上位设计：[预算约束长程任务执行架构](./budgeted-long-horizon-execution-architecture.md)

## 0. 当前实施状态

状态核对日期：2026-10-16。\`verified\` 沿用已记录的组件验证结果；\`partial\` 表示生产接入、Adapter 覆盖或发布验证不完整；\`blocked\` 表示发布所需证据或前置 Gate 尚未满足。本轮 Program、Budget、Sandbox、实验配置及 TaskManager 相关回归已重新运行；verified 不等于真实 Provider 或线上发布验证已完成。

| 任务 | 状态 | 结果 |
| --- | --- | --- |
| BLH-001 | \`verified\` | 实验配置、类型、JSON Schema、示例和默认关闭测试已实现 |
| BLH-002 | \`verified\` | Runtime Hook 覆盖矩阵和 SDK 兼容性测试已实现；shadow/soft Go，hard No-Go |
| BLH-003 | \`verified\` | Provider Capability Profile、保守探测器、fixtures 和 fail-closed 测试已实现 |
| BLH-004 | \`verified\` | 已接受 Runtime 策略 ADR；统一预检拒绝未满足条件的 hard，且不静默降级 |
| BLH-005 | \`verified\` | 独立 Execution DB 启动器、PRAGMA 验证、并发/重启与 fail-closed 测试已实现 |
| BLH-006 | \`verified\` | Schema v1 基础、v2 预算扩展及 v3 计划运行时扩展，原子迁移、checksum/漂移检测和中断恢复已实现 |
| BLH-007 | \`verified\` | Program/Plan/WorkPackage/Attempt/BudgetVector 严格 Schema 与状态转换守卫已实现 |
| BLH-008 | \`verified\` | Program/Plan/WorkPackage Repository、状态守卫与 revision CAS 已实现 |
| BLH-009 | \`verified\` | Transactional Outbox、稳定幂等键、投递租约重领与 dead-letter 已实现 |
| BLH-010 | \`verified\` | Append-only Audit Repository、递归脱敏和三类关联查询已实现 |
| BLH-011 | \`verified\` | BudgetVector 逐维安全整数加减、比较、规范化和溢出测试已实现 |
| BLH-012 | \`verified\` | 账户树、父子额度约束、保护分区和 Schema v2 已实现 |
| BLH-013 | \`verified\` | Reservation 状态机、operationKey 幂等与并发防超卖已实现 |
| BLH-014 | \`verified\` | Spend Event 幂等结算、父信封差额释放和迟到 Usage 对账已实现 |
| BLH-015 | \`verified\` | 不可变 Pricing Snapshot、历史重放估算与价格漂移冻结已实现 |
| BLH-016 | \`partial\` | Program Context 已贯通 Task、Prompt、工具及 SDK 模型流 IPC；每次受管 SDK 调用有独立 operation ID。Provider 权威请求身份与账单证据仍不完整 |
| BLH-017 | \`partial\` | 共享 SDK streamFunction 已接入生产 Shadow/Soft 闸门；Soft 在任务信封内创建子 Reservation，终态前结算，隐藏 Provider 重试被显式关闭。实际 Provider 能力仍需发布环境验证，Hard 未开放 |
| BLH-018 | \`verified\` | Provider Usage 查询、释放及未知结果按上界保守结算已实现 |
| BLH-019 | \`verified\` | 历史 P50/P90、样本量、置信度和 5% 双尾异常值策略已实现 |
| BLH-020 | \`verified\` | 默认关闭的 Program 草案 CRUD API，以及 Program/账户/价格快照原子创建已实现 |
| BLH-021～025 | \`verified\` | 类型化验收、Plan 校验、成本分布、相关联合 Monte Carlo 准入与 Scope Tier 选择已实现 |
| BLH-026 业务入口 | \`partial\` | 已接通计划提交、冷启动准入、显式风险确认和 revision 绑定的原子审批激活 API；实际所选 Scope Tier 会持久化。生产历史样本自动校准和 Desktop 计划编辑/审批表单仍待接入，运行期自动重规划不在本次入口范围内 |
| BLH-026～030 | \`partial\` | Plan 激活、预算健康选择、Reservation、Lease/Fencing 已接入常驻 10 秒生产调度循环和 TaskManager；Task Completed 后自动验收并推进依赖，ReviewPending 继续续租。持久化 Wakeup 已驱动常驻调度；共享 SQLite 的 Program owner/fence、原子派发和项目资源互斥已接入，远端会话迁移仍待扩展 |
| BLH-029 常驻集成 | \`verified\` | Wakeup→专用 Outbox 消费→Coordinator 已接入；重启补发、回拨去重、失败重试、暂停延期、新 epoch 隔离、确认与后继唤醒原子提交及停机排空已有真实 SQLite 回归。消费为至少一次，现已接入独立的跨实例 owner/fence 与 Outbox owner 过滤 |
| BLH-027～028 跨实例集成 | \`verified\` | Schema v7 调度所有权、tick 互斥、原子预算/Lease/资源派发、运行时 fencing、保守接管、远端中止隔离及并发迁移已实现；真实多进程 SQLite 回归通过。未知在途结果保留 uncertain，不声称透明接管 |
| BLH-031～038 | \`verified\` | Checkpoint、Runtime 中止、Execution Barrier、安全快照、控制 API、恢复预检和迟到事件隔离已实现 |
| BLH-039～040 | \`partial\` | 本地/Docker 的 OAT execute 与 SDK 工具钩子已接入生产网关；支持身份/权限/信封检查、稳定 operation key、摘要回执、调用次数预留结算与防重。任意命令内的嵌套副作用和外部 Provider 保证仍需专用 Adapter 与发布验证 |
| BLH-041 | \`partial\` | 文件 postcondition、任务进度/交付、Git 审核与发布记录查询已接入持续轮询、结束、中止和停机路径；查询超时与不可查询操作保持 uncertain，不重发；通用外部 Provider 查询仍待扩展 |
| BLH-042 | \`partial\` | Budget Health/Mode 已接入执行分区检查与收尾决策；预算不足、强制期限与未知结果触发安全收尾，其他运营策略仍待扩展 |
| BLH-043～046 | \`partial\` | 文件、命令、JSON 测试报告验收已接入生产 tick；证据提交检查 epoch/lease，依赖自动解锁，活动计划完成后触发 Closeout。批准定义内的有限自动重规划、显式配置的规则路由、停止/恢复点/对账/预算报告已接入；生成新定义的规划器及其他验收 Adapter 仍待扩展 |
| BLH-047～048 | \`partial\` | Execution DB 只读模型、Desktop Program 页面、中止/恢复 API 与 UI 已实现；预算账户、DAG 数据和时间线已有基础 JSON 展示，端到端验收证据仍待补齐 |
| BLH-049 | \`verified\` | 指标已接入 10 秒后台扫描与只读视图；持久化告警跨连接合并、固定枚举标签、恢复关闭已有回归 |
| BLH-050 | \`partial\` | 六类故障注入点均在真实组件链触发，覆盖回滚、重放防重、快照重试及恢复中断；逐故障点系统强杀重启及真实远端验证仍待补齐 |
| BLH-051 | \`verified\` | 独立 SQLite 的 90 天多 Program 集成仿真已接通计划、调度、账本、验收、重规划、快照/恢复及收尾；覆盖重启、回拨、价格/审批、模拟 Provider 错误和备份恢复，验证 seed 可复现及七项不变量。Provider/任务派发采用测试替身，不替代发布观察 |
| BLH-052 | \`partial\` | 五类威胁评审规则与持久化已实现；实际安全评审及高风险 finding 关闭证据仍需提供 |
| BLH-053～054 | \`blocked\` | Shadow/Soft Gate 机制已实现；缺少各至少 7 天的真实观察、质量基线比较和停止/恢复演练等发布证据 |
| BLH-055 | \`blocked\` | Hard Gate、启动阻断与能力退化熔断机制已实现；Soft Gate、verified Runtime/Provider 能力与灾难恢复等前置证据不足，Hard 仍为 No-Go |

BLH-002 详细证据见 [Runtime 调用级 Hook Spike](./budgeted-runtime-hook-spike.md)。
BLH-003 详细证据见 [Provider Budget Capability Profile](./provider-budget-capability-profile.md)。
BLH-004 决策见 [ADR 0003：预算执行 Runtime 接入与 Hard-mode Gate](./adr/0003-budget-execution-runtime-strategy.md)。
BLH-005 实现边界见 [Execution DB 启动器](./execution-database-bootstrap.md)。
BLH-006 表结构与迁移协议见 [Execution Schema v1](./execution-schema-v1.md)。
BLH-007 领域约束见 [Program 领域 Schema v1](./program-domain-schemas-v1.md)。
BLH-008～010 的并发、投递和审计协议见 [Execution Repository、Transactional Outbox 与审计存储](./execution-repositories-outbox-audit.md)。
BLH-011～020 的账本、计价、Runtime Context 和 Program 草案实现见 [预算账本、运行时上下文与 Program 草案](./budget-ledger-runtime-program.md)。
BLH-021～030 的计划、准入、调度、租约和投影协议见 [计划、准入、调度与长期运行基础](./planning-admission-scheduling-runtime.md)。
计划提交到审批激活的 API 与使用示例见 [Program 计划 API](./program-planning-api.md)。
SDK 模型调用计量、自动验收和保证边界见[模型调用计量与自动验收运行时](./model-metering-verification-runtime.md)。
工具权限、调用次数预算、副作用回执和状态查询见[工具副作用网关与对账](./tool-effects-runtime.md)。
BLH-031～040 的 Checkpoint、中止恢复和外部副作用安全协议见 [Checkpoint、中止恢复与外部副作用安全](./checkpoint-interrupt-effects-runtime.md)。
指标、故障注入和集成仿真运行方式见[指标告警与集成长周期仿真](./metrics-integrated-simulation-runtime.md)。
BLH-041～050 的组件能力见同文[运营闭环](./checkpoint-interrupt-effects-runtime.md#7-blh-041050-运营闭环)；BLH-051～055 的证据要求见[长周期仿真、安全评审与发布 Gate](./release-assurance-and-long-horizon-simulation.md)。

## 1. 任务执行规则

每项任务原则上对应一个小 PR，目标工期为 0.5–2 人日。超过 2 日仍无法交付时必须再次拆分。任务流转为：

\`\`\`text
backlog -> ready -> in_progress -> review -> verified -> done
                         \\-> blocked
\`\`\`

Definition of Done：

- 依赖任务已经 \`verified\`；
- 实现、类型、测试和必要文档在同一个 PR；
- \`budgetExecution.enabled=false\` 时现有行为不变；
- 新状态、事件和错误均有严格 Schema；
- 数据库变化包含版本化迁移和中断恢复测试；
- PR 描述包含失败模式、回滚方式和未覆盖风险；
- 相关测试、类型检查、构建和 \`git diff --check\` 通过。

## 2. 总体依赖

\`\`\`mermaid
flowchart LR
    G0[Gate 0<br/>Runtime/Provider 可行性] --> F[基础设施与 DB]
    F --> B[预算账本与 Shadow Guard]
    F --> P[Program/Plan/Admission]
    B --> S[Scheduler/Lease/Wakeup]
    P --> S
    S --> C[中止/快照/恢复]
    B --> E[Effect Ledger/Tool Guard]
    S --> R[重规划/验证/收尾]
    E --> R
    C --> UI[Desktop/API/Admin 控制]
    R --> UI
    UI --> H[故障注入与长期仿真]
    H --> GS[Shadow Gate]
    GS --> GF[Soft Gate]
    GF --> GH[Hard 实验 Gate]
\`\`\`

关键路径：

\`\`\`text
BLH-001 -> 002 -> 004 -> 005 -> 006 -> 012 -> 017
-> 027 -> 028 -> 032 -> 035 -> 037 -> 050 -> 051 -> 055
\`\`\`

## 3. Gate 0：硬控制可行性

| ID | 可执行任务 | 主要修改 | 依赖 | 估时 | 验收结果 |
| --- | --- | --- | --- | --- | --- |
| BLH-001 | 增加实验配置骨架，默认 \`enabled=false/mode=shadow\` | \`src/config/schema.ts\`、\`src/types/config.ts\`、配置测试 | 无 | 0.5d | 未配置时完全关闭；非法 mode 被拒绝 |
| BLH-002 | 验证模型调用级 Hook | 隔离 spike/test，不接生产路径 | 001 | 1–2d | 覆盖首轮、工具续轮、压缩、重试、内部调用的 before/after/abort/usage 矩阵 |
| BLH-003 | 建立 Provider Capability Profile | 新类型、探测器和 fixtures | 001 | 1d | 未知能力保守标记 unsupported/unknown，不允许 hard |
| BLH-004 | 形成 Hard-mode Go/No-Go ADR | ADR、能力预检规则 | 002,003 | 0.5d | 明确 SDK Hook、Metering Proxy 或只支持 shadow/soft；没有可行组合则停止 hard 路线 |

## 4. 基础设施与持久化

| ID | 可执行任务 | 主要修改 | 依赖 | 估时 | 验收结果 |
| --- | --- | --- | --- | --- | --- |
| BLH-005 | Execution DB 启动器 | 新增 \`src/program/execution-database.ts\` | 004 | 1d | WAL/foreign key/busy timeout 生效；打开失败时 fail closed |
| BLH-006 | Schema v1 迁移 | Program、Plan、WorkPackage、Attempt、Lease、Outbox、Audit 表 | 005 | 1–2d | 空库、重复升级、迁移中断、未知高版本测试通过 |
| BLH-007 | 领域类型与运行时 Schema | \`program-types.ts\`、\`budget-types.ts\` | 006 | 1d | 未知字段、非法状态、负数和浮点金额被拒绝 |
| BLH-008 | Repository 与 revision CAS | Program/Plan/WorkPackage Repository | 007 | 1.5d | 并发写只有一个成功，冲突返回结构化错误 |
| BLH-009 | Transactional Outbox | \`execution-outbox.ts\` 和 worker | 006,008 | 1d | 事务提交后崩溃或投递后确认前崩溃均不丢失、不重复推进 |
| BLH-010 | 审计事件存储 | Audit Repository、Observability 只读投影 | 006 | 1d | 可按 Program/Attempt/requestId 查询，敏感字段脱敏 |

## 5. 预算账本与计量

| ID | 可执行任务 | 主要修改 | 依赖 | 估时 | 验收结果 |
| --- | --- | --- | --- | --- | --- |
| BLH-011 | BudgetVector 整数算术 | \`src/budget/budget-types.ts\` | 007 | 0.5d | 属性测试覆盖逐维非负、比较和溢出 |
| BLH-012 | 账户树与保护分区 | \`budget-repository.ts\`、\`budget-ledger.ts\` | 006,011 | 1.5d | 子账户不超父账户；execution 不能消费 validation/closeout |
| BLH-013 | Reservation 状态机 | created/active/settled/released/uncertain | 012 | 1.5d | operationKey 幂等；并发预留不超卖 |
| BLH-014 | Settlement 与 Usage 幂等 | spend event、差额释放 | 013 | 1d | 重复、乱序、迟到 usage 不重复扣费 |
| BLH-015 | Pricing Snapshot | \`pricing-service.ts\`、全局模型目录只读适配 | 003,012 | 1d | 可重放历史估算；价格变化冻结新调用 |
| BLH-016 | Runtime Context 穿透 | sandbox interface、本地/Docker IPC | 007,013 | 1.5d | program/attempt/epoch/token/operationId 跨进程不丢失；普通 Task 兼容 |
| BLH-017 | Shadow Model Guard | 调用前上界估算、决策记录 | 002,013,015,016 | 2d | 覆盖工具续轮和重试；shadow 不阻断响应 |
| BLH-018 | Usage Reconciler | Provider 查询、保守结算 | 003,014,017 | 1.5d | 可查询请求 settle/release；不可恢复请求按上界结算 |
| BLH-019 | 历史成本基线 | \`usage-tracker.ts\` 只读样本投影 | 010,015 | 1d | 输出样本数、P50/P90、置信度和异常值策略 |

## 6. Program、计划与准入

| ID | 可执行任务 | 主要修改 | 依赖 | 估时 | 验收结果 |
| --- | --- | --- | --- | --- | --- |
| BLH-020 | Program 草案 CRUD | \`program-service.ts\`、实验 API | 008,012,015 | 1d | 关闭时路由不存在；创建时原子生成账户和价格快照 |
| BLH-021 | Typed Acceptance Criteria | 类型、Schema、验证器注册表 | 007,020 | 1d | mandatory 交付不能仅用自然语言自证 |
| BLH-022 | Plan Validator | DAG、stableKey、依赖、冲突、验收、信封校验 | 020,021 | 1.5d | 环、悬空依赖、重复 key、无验收 mandatory 包被拒绝 |
| BLH-023 | Work Package 成本分布 | \`cost-estimator.ts\` | 019,022 | 1.5d | 产生 P50/P90/HardMax、版本和置信度 |
| BLH-024 | 联合 Monte Carlo 准入 | \`admission-controller.ts\` | 023 | 2d | 预算和期限联合概率可复现，不用边际概率冒充 |
| BLH-025 | Scope Tier 选择 | minimum/standard/stretch 策略 | 024 | 1d | minimum 不可行即拒绝启动，不启动半成品计划 |
| BLH-026 | Plan 审批与原子激活 | Plan Version、审批 revision、Outbox | 009,022,025 | 1d | 过期审批失败；激活和初始 runnable 事件同事务 |

## 7. 调度、租约与长期运行

| ID | 可执行任务 | 主要修改 | 依赖 | 估时 | 验收结果 |
| --- | --- | --- | --- | --- | --- |
| BLH-027 | Runnable 选择器 | \`plan-scheduler.ts\` | 013,026 | 1.5d | 依赖、冲突、预算、能力、截止时间均受约束，排序确定 |
| BLH-028 | Lease 与 Fencing Token | \`lease-service.ts\` | 027 | 1.5d | 多实例仅一个有效 owner；旧 token 写入被拒绝 |
| BLH-029 | 持久化 Wakeup | \`wakeup-service.ts\` | 009,028 | 1.5d | 停机后补发一次；时钟回拨不重复执行 |
| BLH-030 | Task Board 单向投影 | \`task-manager.ts\`、投影 worker | 009,027 | 1.5d | 投影失败不影响事实状态、不触发执行；普通 Task 不变 |
| BLH-031 | Continuation State/Checkpoint | checkpoint store、digest、大小限制 | 016,028 | 1.5d | 损坏/过期 checkpoint 被拒绝，不依赖完整对话重放 |

## 8. 人工中止、快照与恢复

| ID | 可执行任务 | 主要修改 | 依赖 | 估时 | 验收结果 |
| --- | --- | --- | --- | --- | --- |
| BLH-032 | Interruptible Runtime 接口 | \`requestCheckpoint/abortAttempt/terminateSession\`、IPC | 002,016,031 | 2d | cooperative、abort 超时、进程树终止、Session reset 测试通过 |
| BLH-033 | Execution Barrier | epoch、调度/调用冻结、多实例广播 | 017,028,029 | 1.5d | barrier 后没有新模型或工具请求发出 |
| BLH-034 | Suspension Snapshot Store | manifest、Git SHA、patch、artifact digest、秘密排除 | 006,031 | 2d | 越界/忽略/秘密文件不入包；篡改后无法恢复 |
| BLH-035 | Program Control Service | graceful/immediate/cancel_closeout 协议 | 032,033,034 | 2d | 先静默再快照；存储失败不虚报成功；零模型预算可停止 |
| BLH-036 | 中止 API 与 Admin 工具 | interrupt/status、controlIntent、审计 | 010,035 | 1d | 按钮和结构化意图走同一服务；重复 requestId 幂等 |
| BLH-037 | Resume Dry-run 与恢复 | 漂移检测、重估、新 epoch/Attempt/token | 018,024,034,035 | 2d | 阻塞漂移保持 suspended；默认用户确认；绝不续跑旧 Session |
| BLH-038 | 迟到事件隔离 | Runtime/ledger/state reducer | 014,033,037 | 1d | 旧 epoch 事件可对账但不能推进状态 |

BLH-035 的固定执行顺序：

\`\`\`text
幂等校验 -> increment epoch -> 冻结调度 -> 撤销 lease
-> cooperative checkpoint（可选）-> Runtime abort -> 终止超时 Session
-> 标记 uncertain -> 生成权威快照 -> 对账 -> suspended/suspended_uncertain
\`\`\`

## 9. 外部工具、副作用、重规划与收尾

| ID | 可执行任务 | 主要修改 | 依赖 | 估时 | 验收结果 |
| --- | --- | --- | --- | --- | --- |
| BLH-039 | Effect Ledger | prepare/dispatched/confirmed/uncertain/reconciled | 006,013 | 1.5d | operationKey 唯一，request digest/receipt 可追踪 |
| BLH-040 | Tool Guard | 权限、预算、epoch、token、幂等检查 | 016,033,039 | 2d | 旧 token 不能产生外部效果；hard 拒绝不可控高影响工具 |
| BLH-041 | Effect Reconciler | Provider/工具状态查询 | 018,039,040 | 1.5d | 未知高影响操作不自动重试，重复副作用为 0 |
| BLH-042 | Budget Health/Mode | explore/balanced/commit/closeout | 014,023,027 | 1d | 决策可解释；closeout 不开放可选预算 |
| BLH-043 | Replanner/Plan 切换 | \`replanner.ts\` | 022,026,042 | 2d | 继承完成包不重复执行；连续同类失败触发重规划 |
| BLH-044 | 规则型模型路由 | 模型能力/风险/预算规则 | 003,015,042 | 1d | Prompt 不能自行升级模型；未知价格 hard 拒绝 |
| BLH-045 | Verifier 与最终验收 | \`verification-service.ts\` | 021,031,043 | 2d | Agent 自报不能替代验证；证据绑定 SHA/digest/version |
| BLH-046 | Closeout Service | 停止、恢复点、对账、预算报告 | 035,041,045 | 1.5d | reservation 全部有确定或 uncertain 归宿；不虚报完整交付 |

## 10. Desktop、可观测性和发布 Gate

| ID | 可执行任务 | 主要修改 | 依赖 | 估时 | 验收结果 |
| --- | --- | --- | --- | --- | --- |
| BLH-047 | Program 只读页面 | Desktop Program 预算/DAG/时间线 | 020,027,042 | 2d | disabled 无入口；不以 Task 投影为事实源 |
| BLH-048 | 中止与恢复 UI | 三个停止按钮、进度、快照、dry-run | 036,037,047 | 2d | 危险操作明确确认；uncertain 不显示“安全停止” |
| BLH-049 | 指标与告警 | budget/uncertain/quiesce/snapshot/late-event 指标 | 010,018,038,046 | 1d | 关键不变量有告警且不泄露 Prompt/凭据 |
| BLH-050 | 故障注入 Harness | reservation/dispatch/settlement/lease/snapshot/resume 注入点 | 018,028,038,041 | 2d | 任一点崩溃重启后不重复消费或副作用 |
| BLH-051 | 90 天虚拟时钟仿真 | 多 Program、停机、回拨、价格/审批变化 | 029,043,049,050 | 2d | CI 分钟级完成；随机种子可复现 |
| BLH-052 | 安全威胁模型评审 | Prompt 注入、预算提升、快照泄密、旧 token、权限 | 040,048,050 | 1–2d | 未关闭高风险项阻止 soft/hard |
| BLH-053 | Shadow 发布 Gate | 内部显式项目收集覆盖率 | 017,025,049,052 | 1–2 周观察 | 现有行为零阻断；usage 可归属；P90 覆盖达标 |
| BLH-054 | Soft 发布 Gate | 低风险项目调度/降级试验 | 046,048,051,053 | 1–2 周观察 | 最小交付优于基线；停止/恢复演练通过；无重复副作用 |
| BLH-055 | Hard 实验 Gate | 仅开放通过预检的 Runtime/Provider | 004,050,051,052,054 | 1d 评审+持续观察 | 所有不变量和灾难恢复通过；能力退化立即冻结新调用 |

> 实现进度（2026-10-16）：计划 API、SDK 调用级 Shadow/Soft 预算入口、首批自动验收、依赖推进、活动计划 Closeout，OAT/SDK 工具副作用网关、首批状态查询以及持久化 Wakeup 自动驱动、有限重规划、配置式模型路由、安全收尾与共享 SQLite 跨实例协调已接入生产骨架。Provider 权威计费与请求身份、其他工具/验收 Adapter、新定义重规划策略、远端运行时迁移、集成长周期仿真及真实 7～14 天发布证据仍属于 \`partial/not integrated\`，不得以“BLH-001～055 全部完成”描述。Soft 进入前必须通过 Shadow Gate；合成仿真不能授权 Soft/Hard。全部能力仍受默认关闭的实验父开关保护。

## 11. 推荐迭代

| Iteration | 任务 | 可验证交付 |
| --- | --- | --- |
| 0：可行性与骨架 | 001–010 | 实验开关、能力结论、Execution DB、Repository、Outbox、Audit |
| 1：可核算 Shadow | 011–019 | 预算账本、价格快照、Runtime Context、Shadow Guard、Reconciler |
| 2：完整计划准入 | 020–026 | Program、验收标准、计划校验、成本分布、联合准入、Scope Tier |
| 3：数月运行 | 027–031 | Scheduler、Lease、Wakeup、Task 投影、Continuation State |
| 4：停止与恢复 | 032–038 | Runtime abort、Barrier、Snapshot、控制 API、恢复预检、迟到隔离 |
| 5：副作用与交付 | 039–046 | Effect Ledger、Tool Guard、重规划、路由、验证、Closeout |
| 6：产品化验证 | 047–055 | Desktop、指标、故障注入、90 天仿真、安全和发布 Gate |

## 12. 可并行工作流与冲突控制

| 工作流 | 任务 | 主要冲突区域 |
| --- | --- | --- |
| Runtime/Provider | 002,003,016,017,032 | \`src/sandbox/*\` |
| Persistence | 005–010 | Execution DB、\`observability-hub.ts\` |
| Budget | 011–019 | \`src/budget/*\` |
| Planning | 020–026 | \`src/program/*\` |
| Scheduler | 027–031 | \`task-manager.ts\`、新 scheduler 模块 |
| Control/Recovery | 032–038 | Runtime、Program Control、Desktop IPC |
| Effect/Replan | 039–046 | Tool adapter、Program/Replanner |
| Desktop/QA | 047–055 | \`desktop/*\`、测试 Harness |

同一时段避免两个 PR 同时大改 \`task-manager.ts\`、\`orchestrator.ts\` 或 Runtime IPC。先合并接口/Schema PR，再并行实现调用方。

## 13. 当前待办与建议顺序

BLH-001～015 等基础任务已有实现和验证记录，不再作为首批新任务领取。下一批围绕现有 partial 项补齐生产链路：

1. **BLH-016～018：Provider 计量证据**。SDK 调用级 Reservation/Settlement 已接入；继续补齐真实 Provider 状态查询、权威用量和请求身份，验证重试、输出限制与错误回报边界。
2. **BLH-039～041：工具 Adapter 与发布验证**。生产网关和首批状态查询已接入；继续补齐其他外部服务状态查询、能力证据及跨实例/真实 Docker/远端恢复验证，不以重发工具代替对账。
3. **BLH-026～030、043～046：执行闭环**。首批自动验收与 Closeout 已接入；有限重规划/配置式路由/安全收尾已接入；继续补齐其他验收 Adapter、新定义规划策略及真实远端运行时故障验证。
4. **BLH-047～052：产品与集成验证**。验证 Desktop 预算/DAG/时间线及中止恢复流程，指标与真实组件参与的 90 天仿真已接通，继续提供 Desktop 端到端验收、真实远端故障演练及实际安全评审证据。
5. **BLH-053～054：真实观察**。在显式 opt-in 项目收集至少 7 天 Shadow 证据；通过 Shadow Gate 后再开展至少 7 天低风险 Soft 观察、基线比较和停止/恢复演练。
6. **BLH-055：Hard 前置能力复评**。在 Soft Gate 及 Runtime/Provider verified 能力等条件满足后重新评审；合成仿真或组件单测不能代替发布证据。

所有工作保持实验父开关默认关闭，不能将上述任务列表解释为开放 Hard 的授权。
`;export{e as default};