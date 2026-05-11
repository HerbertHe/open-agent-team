# 开放代理团队

本项目让你以声明式方式构建一个包含三层的 **agent team**：

`Admin -> Leader -> Worker`

你在 `team.json` 中声明角色、模型、共享 skills、以及 workspace/git 策略。运行时 Orchestrator 会启动静态 agent（`Admin` 与所有 `Leader`），并在 `Leader` 请求时动态生成 `Worker`。每个 `Worker` 都必须更新其 `CHANGELOG.md`，并按层级向上合并汇总：

`Worker CHANGELOG` -> `Leader CHANGELOG` -> 最终 `Admin` 总结。所有角色在系统约束中都被严格要求必须以**追加（APPEND）**的方式更新各自的 `CHANGELOG.md`。

## 关键概念

### 声明式配置（`team.json`）

- `team.json` 定义：
  - 全局默认模型（`model`，可选）
  - 全局供应商接入配置（`providers`，可选）
  - 项目元信息（`project`；`project.base_branch` 仅允许 `main` 或 `master`，默认 `main`）
  - 模型别名映射（`models`）
  - `Admin` 配置（`admin`）
  - team 配置（`teams[]`: `Leader` + `Worker`）
- 如果 `admin.prompt` / `leader.prompt` / `worker.prompt` 以 `.md` 结尾，loader 会把它当作文件路径读取文件内容作为 prompt 文本。
- 模型继承链路：`worker.model -> leader.model -> admin.model -> model`（任意层都可覆盖）。
- 可在顶层 `providers` 下按服务商名称配置 `compatible_type`（`openai` / `anthropic`）、`base_url` 与 `api_key`，由编排器写入进程环境变量后被子进程继承。

详细字段说明：`oat docs config --lang zh-CN`。

### 独立工作空间（git worktree）

默认情况下，每个 agent 会在隔离的 workspace 中运行，workspace 创建于：

- `workspace.root_dir`（默认：`<team.json目录>/workspaces`）

对于较大的仓库，可启用 sparse-checkout；worker 的 sparse-checkout 路径来自 `teams[].leader.repos`。

### skills 管理（`npx skills`）

Skills 通过 [`npx skills`](https://github.com/vercel-labs/skills) 管理，在 `team.json` 中以 `SkillEntry` 对象声明：

- 每个 entry 指定 `source`（GitHub 仓库、URL 或本地路径）和可选的 `names` 过滤
- 启动时 OAT 为每个 entry 执行 `npx skills add`，将 skills 安装到 `<workspace>/skills/`
- 创建 `.pi/skills` 符号链接以兼容 pi-coding-agent

### 基于 CHANGELOG 的协作

在初始化 Agent 时，Orchestrator 会注入系统约束：

- 所有角色（Admin, Leader, Worker）都必须在 workspace 根目录**追加更新** `CHANGELOG.md`（即使没有代码改动也要记录原因）
- 所有日常中间产物（笔记、草稿、日志）必须保存在 `.oat/workspaces/<agentId>/records/<date>/` 目录下
- Worker 和 Leader 需要调用 `notify-complete`，并把准备好的 `CHANGELOG.md` 内容作为入参传递以向上汇报

## 快速上手

### 1) 配置 skills（可选）

在 `team.json` 中以 `SkillEntry` 格式声明 skill 来源：

```json
"skills": [{ "source": "vercel-labs/agent-skills", "names": ["frontend-design"] }]
```

### 2) 编写 `team.json`

参考：

- `docs/zh-CN/guide.md`（最小示例 + 启动步骤）
- `docs/zh-CN/config.md`（字段逐项说明）

### 3) 启动 Orchestrator

```bash
oat start team.json "<goal>"
```

`--port` 参数可选 — OAT 会从 8787 端口开始自动扫描可用端口。

选择输出/文档语言：

```bash
oat start team.json "<goal>" --lang zh-CN
```

启动后可在 `http://localhost:<port>` 访问内置的 **Web 仪表盘**，提供实时可观测、项目配置在线编辑（带 Shiki 语法高亮 JSON 预览）、全局设置管理和多项目管理功能。它还包含一个**项目成果（Project Achievements）**页面，用于浏览各个 Agent 的每日工作记录与 `CHANGELOG.md` 历史。仪表盘采用了按需加载和分包优化以提供极致性能。

### 4) 常用命令

```bash
oat status
oat stop
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
oat docs guide --lang zh-CN
```

## 协作工作原理（高层）

1. Orchestrator 通过 `npx skills add` 安装 skills，并启动 `Admin` 与每个 `Leader`。
2. `Leader` 调用工具 `request-workers`，提交 `tasks` 列表。
3. Orchestrator 将任务发送到已预先创建好的 `Worker` 池（size = `teams[].worker.total`）：
   - 连接到目标 worker
   - 发送任务 prompt
4. `Worker` 必须：
   - 追加更新 workspace 根目录的 `CHANGELOG.md`
   - 调用 `notify-complete` 并传递准备好的 `CHANGELOG.md`
5. Orchestrator 自动提交所有变更（`git add -A && git commit`），然后执行 `Worker -> Leader` 合并，要求 `Leader` 汇总，再执行 `Leader -> project.base_branch` 合并。
6. 每个 agent 的 git 提交会使用独立的本地身份标识（如 `worker-0-teamName@project-projectName.oat`）。
7. Orchestrator 会保持 worker 池直到 shutdown；只有编排器退出时的 `stopAll` 才会停止/销毁进程。

## 当前实现要点（与代码对齐）

- Runtime mode：实现了 `local_process`（Orchestrator 会启动多个 agent 进程并分配不同端口）。
- Workspaces：实现了 `worktree` provider；其它 providers 为占位。
- `teams[].worker.total` 的 worker 池规模会在启动 team 时被预先创建并生效；leader 完成后不会清理 worker 池（仅在 orchestrator 退出时销毁）。

## 致谢

- [CLIProxyAPI Management Console (CPAMC)](https://github.com/router-for-me/CLIProxyAPI) — Dashboard 的设计系统（主题、布局和毛玻璃效果）移植自 CPAMC 的 UI。

## LICENSE

MIT &copy; Herbert He
