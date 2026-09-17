# team.json 配置说明（完整参数字典）

`team.json` 是这个项目的声明式配置入口。你可以使用 `oat init` 快速在当前目录生成一份配置模板。Orchestrator 会读取并解析它，然后根据配置启动 `Admin / Leader` 并在启动时预先创建 `Worker` 池。
你可以使用项目根目录的 `schema/v1.json` 对该文件做校验。

同时，loader 会做两类“运行时补齐/解析”：

- `prompt` 字段允许直接写 prompt 文本，也允许写成以 `*.md` 结尾的文件路径（loader 会读取该文件内容替换）
- `model` 字段允许使用别名；别名来源于顶层 `models` 映射（loader 将别名替换成真实 model id）

下面按层级给出参数说明（类型/必填/默认值/作用）。

## 1. 顶层配置

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `model` | 否 | string | - | 全局默认模型（admin/leader/worker 的兜底） |
| `providers` | 否 | object | 见下文 | 全局模型供应商接入配置（推荐入口，集中配置 base_url/key 注入） |
| `project` | 是 | object | - | 项目元信息：用于日志/提示词，以及 git 操作的根分支与仓库路径 |
| `models` | 是 | record<string, string> | - | 模型别名到 model id 的映射（供 admin/leader/worker 解析） |
| `admin` | 是 | object | - | Admin agent 的角色定义：prompt、模型与 skills |
| `teams` | 是 | array | - | 每个 team 一组 leader/worker 配置 |
| `runtime` | 否 | object | 见下表 | 运行时模式、状态目录 |
| `workspace` | 否 | object | 见下表 | workspace 创建策略、根目录、git lfs/sparse-checkout 策略 |
| `memory` | 否 | object | lexical | 记忆、检索模式和全局 Embedding Profile 引用 |
| `knowledge` | 否 | object | 启用 | 文件共享知识根目录、监听与分块；复用 `memory` 的 Embedding/Zvec 配置 |

## 2. `project`

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `project.name` | 是 | string | - | 项目名称（用于构建提示词/日志） |
| `project.repo` | 是 | string | - | git 仓库路径（workspace 与 skills 解析都依赖该路径；相对路径会按 `team.json` 所在目录解析） |
| `project.base_branch` | 否 | `main` \| `master` | `"main"` | Leader 完成后合并目标分支；仅允许 `main` 或 `master`（由 schema 校验） |

## 3. `models`（模型别名映射）

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `models` | 是 | record<string, string> | - | key 为别名（如 `default`），value 为真实 model id（如 `anthropic/...`） |

loader 行为：

- 模型继承链路：`worker.model -> leader.model -> admin.model -> model`（左侧优先，右侧兜底）
- 最终选中的模型若存在于 `models` 中，则会被替换为映射值
- 若不在 `models` 中，则保持该最终值不变

## 4. `admin`

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `admin.name` | 是 | string | - | Admin agent 名称（注入到 workspace 的 agent markdown meta） |
| `admin.description` | 是 | string | - | Admin 的职责描述（写入 prompt/约束构建逻辑，由你在 team.json 填写） |
| `admin.model` | 否 | string | 继承顶层 `model` | Admin 使用的模型（可为别名） |
| `admin.prompt` | 是 | string | - | Admin 的系统/角色 prompt（支持 `*.md` 文件路径形式） |
| `admin.skills` | 否 | SkillEntry[] | `[]` | Admin 安装的 skills 列表（每个 entry 包含 `source` 和可选 `names`，通过 `npx skills add` 安装） |
| `admin.push_channel` | 否 | object | - | 旧版推送通道目标；Desktop 会迁移到全局 Channel 绑定，新配置请使用 Channels 页面。 |

## 5. `runtime`

> `runtime` 整体是可选项；若不提供，loader 会使用以下默认值。

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `runtime.mode` | 否 | enum (`local_process` \| `docker`) | `local_process` | 运行时模式；`docker` 为每个 Agent session 创建独立容器 |
| `runtime.docker.image` | docker 模式必填 | string | - | Docker 镜像；需包含 Node.js 和项目任务工具 |
| `runtime.docker.network` | 否 | `none` \| `bridge` \| `host` | `bridge` | 容器网络模式 |
| `runtime.docker.extra_args` | 否 | string[] | `[]` | 追加至 `docker run` 的资源/安全参数 |
| `runtime.persistence.state_dir` | 否 | string | `"<team.json目录>/.oat/state"` | orchestrator 状态持久化目录（`status/stop` 会读取 `orchestrator.json`） |

home 展开：

