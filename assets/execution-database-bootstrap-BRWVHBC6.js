var e=`# BLH-005 Execution DB 启动器

> 日期：2026-10-10
> 状态：已实现；已接入 Orchestrator 启动与关闭生命周期，仅在 \`budgetExecution.enabled=true\` 时打开并迁移。

## 文件位置

实验 Program 使用独立数据库：

\`\`\`text
<runtime.persistence.state_dir>/execution/execution.db
\`\`\`

模块导入没有副作用。父级实验功能显式启用后，Orchestrator 调用 \`openExecutionDatabase()\`、执行版本化迁移并注册实验 Program 服务和调度循环；启动初始化失败时关闭连接并抛出错误，正常停机时关闭连接。默认关闭状态不会创建 Execution DB 目录、数据库或启动 Program 调度循环。

## 打开策略

每个连接设置并验证：

\`\`\`text
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;
PRAGMA trusted_schema = OFF;
PRAGMA quick_check;
\`\`\`

启动器还会在事务中创建并删除一个探针表，用于验证目标数据库确实可写。事务结束后不留下业务表；BLH-006 才负责 Schema v1。

## Fail-closed

下列情况抛出结构化 \`ExecutionDatabaseOpenError\`，并关闭已经部分打开的连接：

- 状态目录为空；
- 目录或数据库不可写；
- 文件不是有效 SQLite 数据库；
- WAL 或关键 PRAGMA 无法生效；
- \`quick_check\` 不通过。

错误对象只保存本地数据库路径和 cause，不会把错误转成“继续使用 Task board/JSON”之类的降级路径。

## 已验证行为

- 缺失目录会以受限权限递归创建；
- 两个连接可同时打开同一 WAL 数据库；
- 关闭并重启后配置保持正确；
- \`close()\` 幂等；
- 损坏数据库和只读存储均 fail closed；
- 启动写探针不会遗留表。

当前 Schema 为 v7，共享同一 SQLite 的实例使用持久化 owner/fence 协调；停机先排空调度并停止续租，再关闭数据库。详见[跨实例调度协调](./cross-instance-scheduling-runtime.md)。
`;export{e as default};