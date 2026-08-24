# Open Agent Team

<p align="center">
  <img src="./logo/logo.svg" width="200" alt="Open Agent Team Logo" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/open-agent-team"><img src="https://img.shields.io/npm/v/open-agent-team?style=flat-square" alt="NPM Version" /></a>
  <a href="https://www.npmjs.com/package/open-agent-team"><img src="https://img.shields.io/npm/dt/open-agent-team?style=flat-square" alt="NPM Downloads" /></a>
</p>


本项目让你以声明式方式构建一个包含三层的 **agent team**：

`Admin -> Leader -> Worker`

你在 `team.json` 中声明角色、模型、共享 skills、以及 workspace/git 策略。Admin 负责项目治理，Leader 负责 review 与集成，Worker 交付完成自测的短生命周期 Git 分支。Worker 不会直接合并；它提交持久化 review request，只有 Admin 批准后，串行 MergeController 才会更新 `main/master`。

完整分支、review、发布审批、产物清单与运行文件隔离规则见 [Git 协作文档](docs/zh-CN/git-collaboration.md)。

## 快速上手

### 1. 安装

**通过一键脚本安装 (推荐):**

**macOS & Linux:**
```bash
curl -fsSL https://oat.ibert.me/install.sh | bash
```

**Windows:**
```powershell
powershell -c "irm https://oat.ibert.me/install.ps1 | iex"
```

**通过 NPM 安装:**

```bash
npm i open-agent-team -g
```

### 2. 创建 `team.json`

在项目根目录创建 `team.json`（完整示例参考 [team.example.json](./team.example.json)）：

```bash
oat init
```

不想手工填写配置时，可运行 `oat resources` 进入 Agent Resources 问答式建队流程；详见 [对话式项目与团队创建](docs/zh-CN/agent-resources.md)。

### 3. 启动团队

```bash
oat start team.json
```

### 4. 打开 OAT Desktop

使用 Desktop 管理项目、任务、实时可观测、配置、用量、成果、插件、通道、Git 交付和 Docker 运行环境。

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

### 基于 Git review 的协作

在初始化 Agent 时，Orchestrator 会注入系统约束：

- `CHANGELOG.md` 是人可读交付证据，不再是协作总线。
- Worker 实现、自测并调用 `submit-review`；请求记录分支、commit、变更文件、测试和产物路径。
- Leader 通过 `review-worker-branch` 显式审核并合入 integration 分支，再创建 release proposal。
- Admin 用 `approve-release` 批准或拒绝；只有串行 MergeController 可更新 `main/master`。
- 日志、草稿、Agent 元数据等运行文件位于 `<runtime.persistence.state_dir>/git-collaboration/`，不会写入 Git worktree。

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
oat start team.json [goal]
```


选择输出/文档语言：

```bash
oat start team.json [goal] --lang zh-CN
```

**OAT Desktop** 提供实时可观测、项目配置编辑、全局设置、多项目管理、任务操作和项目成果浏览，可查看各 Agent 的每日工作记录与 `CHANGELOG.md` 历史。

### 4) 常用命令

```bash
oat list
oat stop
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
oat docs guide --lang zh-CN
```

## 协作工作原理（高层）

1. Orchestrator 通过 `npx skills add` 安装 skills，启动 `Admin`、每个 `Leader`，并预先创建 `Worker` 池（size = `teams[].worker.total`）。
2. `Leader` 调用工具 `dispatch-worker-tasks`，提交 `tasks` 列表。
3. Orchestrator 将任务发送到预先创建好的 `Worker` 池：
   - 连接到目标 worker
   - 发送任务 prompt
4. Worker 基于锁定的 `main/master` SHA 创建任务分支，完成自测并提交 `submit-review`。
5. Leader 在 merge 前 review；通过后合入 integration 分支，拒绝则创建新的任务尝试。
6. Leader 创建带产物路径的 release proposal；Admin 批准/拒绝，MergeController 串行且原子地更新 `main/master`。
7. 任务 worktree 与 manifest 位于 `state_dir/git-collaboration/`，仓库 worktree 不保存运行垃圾。

## 当前实现要点（与代码对齐）

- Runtime mode：实现了 `local_process`（Orchestrator 会启动多个 agent 进程并分配不同端口）。
- Workspaces：实现了 `worktree` provider；其它 providers 为占位。
- `teams[].worker.total` 的 worker 池规模会在启动 team 时被预先创建并生效；leader 完成后不会清理 worker 池（仅在 orchestrator 退出时销毁）。

## 推送通道通知与 OpenClaw 插件

OAT 支持将任务进度、Agent 崩溃和最终的成果通知发送到外部聊天渠道（如 Slack、Discord、微信），并且完全兼容 OpenClaw 插件生态系统。

### 1) 配置文件 (`~/.oat/oat.json`)
所有全局设置均以标准 JSON 格式原生存储在 `~/.oat/oat.json` 中。以下是典型的通道配置结构：

```json
{
  "channels": {
    "openclaw-slack": {
      "accounts": {
        "team-slack": {
          "webhookUrl": "https://hooks.slack.com/services/..."
        }
      }
    }
  }
}
```

要在任务管理器中将推送通知路由到特定通道，请在 `team.json` 的 `admin.push_channel` 中声明目标：
```json
"admin": {
  "name": "AdminAgent",
  "push_channel": {
    "channel": "openclaw-slack",
    "account": "team-slack"
  }
}
```

### 2) CLI 命令
直接从终端管理兼容的插件和账号：

- `oat channels` - 查看所有已加载的插件、配置的账号以及活跃的微信会话（Session）。
- `oat channel login <channelId> <accountId>` - 引导有状态通道（例如微信）在终端中进行交互式 ASCII 二维码扫码登录与凭证存储：
  ```bash
  oat channel login weixin my-wechat
  ```
- `oat plugins install <packageName>` - 从 NPM 下载并热安装兼容 OpenClaw 的插件包：
  ```bash
  oat plugins install @tencent-weixin/openclaw-weixin
  ```
- `oat plugins uninstall <pluginId>` - 从磁盘物理删除插件，擦除其缓存的会话与相关凭证。

### 3) Desktop 可视化插件中心
OAT Desktop 内置原生**插件中心**，提供以下功能：
- 查看已安装插件和活跃账号的状态卡片。
- 输入 NPM 包名，一键后台下载并动态热安装插件。
- 根据插件的配置模式（`configSchema`）动态生成可视化表单字段，实时配置新账号。
- 引导用户在 CLI 终端中扫描微信互动二维码。

## 致谢


## Star History

<a href="https://star-history.com/#HerbertHe/open-agent-team&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HerbertHe/open-agent-team&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HerbertHe/open-agent-team&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=HerbertHe/open-agent-team&type=Date" />
  </picture>
</a>

## LICENSE

MIT &copy; Herbert He
