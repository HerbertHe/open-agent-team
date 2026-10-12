var e=`# BLH-006 Execution Schema v1

> 日期：2026-10-10
> 状态：v1 已实现；当前二进制最新版本为 v6。Execution DB 仅在实验父开关开启时接入 Orchestrator 生命周期。

## Schema 内容

v1 在单个 SQLite 事务内创建：

\`\`\`text
execution_schema_migrations
programs
plan_versions
work_packages
work_package_dependencies
work_package_attempts
attempt_leases
execution_outbox
audit_events
\`\`\`

这是 Program 执行事实源的最小骨架。预算账本由 v2 添加，计划运行时存储由 v3 添加；Checkpoint 和 Suspension Snapshot 仍由后续迁移添加。

## Schema v2

v2 在独立原子迁移中增加：

\`\`\`text
budget_accounts
budget_reservations
pricing_snapshots
spend_events
estimation_observations
\`\`\`

空库依次提交 v1、v2；若 v2 中断，v1 保持可验证状态，重启后只继续 v2，不重复执行 v1。

## Schema v3

v3 增加 \`acceptance_criteria\`、\`work_package_estimates\`、\`admission_decisions\`、\`wakeups\` 和 \`task_board_projections\`。空库依次提交 v1、v2、v3；任一版本中断只回滚当版，重启从最后一个已验证版本继续。

## Schema v4

v4 增加 \`execution_checkpoints\`、\`execution_barriers\`、\`suspension_snapshots\`、\`program_control_requests\` 和 \`effects\`，用于持久化中止、恢复和外部副作用安全状态。空库按 v1→v2→v3→v4 顺序迁移。

## Schema v5

v5 增加 \`verification_evidence\`、\`replan_failures\`、\`program_closeouts\` 和 \`program_alerts\`，分别持久化验收证据、连续同类失败、幂等收尾报告和安全告警。空库按 v1→v2→v3→v4→v5 顺序迁移；v5 故障只回滚本版。

## Schema v6

v6 增加 \`simulation_runs\`、\`threat_model_reviews\` 和 \`release_gate_records\`，持久化确定性长周期仿真、安全评审及 Shadow/Soft/Hard Gate 证据。空库按 v1→v2→v3→v4→v5→v6 顺序迁移；v6 中断不会污染已提交的 v5。

## 迁移协议

- \`PRAGMA user_version\` 是当前 Schema version；最新版本为 6。
- \`execution_schema_migrations\` 保存 migration name、SHA-256 checksum 和应用时间。
- 每一版 DDL、migration history 与对应 \`user_version\` 在同一事务提交。
- 重复运行会验证表集合、checksum 和 foreign key，而不是直接返回成功。
- 数据库版本高于当前二进制时返回 \`SCHEMA_TOO_NEW\`。
- version 0 数据库存在未知表时返回 \`UNMANAGED_SCHEMA\`。
- 表集合、checksum 或 foreign key 漂移时返回 \`SCHEMA_DRIFT\`。
- 迁移异常返回 \`MIGRATION_FAILED\`，事务完整回滚。

## 数据库级不变量

- 状态字段使用 CHECK 约束；revision、epoch、attempt number 和 fencing token 不允许负数或零值越界。
- JSON 字段使用 \`json_valid()\` 校验。
- Program 的 active Plan 必须属于该 Program。
- Work Package 的 Plan 必须属于同一 Program。
- Work Package 依赖边两端必须属于同一 Plan Version，且不能自依赖。
- Attempt、Lease、Audit 使用 foreign key，并定义明确的删除行为。
- Outbox 状态和重试次数受 CHECK 约束。

## 故障验证

自动化测试覆盖：

1. 空库升级；
2. 重复升级；
3. DDL 完成后、history 写入前模拟崩溃并恢复；
4. 未知高版本拒绝；
5. migration checksum 篡改；
6. foreign key 和 JSON 约束；
7. 跨 Program Plan/Work Package 绑定拒绝。
`;export{e as default};