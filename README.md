# Open Agent Team (Orchestrator + OpenCode)

This project lets you build a declarative **agent team** with a 3-layer hierarchy:

`Admin -> Leader -> Worker`

You declare roles, models, shared skills, and workspace/git strategies in `team.json`. At runtime, the Orchestrator starts static agents (`Admin`, all `Leader`s) and dynamically spawns `Worker`s when a `Leader` requests them. Each `Worker` must update a `CHANGELOG.md`, which is merged upward:

`Worker CHANGELOG` -> `Leader CHANGELOG` -> final `Admin` summary.

## Key concepts

### Declarative configuration (`team.json`)shii

- `team.json` defines:
  - global default model (`model`, optional)
  - global provider integration (`providers`, optional)
  - project metadata (`project`)
  - model alias mapping (`models`)
  - `Admin` agent config (`admin`)
  - team configs (`teams[]`: `Leader` + `Worker`)
- If `admin.prompt` / `leader.prompt` / `worker.prompt` ends with `.md`, the loader treats it as a file path and loads the file content as prompt text.
- Model inheritance chain: `worker.model -> leader.model -> admin.model -> model` (you can override at any level).

See the detailed field reference: `oat docs config --lang en`.

### Isolated workspaces (git worktree)

By default, each agent runs in an isolated workspace created via `git worktree`, under:

- `workspace.root_dir` (default: `<team.json dir>/workspaces`)

For large repos, sparse-checkout can be enabled; worker sparse-checkout paths come from `teams[].leader.repos`.

### Skills sharing & injection

Skills follow the OpenCode `SKILL.md` convention:

- Source: `skills/<skill-name>/SKILL.md` at the repo root (`project.repo`; if relative, resolved from the `team.json` directory)
- Injected into each agent workspace at: `.opencode/skills/<skill-name>/SKILL.md`

### CHANGELOG-driven collaboration

When a `Worker` is created, the orchestrator injects a system constraint into the worker prompt:

- create/update `CHANGELOG.md` at the workspace root (even if there are no code changes)
- call `notify-complete` and pass the prepared `CHANGELOG.md` content

## Quick start

### 1) Prepare skills

In the repository root resolved from `project.repo`, create:

`skills/<skill-name>/SKILL.md`

### 2) Create `team.json`

Refer to:

- `docs/en/guide.md` (minimal example + run steps)
- `docs/en/config.md` (field-by-field reference)

### 3) Start Orchestrator

```bash
oat start team.json "<goal>" --port 3100
```

Choose output/docs language:

```bash
oat start team.json "<goal>" --port 3100 --lang zh-CN
```

### 4) Useful commands

```bash
oat status
oat stop
oat docs architecture --lang en
oat docs config --lang en
oat docs guide --lang en
```

## How collaboration works (high level)

1. Orchestrator injects skills/tools/plugins and starts `Admin` and each `Leader`.
2. A `Leader` calls the tool `request-workers` with a list of `tasks`.
3. Orchestrator spawns one `Worker` per task:
   - creates/ensures a git worktree workspace
   - injects leader skills + `worker.extra_skills`
   - starts `opencode serve` and sends the task prompt
4. A `Worker` must:
   - update `CHANGELOG.md` at the workspace root
   - call `notify-complete` with the prepared `CHANGELOG.md` content
5. Orchestrator merges `Worker -> Leader`, asks `Leader` to summarize, then merges `Leader -> project.base_branch`.
6. Orchestrator cleans up the leader and its workers (processes + workspaces).

## Current implementation notes (aligned with code)

- Runtime mode: `local_process` is implemented (Orchestrator starts multiple `opencode serve` processes on different ports).
- Workspaces: `worktree` provider is implemented; other providers are placeholders.
- Worker count intent (`teams[].worker.max`) and lifecycle fields are currently not enforced as strict runtime limits in the dynamic worker logic (workers are cleaned up after a leader completes).

## Other languages

- `README.en.md`
- `README.zh-CN.md`
- `README.fr.md`
- `README.ja.md`

## LICENSE

MIT &copy; Herbert He
