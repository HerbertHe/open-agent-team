var e=`# BLH-031～040：Checkpoint、中止恢复与外部副作用安全

> 状态：已实现并验证。所有能力仍属于默认关闭的实验功能，统一受 \`budgetExecution.enabled=false\` 控制。hard 模式仍为 No-Go；本阶段提供安全原语，不代表端到端硬预算保证已经开放。

## 1. 已实现能力

| 任务 | 实现 | 保证 |
| --- | --- | --- |
| BLH-031 | \`checkpoint-store.ts\` | Continuation State 严格 Schema、大小上限、SHA-256、TTL、epoch/token 校验；恢复不依赖完整对话 |
| BLH-032 | \`InterruptibleRuntimeProvider\`、本地/Docker IPC | checkpoint request、attempt abort、超时 Session 终止、恢复前 Session reset |
| BLH-033 | \`execution-barrier.ts\` | 持久化 epoch barrier；调度、模型和工具入口可在每次调用前重新读取并 fail closed |
| BLH-034 | \`suspension-snapshot-store.ts\` | manifest、内容 digest、受控工件；拒绝越界、symlink、\`.git\`、依赖目录与秘密文件 |
| BLH-035 | \`program-control-service.ts\` | 固定顺序执行冻结、撤租、checkpoint、abort、快照、对账状态；存储失败不标记完成 |
| BLH-036 | 中止 API、结构化 control intent、审计 | 按钮/结构化 Admin 意图共享服务；\`controlRequestId\` 幂等且跨 Program 冲突拒绝 |
| BLH-037 | \`resume-service.ts\` | dry-run 漂移报告、显式确认、新 epoch、Session reset；阻塞漂移保持暂停 |
| BLH-038 | \`late-event-reducer.ts\` | 旧 epoch/token 状态事件不能推进状态；可信 Usage 仍可进入账本对账路径 |
| BLH-039 | \`effect-ledger.ts\` | prepare/dispatched/confirmed/uncertain/reconciled/cancelled；operation key 和 request/receipt digest |
| BLH-040 | \`tool-guard.ts\` | 权限、预算、barrier、epoch、lease、fencing、幂等能力联合门控 |

Execution Schema v4 新增：\`execution_checkpoints\`、\`execution_barriers\`、\`suspension_snapshots\`、\`program_control_requests\`、\`effects\`。每版迁移独立事务提交，并验证 checksum、表集合与外键。

## 2. 中止协议

固定顺序不能调整：

\`\`\`text
幂等校验
→ Program epoch + 1，status=interrupt_requested
→ 持久化 barrier，冻结新调度/模型/工具调用
→ 删除 Attempt leases
→ graceful 模式请求 cooperative checkpoint
→ Runtime abort；未确认则终止 Session 并标记 uncertain
→ 生成 digest 保护的权威 Suspension Snapshot
→ 汇总未决 Effect/Reservation
→ suspended / suspended_uncertain / closing_out
\`\`\`

Checkpoint 与 pre-interrupt 状态不是权威 Suspension Snapshot。权威快照必须在 barrier 生效、Lease 撤销且 Runtime 已静默之后生成。控制流程不消费 Program 模型预算。

活动 Attempt 与 Agent 的对应关系必须由服务端从 \`work_package_attempts + attempt_leases.owner_id\` 读取；UI/Admin 请求中的 Agent 列表不是授权源。Checkpoint 与 abort 使用相关 request ID 等待 ACK，超时或缺少 Lease owner 时 Attempt 进入 \`uncertain\`，不得返回“安全停止”。

三个控制模式保持不同语义：

- \`graceful\`：先请求 checkpoint，再 abort；
- \`immediate\`：跳过 cooperative checkpoint，立即 abort；
- \`cancel_closeout\`：中止后进入 \`closing_out\`，默认不恢复。

## 3. 快照安全

Snapshot DB 行与磁盘 \`manifest.json\` 必须同时匹配 SHA-256。工件只允许显式相对路径和普通文件；拒绝绝对路径、\`..\`、symlink、\`.git\`、\`node_modules\` 及名称包含 env/secret/credential/token/private-key 的文件。每个工件有独立 digest 和大小上限。任何 manifest 或工件篡改都使恢复失败。

manifest 只保存恢复所需的受限状态：Program/Plan/epoch/revision、预算 digest、在途 Reservation/Effect、Work Package 状态、Checkpoint 引用、Git/工件引用、Wakeup 和恢复前置条件。不会把完整聊天记录或整个工作目录写入数据库。

## 4. 恢复协议

恢复先生成 dry-run 报告，检查：

- Snapshot 所属 Program 与完整性；
- Program 是否仍为 suspended；
- uncertain Effect 和快照前置条件；
- Git SHA、工件 digest、权限漂移；
- 价格和 Provider 变化警告；
- 需要重新执行的未完成 Work Package。

报告包含 digest，用户必须显式确认。恢复先以 CAS 将 Program 放入 \`reconciling\`、递增 epoch 并保持 barrier；随后 reset/recreate Agent Session。全部 reset 成功后才切为 running 并释放新 epoch 的 barrier。旧 Session、Attempt token 或旧报告都不能恢复执行。

## 5. Effect Ledger 与 Tool Guard

所有受管外部副作用先持久化 \`prepared\`：

\`\`\`text
prepared → dispatched → confirmed
                    └→ uncertain → reconciled
prepared → cancelled
\`\`\`

\`operationKey\` 唯一；同 key 不同请求返回冲突。发送前 Tool Guard 同时验证：工具权限、预算决策、当前 Program epoch、barrier、Attempt lease、fencing token，以及 hard 高影响调用的 Provider 幂等能力。旧 token 即使还能运行本地代码，也不能通过受管 Adapter 发出外部效果。

迟到事件分流：旧 epoch 的状态结果只写审计，不推进 Work Package；旧 epoch 的可信 Usage 标为 \`applied_to_ledger_only\`，供账本保守结算。

## 6. 完整时序图

\`\`\`mermaid
sequenceDiagram
    autonumber
    actor U as User/Admin
    participant API as Control API/Admin Tool
    participant C as Program Control Service
    participant DB as Execution DB
    participant B as Execution Barrier
    participant R as Interruptible Runtime
    participant CP as Checkpoint Store
    participant SS as Snapshot Store
    participant RS as Resume Service
    participant TG as Tool Guard
    participant EL as Effect Ledger
    participant X as External Provider

    U->>API: pause/interrupt/cancel + controlRequestId
    API->>C: 同一结构化请求
    C->>DB: 校验 requestId/program/mode/revision
    alt 已完成的相同请求
        DB-->>C: 返回原结果
        C-->>U: 幂等结果
    else 新请求
        C->>DB: BEGIN: epoch++, interrupt_requested
        C->>B: freeze(newEpoch)
        C->>DB: revoke all leases
        alt graceful
            C->>R: requestCheckpoint(attempt, deadline)
            R-->>CP: 受限 Continuation State
            CP->>CP: size/digest/TTL/epoch/token
            CP->>DB: checkpoint
        end
        C->>R: abortAttempt
        alt abort 未确认
            C->>R: terminateSession/process tree
            C->>DB: Attempt=uncertain
        else abort 已确认
            C->>DB: Attempt=aborted
        end
        C->>SS: 创建权威 manifest + 受控工件
        SS->>SS: 路径/秘密/symlink/大小/digest 校验
        SS->>DB: suspension_snapshot
        C->>DB: reconcile pending Reservation/Effect
        C->>DB: suspended / suspended_uncertain / closing_out
        C-->>U: snapshotId + 中止状态
    end

    U->>RS: resume dry-run(snapshotId)
    RS->>SS: 校验 DB/manifest/artifact digest
    RS->>DB: 读取 Git/价格/Provider/权限/uncertain 状态
    RS-->>U: drift report + reportDigest + restart set
    alt 存在阻塞漂移或未确认
        RS-->>U: 保持 suspended
    else 用户确认
        RS->>DB: CAS, epoch++, reconciling
        RS->>B: freeze(newEpoch)
        RS->>R: reset/recreate Session
        alt reset 失败
            RS->>DB: suspended，barrier 保持
        else reset 成功
            RS->>DB: running
            RS->>B: release(newEpoch)
            RS-->>U: resumed
        end
    end

    R->>TG: effectful tool + context(epoch, token, operationKey)
    TG->>B: assertAllowed(epoch)
    TG->>DB: validate lease/fencing/permission/budget
    alt 旧 epoch/token 或 hard 高影响不可控
        TG-->>R: deny before dispatch
    else 允许
        TG->>EL: prepare(requestDigest)
        EL->>X: dispatch(idempotencyKey)
        alt provider confirmed
            X-->>EL: receipt
            EL->>DB: confirmed + receiptDigest
        else timeout/unknown
            EL->>DB: uncertain，禁止自动重试
        end
    end

    X-->>DB: late usage/state event
    alt epoch/token 已过期且是状态事件
        DB->>DB: audit only, ignored_for_state
    else epoch 已过期但 Usage 可信
        DB->>DB: ledger reconciliation only
    end
\`\`\`

## 7. BLH-041～050 运营闭环

- Effect Reconciler 只通过 Provider/工具状态查询把 \`uncertain\` 归并为 \`reconciled\`；未知或不可恢复的高影响操作保持 \`uncertain\`，不会生成重试指令。
- Budget Health 按所有预算维度中最差覆盖率选择 \`explore/balanced/commit/closeout\`，输入仅接受 execution 可用额，validation/closeout 等保护分区不能被调度器借用。
- Replanner 持久化连续同类失败计数；通过 stable key 和相同验收标准继承已完成包，已继承包不会重新执行。
- 模型路由仅依据能力、风险、预算模式和已冻结价格做规则选择，忽略 Prompt 指定的升级模型；未知价格返回 \`NO_PRICED_MODEL_ROUTE\`。
- Verification Service 使用注册的版本化验证器，将证据绑定到 Attempt、criterion、artifact digest/Git SHA；LLM judge 必须有非 LLM 证据佐证。
- Closeout 先冻结 barrier，再生成 reservation/effect/强制工作包/证据报告；只有强制工作完成、有证据且无不确定账目时才能标记 \`completed\`，否则是 \`incomplete\`。
- Desktop Program 页面直接读取 Execution DB read model，而非 Task 投影。父开关关闭时没有入口；三个停止按钮和恢复操作均有明确状态与危险确认，uncertain 永不显示“安全停止”。
- 指标标签仅允许有限安全字符，不接收 Prompt、凭据或自由文本；预算越界、保护预算使用、重复副作用、快照失败和长期 uncertain 可生成持久告警。
- 故障注入 Harness 提供 reservation、dispatch、settlement、lease、snapshot、resume 六个一次性确定性崩溃点，用于验证重启幂等。

这些能力仍属于实验功能，\`budgetExecution.enabled\` 默认保持 \`false\`。BLH-051～055 的确定性长周期仿真、威胁评审和发布 Gate 已实现，详见 [长周期仿真、安全评审与发布 Gate](./release-assurance-and-long-horizon-simulation.md)；没有真实观察证据时 Gate 保持 blocked，hard 继续 fail closed。
`;export{e as default};