var e=`# Docker-only Pi Extensions 与 OAT 工具命名空间设计

> 状态：设计已确认，待后续实现。
>
> 本文是实现、评审和验收的依据；当前版本只持久化方案，不表示仓库已经提供这些能力。

## 1. 背景与目标

OAT 当前基于 \`@earendil-works/pi-coding-agent\` 创建 Admin、Leader、Worker AgentSession，并另外提供一套运行在宿主 Orchestrator 中的 OpenClaw 兼容插件。Pi 的官方扩展机制称为 Extension，它与 OAT 的通道 Plugin 不是同一种能力：

- **Pi Extension**：与 AgentSession 在同一进程内执行，可以注册工具、订阅事件、拦截工具调用和注入上下文。
- **OAT/OpenClaw Plugin**：由宿主 Orchestrator 加载，主要用于消息通道、账号和通知集成。

为避免概念和安全边界混淆，配置、代码、API、Desktop 和文档统一使用 **Pi Extensions**；现有通道体系继续使用 **Plugins**。

本设计目标：

1. 为 Admin、Leader、Worker 按角色提供 Pi Extension。
2. Pi Extension 只能在 \`runtime.mode: "docker"\` 时启用。
3. 本地进程模式不得隐式或显式执行任何 Pi Extension。
4. Docker 模式只加载经过 OAT 显式声明、校验和挂载的 Extension 白名单。
5. 所有 OAT 注入 Pi 的自定义工具统一使用 \`oat-\` 前缀，与 Pi 内建工具和第三方 Extension 工具明确区分。
6. Docker 页面需要向用户说明：开启 Docker 后可以解锁 Pi Extensions、角色级扩展和更完整的隔离/资源控制能力，同时明确其安全边界和单向迁移规则。
7. 中文及其他现有语言文档需要同步说明上述行为。

## 2. 非目标

首期不承诺：

- 在 \`local_process\` 中提供“受信任 Extension”开关。
- 运行中热安装、热更新或 \`/reload\` Pi Extension。
- Pi TUI、自定义 footer、shortcut 或交互式 UI。
- 由 Extension 提供首次启动所需的模型 provider。
- 运行容器启动时从浮动 npm/git 地址下载代码。
- 把容器描述成能够保护模型密钥或 workspace 不受已授权 Extension 影响的绝对安全边界。

## 3. 关键设计决策

### 3.1 Docker 是唯一允许的执行边界

进程隔离只提供故障隔离，不提供安全隔离。Pi Extension 是任意 JavaScript/TypeScript，能够使用 Node.js 内置模块、启动子进程、访问网络，并继承 Agent 进程可以访问的文件与凭据。因此本设计不允许在 \`local_process\` 中加载 Extension。

约束必须在多层执行，而不是只依赖 Desktop 隐藏入口：

1. JSON Schema 和 Zod 跨字段校验拒绝 \`local_process + pi_extensions\`。
2. \`loadConfig()\` 和 runtime policy 在启动前再次验证。
3. \`PiSessionProvider\` 永远不接受 Extension 参数。
4. IPC start 消息明确携带 runtime 类型；runner 在非 Docker runtime 收到 Extension 时立即失败。
5. \`DefaultResourceLoader\` 在所有模式都设置 \`noExtensions: true\`，关闭 Pi 默认自动发现。
6. Docker 只通过 \`additionalExtensionPaths\` 注入 OAT 验证后的容器内白名单路径。

项目从本地迁移到 Docker 后，继续沿用现有 \`.oat/runtime-policy.json\` 的不可逆策略，不能通过手工修改 \`team.json\` 降级回进程模式。

### 3.2 禁止 Pi 默认 Extension 自动发现

当前 Pi ResourceLoader 默认可能发现：

- \`~/.pi/agent/extensions/\`
- \`<workspace>/.pi/extensions/\`
- \`settings.json\` 中声明的 extension/package

未来必须统一使用：

\`\`\`ts
const loader = new DefaultResourceLoader({
  cwd: spec.workspacePath,
  agentDir,
  noExtensions: true,
  additionalExtensionPaths:
    runtime === "docker"
      ? piExtensions.map((extension) => extension.entryPath)
      : [],
});
\`\`\`

\`noExtensions: true\` 用于关闭 global/project/settings 自动发现；显式 \`additionalExtensionPaths\` 只来自 OAT 的 Docker 白名单。

不能先自动加载再通过 \`extensionsOverride\` 过滤，因为 Extension factory 在过滤前可能已经执行。

### 3.3 按角色做宿主侧授权

Extension 角色过滤必须发生在宿主 Orchestrator，不能把全部代码挂进容器后依靠 Extension 自行判断角色。

每个 Agent 容器只得到与其角色匹配的 Extension：

| Agent 角色 | 可加载范围 |
| --- | --- |
| Admin | \`roles\` 包含 \`admin\` 的 Extension |
| Leader | \`roles\` 包含 \`leader\` 的 Extension |
| Worker | \`roles\` 包含 \`worker\` 的 Extension |

同一 Extension 可以同时授权给多个角色；每个 Agent 仍在自己的独立容器和 Extension runtime 中初始化，不共享进程内状态。

## 4. 配置模型

Pi Extension 放在 \`runtime.docker.pi_extensions\`，不使用顶层 \`plugins\`，避免与 OpenClaw Plugin Center 混淆。

\`\`\`json
{
  "runtime": {
    "mode": "docker",
    "docker": {
      "image": "my-oat-agent:1.0.0",
      "network": "bridge",
      "extra_args": [
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        "--memory=4g"
      ],
      "pi_extensions": {
        "failure_policy": "fail_closed",
        "items": [
          {
            "id": "audit-events",
            "source": {
              "type": "project",
              "path": "./pi-extensions/audit-events/index.js"
            },
            "integrity": "sha256:0123456789abcdef...",
            "roles": ["admin", "leader", "worker"],
            "config": {
              "logLevel": "info"
            }
          },
          {
            "id": "leader-review",
            "source": {
              "type": "image",
              "path": "/opt/oat/pi-extensions/leader-review/index.js"
            },
            "roles": ["leader"]
          },
          {
            "id": "worker-quality-gate",
            "source": {
              "type": "image",
              "path": "/opt/oat/pi-extensions/worker-quality-gate/index.js"
            },
            "roles": ["worker"]
          }
        ]
      }
    }
  }
}
\`\`\`

建议类型：

\`\`\`ts
type PiExtensionRole = "admin" | "leader" | "worker";

interface PiExtensionConfig {
  failure_policy: "fail_closed";
  items: PiExtensionEntry[];
}

interface PiExtensionEntry {
  id: string;
  source:
    | { type: "project"; path: string }
    | { type: "image"; path: string };
  integrity?: \`sha256:\${string}\`;
  roles: PiExtensionRole[];
  config?: Record<string, unknown>;
}
\`\`\`

校验规则：

- \`id\` 匹配 \`^[a-z][a-z0-9-]{1,63}$\`，全局唯一。
- \`roles\` 至少包含一个角色且不得重复。
- 只要声明了 \`pi_extensions\`，\`runtime.mode\` 就必须是 \`docker\`；不能通过 \`enabled: false\` 绕过。
- \`project.path\` 相对 \`team.json\` 目录解析，禁止 \`..\`、realpath 越界、符号链接越界、设备文件和 socket。
- \`image.path\` 必须是位于 \`/opt/oat/pi-extensions/\` 下的绝对容器路径。
- 生产配置要求固定 \`integrity\`；开发期允许缺省时必须产生显著警告。
- \`config\` 只允许普通 JSON，不允许直接保存 secret。
- 首期只支持 \`project\` 和 \`image\` source。

未来如支持 npm，必须使用精确版本、entry 和 integrity，并由一次性 Docker provisioner 安装到不可变 bundle；不得在宿主运行安装脚本，也不得接受浮动版本。

## 5. Extension 准备与挂载

新增宿主侧 \`PiExtensionManager\`，在启动任何 Agent 容器前完成：

1. 解析和规范化 source。
2. 对 project source 执行 realpath、类型和边界检查。
3. 计算稳定内容摘要并验证 \`integrity\`。
4. 复制为不可变 staging bundle，而不是直接挂载可变源码目录。
5. 生成 bundle manifest，记录 ID、entry、digest、角色和来源。
6. 为每个角色生成最小挂载集合。

建议目录：

\`\`\`text
<state_dir>/pi-extensions/<bundle-digest>/
├── manifest.json
├── audit-events/
├── leader-review/
└── worker-quality-gate/
\`\`\`

容器挂载：

\`\`\`text
<role-bundle>:/oat-pi-extensions:ro
<role-config>:/run/oat/pi-extension-config:ro
\`\`\`

容器只接收属于当前角色的 bundle。Extension 普通配置使用只读 JSON 文件，不使用环境变量序列化；secret 后续只能通过引用式 secret provider 设计，不写入 \`team.json\`、日志或 API 响应。

## 6. IPC 与 Agent runner

\`MainToChild.start\` 增加：

\`\`\`ts
{
  type: "start";
  runtime: "docker" | "local_process";
  piExtensions: Array<{
    id: string;
    entryPath: string;
    digest: string;
    configPath?: string;
  }>;
}
\`\`\`

runner 必须验证：

- \`runtime !== "docker"\` 时 \`piExtensions\` 必须为空。
- Extension entry 必须位于 \`/oat-pi-extensions/\`。
- config 必须位于 \`/run/oat/pi-extension-config/\`。
- ID、路径和 digest 不得重复。
- 不以可伪造的环境变量作为唯一 runtime 判断。
- \`loader.reload()\` 和 \`createAgentSession()\` 返回的 Extension errors 必须转成启动失败。

Extension 在 Agent 容器内、AgentSession 同进程执行。Extension 注册的工具和事件 hook 不通过宿主执行；OAT 自定义工具仍使用既有 JSONL/IPC 桥，由宿主 Orchestrator 执行。

## 7. OAT 工具统一使用 \`oat-\` 前缀

### 7.1 命名规则

凡是由 OAT 通过 \`defineTool()\` 注入 AgentSession 的工具，名称必须满足：

\`\`\`text
oat-<kebab-case-name>
\`\`\`

Pi 内建工具和第三方 Extension 工具不自动增加前缀。\`oat-\` 是 OAT 保留命名空间，Pi Extension 不得注册任何以 \`oat-\` 开头的工具。

工具 label 可以继续使用自然语言，不要求增加 \`OAT\`；协议、prompt、日志和文档使用带前缀的实际 name。

### 7.2 工具迁移表

实现时至少同步以下现有定义：

| 旧名称 | 新名称 |
| --- | --- |
| \`create-task\` | \`oat-create-task\` |
| \`update-task\` | \`oat-update-task\` |
| \`delete-task\` | \`oat-delete-task\` |
| \`query-tasks\` | \`oat-query-tasks\` |
| \`assign-leader-task\` | \`oat-assign-leader-task\` |
| \`dispatch-worker-tasks\` | \`oat-dispatch-worker-tasks\` |
| \`list-review-requests\` | \`oat-list-review-requests\` |
| \`submit-review\` | \`oat-submit-review\` |
| \`review-worker-branch\` | \`oat-review-worker-branch\` |
| \`submit-release-proposal\` | \`oat-submit-release-proposal\` |
| \`list-release-proposals\` | \`oat-list-release-proposals\` |
| \`approve-release\` | \`oat-approve-release\` |
| \`push-release\` | \`oat-push-release\` |
| \`notify-complete\` | \`oat-notify-complete\` |
| \`report-progress\` | \`oat-report-progress\` |
| \`generate-changelog\` | \`oat-generate-changelog\` |

实现时应再次扫描全部 \`defineTool()\`，保证不存在漏网的 OAT 工具。

### 7.3 迁移策略

这是 breaking change，必须在一个版本内原子完成：

- 修改 Orchestrator 和 TaskManager 中的工具定义。
- 修改 Admin、Leader、Worker 系统提示词和 runtime prompt。
- 修改 workspace 注入文本、crash/recovery prompt、release prompt。
- 修改测试 fixture、断言和文档示例。
- 修改 README 及 \`docs/{zh-CN,en,fr,ja}\` 中的工具名。
- 修改观测、日志和 UI 中展示的工具名。
- 增加静态测试，拒绝 OAT 自定义工具缺少 \`oat-\` 前缀。

不保留旧名称兼容别名。否则 AgentSession 会同时暴露两套 OAT 工具，既违背命名空间要求，也增加模型选择歧义和 Extension 冲突面。

队列、持久化任务和历史文本中若包含旧工具名，需要在升级说明中要求项目重启，并在启动时检测活跃旧会话；不得在旧 AgentSession 继续运行时切换工具集合。

## 8. Extension 工具冲突策略

Extension 工具最终会与 Pi 内建工具和 OAT 工具合并。采用 fail-closed：

- Extension 不得注册 \`oat-*\`。
- Extension 工具不得与 Pi 内建工具重名。
- Extension 之间不得注册重名工具。
- 不采用后加载覆盖前加载。
- 冲突错误必须包含 Agent ID、角色、Extension ID、工具名和冲突来源。

Extension 的 \`tool_call\` handler 仍可能阻止 OAT 工具调用，这是 Pi Extension 的标准进程内能力。Docker 不能消除这种功能风险，因此只允许可信、固定 digest 的 Extension，并将阻止 \`oat-*\` 调用记录为高优先级审计事件。

## 9. 支持能力与限制

首期支持：

- \`pi.registerTool()\`，但禁止 \`oat-*\` 命名空间。
- Agent、session、model 和 tool 生命周期事件。
- 工具调用/结果拦截。
- 上下文注入。
- Extension 自有状态，受容器文件系统和挂载约束。
- 访问当前 Agent workspace。

首期不保证 TUI、shortcut、交互式 command、热重载和 provider Extension。当前 runner 在 Extension 加载前解析 model；若以后允许 Extension 提供首次启动模型，需要单独重构模型 bootstrap 顺序。

## 10. Docker 页面产品设计

Docker 页面不仅展示 Engine 和容器状态，还承担能力发现与风险告知。

### 10.1 本地模式下的提示

在尚未启用 Docker 时展示醒目的能力卡片：

**标题：**

> 启用 Docker，解锁受隔离的 Agent 扩展能力

**正文建议：**

> Docker 会为每个 Admin、Leader 和 Worker 创建独立容器。启用后可以按角色加载 Pi Extensions，并获得容器级资源限制、只读扩展挂载和更清晰的运行边界。Pi Extensions 不支持本地进程模式。

**能力列表：**

- Admin、Leader、Worker 按角色加载 Pi Extensions。
- Extension 白名单、固定摘要和只读挂载。
- 独立容器、CPU/内存/PID 限制。
- 更清晰地区分 \`oat-*\` 工具、Pi 内建工具和 Extension 工具。
- Extension 加载状态、版本和错误可观测。

**风险说明：**

> Extension 与 AgentSession 在同一容器进程内执行，仍可访问该 Agent 的 workspace、注入容器的模型凭据和允许的网络。请只加载可信 Extension。

**单向迁移提示：**

> 项目启用 Docker 后不能降级回本地进程模式。请确认 Docker Engine、镜像和资源配置已经准备好。

主按钮建议使用“启用 Docker 并解锁增强能力”，点击后仍保留现有二次确认，确认内容必须包含不可逆迁移和 Extension 安全边界。

### 10.2 Docker 已启用后的能力状态

展示 “Docker 增强能力” 面板：

| 能力 | 状态示例 |
| --- | --- |
| Agent 容器隔离 | 已启用 |
| Pi Extensions | 未配置 / 已配置 3 个 / 加载失败 |
| 角色级授权 | Admin 1、Leader 2、Worker 2 |
| 完整性校验 | 全部通过 / 1 个失败 |
| Extension bundle | digest 与更新时间 |
| 资源限制 | CPU、内存、PID |
| 网络模式 | none / bridge / host，并展示风险等级 |

Extension 配置变化后显示“需要重启项目后生效”，不提供运行时热加载按钮。

### 10.3 UI 命名要求

- 使用 “Pi Extensions”，中文可写“Pi 扩展”。
- 不把它放入现有 OpenClaw Plugin Center。
- Agent 详情页展示当前 Agent 实际加载的 Extension，而不是项目声明全集。
- 工具列表将 OAT 工具显示为 \`oat-*\`，并按 OAT / Pi built-in / Extension 分组。
- 页面不得使用“完全安全”“插件无法访问凭据”等误导性表述。

## 11. 安全基线

Docker 保护宿主边界，但 Extension 与 AgentSession 同进程，仍能读取容器中的模型输入输出、API key 和 workspace，并能影响工具调用和任务流程。

生产建议：

- Extension 固定 digest，不使用浮动版本。
- Extension bundle 只读挂载。
- 容器使用非 root 用户。
- 强制 \`--cap-drop=ALL\` 和 \`no-new-privileges\`。
- 设置 CPU、内存、PID 和 \`/tmp\` tmpfs。
- 不挂载 Docker socket、宿主 home、SSH agent 或无关目录。
- 为每个 Agent 构建最小化 \`/agent\`，不要挂载完整宿主 \`~/.pi/agent\`。
- 通过模型 egress proxy 限制网络出口；\`bridge\` 网络本身不能阻止密钥外传。
- API、日志和观测事件只记录 secret 引用，不记录 secret 值。
- 审计 Extension 对 \`oat-*\` 工具的阻止、修改和异常行为。

## 12. 错误处理与生命周期

首期固定 \`failure_policy: "fail_closed"\`：

- 配置不合法：Orchestrator 不启动。
- source 越界或类型不合法：Orchestrator 不启动。
- integrity 不匹配：Orchestrator 不启动。
- Extension entry 不存在：Agent 启动失败。
- Extension factory 抛错：Agent 启动失败。
- 工具冲突或使用 \`oat-*\`：Agent 启动失败。
- 任一 Agent 在团队启动期失败：回收已经启动的 Agent，避免半可用团队。

Extension 不热替换。源码或配置变化生成新 bundle digest，项目重启后切换；session reset 继续使用创建时的不可变 bundle。保留有限数量的历史 bundle，用于审计和故障复现。

## 13. 可观测性

新增事件：

\`\`\`text
pi.extension.prepare_started
pi.extension.prepared
pi.extension.load_started
pi.extension.loaded
pi.extension.load_failed
pi.extension.integrity_failed
pi.extension.tool_conflict
pi.extension.oat_tool_intercepted
\`\`\`

事件至少包含：

\`\`\`json
{
  "agentId": "backend-worker-0",
  "role": "worker",
  "extensionId": "worker-quality-gate",
  "digest": "...",
  "durationMs": 123
}
\`\`\`

不得包含 Extension config secret、API key、auth 文件内容或完整敏感 prompt。

## 14. 文档同步计划

实现版本必须同步：

1. \`README.md\` 和 \`README.zh-CN.md\`：Docker 增强能力、Pi Extensions 仅 Docker、\`oat-*\` 工具命名约定。
2. \`docs/zh-CN/docker-sandbox.md\`：Extension 挂载、角色授权、安全边界和网络风险。
3. \`docs/zh-CN/config.md\`：完整 \`runtime.docker.pi_extensions\` schema、示例和校验错误。
4. 新增面向用户的 \`docs/zh-CN/pi-extensions.md\`：Extension 编写、支持能力、配置、调试、版本与完整性。
5. \`docs/zh-CN/architecture.md\` 和 \`git-collaboration.md\`：所有 OAT 工具改为 \`oat-*\`。
6. 同步 \`docs/en\`、\`docs/fr\`、\`docs/ja\` 和对应 README；不能只更新中文造成协议文档分叉。
7. 发布说明明确：旧工具名已删除、需要重启项目、Pi \`.pi/extensions\` 不再自动加载。

文档必须明确写出：

> 开启 Docker 后，项目可以获得按 Admin、Leader、Worker 角色加载 Pi Extensions、扩展完整性校验、只读挂载和容器资源控制等额外能力。Pi Extensions 不支持本地进程模式。Extension 仍能访问所在容器中当前 Agent 的 workspace、模型凭据和允许的网络，请只加载可信代码。

## 15. 预计实现范围

- \`src/types/config.ts\` 或新增 \`src/types/pi-extension.ts\`
- \`src/config/schema.ts\`
- \`src/config/loader.ts\`
- \`src/config/runtime-policy.ts\`
- \`schema/v1.json\`
- 新增 \`src/pi/extension-manager.ts\`
- 新增 \`src/pi/extension-policy.ts\`
- \`src/sandbox/agent-runner-ipc.ts\`
- \`src/sandbox/agent-runner.ts\`
- \`src/sandbox/docker-process.ts\`
- \`src/sandbox/local-process.ts\`
- \`src/orchestrator/orchestrator.ts\`
- \`src/orchestrator/task-manager.ts\`
- \`src/pi/workspace-inject.ts\`
- Desktop Docker 页面、Agent 详情、management 配置与 i18n
- README、Docker/config/architecture/git-collaboration 文档及多语言版本

## 16. 测试与验收

### 16.1 Docker-only 策略

1. \`local_process + pi_extensions\` 配置被拒绝。
2. 本地模式不会加载 \`~/.pi/agent/extensions\`。
3. 本地模式不会加载 workspace \`.pi/extensions\`。
4. Docker 模式不会隐式加载未声明 Extension。
5. runner 拒绝非 Docker start 消息携带 Extension。

### 16.2 来源、角色和完整性

1. Admin、Leader、Worker 只加载各自授权集合。
2. \`../\`、realpath 越界和符号链接越界被拒绝。
3. digest 不匹配时启动失败。
4. Docker mount 只包含当前 Agent 的 bundle，且为只读。
5. session reset 不改变 bundle digest。
6. 源码变化必须项目重启才生效。

### 16.3 工具命名空间

1. 所有 OAT \`defineTool()\` 名称都以 \`oat-\` 开头。
2. AgentSession 不暴露旧的无前缀 OAT 工具名。
3. 系统提示词和 workspace 注入文本只引用 \`oat-*\`。
4. Extension 注册 \`oat-*\` 时启动失败。
5. OAT、Pi built-in、Extension 工具冲突均 fail-closed。
6. README 和四种语言文档不存在旧工具名，历史说明除外且必须显式标注。

### 16.4 UI 和文档

1. 本地模式 Docker 页面展示增强能力、风险和不可逆迁移提示。
2. Docker 模式展示 Pi Extension 数量、角色分布、digest 和错误状态。
3. Extension 变更显示“重启后生效”。
4. UI 不把 Pi Extension 混入 OpenClaw Plugin Center。
5. 文档包含 Docker 增强能力说明、完整配置示例和安全边界。

最终验收条件：

> 任意本地进程路径都不能执行 Pi Extension；Docker 中只有显式授权、来源受限、完整性验证通过且属于当前 Agent 角色的 Extension 能执行。所有 OAT 注入工具只以 \`oat-*\` 名称对 Agent 暴露，Desktop 和文档对 Docker 解锁的增强能力及其限制给出一致说明。

## 17. 推荐实施顺序

1. **命名空间准备**：完成 \`oat-*\` 原子迁移和静态测试，先消除与 Extension 工具的歧义。
2. **封闭默认发现**：所有 runtime 设置 \`noExtensions: true\`，验证本地模式无法执行 Extension。
3. **配置与策略**：加入 Docker-only schema、runtime policy 和错误信息。
4. **不可变 bundle**：实现 source 解析、路径防护、digest、角色过滤和只读挂载。
5. **runner 加载**：扩展 IPC、显式 additional paths、冲突检测和 fail-closed。
6. **可观测性与生命周期**：事件、Agent 详情、restart 语义和失败回滚。
7. **Desktop 与文档**：Docker 能力提示、配置入口、状态页和多语言文档同步。
8. **后续评估**：再决定 npm/git provisioner、secret provider 和 provider Extension。
`;export{e as default};