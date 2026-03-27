# 使用指南（快速上手）

本指南帮助你在本地用最少步骤跑通声明式的 `Admin -> Leader -> Worker` agent 管理结构。

## 1. 准备 skills（必须）

Orchestrator 会从 `team.yaml` 的 `project.repo` 路径下读取 skill 定义，并把它们注入到各 agent workspace 中。

请在你的 git 仓库根目录准备：

- `skills/<skill-name>/SKILL.md`

例如：

```text
skills/
  doc-search/
    SKILL.md
  coding-assistant/
    SKILL.md
```

> 提示：如果你还没有 skills，也可以先准备一个空或最基础的 `SKILL.md`，确保系统能完成注入与工具调用流程。

## 2. 准备 Git 仓库与分支（建议）

该项目会基于 `project.base_branch` 执行合并（默认 `main`），并为每个 agent 创建 git worktree workspace。

建议你确认：

- `team.yaml -> project.repo` 指向一个 git 仓库（通常写 `.`）
- `project.base_branch` 对应的分支存在（例如 `main`）
- 你的仓库支持 `git worktree`（大多数情况下开箱即用）

## 3. 编写 `team.yaml`（核心）

`team.yaml` 位于仓库任意位置均可，但推荐放到仓库根目录或你容易管理的路径。

下面给一个“最小骨架”示例（你需要把模型与 prompt 换成自己的内容，并填入真实 skills 名称）：

```yaml
model: default

project:
  name: open-agent-team-demo
  repo: .
  base_branch: main

models:
  default: anthropic/claude-3-5-sonnet-20240620

admin:
  name: admin
  description: 项目经理，负责最终汇总交付
  model: default
  prompt: |
    You are the project manager (Admin).
    Your job is to summarize the final delivery and review team changelogs.
  skills: []

teams:
  - name: frontend
    branch_prefix: team/frontend
    leader:
      name: frontend-lead
      description: 前端负责人，负责拆分任务并请求 worker 执行
      model: default
      prompt: |
        You are the Leader agent for the frontend team.
        When you need engineers to implement tasks in parallel, call tool request-workers with a JSON body:
        { "tasks": [ { "index": 0, "prompt": "..." }, { "index": 1, "prompt": "..." } ] }

        After workers finish, summarize all worker CHANGELOGs into your own CHANGELOG.
      skills: []
      repos:
        - src/
        - package.json
    worker:
      max: 3
      model: default
      prompt: |
        You are a Worker engineer.
        For your assigned task:
        1) Modify code in this workspace.
        2) Update CHANGELOG.md at workspace root with what you did and why.
        3) Call tool notify-complete with changelog set to the CHANGELOG content.
      extra_skills: []
```

你需要至少保证：

- `admin.prompt`、`leader.prompt`、`worker.prompt` 不为空（也可以写成 `*.md` 文件路径）
- 模型继承关系清晰：`worker.model -> leader.model -> admin.model -> model`（可只配置顶层 `model`，按需覆写）
- `teams[]` 至少配置一个 team
- `leader.repos` 给出你希望 worker 重点关注的路径（对应 sparse-checkout set）

## 4. 启动 Orchestrator

在你的终端执行：

```bash
oat start team.yaml "<goal>" --port 3100
```

- `--port`：Orchestrator HTTP 服务端口（工具回调使用）
- `<goal>`：最终要达成的项目目标（会注入到 Leader prompt 中）

如果你要指定输出语言：

```bash
oat start team.yaml "<goal>" --port 3100 --lang zh-CN
```

## 5. 观察执行结果（你应该看到什么）

常见观察点：

- Orchestrator 启动后会监听你指定的端口
- worker workspace 会出现在 `workspace.root_dir`（默认 `~/.oat/workspaces/<agentId>`）
- 每个 worker 在完成后会更新其 workspace 根目录 `CHANGELOG.md`
- worker 的分支会被合并进对应 leader 分支
- leader 合并进入 `project.base_branch` 后，Orchestrator 会清理对应 leader 与 worker（进程 + workspace）

## 6. 查看状态 / 停止

查看 orchestrator 状态（读取 `state_dir` 下的 `orchestrator.json`）：

```bash
oat status "~/.oat/state"
```

停止（向 orchestrator pid 发 SIGTERM）：

```bash
oat stop "~/.oat/state"
```

## 7. 查看文档（多语言）

你可以用 CLI 直接输出 docs 文件内容，例如：

```bash
oat docs guide --lang fr
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
```
