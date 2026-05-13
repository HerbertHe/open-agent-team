# team.json Configuration Reference (complete parameter dictionary)

`team.json` is the entry point for declaring your agent team configuration. Orchestrator reads and parses it, starts `Admin / Leader` and pre-spawns a `Worker` pool at startup.
You can validate this file against the root-level `schema/v1.json`.

At the same time, the loader performs two kinds of runtime "completion/parsing":

- `prompt` fields accept either prompt text directly or a file path ending with `*.md` (loader reads the file and substitutes the content)
- `model` fields accept aliases; aliases are resolved from the top-level `models` mapping (loader replaces them with real model ids)

Below is a field-by-field dictionary (type / requiredness / default / purpose).

## 1. Top-level configuration

| Field | Required | Type | Default | Purpose |
| --- | --- | --- | --- | --- |
| `model` | No | string | - | Global default model (fallback for admin/leader/worker) |
| `providers` | No | object | See below | Global model-provider integration config (recommended entry) |
| `project` | Yes | object | - | Project metadata: used for logs/prompts, git base branch, and repository path |
| `models` | Yes | record<string, string> | - | Model alias map (used by admin/leader/worker) |
| `admin` | Yes | object | - | Admin agent definition: prompt, model, and skills |
| `teams` | Yes | array | - | Each team contains one Leader and one Worker definition |
| `runtime` | No | object | See tables below | Execution mode and state directory |
| `workspace` | No | object | See tables below | Workspace strategy, root dir, git lfs/sparse-checkout behavior |

## 2. `project`

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `project.name` | Yes | string | - | Project name (used in prompts/logs) |
| `project.repo` | Yes | string | - | Git repository path (used by workspace management and skill loading; relative paths are resolved from the `team.json` directory) |
| `project.base_branch` | No | `main` \| `master` | `"main"` | Merge target after leader completes; only `main` or `master` are allowed (schema-enforced) |

## 3. `models` (model alias mapping)

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `models` | Yes | record<string, string> | - | Key is alias (e.g. `default`), value is real model id (e.g. `anthropic/claude-opus-4-5`) |

Loader behavior:

- Model inheritance chain: `worker.model -> leader.model -> admin.model -> model` (higher-priority left, fallback right)
- If the final selected model exists as a key in `models`, it is replaced with the mapped value
- Otherwise, the final selected value is kept as-is
- Model id format: `<provider>/<model-id>` (e.g. `anthropic/claude-opus-4-5`); if no `/` present, provider defaults to `anthropic`

## 4. `admin`

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `admin.name` | Yes | string | - | Admin agent name |
| `admin.description` | Yes | string | - | Admin responsibility text |
| `admin.model` | No | string | inherit from top-level `model` | Model used by Admin (can be an alias) |
| `admin.prompt` | Yes | string | - | Admin prompt (supports `*.md` file path) |
| `admin.skills` | No | SkillEntry[] | `[]` | Skills to install into Admin workspace (each entry has `source` and optional `names`) |

## 5. `runtime`

> `runtime` is optional; if it is not provided, the loader uses the defaults below.

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `runtime.mode` | No | enum (`local_process`) | `local_process` | Runtime mode (currently only implements `local_process`; each Agent runs in an isolated child process via `child_process.fork()`) |
| `runtime.persistence.state_dir` | No | string | `"<team.json dir>/.oat/state"` | Orchestrator state directory (used by `status/stop` reading `orchestrator.json`) |

Home expansion:

- If `runtime.persistence.state_dir` is omitted, it defaults to `.oat/state` under the same directory as `team.json`
- `runtime.persistence.state_dir` supports `~` prefix; loader expands it to a real user home path
- If `runtime.persistence.state_dir` is a relative path, it is resolved relative to the `team.json` directory

## 5.1 `providers` (global provider integration)

