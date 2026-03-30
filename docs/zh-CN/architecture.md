# Agent 团队架构（Orchestrator + OpenCode）

## 1. 总览：声明式团队如何落地

本项目提供一个“声明式的 agent team 构建”流程：你在 `team.json` 中声明 `Admin / Leader / Worker` 的角色、模型、skills、以及团队分支/工作空间策略；运行时由 Orchestrator 读取配置并完成以下工作：

- 启动静态的 `Admin` 与每个 `Team` 的 `Leader`（这些会长期常驻，直到 leader 合并完成后触发清理）
- 当 `Leader` 需要更多“工程师级执行者”时，通过工具调用向 Orchestrator 请求动态生成 `Worker`
- `Worker` 在独立 git worktree workspace 中完成具体变更，并产出 `CHANGELOG.md`
- Orchestrator 将 `Worker` 的分支合并回 `Leader`，并让 `Leader` 汇总 worker 的 CHANGELOG
- `Leader` 汇总完成后再合并进入主分支（`project.base_branch`），并让 `Admin` 做最终交付总结与回报

声明关系可以理解为：

- `Admin`：项目经理（最终汇总与交付）
- `Leader`：团队负责人（拆任务、调度 worker、汇总结果）
- `Worker`：工程师（执行任务、提交变更、撰写 CHANGELOG）

## 2. 组件划分（代码模块职责）

### Orchestrator（编排入口）

Orchestrator 位于 `src/orchestrator/orchestrator.ts`，主要职责是：

- 根据 `ResolvedConfig` 计算各 agent 的 `workspacePath`、端口、模型、skills
- 注入并启动 `Admin`、各 `Leader`
- 注册 Orchestrator 的 HTTP 工具路由（供 OpenCode 工具回调）
- 将 `opencode` 需要的“agent markdown、tools、plugins、meta 信息”写入对应 workspace（通过 `workspace-inject` 完成）

Orchestrator 在启动时主要做两件事：

1. 生成并启动 `Admin` 与 `Leader`（静态 agent）
2. 开 HTTP 服务等待工具回调（动态 worker 的创建/合并/回报都经由这些接口）

### TaskManager（动态调度与合并回报）

动态部分由 `src/orchestrator/task-manager.ts` 承担，核心职责：

- 接收 `Leader` 请求：`POST /tool/request_workers`
- 为每个任务在本地动态创建一个 `Worker`（worktree workspace + skills 注入 + runtime 启动）
- 接收 `Worker/Leader` 完成通知：`POST /tool/notify_complete`
- 执行 git merge：
  - `Worker` 分支 -> `Leader` 分支
  - `Leader` 分支 -> `project.base_branch`
- 让 `Leader`/`Admin` 基于 CHANGELOG 进行总结
- 清理（stop runtime + remove workspace）

### RuntimeProvider（如何启动 OpenCode 进程）

当前默认实现是 `local_process`，由 `src/sandbox/local-process.ts` 实现：

- 对每个 agent 使用 `opencode serve --port <agentPort>` 启动独立进程
- 进程在对应 `workspacePath` 作为工作目录启动
- `stop` 会向对应进程发送 `SIGTERM`

> 扩展点：`RuntimeModeEnum.flue` 在代码中仅作为枚举位存在，但当前实现集中在 `local_process`。

### WorkspaceProvider（工作空间隔离与 git worktree 管理）

当前的 workspace 策略由 `src/workspace/workspace-provider.ts` 工厂提供，默认使用 `WorktreeWorkspaceProvider`：

- 为每个 agent/branch 创建一个 git worktree workspace：目录形如 `<workspace.root_dir>/<spec.id>`
- 使用 `sparse-checkout` 降低大仓库体积（由 `team.leader.repos` 提供允许的路径白名单）
- 可选执行 `git lfs pull`
- 清理时会 `git worktree remove --force` 并删除目录

> 扩展点：`workspace.provider` 目前只落地 `worktree`，`shared_clone/full_clone` 等策略在工厂中仍是占位。

### SkillResolver（skills 同步到 workspace）

由 `src/skills/skill-resolver.ts` 实现：

- 从项目根目录（`config.project.repo` 作为 repo root）读取 `skills/<skill-name>/SKILL.md`
- 把对应 SKILL.md 复制到 `<workspacePath>/.opencode/skills/<skill-name>/SKILL.md`

### Git 与文档流水线：MergeManager / ChangelogManager

- `src/git/merge-manager.ts`：执行 `merge --no-ff`，负责 worker->leader 与 leader->main 的合并
- `src/changelog/changelog-manager.ts`：负责读取 workspace 根目录的 `CHANGELOG.md`

