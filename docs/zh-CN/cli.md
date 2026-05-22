# OAT CLI 命令行参考

`oat` 命令行工具为你提供了管理 Open Agent Team 编排器、检查状态以及查看本地文档的功能。

## 全局选项

- `-v, --version`：输出版本号。
- `--lang <lang>`：指定 CLI 提示和文档的输出语言。支持：`en`, `zh-CN`, `fr`, `ja`。
- `-h, --help`：显示命令帮助信息。

---

## `oat init`

在当前目录初始化一个新的 `team.json` 配置文件（通过复制内置示例配置）。

**用法：**
```bash
oat init
```

## `oat start`

根据配置文件启动编排器（Orchestrator），并在后台运行以管理和调度 Agent 团队。可以通过 `oat dashboard` 实时查看。

**用法：**
```bash
oat start [options]
```

**选项：**
- `--config <path>`：`team.json` 配置文件的路径。如果不提供，默认读取当前目录下的 `./team.json`，或读取环境变量 `OAT_TEAM_JSON` 指定的路径。
- `--goal <text>`：项目的最终目标，会注入到 Leader agent 的 prompt 中（可选）。你也可以直接作为参数追加：`oat start team.json "我的目标"`。

---

## `oat list` / `oat ls`

全局检查所有本地 OAT Orchestrator 的当前运行状态（例如是否在运行、PID、端口号等）。

**用法：**
```bash
oat list
# 或
oat ls
```

---

## `oat stop`

向正在运行的 Orchestrator 发送优雅关闭信号（SIGINT）。Orchestrator 会安全地停止所有 Agent 运行实例和工作区。

**用法：**
```bash
oat stop [options] [projectId]
```

**选项：**
- `--all`：停止所有正在运行的 OAT 项目。如果使用了 `--all`，则不需要指定 `projectId`。

**参数：**
- `projectId`：项目的 ID，可以通过 `oat list` 命令查看。如果不提供 `--all` 则必须提供 `projectId`。

---

## `oat rm`

彻底删除指定项目的所有 OAT 状态数据和工作区目录。请注意：项目必须处于停止状态才能被删除。此操作不会删除你的源码仓库。

**用法：**
```bash
oat rm [options] <projectId>
```

**参数：**
- `projectId`：项目的 ID，可以通过 `oat list` 命令查看。

---

## `oat inspect`

检查并列出由 Orchestrator 创建的本地工作区及其状态信息。

**用法：**
```bash
oat inspect [options] [stateDir] [workspaceRoot]
```

**参数：**
- `stateDir`：状态目录。
- `workspaceRoot`：存放工作区的根目录（默认为 `workspaces`）。

**选项：**
- `--limit <number>`：最多显示的工作区条目数（默认：50）。

---

## `oat dashboard`

在默认浏览器中打开全局 OAT Web 仪表盘。仪表盘会自动连接正在运行的 Orchestrator 实例，提供实时可观测性、项目管理和工作成果历史追踪。

**用法：**
```bash
oat dashboard
```

---

## `oat docs`

将指定文档的内容直接输出到终端。

**用法：**
```bash
oat docs [options] <name>
```

**参数：**
- `name`：要展示的文档名称。可用的文档：`architecture`、`config`、`guide`、`cli`。

**示例：**
```bash
oat docs config --lang zh-CN
```

---

## `oat channels`

检查已加载的推送通道插件、所有配置的账号、活跃会话（例如微信扫码登录）以及全局状态。

**用法：**
```bash
oat channels
```

---

## `oat channel login`

以交互式扫码登录的方式设置有状态通道的会话（例如微信终端扫码登录）。

**用法：**
```bash
oat channel login <channelId> <accountId>
```

**参数：**
- `channelId`：目标通道类型（例如 `weixin`）。
- `accountId`：此通道登录会话的标识符。

**示例：**
```bash
oat channel login weixin my-wechat
```

---

## `oat plugins install`

从 NPM 动态下载并热安装兼容 OpenClaw 的推送通道插件。

**用法：**
```bash
oat plugins install <packageName>
```

**参数：**
- `packageName`：插件的 NPM 包名（例如 `@tencent-weixin/openclaw-weixin`）。

---

## `oat plugins uninstall`

从系统中动态卸载已安装的插件，安全地删除所有关联的会话文件和配置信息。

**用法：**
```bash
oat plugins uninstall <pluginId>
```

**参数：**
- `pluginId`：要卸载的插件 ID（例如 `openclaw-weixin`）。

