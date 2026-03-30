# team.json Configuration Reference (complete parameter dictionary)

`team.json` is the entry point for declaring your agent team configuration. Orchestrator reads and parses it, starts static `Admin / Leader`, and dynamically creates `Worker` agents when requested by `Leader`.
You can validate this file against the root-level `schema/v1.json`.

At the same time, the loader performs two kinds of runtime “completion/parsing”:

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
| `runtime` | No | object | See tables below | Execution mode, base ports, and state directory |
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
| `models` | Yes | record<string, string> | - | Key is alias (e.g. `default`), value is real model id (e.g. `anthropic/...`) |

Loader behavior:

- Model inheritance chain: `worker.model -> leader.model -> admin.model -> model` (higher-priority left, fallback right)
- If the final selected model exists as a key in `models`, it is replaced with the mapped value
- Otherwise, the final selected value is kept as-is

## 4. `admin`

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `admin.name` | Yes | string | - | Admin agent name (written into workspace agent markdown meta) |
| `admin.description` | Yes | string | - | Admin responsibility text (you fill it into `team.json`) |
| `admin.model` | No | string | inherit from top-level `model` | Model used by Admin (can be an alias) |
| `admin.prompt` | Yes | string | - | Admin prompt (supports `*.md` file path) |
| `admin.skills` | No | string[] | `[]` | Skills to inject into Admin workspace |

## 5. `runtime`

> `runtime` is optional; if it is not provided, the loader uses the defaults below.

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `runtime.mode` | No | enum (`local_process` \| `flue`) | `local_process` | Runtime mode (currently only implements `local_process`) |
| `runtime.opencode.executable` | No | string | `"opencode"` | `opencode` executable name/path |
| `runtime.ports.base` | No | number | `8848` | Base port for agent servers (Admin uses `base`, Leader uses `base + 1 + index`) |
| `runtime.ports.max_agents` | No | number | `10` | The current code does not strictly enforce this (placeholder/preference) |
| `runtime.persistence.state_dir` | No | string | `"<team.json dir>/.oat/state"` | Orchestrator state directory (used by `status/stop` reading `orchestrator.json`) |

Home expansion:

- If `runtime.persistence.state_dir` is omitted, it defaults to `.oat/state` under the same directory as `team.json`
- `runtime.persistence.state_dir` supports `~` prefix; loader expands it to a real user home path
- If `runtime.persistence.state_dir` is a relative path, it is resolved relative to the `team.json` directory

## 5.1 `providers` (global provider integration)

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `providers.env` | No | record<string, string> | `{}` | Plain env vars injected into every `opencode serve` process |
| `providers.env_from` | No | record<string, string> | `{}` | Env mapping: key is injected name, value is source env var name on the **orchestrator process**; if that injected key already exists from `providers.env`, the entry is **skipped** (no overwrite from the OS) |
| `providers.openai_compatible.base_url` | No | string | - | Convenience mapping to `OPENAI_BASE_URL` |
| `providers.openai_compatible.api_key` | No | string | - | Convenience mapping to `OPENAI_API_KEY` (plain text; not recommended); if set, overwrites any prior merged `OPENAI_API_KEY` |
| `providers.openai_compatible.api_key_env` | No | string | - | Used when `api_key` is unset: value is an **env var name**; resolve **first** from merged config (`providers.env` plus applied `env_from`), **else** from the current process env, then set child `OPENAI_API_KEY` |

Notes (merge order):

1. Apply `providers.env` first.
2. Apply `providers.env_from` only for keys not already present.
3. Apply `providers.openai_compatible` last: `base_url` / `api_key` directly; if `api_key` is absent and `api_key_env` is set, resolve as above (config before OS env).
4. For secrets, prefer `env_from` or `api_key_env` pointing at OS vars, or use `providers.env` locally without committing keys.
5. Warnings if `env_from` still needs the OS but the source var is missing, or if `api_key_env` resolves empty from both config and env.

## 6. `workspace`

> `workspace` is optional; if it is not provided, the loader uses the defaults below.

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `workspace.provider` | No | enum (`worktree` \| `shared_clone` \| `full_clone`) | `worktree` | Workspace strategy (only `worktree` implemented today) |
| `workspace.root_dir` | No | string | `"<team.json dir>/workspaces"` | Root directory where workspaces are created |
| `workspace.persistent` | No | boolean | `true` | Currently not implemented as differentiated behavior (placeholder) |
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
- `team.worker`: Worker agent definition (created dynamically during Leader runtime)

### 7.1 team basic fields

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `teams[].name` | Yes | string | - | Team name (used for workspace/scope identifiers and agent naming) |
| `teams[].branch_prefix` | Yes | string | - | Branch naming base used for worker/leader |

### 7.2 `teams[].leader`

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `leader.name` | Yes | string | - | Leader’s name inside the team (used when constructing role/prompt context) |
| `leader.description` | Yes | string | - | Leader responsibility text |
| `leader.model` | No | string | inherit from `admin.model` (or top-level `model`) | Model used by Leader (can be an alias) |
| `leader.prompt` | Yes | string | - | Leader prompt (supports `*.md` file path) |
| `leader.skills` | No | string[] | `[]` | Skills shared with Workers (inherited and injected on spawn) |
| `leader.repos` | No | string[] | `[]` | sparse-checkout allowlist paths (controls which paths worker workspaces can see) |

### 7.3 `teams[].worker`

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `worker.max` | Yes | number(int, >0) | - | Intended max worker count. In the current code, worker count is effectively driven by `tasks.length` |
| `worker.model` | No | string | inherit from `leader.model` | Model used by Worker (can be an alias) |
| `worker.prompt` | Yes | string | - | Worker prompt (supports `*.md` file path) |
| `worker.extra_skills` | No | string[] | `[]` | Extra skills appended on top of leader.skills when dynamically spawning workers |
| `worker.lifecycle` | No | enum | `ephemeral_after_merge_to_main` | Intended cleanup strategy after merging into main (current cleanup logic always executes when the leader completes) |
| `worker.skill_sync` | No | enum | `inherit_and_inject_on_spawn` | Intended skill sync strategy for dynamic spawn (current behavior is “inherit and inject”; `manual` is not fully implemented) |