## 3. 运行时流程（从启动到交付）

下面给出完整的“主流程”：

```mermaid
flowchart TD
  U[用户] --> CLI[oat start team.json "<goal>" --port PORT]
  CLI --> O[Orchestrator.start()]
  O --> A[启动 Admin agent]
  O --> L[为每个 Team 启动 Leader agent]
  L -->|工具 request-workers(tasks[])| O
  O --> W[动态创建 Worker agents]
  W -->|工具 notify-complete(changelog)| O
  O -->|merge worker->leader + 提示 leader 汇总| L
  L -->|工具 notify-complete(changelog)| O
  O -->|merge leader->main + 提示 admin 汇总| A
  O --> C[清理 leader 与 worker workspace/进程]
```

### 3.1 启动阶段：Admin 与 Leader 注入

Orchestrator 会为每个静态 agent：

- 计算端口：
  - `Admin` 使用 `config.runtime.ports.base`
  - `Leader` 使用 `base + 1 + index`
- 创建 workspace（worktree provider）
- 注入 skills、tools、plugins、agent markdown、以及 `.oat/* meta`

其中关键注入行为在 `src/opencode/workspace-inject.ts`：

- `writeAgentMarkdown()`：写入 `<workspacePath>/.opencode/agents/<agentName>.md`
- `writeCustomTools()`：写入 `<workspacePath>/.opencode/tools/*.ts`（包含 request-workers、notify-complete 等）
- `writeCustomPlugins()`：写入 `.opencode/plugins/commit-guard.ts` 与 `scope-guard.ts`
- `writeOatOrchestratorMeta()`：写入 `.oat/orchestrator.json`（供工具读取 orchestrator baseUrl）
- `writeOatAgentMeta()`：写入 `.oat/agent.json`（包含角色信息、worker 的 push allowlist 等）

### 3.2 Worker 动态创建：Leader 发起 tasks 请求

`Leader` 通过工具调用 `request-workers`，提交一个形如：

```json
{ "tasks": [ { "index": 0, "prompt": "..." }, { "index": 1, "prompt": "..." } ] }
```

Orchestrator 的 `POST /tool/request_workers` 在 `TaskManager.requestWorkers()` 中处理：

- 以 `tasks.length` 作为 worker 数
- 为每个 task 分配：
  - `workerId = <team.name>-worker-<index>`
  - `branch = <team.branch_prefix>/worker-<index>`
  - `port = allocatePort()`（基于运行时下一端口）
  - `workspacePath = <workspace.root_dir>/<workerId>`
- 创建 worker workspace：`workspaceProvider.ensureWorkspace(spec, team.leader.repos)`
- 注入 skills：
  - worker skills = `leader.skills` + `team.worker.extra_skills`
- 注入 worker 的 oat meta、agent markdown、tools/plugins
- 启动 opencode serve 进程，并创建 OpenCode session
- 向 worker session 发送 prompt：
  - worker 的具体任务 prompt（来自 tasks[i].prompt）
  - worker 必须更新 workspace 根目录 `CHANGELOG.md`
  - worker 完成后必须调用 `notify-complete`，并把 `changelog` 参数设置为 CHANGELOG 内容

### 3.3 合并与回报：worker->leader->admin

当 worker 调用 `POST /tool/notify_complete`：

1. `TaskManager.handleWorkerComplete()`：
   - 读取/使用 worker 传入的 `changelog`（若未传则读取 worker workspace 的 `CHANGELOG.md`）
   - 执行 git merge：`worker.spec.branch -> leader.spec.branch`
   - 用 leader agent 的 session 发送 prompt，让 leader 根据 worker 的 CHANGELOG 汇总到自己的 CHANGELOG

2. 当 leader 最终调用 `notify-complete`：
   - `TaskManager.handleLeaderComplete()` 执行 git merge：`leader.spec.branch -> project.base_branch`
   - 读取 leader 的 `CHANGELOG.md`（或使用 notify-complete 传入的 changelog）
   - 用 admin agent 的 session 发送最终总结 prompt，让 admin 在交付总结中包含该团队 CHANGELOG
   - 清理 leader 与其 worker 的进程与 workspace（stop + remove）

## 4. Workspace 隔离与 Git 策略

### 4.1 worktree 布局

默认 workspace provider 为 `worktree`，工作空间目录形如：

- `<workspace.root_dir>/<agentId>`（例如：`<team.json目录>/workspaces/frontend-worker-0`）

