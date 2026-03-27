# 开放代理团队（Orchestrator + OpenCode）

本项目让你以声明式方式构建一个包含三层的 **agent team**：

`Admin -> Leader -> Worker`

你在 `team.yaml` 中声明角色、模型、共享 skills、以及 workspace/git 策略。运行时 Orchestrator 会启动静态 agent（`Admin` 与所有 `Leader`），并在 `Leader` 请求时动态生成 `Worker`。每个 `Worker` 都必须更新其 `CHANGELOG.md`，并按层级向上合并汇总：

`Worker CHANGELOG` -> `Leader CHANGELOG` -> 最终 `Admin` 总结。

## 关键概念

### 声明式配置（`team.yaml`）

- `team.yaml` 定义：
  - 全局默认模型（`model`，可选）
  - 项目元信息（`project`）
  - 模型别名映射（`models`）
  - `Admin` 配置（`admin`）
  - team 配置（`teams[]`: `Leader` + `Worker`）
- 如果 `admin.prompt` / `leader.prompt` / `worker.prompt` 以 `.md` 结尾，loader 会把它当作文件路径读取文件内容作为 prompt 文本。
- 模型继承链路：`worker.model -> leader.model -> admin.model -> model`（任意层都可覆盖）。

详细字段说明：`oat docs config --lang zh-CN`。

### 独立工作空间（git worktree）

默认情况下，每个 agent 会在隔离的 workspace 中运行，workspace 创建于：

- `workspace.root_dir`（默认：`~/.oat/workspaces`）

对于较大的仓库，可启用 sparse-checkout；worker 的 sparse-checkout 路径来自 `teams[].leader.repos`。

### skills 共享与注入

skills 遵循 OpenCode 的 `SKILL.md` 约定：

- 源文件：仓库根目录下 `skills/<skill-name>/SKILL.md`（对应 `project.repo`）
- 注入到每个 agent workspace：`.opencode/skills/<skill-name>/SKILL.md`

### 基于 CHANGELOG 的协作

当创建一个 `Worker` 时，Orchestrator 会向 worker prompt 注入系统约束：

- 在 workspace 根目录创建/更新 `CHANGELOG.md`（即使没有代码改动也要记录原因）
- 调用 `notify-complete`，并把准备好的 `CHANGELOG.md` 内容作为入参传递

## 快速上手

### 1) 准备 skills

在你的 git 仓库根目录创建：

`skills/<skill-name>/SKILL.md`

### 2) 编写 `team.yaml`

参考：

- `docs/zh-CN/guide.md`（最小示例 + 启动步骤）
- `docs/zh-CN/config.md`（字段逐项说明）

### 3) 启动 Orchestrator

```bash
oat start team.yaml "<goal>" --port 3100
```

选择输出/文档语言：

```bash
oat start team.yaml "<goal>" --port 3100 --lang zh-CN
```

### 4) 常用命令

```bash
oat status "~/.oat/state"
oat stop "~/.oat/state"
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
oat docs guide --lang zh-CN
```

## 协作工作原理（高层）

1. Orchestrator 注入 skills/tools/plugins，并启动 `Admin` 与每个 `Leader`。
2. `Leader` 调用工具 `request-workers`，提交 `tasks` 列表。
3. Orchestrator 为每个 task 生成 1 个 `Worker`：
   - 创建/确保 git worktree workspace
   - 注入 leader skills + `worker.extra_skills`
   - 启动 `opencode serve` 并发送任务 prompt
4. `Worker` 必须：
   - 更新 workspace 根目录的 `CHANGELOG.md`
   - 调用 `notify-complete` 并传递准备好的 `CHANGELOG.md`
5. Orchestrator 执行 `Worker -> Leader` 合并，要求 `Leader` 汇总，然后执行 `Leader -> project.base_branch` 合并。
6. Orchestrator 清理 leader 与其 workers（进程 + workspace）。

## 当前实现要点（与代码对齐）

- Runtime mode：实现了 `local_process`（Orchestrator 会启动多个 `opencode serve` 进程并分配不同端口）。
- Workspaces：实现了 `worktree` provider；其它 providers 为占位。
- `teams[].worker.max` 的“意图”与生命周期字段在动态 worker 逻辑中当前并未作为严格运行时限制来执行（leader 完成后会清理 workers）。

## LICENSE

MIT &copy; Herbert He
