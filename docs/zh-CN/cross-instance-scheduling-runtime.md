# 跨实例调度协调

更新：2026-10-16。对应第七项后续任务，补齐 BLH-027～029 的共享数据库竞争路径。

## 适用范围

多个当前版本的 Orchestrator 的 Program 调度可以连接同一个 Execution SQLite 数据库；本功能不把本地 TaskManager 队列改成共享队列，也不提供全应用状态目录的多写者合并。每次进程启动生成独立的 instance ID，每个 Program 同一时间只有一个调度 owner；其他实例返回 `mode: standby`，不做恢复补偿、验收、重规划或新派发。

这是共享 SQLite 下的排他调度与保守接管，不包含远端 Agent 会话迁移或网络分区下的透明故障恢复。不同数据库之间没有协调能力，也未验证网络文件系统上的 SQLite 部署。升级到 v7 前应停止旧版本实例；旧二进制没有新 fencing 检查，不能混跑。

## Schema v7 与所有权

新增三张表：

| 表 | 用途 |
| --- | --- |
| `program_scheduler_leases` | Program owner、递增 scheduler fence、60 秒租约，以及独立 tick ID/到期时间 |
| `attempt_execution_owners` | 把 Attempt 绑定到派发它的 instance ID 和 scheduler fence |
| `execution_resource_claims` | 按 project + resource key 唯一占用 Agent 和工作包冲突资源 |

调度 owner 的租约在 tick 完成后继续有效，运行中的 Agent 才能继续发送模型/工具请求。常驻实例每 20 秒续租，tick 在异步工作期间也续租；续租不能复活已经过期的租约。不同 owner 接管、过期 owner 重领或过期 tick 被替换时递增 fence。tick ID 防止同一 instance ID 下两个 Coordinator 同时运行。

领取、续租、完成 tick 和接管均使用 SQLite 事务或 owner/fence/tick 条件更新。旧回调不能清除新 owner 的 tick。正常停机先停止并排空唤醒与 Coordinator，再关闭 Runtime 和数据库；调度 owner 在排空后释放租约。

v7 的 DDL、迁移历史和 user_version 同事务提交，失败保留已提交的 v6。旧迁移 SQL/checksum 不变。两个进程并发迁移时，观察到另一个进程推进版本会重新读取并验证历史，不能把真实 Schema 漂移当作迁移成功。

## 原子派发和资源竞争

派发前在同一 `BEGIN IMMEDIATE` 事务中重新检查 owner、Program 状态、Barrier、epoch 和工作包 revision，再一起保存：

- dispatch intent 审计；
- 预算 Reservation 与激活状态；
- Attempt、运行状态、Lease 与 instance/fence 绑定；
- 项目内 `agent:<id>` 及 `conflict:<key>` 占用。

任一步失败都会回滚，不留下孤立预算或半个 Attempt。资源冲突不进行外部派发。项目内唯一占用还阻止不同 Program 同时使用同名 Agent 或相同冲突键；只有已明确完成、失败或中止且无未决工具副作用的 Attempt，才能在后续派发时释放旧占用。uncertain 占用保留隔离。资源协议只覆盖受管 Program，不改变普通 Task 的调度；普通 Task 的 JSON 队列不是共享消息队列。

`TaskManager.createTask` 在事务外调用，避免跨异步操作持有 SQLite 写锁。Program Task ID 使用 UUID，避免不同进程的每日自增编号碰撞；恢复和对账必须同时匹配 Program、Work Package 和 Attempt，不能仅凭 Task ID 或 conflict key 关联。返回后再次检查 owner/fence；所有权已丢失时不提交成功关联，也不以失败补偿释放预算。

## 运行时 fencing 与保守接管

Prompt、模型及工具执行入口读取数据库中的 Attempt owner/fence 绑定，不接受子进程自报所有权。它必须匹配当前 scheduler 租约、有效期和实际接收请求的 instance ID。Attempt 的续租/状态提交也检查 scheduler 绑定、Barrier 和 epoch。验收证据提交、重规划及内部收尾在异步返回后和写事务内重新检查 tick 所有权。

新实例看不到旧实例的 Task 队列，不构成“任务没有执行”的证据。接管时：

1. 旧 owner/fence 下仍在 leased/running/checkpointed/verifying 的 Attempt 转为 uncertain，撤销 Attempt Lease。
2. 工作包进入 replanning_required；对应未结算预算保留为 uncertain，资源占用不释放。
3. 未确认的远端 dispatch intent 记录 `program.work_dispatch_uncertain`，不补发同一个工作包。
4. 可查询结果继续对账，迟到模型用量仍按原 operation ID 入账；不能确认时进入不完整交付或保留不确定性，不能自动重试。

接管没有在途 Attempt 的 Program，可继续调度剩余 runnable 工作。已开始的外部请求不能通过数据库 fence 撤销，因此不能承诺任意副作用恰好执行一次。

## 唤醒、中止、恢复与对账

Wakeup 的 Outbox 领取会过滤仍由其他实例持有的 Program，不增加重试次数，也不抢走当前 owner 的心跳。发生领取竞争后收到 standby 时仅延期，不确认事件。

在另一实例发起中止时，共享 Barrier/epoch 立即阻止后续受管请求；无法触达的远端执行标为 uncertain，不向本地同名 Agent 发送 abort/terminate。后台工具对账也会跳过其他有效 owner 正在执行的操作，不能因为本地没有任务就把远端操作判为未知或未执行。

启动恢复不会回滚另一个有效 owner 正在进行的 resume。常驻扫描可将 owner 已过期的中断 resume 恢复为 suspended。恢复预检对属于其他 runtime owner 的会话增加 `foreign_runtime_owner` 阻断项，避免重置本地同名会话；当前版本不自动迁移这些会话。

只读 Program view 增加 `schedulerOwnership` 和 `resourceClaims`，可查看 owner/fence/到期时间及持久化资源占用。

## 回归证据与限制

`cross-instance-scheduling.test.ts` 启动真实 Node 子进程并使用同一 SQLite 文件，验证异步派发竞争、租约过期接管、旧回调 fencing、预算保留、迟到用量、跨 Program 冲突和并发迁移。其他测试覆盖 Agent 独占、原子派发故障回滚、过期验收禁止提交、远端中止隔离、工具对账跳过及恢复所有权隔离。

现有 Wakeup 重启测试改为使用虚拟 scheduler 时钟；活跃任务在未知新实例中的重启不再假定可以无损接管。uncertain 的人工处置、真实远端 Provider/容器故障演练和跨数据库协调仍不在本次保证范围内。实验父开关默认关闭，Hard 发布门禁不变。
