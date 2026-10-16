var e=`# 持久化唤醒运行时

更新：2026-10-16。对应第五项后续任务 / BLH-029 常驻集成。

实验父开关启用后，Orchestrator 在 Agent 池注册完成后立即运行一次扫描，随后每 10 秒扫描。\`ProgramWakeupRuntime\` 为活动计划保存带有 Program、Plan、execution epoch 的 \`scheduler_tick\` 唤醒；已有 pending 或消费中的唤醒会保留原 deadline。关闭实验父开关时不会启动该运行时。

\`WakeupService.dispatchDue\` 在同一 SQLite 事务中写入稳定 ID 的 \`program.wakeup_due\` Outbox 事件并标记唤醒 dispatched。专用消费者只领取这一事件类型，不领取其他 Outbox 事件。成功调用 Coordinator 后，事件确认、审计和下一次持久化唤醒在同一事务提交。Wakeup 表沿用原结构；当前 Schema v7 已增加独立的跨实例调度所有权与资源占用，见[协调协议](./cross-instance-scheduling-runtime.md)。

消费语义是**至少一次**：进程在任务派发后、事件确认前退出时，租约到期后会重放 tick；Coordinator 使用已持久化的 Work Package 状态、Attempt Lease 和 dispatch intent 恢复关联，避免在单个常驻实例重启时重复创建任务。不能将 Outbox 去重解释成任意外部副作用恰好执行一次，跨实例互斥由独立 owner/fence 协议提供。

具体行为：

- 停机跨过多次心跳后，只补发已有的过期唤醒；后继时间按实际消费完成时间加 10 秒计算，不逐次回放所有错过的周期。
- 时钟回拨不会重发已确认事件，也不会重置待执行唤醒的时间。\`notBefore\` 仍由 Scheduler 检查，通常在到期后的下一次扫描派发。
- 暂停、恢复过渡或活跃 Barrier 使事件延期，延期不消耗失败重试次数。Coordinator 的手动 tick 也检查状态、Barrier 和 epoch，在异步对账后及每次新派发前重新检查。
- Resume 成功提交新 epoch 并释放 Barrier 时，在同一事务保存新 epoch 的即时唤醒。旧 epoch 或旧计划事件只审计为 stale，不执行 tick；终态 Program 只确认事件，不生成后继。
- 消费失败间隔 10 秒重试，单个事件最多 5 次，之后进入 Outbox dead letter 并记录错误日志。活动 Program 的后续扫描可重新建立心跳，dead letter 仍保留供排查。
- 消费租约默认 60 秒，异步调度期间每 20 秒续租。进程内扫描共享一个 Promise；退出时停止扫描并等待在途消费结束，再关闭 Runtime 和数据库。

回归使用真实 SQLite 数据库和 Coordinator，覆盖关闭并重开数据库、过期消费租约、派发后重放、回拨、暂停/恢复、未来 \`notBefore\`、消费重试、异常 payload、持久化失败回滚及停机排空。测试位于 \`src/program/program-wakeup-runtime.test.ts\`，恢复事务还由 \`control-effects-runtime.test.ts\` 验证。

默认关闭和 Shadow/Soft/Hard 发布门禁保持原有约束；跨实例排他调度由后续 v7 协调层提供，真实长期运行发布证据仍待补齐。

后续收尾集成增加 \`closing_out\` 消费：即使 Barrier 已冻结也允许继续对账和生成最终报告，该分支不会派发模型执行任务，详见[重规划、规则路由与收尾运行时](./replanning-routing-closeout-runtime.md)。
`;export{e as default};