> Each **key** under `providers` is a provider name. It must match the prefix of resolved `models` entries, which use the form `<providerKey>/<modelName>` (for example, if `models.default` is `openai/gpt-4o-mini`, you need a `providers.openai` block).

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `providers.<name>.compatible_type` | Yes | `openai` \| `anthropic` | - | Protocol: `openai` maps `base_url` / `api_key` to `OPENAI_BASE_URL` / `OPENAI_API_KEY`; `anthropic` maps to `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` |
| `providers.<name>.base_url` | No | string | - | API base URL |
| `providers.<name>.api_key` | No | string | - | API key (plain text; avoid committing real secrets) |

Notes:

1. On startup the orchestrator walks every `providers` entry and sets the corresponding process env vars from `base_url` / `api_key`. Child agent processes inherit them via `fork`; pi-coding-agent still reads keys from the environment.
2. If multiple entries share the same `compatible_type`, later keys in object iteration order can overwrite earlier `OPENAI_*` / `ANTHROPIC_*` values. In practice configure one provider per protocol.
3. Model IDs in `models` can use `<providerKey>/<modelName>` with any `providerKey` defined in `providers` (e.g. `cli_proxy_api/deepseek-v4-pro`). At runtime, the loader rewrites the provider prefix to the corresponding `compatible_type` (`openai/<modelName>` or `anthropic/<modelName>`) before creating pi sessions.

> pi-coding-agent reads API keys from process environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.). `providers` only sets those variables before pi sessions start.

## 6. `workspace`

> `workspace` is optional; if it is not provided, the loader uses the defaults below.

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `workspace.provider` | No | enum (`worktree` \| `shared_clone` \| `full_clone`) | `worktree` | Workspace strategy (only `worktree` implemented today) |
| `workspace.root_dir` | No | string | `"<team.json dir>/workspaces"` | Root directory where workspaces are created |
| `workspace.git.remote` | No | string | `"origin"` | Placeholder: current code does not directly use remote name when creating worktrees |
| `workspace.git.lfs` | No | enum (`pull` \| `skip` \| `allow_pull_deny_change`) | `pull` | For the `worktree` provider, run `git lfs pull` only when set to `pull` |
| `workspace.sparse_checkout.enabled` | No | boolean | `true` | Enable sparse-checkout (requires `teams[].leader.repos` to set paths) |

Home expansion:

- If `workspace.root_dir` is omitted, it defaults to `workspaces` under the same directory as `team.json`
- `workspace.root_dir` supports `~` prefix; loader expands it to a real user home path
- If `workspace.root_dir` is a relative path, it is resolved relative to the `team.json` directory

## 7. `teams[]`

Each team contains:

- `team.name`: team identifier
- `team.branch_prefix`: prefix used to build leader/worker branch names
- `team.leader`: Leader agent definition (started statically)
- `team.worker`: Worker agent definition (pre-spawned at startup)

### 7.1 team basic fields

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `teams[].name` | Yes | string | - | Team name (used for workspace/scope identifiers and agent naming) |
| `teams[].branch_prefix` | Yes | string | - | Branch naming base used for worker/leader |

### 7.2 `teams[].leader`

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `leader.name` | Yes | string | - | Leader's name inside the team |
| `leader.description` | Yes | string | - | Leader responsibility text |
| `leader.model` | No | string | inherit from `admin.model` (or top-level `model`) | Model used by Leader (can be an alias) |
| `leader.prompt` | Yes | string | - | Leader prompt (supports `*.md` file path) |
| `leader.skills` | No | SkillEntry[] | `[]` | Skills shared with Workers (inherited and installed on spawn) |
| `leader.repos` | No | string[] | `[]` | sparse-checkout allowlist paths (controls which paths worker workspaces can see) |

### 7.3 `teams[].worker`

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `worker.total` | Yes | number(int, >0) | - | Worker pool size. Workers are pre-created when starting a team and stopped only when the orchestrator exits (`stopAll`) |
| `worker.model` | No | string | inherit from `leader.model` | Model used by Worker (can be an alias) |
| `worker.prompt` | Yes | string | - | Worker prompt (supports `*.md` file path) |
| `worker.extra_skills` | No | SkillEntry[] | `[]` | Extra skills appended on top of leader.skills when spawning workers |
| `worker.skill_sync` | No | enum | `inherit_and_inject_on_spawn` | Skill sync strategy on spawn (current behavior is "inherit and inject") |
