# M14 记忆运维与可观测性

> 状态：已实现  
> 更新日期：2026-09-14  
> 适用范围：Desktop 全局设置、Project Orchestrator 本地 API

## 入口与边界

Desktop 的入口为「全局设置 → 记忆管理」。页面按 Project 展示状态和执行操作，不改变现有 Admin、Leader、Worker 页面及其交互。离线 Project 只显示不可用，不会由 Desktop 绕过 Orchestrator 直接打开 SQLite 或 Zvec collection。

页面和 API 只返回索引 identity、计数、状态、脱敏错误和审计元数据，不返回 API key、完整提示、记忆向量或 collection 内部文档。

## 页面信息

选择在线 Project 后可以查看：

- 当前检索模式、实际 backend、fallback 和熔断状态；
- 当前 Embedding Profile、embedding revision、维度、目标 collection revision 和 active pointer；
- 每个 collection 的 building/ready/active/retired/failed 状态、完整度、文档数、pending/dead-letter 数、磁盘占用和迁移进度；
- 重建预计文档数、向量数据量、保守磁盘需求、可用磁盘和空间是否充足；
- 最近后台操作、retrieval trace 和访问审计；
- candidate/disputed 事实，以及确认和忘记入口。

以下情况会明确显示警告：Embedding 未配置或不可用、active collection 缺失、模型 identity 不匹配、检索回退、pending 积压、dead letter、重建失败和磁盘不足。

## Embedding Profile 版本规则

Embedding Profile 是全局资源，Project 只保存引用。Profile 一旦被全局默认值或任一 Project 引用，模型身份字段即不可原地修改或删除。Desktop 保存全局模型配置前会扫描引用关系，并列出显式引用和继承全局默认值的受影响 Project。

需要更换 provider、endpoint、model、dimensions、normalization 或 `revision` 时：

1. 创建一个新名称的 Profile，或以新版本名称保存；
2. 在受影响 Project 中切换引用；
3. 在「记忆管理」中检查重建估算并创建 sibling collection；
4. 等待状态变为 ready 后激活；
5. 观察检索状态，必要时回滚到保留的旧 collection。

API key、timeout、batchSize 和 maxAttempts 属于运行参数，不改变冻结的模型 identity；它们仍可按配置规则更新。

## 索引操作

| 操作 | 前置条件 | 行为 |
| --- | --- | --- |
| 重建 | Embedding 可用、磁盘估算充足、无冲突后台任务 | 创建 sibling collection，从 SQLite 权威数据构建并追赶增量 |
| 暂停 | collection 正在 building | 在批次边界停止消费并保留进度 |
| 重试/继续 | migration 已暂停或失败且原因已处理 | 从持久化进度继续；dead letter 由显式恢复流程重试 |
| 激活 | collection 为 ready 且完整性检查通过 | 原子更新 active pointer，旧 active 转为 retained retired |
| 回滚 | 旧 collection 仍被保留且 identity 有效 | 先追平旧 collection，再原子切换 active pointer |

重建、继续、激活和回滚均要求前端确认；服务端同时要求请求体包含 `confirm: true`，避免绕过 UI。重建还会在服务端再次检查磁盘空间。操作以后台 job 运行，页面轮询进度；索引错误不会终止 Agent 任务，当前检索继续使用旧 active collection 或 lexical fallback。

## 本地 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/memory/operations` | 完整脱敏运维快照 |
| `GET` | `/memory/index/estimate` | 当前目标 collection 的保守重建估算 |
| `POST` | `/memory/index/rebuild` | 启动重建，请求体必须为 `{ "confirm": true }` |
| `POST` | `/memory/index/:revision/pause` | 暂停指定重建，不需要确认体 |
| `POST` | `/memory/index/:revision/resume` | 继续指定重建，必须确认 |
| `POST` | `/memory/index/:revision/activate` | 激活 ready collection，必须确认 |
| `POST` | `/memory/index/:revision/rollback` | 回滚到保留 collection，必须确认 |
| `GET` | `/api/embedding-profile-impact?profile=...` | Desktop control plane 预览 Profile 引用影响 |

`:revision` 必须是 16 位小写十六进制 collection revision。耗时操作返回 `202` 和 job 快照；同一运维门面同一时间只运行一个后台任务。

## 故障处理

- **Embedding 未配置**：不能建立 dense collection；继续使用 lexical，先在全局模型中创建 Profile。
- **模型不匹配**：不得打开旧 collection 写入；创建新 Profile/collection 并重建。
- **磁盘不足**：重建按钮禁用，服务端也拒绝启动；释放空间后重新估算。
- **402 或限额错误**：迁移持久化为 paused，不影响 Agent；补充额度后显式继续。
- **dead letter**：检查脱敏错误和 Profile 连通性，修复后从管理页继续，不会自动无限重试。
- **新索引异常**：未激活时继续旧索引；已激活且旧 collection 尚在保留期内时执行回滚。
- **Project 离线**：先恢复 Project Orchestrator；Desktop 不直接操作其数据目录。

## 验证

```bash
pnpm test:memory:operations
pnpm test:memory
pnpm exec tsc --noEmit
pnpm run build
pnpm --dir desktop run lint
pnpm --dir desktop run build
```

M14 专项测试覆盖 Profile 引用分类与不可变约束、真实 Node SDK 重建/激活、进度与完整性、磁盘不足以及响应中不泄漏 secret/vector。
