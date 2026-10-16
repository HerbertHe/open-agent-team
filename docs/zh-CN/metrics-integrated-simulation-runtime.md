# 指标告警与集成长周期仿真

核对日期：2026-10-16。实验父开关默认关闭；下述验证属于本地集成证据，不代表真实 Provider、Docker/远端会话或线上观察已通过。

## 指标与持久化告警

父开关开启后，Orchestrator 每 10 秒运行 `ProgramMetrics.evaluateAll()`；即使 Program 已终止，仍检查未解决的不确定性。既有 `GET /api/experimental/programs/:id/view` 增加 `metrics` 与最近 200 条 `alerts`，列表投影同步包含。读取不写告警，后台评估负责持久化。

| 告警 | 检测依据 |
| --- | --- |
| `BUDGET_OVERRUN` | 每账户 spent + reserved 逐维超过 limit，包括 externalUnits；非法向量或溢出视为异常 |
| `PROTECTED_RESERVE_USED` | dispatch/model/tool-budget 执行预留落入保护账户；正常 validation/closeout 预留不告警 |
| `DUPLICATE_EFFECT` | 同一 operation request ID 出现重复 tool_dispatched 审计记录 |
| `SNAPSHOT_FAILURE` | 控制协议留下 failed 请求 |
| `UNCERTAIN_TOO_LONG` | Reservation、Effect 或 Attempt 已处于 uncertain 超过 15 分钟 |
| `QUIESCE_TIMEOUT` | 控制请求停留 quiescing 超过 60 秒 |
| `LATE_EVENT_STATE_ADVANCE` | 状态应用审计的 eventEpoch 与 currentEpoch 不一致 |
| `RESUME_WITHOUT_PREFLIGHT` | 恢复审计缺少格式正确的预检报告 digest |

同时展示 active/uncertain 预留、uncertain Attempt/Effect、快照数、未关闭告警数与 dead-letter Wakeup 数。不确定性年龄从进入该状态后的更新时间计算，正常长任务不因此告警；墙钟回拨时年龄下限为零。

同 Program、code、规范化 labels 的未关闭告警在 SQLite immediate 事务内合并，跨连接重复评估不会新增重复告警。严重级别只能提升。预算、uncertain 年龄和 quiesce 超时恢复正常后自动记录 resolved_at；历史安全违规保留告警。

labels 只允许固定枚举 reason/component；Prompt、凭据、任意 token 和错误全文均不能用作标签。指标扫描失败日志也只写固定原因码。

边界：重复 dispatch 是网关可观测异常，不等于第三方服务完整的副作用账单；预检 digest 检查也不能替代 ResumeService 的内容校验。任意外部服务的真实执行次数与权威用量仍需要 Adapter。此处持久化告警不发送邮件或消息通知。

## 90 天集成执行

```bash
pnpm run simulate:program --seed program-ci-v1 --programs 2 --days 90 --output /tmp/oat-program-simulation.json
pnpm run test:program
```

`IntegratedLongHorizonSimulator` 仅创建临时目录和独立 SQLite，不读取或修改项目运行数据库。接受 90～366 天、2～16 个 Program；结束后移除临时执行状态，按需导出 JSON。报告先通过已有 append-only simulation_runs 写入接口持久化到临时 DB，再返回给调用者；JSON 导出是保留报告的方式。

每个 Program 包含四阶段依赖链，在不同 notBefore 窗口运行，最后一阶段位于最后一个虚拟日。实际调用以下生产组件：

- Program 草案、Plan 评估与显式审批；
- Wakeup → Outbox → Coordinator → Reservation、Lease、跨实例 owner/fence；
- ModelCallService 调用级计量、ToolEffectService 权限/fencing/防重和测试外部接收器；
- 文件验收、有限重试/重规划、证据继承与安全 Closeout；
- Control、磁盘 Snapshot、Resume 预检/确认、重启恢复与迟到事件隔离；
- 真实 SQLite 关闭重开、迁移核对及 SQLite backup/恢复。

外部模型响应和任务派发器使用测试替身。Provider 429/500/402 被实际注入模型调用包装流程，未知 usage 走真实保守结算。测试任务适配器在服务重启间保留任务与上下文；这不证明 JSON TaskManager 支持跨进程写入或远端会话透明恢复。

六个故障点均在实际组件路径触发：预算预留更新后、结算提交前、Lease 获得后、任务接受但派发关联提交前、快照 manifest 落盘后、恢复 epoch 增加后。分别验证事务回滚、派发关联补偿/防重、磁盘快照幂等重试与中断恢复；还定期重建服务和重新打开 SQLite。这里的故障注入使用异常，不声称对六处都进行了操作系统强杀。真实多进程争抢/旧 owner fencing 另由 cross-instance-scheduling 回归覆盖。

报告含实际表记录计数、故障覆盖、事件数、七项不变量与语义 trace digest。重复外部副作用由测试接收器按 stableKey 统计；快照检查扫描实际导出文件，并尝试保存 `.env` 验证拒绝。预算检查保留每天观测到的异常，不能靠最后修复余额抹掉。必须所有 Program 完成带证据收尾、无悬挂预留/告警且不变量全为零才通过。

随机 UUID、临时路径不参与语义摘要；对象键规范排序，seed 和全部输入参与摘要。相同输入重复运行得到相同报告。

## 发布边界

原 `LongHorizonSimulator` 继续提供快速 synthetic 策略回归。Soft/Hard Gate 现在还检查集成报告版本、覆盖计数、全部故障点、不变量和完整性 digest；只修改 evidenceLevel 无法通过。

digest 用于发现损坏，不能认证不可信调用者或充当 Provider 签名。集成报告不自动写入生产 release_gate_records，也不能补足真实至少 7 天 Shadow、至少 7 天低风险 Soft、质量基线、安全评审及 verified Provider/Runtime 能力。Hard 仍未开放。
