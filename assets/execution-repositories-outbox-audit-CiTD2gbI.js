var e=`# Execution Repository、Transactional Outbox 与审计存储

> 对应 BLH-008、BLH-009、BLH-010。属于实验性预算长程执行能力；父开关 \`budgetExecution.enabled\` 默认关闭，因此这些组件不会进入普通 Task 路径。

## 1. Repository 与并发控制

\`ProgramRepository\`、\`PlanVersionRepository\`、\`WorkPackageRepository\` 的持久化输入和读取结果都经过 Zod 严格 Schema。Plan 与 Work Package 的 JSON 真相副本会和可索引列交叉校验；两者不一致时以 \`CORRUPT_ENTITY\` fail closed，避免调度器读取一半新、一半旧的状态。

状态写入必须提供调用方最后读取到的 \`expectedRevision\`，SQL 使用 \`WHERE id = ? AND revision = ?\` 完成 compare-and-swap。Repository 在写入前再次检查 revision，并通过领域状态机守卫验证迁移。冲突返回结构化 \`REVISION_CONFLICT\`，不存在返回 \`ENTITY_NOT_FOUND\`，不会 last-write-wins。

Work Package 批量创建先写所有节点，再写依赖边，支持同一批次中的前向引用；任意节点或依赖失败会回滚整批。

## 2. Transactional Outbox

Repository 的每个变更 API 都接受可选 \`outboxEvents\`，状态行和事件在同一 SQLite 事务提交。注入点覆盖实体写入后和 Outbox 写入后，测试证明任一点崩溃都不会形成“状态已推进但事件丢失”。

事件具有两个稳定标识：

- \`id\`：投递与日志追踪的事件身份；重投时不变；
- \`dedupeKey\`：业务幂等键；相同键只能重用完全相同的事件，否则返回 \`OUTBOX_DEDUPE_CONFLICT\`。

worker 使用 \`pending -> publishing -> published\` 流程。claim 会写入 owner、到期时间并递增 attempts；进程在发布后、确认前崩溃时，其他 worker 可在租约到期后重领同一事件。该协议提供 at-least-once 投递，不声称 exactly-once；消费者必须按稳定 \`id\` 或 \`dedupeKey\` 幂等推进。失败按 \`maxAttempts\` 回到 pending 或进入 \`dead_letter\`。

\`\`\`mermaid
sequenceDiagram
    participant S as Domain Service
    participant DB as Execution DB
    participant W1 as Outbox Worker A
    participant B as Idempotent Consumer
    participant W2 as Outbox Worker B

    S->>DB: BEGIN IMMEDIATE
    S->>DB: CAS update revision N -> N+1
    S->>DB: INSERT event(id, dedupeKey, pending)
    S->>DB: COMMIT
    W1->>DB: claim; state=publishing, lease=A
    W1->>B: publish(stable id)
    Note over W1: crash before acknowledgement
    W2->>DB: reclaim after lease expiry
    W2->>B: publish(same stable id)
    B-->>W2: duplicate-safe acknowledgement
    W2->>DB: state=published
\`\`\`

## 3. Append-only 审计

审计输入是严格 Schema，可关联 Program、Attempt 和 requestId。写入前递归脱敏 \`apiKey\`、\`authorization\`、密码、secret、credential、cookie、access/refresh token 等字段，同时限制深度、字符串、数组和对象键数量；\`inputTokens\`、\`outputTokens\`、\`tokenUsage\` 等计量数据不会因名称中含 token 而被误删。

数据库触发器拒绝 \`audit_events\` 的 UPDATE 和 DELETE，Repository 只提供 append/get/query。索引支持按 Program、Attempt、requestId 查询。审计记录不是秘密保险箱：调用方仍不应把原始凭据放入 \`reason\` 或 eventType 等标量字段。

## 4. 故障语义与边界

- SQLite 是当前单机事实源；跨数据库/消息代理的 exactly-once 不在范围内。
- Outbox 租约依赖 ISO 时间比较，生产 worker 必须使用统一 UTC 时钟，并给租约留出抖动余量。
- 审计 append-only 防止应用层误改，不替代操作系统权限、磁盘加密或远端不可篡改归档。
- 所有组件仅是持久化基础设施；只有后续实验性 Program Service 接线且父开关开启后才会运行。

## 5. 验证证据

- 两个连接基于同一 revision 写入，仅一个成功；另一个得到结构化冲突；
- 实体和 Outbox 在故障注入下同时回滚，正常提交时同时可见；
- 发布后确认前崩溃可被过期租约重领，事件 id/dedupeKey 不变；
- 敏感字段递归脱敏，计量字段保留；UPDATE/DELETE 由数据库触发器拒绝；
- Program、Attempt、requestId 三条查询路径均有测试。
`;export{e as default};