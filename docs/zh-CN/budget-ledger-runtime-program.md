# 预算账本、运行时上下文与 Program 草案

> 对应 BLH-011～BLH-020。全部属于实验能力，`budgetExecution.enabled` 默认是 `false`。关闭时不打开 Execution DB、不迁移预算表，也不注册 Program API。

## 1. BudgetVector 与账户树

BudgetVector 的金额、Token、调用次数和外部单位都使用非负安全整数。加法检查 `Number.MAX_SAFE_INTEGER` 溢出，减法检查逐维下溢；缺失维度按零处理，零值在输出中规范化移除。

每个 Program 创建以下账户树：

```text
root
├── planning              protected
├── execution
│   ├── minimum
│   └── upgrade_pool
├── validation            protected
├── contingency           protected
└── closeout              protected
```

创建时一次性校验直接子账户的逐维额度之和不超过父账户。消费方必须声明 `consumerClass`，普通 execution 只能访问 execution/minimum/upgrade 账户，不能消费 validation 或 closeout。

## 2. Reservation 与结算

直属 Reservation 增加账户 `reserved`；子调用 Reservation 从父信封 `remaining` 划拨，不再次增加账户 reserved。因此信封内并发调用不会在根账户重复冻结。

```mermaid
sequenceDiagram
    participant S as Scheduler/Guard
    participant L as Budget Ledger
    participant P as Provider
    participant R as Usage Reconciler

    S->>L: reserve envelope (BEGIN IMMEDIATE)
    L-->>S: created + stable operationKey
    S->>L: reserve child call from envelope.remaining
    S->>L: activate(providerRequestId)
    S->>P: model request
    alt authoritative usage returned
        P-->>R: usage + request identity
        R->>L: idempotent settle(sourceEventId, actual)
        L->>L: reserved -= actual; spent += actual; return unused
    else provider confirms request absent
        R->>L: release remaining
    else result cannot be recovered
        R->>L: settle at reserved upper bound
    end
```

`operationKey` 防止同一调用重复预留，`sourceEventId` 防止 Usage 重复扣费。释放后到达的可信 Usage 不会被丢弃，而是记为 reconciled factual spend。所有余额改变使用 `BEGIN IMMEDIATE` 和 revision CAS。

## 3. Pricing Snapshot

全局模型目录可声明整数微单位价格。Program 创建时复制为不可变 Pricing Snapshot，并保存目录 revision 与 SHA-256 digest。估算使用 BigInt 中间乘法和向上取整，因此历史调用可以按原价格重放。

调用前比较冻结价格与当前目录；model 缺失、revision 变化或费率变化都会产生 `PRICING_CHANGED/MODEL_PRICE_MISSING`，soft/hard 路径停止新预留，shadow 路径只记录 would-block。

## 4. Runtime Context 与 Shadow Guard

实验 Attempt 的以下上下文通过本地 child-process IPC 和 Docker JSON IPC 传递：

```text
programId, workPackageId, attemptId,
executionEpoch, fencingToken, operationId, reservationId?
```

Agent event 和 tool call 回传同一上下文，普通 Task 继续省略该字段。生产 runner 已在 SDK 的共享 streamFunction 上安装预算包装，模型续轮、压缩和摘要调用都会再次经过父进程预算入口。每个受管调用生成独立 operation ID；Shadow 记录 would-block，Soft 在任务信封内创建幂等子 Reservation，并在交付模型终态前确认结算。受管 SDK 调用显式关闭底层自动重试，会话重试重新申请预算；这不构成 Provider 权威计费或 Hard 保证。完整协议见[模型调用计量与自动验收运行时](./model-metering-verification-runtime.md)。

当前 hard 路径仍受 BLH-004 的 No-Go Gate 限制：Provider 内部重试和权威请求身份尚未达到 hard 证据等级。本阶段没有绕过或放宽该 Gate。

## 5. Usage Reconciler 与历史基线

Usage Reconciler 通过 providerRequestId 查询：

- 找到可信 Usage：按冻结价格结算；
- 明确不存在：释放 Reservation；
- 查询失败或不可恢复：按预留上界保守结算。

历史基线是现有 UsageTracker JSONL 的只读投影，按 `taskClass × model × agentRole × toolProfile` 选择样本，输出样本量、P50、P90 和置信度。样本达到 20 个时采用双尾各 5% 裁剪；少于 5 个标记 `uncalibrated`。

## 6. Program 草案 CRUD 与启动边界

Program 草案创建在一个事务中写入：

1. Program draft；
2. 完整预算账户树；
3. Pricing Snapshot。

任一步故障全部回滚。更新和删除要求 expected revision 且只允许 draft；DELETE 是转为 `cancelled` 的逻辑删除，以保留不可变审计、账户和定价历史。Orchestrator 只在 `budgetExecution.enabled=true` 的启动路径打开/迁移 Execution DB、读取全局模型目录并注册 `/api/experimental/programs` 路由；默认关闭路径没有上述副作用。

## 7. 已知边界

- Program Coordinator 已接入生产 TaskManager，负责预算信封预留、Lease/Fencing、上下文绑定和续租；父进程 Prompt/Tool/Model 入口会重新校验执行上下文。SDK 调用级子 Reservation、回报 Usage 结算和未知结果保守对账已接入；Provider 权威账单、请求身份与实际发布环境验证仍待补齐。
- hard mode 仍然 fail closed，不声称 Provider exactly-once 或权威计费能力。
- Pricing Snapshot 是估算事实，不替代 Provider 最终账单。
- 当前账户树创建后不可在线重分配；Budget Amendment/transfer 将由后续任务实现。