- `runtime.persistence.state_dir` 若未配置，默认解析为 `team.json` 同目录下的 `.oat/state`
- `runtime.persistence.state_dir` 支持 `~` 前缀，loader 会展开为实际用户目录
- `runtime.persistence.state_dir` 若配置相对路径，会相对 `team.json` 所在目录解析

## 5.1 `providers`（全局供应商接入）

> `providers` 的 **对象键** 即服务商名称，须与 `models` 中解析后的值 `<服务商key>/<模型名>` 的前缀一致（例如 `models.default` 为 `openai/gpt-4o-mini` 时，需存在 `providers.openai`）。

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `providers.<name>.compatible_type` | 是 | `openai` \| `anthropic` | - | 兼容协议：`openai` 将 `base_url` / `api_key` 映射到 `OPENAI_BASE_URL` / `OPENAI_API_KEY`；`anthropic` 映射到 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` |
| `providers.<name>.base_url` | 否 | string | - | API 基础地址 |
| `providers.<name>.api_key` | 否 | string | - | API 密钥（明文；不建议将含真实密钥的配置提交到仓库） |

注入说明：

1. Orchestrator 启动时会遍历 `providers` 中每个条目，按 `compatible_type` 把 `base_url` 与 `api_key` 写入当前进程环境变量；Agent 子进程通过 `fork` 继承，`pi-coding-agent` 仍从环境变量读取密钥。
2. 若存在多个同 `compatible_type` 的条目，遍历顺序取决于 JSON 对象键顺序，后写入的会覆盖先写入的同名环境变量；通常每种类型只配置一个服务商即可。
3. `models` 中的模型值可以使用任意 `providers` 中已声明的 key 作为前缀（例如 `cli_proxy_api/deepseek-v4-pro`）。运行时 loader 会按该 provider 的 `compatible_type` 自动重写为 `openai/deepseek-v4-pro` 或 `anthropic/deepseek-v4-pro` 后再创建 pi 会话。

## 5.2 全局 Embedding 配置与项目引用

Embedding Profile 不写入 `team.json`，而是在 Desktop「全局设置 → 全局模型」中维护，并保存到 `~/.oat/models.json` 的 `embeddingProfiles`。普通聊天模型别名不会被推断为支持 Embedding。

```json
{
  "providers": {
    "openai": {
      "compatible_type": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "..."
    }
  },
  "models": {},
  "embeddingProfiles": {
    "memory-default": {
      "kind": "openai-compatible",
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "normalization": "provider-default",
      "revision": "1",
      "timeoutMs": 15000,
      "batchSize": 32,
      "maxAttempts": 3
    }
  }
}
```

`provider` 必须引用同一文件中 `compatible_type=openai` 的 Provider。`revision` 是模型内容版本，不是 API 版本：当服务商在相同 model/deployment 名称后替换模型权重时必须递增。旧配置未声明时按 `"1"` 读取；API key、timeout、batchSize 和 maxAttempts 的变化不需要递增。全局默认 Profile 位于 `~/.oat/oat.json`：

Profile 一旦被全局默认值或任一 Project 引用，Desktop 会将其视为不可变版本，禁止原地修改模型身份字段或删除。需要更换模型时应创建新名称的 Profile，切换 Project 引用后在「全局设置 → 记忆管理」执行重建和激活；页面会显示显式引用及继承全局默认值的受影响 Project。详见 [M14 记忆运维与可观测性](./memory-desktop-operations-m14.md)。

```json
{ "memoryDefaults": { "embeddingProfile": "memory-default" } }
```

Project 只保存引用和检索策略：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `memory.embeddingRef` | 继承全局默认 | Profile 名称；设置为 `null` 时显式禁用继承 |
| `memory.retrieval.backend` | `lexical` | `lexical`、`zvec_fts` 或 `zvec_hybrid` |
| `memory.retrieval.fallback` | `lexical` | 当前只允许安全回退到 lexical |
| `memory.retrieval.shadow` | `false` | 仅比较结果，不改变提示注入 |
| `memory.zvec.*` | 见 Schema | 只控制路径、索引和批处理；不得重复配置模型或维度 |

`zvec_hybrid` 没有有效 Profile 时按 lexical 运行且不打开 Dense vector collection；`zvec_fts` 不依赖 Dense Embedding。Profile 的 Provider、endpoint、model、dimensions、normalization 或 revision 改变时 embedding revision 会改变；index、metric 或 Schema 投影版本变化时 collection revision 会改变。后续必须创建新 collection，禁止混写旧向量。

M10 的主动检索使用全局双重开关。Desktop 的「全局设置 → 全局模型 → 记忆检索放量」会把以下配置保存到 `~/.oat/oat.json`：

```json
{
  "memoryRetrieval": {
    "enabled": true,
    "projectAllowlist": ["my-project"]
  }
}
```

只有 `enabled=true` 且 `projectAllowlist` 精确包含 `team.json` 的 `project.name` 时，Project 请求的 `zvec_fts` / `zvec_hybrid` 才会参与实际提示检索。匹配区分大小写，不接受通配符；配置变更后重启对应 Project 生效。`memory.retrieval.shadow=true` 始终优先于主动放量，只记录对比数据而不改变提示。

Project 检索字段：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `memory.retrieval.backend` | `lexical` | `lexical`、`zvec_fts` 或 `zvec_hybrid` |
| `memory.retrieval.fallback` | `lexical` | 当前只允许安全回退到 lexical |
| `memory.retrieval.shadow` | `false` | 影子比较开关；开启后不改变提示注入 |
| `memory.retrieval.candidateLimit` | `30` | Zvec 各路召回进入治理前的候选上限 |
| `memory.retrieval.maxResults` | `8` | 检索结果总量配置上限 |
| `memory.retrieval.maxPromptTokens` | `1800` | 记忆提示预算估算值；顺序为 L1、L3、L2 |
| `memory.retrieval.timeoutMs` | `3000` | 主动 Zvec 检索对 Agent 可见的最大等待时间 |
| `memory.retrieval.circuitBreakerFailureThreshold` | `3` | 连续整体失败达到此次数后打开熔断器 |
| `memory.retrieval.circuitBreakerCooldownSeconds` | `60` | 熔断后允许一次半开探测前的冷却时间 |

超时、collection 缺失/损坏、Embedding 失败或熔断时自动使用 lexical，并继续执行 Agent 任务。L1 始终按时间从 SQLite 读取；主动 Zvec 只替换 L2/L3。部分路由失败但仍有安全结果时继续使用可用结果，同时在状态中显示降级原因。

M11 可选结构化事实提取配置：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `memory.extraction.enabled` | `false` | 开启结构化事实提取；关闭后保持原有确定性沉淀 |
| `memory.extraction.model` | 未配置 | 模型别名或 `provider/model`；无有效模型时保持原有沉淀行为 |
| `memory.extraction.version` | `m11-v1` | 写入候选事实的提取规则版本 |
| `memory.extraction.timeoutMs` | `15000` | 单事件模型调用最大等待时间 |
| `memory.extraction.maxInputChars` | `4000` | 单事件发送给模型的最大字符数 |
| `memory.extraction.maxOutputTokens` | `800` | 单事件输出 token 上限 |
| `memory.extraction.maxFactsPerEvent` | `5` | 单事件最多接受的事实原子数 |
| `memory.extraction.maxAttempts` | `3` | 无效响应、超时或供应商错误的最多跨轮重试次数 |

提取模型复用顶层 `providers` 和 `models` 别名，不复用 Embedding Profile。当前支持 OpenAI-compatible Chat Completions 的 strict JSON Schema，以及 Anthropic Messages 的强制 tool schema；两者返回后都必须再次通过本地严格 Zod 校验。通过校验的结果先以 L2 `candidate` 保存。M12 随后执行有效期、exact duplicate、冲突和独立证据治理；未激活候选不写入 Zvec、不参与提示检索。Channel 来源 trust 最高 40，A2A 来源最高 30，二者 scope 均由代码强制收紧到 `private`，且不能自动激活或晋升。若配置了全局 `memory.embeddingRef`，同一 Embedding Profile 还会用于生成只供人工审查的 semantic duplicate 建议，语义相似本身不能覆盖事实。

M13 权限配置：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `memory.access.leaderProjectScopeTeams` | `[]` | 允许列出的 Team Leader 读取当前 Project 的 `project` scope 记忆；填写 Team 名称 |

Leader 默认只能读取本 Team、本人 private 和项目内 global 记忆。该配置不允许 Leader 读取其他主体的 private，也不会赋予正式 Worker、A2A 外部 Worker或资源主管 canonical 写权限。

## 5.3 `knowledge` 文件共享知识

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `knowledge.enabled` | 否 | boolean | `true` | 启用文件摄取、检索和 Desktop 知识管理 |
| `knowledge.roots.project` | 否 | string | `knowledge/project` | 整个项目可读的知识文件目录，相对 `project.repo` |
| `knowledge.roots.teams` | 否 | string | `knowledge/teams` | 团队知识根目录；一级子目录必须为 Team 名称 |
| `knowledge.roots.uploads` | 否 | string | `knowledge/uploads` | Desktop 用户上传事实源目录 |
| `knowledge.watcher.enabled` | 否 | boolean | `true` | 启用周期合并扫描 |
| `knowledge.watcher.debounceMs` | 否 | integer | `1000` | 扫描间隔，范围 100～60000 ms |
| `knowledge.ingestion.maxFileSizeMb` | 否 | integer | `50` | 单文件上限，范围 1～2048 MiB |
| `knowledge.ingestion.chunkTokens` | 否 | integer | `1000` | 确定性分块的目标 token 数，范围 128～8192 |
| `knowledge.ingestion.chunkOverlapTokens` | 否 | integer | `120` | 相邻分块 overlap，范围 0～2048 且必须小于 `chunkTokens` |

三个 root 都必须位于 `project.repo` 内，运行时会 canonicalize 并拒绝路径逃逸。项目知识、团队知识和上传知识使用同一个 `memory.db`、Semantic Outbox 和 active Zvec collection；不要为知识重复配置模型或向量维度。完整行为见[文件共享知识库](./knowledge-architecture.md)。

## 6. `workspace`

> `workspace` 整体是可选项；若不提供，loader 会使用以下默认值。

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `workspace.provider` | 否 | enum (`worktree` \| `shared_clone` \| `full_clone`) | `worktree` | workspace 策略（当前仅实现 `worktree`） |
| `workspace.root_dir` | 否 | string | `"<team.json目录>/workspaces"` | 静态 Agent workspace 根目录；任务级 worktree 与工件位于 `runtime.persistence.state_dir/git-collaboration/` |
| `workspace.git.remote` | 否 | string | — | 远程名称；不配置即为纯本地 Git |
| `workspace.git.remote_url` | 否 | string | — | 所选 remote 的拉取/推送地址 |
| `workspace.git.user_name` | 否 | string | — | Admin 最终 release 合并提交使用的本地身份 |
| `workspace.git.user_email` | 否 | string | — | Admin 最终 release 合并提交使用的本地邮箱 |
| `workspace.git.push_enabled` | 否 | boolean | `false` | 允许 Admin 显式推送已合并 release；Leader/Worker worktree 始终禁用推送 |
| `workspace.git.lfs` | 否 | enum (`pull` \| `skip` \| `allow_pull_deny_change`) | `pull` | 当前 `worktree` provider 仅在值为 `pull` 时执行 `git lfs pull` |
| `workspace.sparse_checkout.enabled` | 否 | boolean | `true` | 是否启用 sparse-checkout（需要 leader 提供 `teams[].leader.repos` 才会设置 paths） |

home 展开：

- `workspace.root_dir` 若未配置，默认解析为 `team.json` 同目录下的 `workspaces`
- `workspace.root_dir` 支持 `~` 前缀，loader 会展开为实际用户目录
- `workspace.root_dir` 若配置相对路径，会相对 `team.json` 所在目录解析

## 7. `teams[]`

每个 team 都包含：

- `team.name`：team 标识
- `team.branch_prefix`：该 team 的分支前缀（leader/worker branch 会基于它构造）
- `team.leader`：Leader agent 定义（会被静态启动）
- `team.worker`：Worker agent 定义（在启动时预先创建）

### 7.1 team 基本字段

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `teams[].name` | 是 | string | - | Team 名称（用于 workspace/scope 标识与 agent 命名） |
| `teams[].branch_prefix` | 是 | string | - | worker/leader 分支命名基于该前缀构造 |

### 7.2 `teams[].leader`

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `leader.name` | 是 | string | - | Leader 在 team 内的名称（用于 prompt/角色构建） |
| `leader.description` | 是 | string | - | Leader 职责描述（你可放到 prompt 中或由模型自行解读） |
| `leader.model` | 否 | string | 继承 `admin.model`（或顶层 `model`） | Leader 使用的模型（可为别名） |
| `leader.prompt` | 是 | string | - | Leader prompt（支持 `*.md` 文件路径形式） |
| `leader.skills` | 否 | SkillEntry[] | `[]` | Leader skills（会继承到 worker，且在创建时安装） |
| `leader.repos` | 否 | string[] | `[]` | sparse-checkout 白名单路径（用于 worker workspace 可见范围） |

### 7.3 `teams[].worker`

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `worker.total` | 是 | number(int, >0) | - | 配置意图：启动 team 时预先创建并常驻的 worker 数量（仅在 orchestrator 退出时统一 stopAll 销毁） |
| `worker.model` | 否 | string | 继承 `leader.model` | Worker 使用的模型（可为别名） |
| `worker.prompt` | 是 | string | - | Worker prompt（支持 `*.md` 文件路径形式） |
| `worker.extra_skills` | 否 | SkillEntry[] | `[]` | 追加到 worker 的技能集合（在创建时追加到 leader.skills 后安装） |
| `worker.skill_sync` | 否 | enum | `inherit_and_inject_on_spawn` | 配置意图：spawn 时 skill 注入策略（当前版本实际行为是“继承并注入”，未实现手动模式分支） |