每个 agent 的 workspace 都来自同一个 git 仓库：

- `config.project.repo` 指定 git 仓库根目录
- 若 `config.project.repo` 为相对路径，会按 `team.json` 所在目录解析
- 如果工作空间不存在，则会：
  - 对已存在分支使用 `git worktree add <path> <branch>`
  - 对不存在分支使用 `git worktree add <path> -b <branch>`（从当前 HEAD 新建）

### 4.2 sparse-checkout 与团队 repos 白名单

当启用 `workspace.sparse_checkout.enabled=true` 且 leader 提供了 `leader.repos` 时：

- worker workspace 会执行：
  - `sparse-checkout init --cone`
  - `sparse-checkout set <leader.repos...>`

这意味着：

- `leader.repos` 更像是“允许 worker 看到/改动的路径白名单”，而不是“额外 git 仓库”

### 4.3 LFS 策略

若 `workspace.git.lfs=pull`：

- 在创建 workspace 后执行 `git lfs pull`

若失败会记录警告并继续运行（不会阻断 orchestrator）。

### 4.4 提交安全：commit-guard 与允许的 push 范围

worker 的 push 限制由注入插件完成：

- `writeCustomPlugins()` 在 worker workspace 写入 `commit-guard.ts`
- 默认 worker 的 `allowedPushPattern` 为：
  - `.*\/worker-\d+`
- 对 Admin/Leader：push 默认允许

此外，commit-guard 还会阻止 `git add -A` / `git add --all`（鼓励 allowlist staging）。

> 说明：Orchestrator 的合并最终依赖本地 git merge（通过 `MergeManager`），而不是强制 worker 先 push 到远端。

## 5. Orchestrator 工具 API（供 OpenCode 调用）

Orchestrator 在启动后会监听 `--port <PORT>`（由 CLI 参数指定），并注册以下工具路由：

- `POST /tool/request_workers`
  - 用途：由 Leader 请求创建 worker，并下发 tasks
  - 入参：`{ "leaderId": "<leaderId>", "tasks": [{ "index": 0, "prompt": "..." }] }`
  - 出参：`{ "workerIds": ["<team>-worker-0", ...] }`
- `POST /tool/notify_complete`
  - 用途：Worker/Leader 完成后回报 CHANGELOG（Orchestrator 再触发 merge 与总结）
  - 入参：`{ "agentRole": "worker|leader|admin", "agentId": "<id>", "changelog"?: "<string>" }`
- `POST /tool/report_progress`
  - 用途：当前为占位实现（返回 ok）
- `POST /tool/generate_changelog`
  - 用途：按 agentId 读取其 workspace 的 CHANGELOG.md

## 6. 配置驱动点与关键默认值

本文的行为与 `team.json` 的字段绑定关系主要包括：

- 角色与 prompts：
  - `admin.prompt`、`teams[].leader.prompt`、`teams[].worker.prompt`
  - 支持把 prompt 写成 `*.md` 文件路径（loader 会读取内容并替换）
- 模型：
  - 顶层 `model` 提供全局默认模型
  - 模型继承链路：`worker.model -> leader.model -> admin.model -> model`
  - `models` 用于对最终选中的模型做别名映射（例如 `default -> anthropic/...`）
  - 顶层 `providers` 提供全局供应商接入配置（向 `opencode serve` 注入 base_url/key 环境变量）
  - 若模型字符串不包含 `/`，则 provider 默认 `anthropic`
- 工作空间：
  - `workspace.root_dir` 决定 worktree 目录
  - `teams[].leader.repos` 决定 sparse-checkout set 路径
- 变更合并目标：
  - `project.base_branch` 决定 Leader 完成后的合并目标分支；仅允许 `main` 或 `master`

## 7. 当前实现边界与扩展点

为了避免“文档承诺超过实现”，这里列出当前明显的边界：

- `runtime.mode`：当前只实现 `local_process` 运行时，`flue` 未落地
- `workspace.provider`：当前只实现 `worktree`，其他策略尚未实现
- `team.worker.max`：worker 数由 `Leader` 下发的 `tasks.length` 决定；`worker.max` 在当前版本未参与硬性限制
- `team.worker.lifecycle` / `team.worker.skill_sync`：虽然在 schema/loader 中存在默认值，但当前动态 worker 创建与清理逻辑未完全根据它们分支（当前 leader 完成后会清理其下属 worker）

如果你希望把这些“配置意图”真正落地，我可以进一步基于代码把 worker 数上限、生命周期策略、skill_sync 策略接入到 `TaskManager`。
