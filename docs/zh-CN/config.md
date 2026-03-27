# team.json 配置说明（完整参数字典）

`team.json` 是这个项目的声明式配置入口。Orchestrator 会读取并解析它，然后根据配置启动 `Admin / Leader`（静态），并在 `Leader` 请求时动态创建 `Worker`（临时）。
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
| `runtime` | 否 | object | 见下表 | 运行时模式、opencode 可执行文件与 Orchestrator/agent 端口基线、状态目录 |
| `workspace` | 否 | object | 见下表 | workspace 创建策略、根目录、git lfs/sparse-checkout 策略 |

## 2. `project`

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `project.name` | 是 | string | - | 项目名称（用于构建提示词/日志） |
| `project.repo` | 是 | string | - | git 仓库路径（workspace 与 skills 解析都依赖该路径） |
| `project.base_branch` | 否 | string | `"main"` | leader->main 的合并目标分支 |

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
| `admin.skills` | 否 | string[] | `[]` | Admin 共享给 OpenCode 的 skills 列表（会同步到 Admin workspace） |

## 5. `runtime`

> `runtime` 整体是可选项；若不提供，loader 会使用以下默认值。

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `runtime.mode` | 否 | enum (`local_process` \| `flue`) | `local_process` | 运行时模式（当前仅实现 `local_process`） |
| `runtime.opencode.executable` | 否 | string | `"opencode"` | `opencode` 可执行文件/命令名 |
| `runtime.ports.base` | 否 | number | `8848` | agent 端口起始基线：Admin 使用 base，Leader 为 base+1+index |
| `runtime.ports.max_agents` | 否 | number | `10` | 当前版本未参与硬性并发控制（预留配置位） |
| `runtime.persistence.state_dir` | 否 | string | `"~/.oat/state"` | orchestrator 状态持久化目录（`status/stop` 会读取 `orchestrator.json`） |

home 展开：

- `runtime.persistence.state_dir` 支持 `~` 前缀，loader 会展开为实际用户目录

## 5.1 `providers`（全局供应商接入）

> 推荐将模型供应商参数放在顶层 `providers`，与 `model/models` 放在一起，降低配置学习成本。

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `providers.env` | 否 | record<string, string> | `{}` | 直接注入到每个 `opencode serve` 进程的环境变量（明文，不建议放敏感 key） |
| `providers.env_from` | 否 | record<string, string> | `{}` | 环境变量映射：key 为注入名，value 为**当前 orchestrator 进程**中的源环境变量名；若该注入名已在 `providers.env` 中出现过则**跳过**（不再从系统环境覆盖） |
| `providers.openai_compatible.base_url` | 否 | string | - | 便捷配置：自动映射到 `OPENAI_BASE_URL` 注入 `opencode` 进程 |
| `providers.openai_compatible.api_key` | 否 | string | - | 便捷配置：自动映射到 `OPENAI_API_KEY`（不推荐明文）；若设置则会覆盖此前合并结果中的 `OPENAI_API_KEY` |
| `providers.openai_compatible.api_key_env` | 否 | string | - | 在未设置 `api_key` 时生效：值为**环境变量名**；先取该名在**已合并配置**中的取值（含 `providers.env` 以及已应用的 `env_from`），**没有再读**当前进程环境变量，并写入子进程 `OPENAI_API_KEY` |

注入说明（合并顺序）：

1. 先应用 `providers.env`。
2. 再应用 `providers.env_from`：仅当某个注入名尚未存在时才从系统环境补齐。
3. 最后应用 `providers.openai_compatible`：`base_url`、`api_key` 直接写入；若未配置 `api_key` 且配置了 `api_key_env`，按上表「先配置文件、再环境变量」解析后写入 `OPENAI_API_KEY`。
4. 秘密信息可放在系统环境变量中，通过 `env_from` 或 `api_key_env` 引用，避免明文写进 `team.json`；也可直接写在 `providers.env`（不建议提交仓库）。
5. 若 `env_from` 仍需从系统读取但源变量不存在，或 `api_key_env` 在配置与环境中均解析不到有效值，运行时会 warning，`opencode` 可能因缺少 key 而调用失败。

## 6. `workspace`

> `workspace` 整体是可选项；若不提供，loader 会使用以下默认值。

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `workspace.provider` | 否 | enum (`worktree` \| `shared_clone` \| `full_clone`) | `worktree` | workspace 策略（当前仅实现 `worktree`） |
| `workspace.root_dir` | 否 | string | `"~/.oat/workspaces"` | workspace 根目录（每个 agent workspace 会落在该目录下） |
| `workspace.persistent` | 否 | boolean | `true` | 目前在工作空间创建/清理逻辑中未被实现为差异化行为（预留配置位） |
| `workspace.git.remote` | 否 | string | `"origin"` | 预留：当前代码仅创建 worktree、未直接使用 remote 名称 |
| `workspace.git.lfs` | 否 | enum (`pull` \| `skip` \| `allow_pull_deny_change`) | `pull` | 当前 `worktree` provider 仅在值为 `pull` 时执行 `git lfs pull` |
| `workspace.sparse_checkout.enabled` | 否 | boolean | `true` | 是否启用 sparse-checkout（需要 leader 提供 `teams[].leader.repos` 才会设置 paths） |

home 展开：

- `workspace.root_dir` 支持 `~` 前缀，loader 会展开为实际用户目录

## 7. `teams[]`

每个 team 都包含：

- `team.name`：team 标识
- `team.branch_prefix`：该 team 的分支前缀（leader/worker branch 会基于它构造）
- `team.leader`：Leader agent 定义（会被静态启动）
- `team.worker`：Worker agent 定义（会在 Leader 运行中动态创建）

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
| `leader.skills` | 否 | string[] | `[]` | Leader skills（会继承到 worker，且在动态创建时注入） |
| `leader.repos` | 否 | string[] | `[]` | sparse-checkout 白名单路径（用于 worker workspace 可见范围） |

### 7.3 `teams[].worker`

| 字段 | 必填 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `worker.max` | 是 | number(int, >0) | - | 配置意图：期望的最大 worker 数（当前版本未在代码中硬性限制；worker 数由 `tasks.length` 决定） |
| `worker.model` | 否 | string | 继承 `leader.model` | Worker 使用的模型（可为别名） |
| `worker.prompt` | 是 | string | - | Worker prompt（支持 `*.md` 文件路径形式） |
| `worker.extra_skills` | 否 | string[] | `[]` | 追加到 worker 的技能集合（在动态创建时追加到 leader.skills 后注入） |
| `worker.lifecycle` | 否 | enum | `ephemeral_after_merge_to_main` | 配置意图：merge main 后是否回收（当前版本回收逻辑始终执行，未按该字段分支） |
| `worker.skill_sync` | 否 | enum | `inherit_and_inject_on_spawn` | 配置意图：动态 spawn 时 skill 注入策略（当前版本实际行为是“继承并注入”，未实现手动模式分支） |
