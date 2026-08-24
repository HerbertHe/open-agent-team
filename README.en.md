# Open Agent Team

<p align="center">
  <img src="./logo/logo.svg" width="200" alt="Open Agent Team Logo" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/open-agent-team"><img src="https://img.shields.io/npm/v/open-agent-team?style=flat-square" alt="NPM Version" /></a>
  <a href="https://www.npmjs.com/package/open-agent-team"><img src="https://img.shields.io/npm/dt/open-agent-team?style=flat-square" alt="NPM Downloads" /></a>
</p>


This project lets you build a declarative **agent team** with a 3-layer hierarchy:

`Admin -> Leader -> Worker`

You declare roles, models, shared skills, and workspace/git strategies in `team.json`. Admin governs project work, Leaders review and integrate Worker branches, and Workers deliver self-tested short-lived Git branches. A Worker never merges directly: it submits a persisted review request; only an Admin-approved, serialized MergeController updates `main`/`master`.

See the [Git collaboration workflow](docs/en/git-collaboration.md) for branch naming, review, release approval, artifact manifests, and runtime-file isolation.

## Quick Start

### 1. Install

**Via One-liner Script (Recommended):**

**macOS & Linux:**
```bash
curl -fsSL https://oat.ibert.me/install.sh | bash
```

**Windows:**
```powershell
powershell -c "irm https://oat.ibert.me/install.ps1 | iex"
```

**Via NPM:**

```bash
npm i open-agent-team -g
```

### 2. Create `team.json`

Create a `team.json` in your project root (see [team.example.json](./team.example.json) for a full example):

```bash
oat init
```

### 3. Start your team

```bash
oat start team.json
```

### 4. Open OAT Desktop

Use the Desktop application for project management, task operations, observability, configuration, usage, achievements, plugins, channels, Git delivery, and Docker runtime management.

## Key concepts

### Declarative configuration (`team.json`)

- `team.json` defines:
  - global default model (`model`, optional)
  - global provider integration (`providers`, optional)
  - project metadata (`project`; `project.base_branch` must be `main` or `master`, default `main`)
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

### Skills management (`npx skills`)

Skills are managed via [`npx skills`](https://github.com/vercel-labs/skills) and declared in `team.json` as `SkillEntry` objects:

- Each entry specifies a `source` (GitHub repo, URL, or local path) and optional `names` filter
- On startup, OAT runs `npx skills add` for each entry and installs skills into `<workspace>/skills/`
- A `.pi/skills` symlink is created for pi-coding-agent compatibility

### Git-reviewed collaboration

When initializing agents, the Orchestrator injects system constraints:

- `CHANGELOG.md` is human-readable delivery evidence, not the collaboration bus.
- Workers call `submit-review` after implementation and self-tests; requests record branch, commit, changed files, tests, and artifact paths.
- Leaders explicitly review and integrate approved branches; Admin approves/rejects release proposals before MergeController updates `main`/`master`.
- Runtime files are stored below `<runtime.persistence.state_dir>/git-collaboration/`, outside Git worktrees.

## Quick start

### 1) Configure skills (optional)

Declare skill sources in `team.json` using the `SkillEntry` format:

```json
"skills": [{ "source": "vercel-labs/agent-skills", "names": ["frontend-design"] }]
```

### 2) Create `team.json`

Refer to:

- `docs/en/guide.md` (minimal example + run steps)
- `docs/en/config.md` (field-by-field reference)

### 3) Start Orchestrator

```bash
oat start team.json [goal]
```


Choose output/docs language:

```bash
oat start team.json [goal] --lang zh-CN
```

**OAT Desktop** provides real-time observability, project configuration editing, global settings, multi-project management, task operations, and Project Achievements for browsing daily work records and `CHANGELOG.md` history.

### 4) Useful commands

```bash
oat list
oat stop
oat docs architecture --lang en
oat docs config --lang en
oat docs guide --lang en
```

## How collaboration works (high level)

1. Orchestrator installs skills via `npx skills add`, starts `Admin`, each `Leader`, and pre-spawns a `Worker` pool (size = `teams[].worker.total`).
2. A `Leader` calls the tool `dispatch-worker-tasks` with a list of `tasks`.
3. Orchestrator dispatches tasks to the pre-spawned `Worker` pool:
   - connects to the target worker
   - sends the task prompt
4. Each Worker creates a task-specific branch from a pinned `main`/`master` SHA, self-tests, commits only Git-reported changes, and calls `submit-review`.
5. Leaders review before merging to an integration branch; rejected reviews create a new attempt.
6. Leaders submit release proposals with artifact paths; Admin approval invokes the serialized MergeController.
7. Task worktrees and manifests are stored under `state_dir/git-collaboration/`.

## Current implementation notes (aligned with code)

- Runtime mode: `local_process` is implemented (Orchestrator starts multiple agent processes on different ports).
- Workspaces: `worktree` provider is implemented; other providers are placeholders.
- Worker pool size intent (`teams[].worker.total`) is enforced by pre-spawning workers at team startup; workers are not cleaned up after a leader completes (only on orchestrator shutdown).

## Push Channel Notification & OpenClaw Plugins

OAT supports sending task progress, agent crashes, and final achievements to external chat channels (e.g. Slack, Discord, WeChat), fully compatible with the OpenClaw plugin ecosystem.

### 1) Configuration File (`~/.oat/oat.json`)
All global settings are natively stored in standard JSON at `~/.oat/oat.json`. A typical structure for channels is:

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

To route task manager push notifications to a channel, declare the target in `team.json` under `admin.push_channel`:
```json
"admin": {
  "name": "AdminAgent",
  "push_channel": {
    "channel": "openclaw-slack",
    "account": "team-slack"
  }
}
```

### 2) CLI Commands
Manage compatibility plugins and accounts directly from the terminal:

- `oat channels` - View all loaded plugins, configured accounts, and active WeChat sessions.
- `oat channel login <channelId> <accountId>` - Guideline/interactive ASCII QR scanner setup for stateful channels (e.g., WeChat):
  ```bash
  oat channel login weixin my-wechat
  ```
- `oat plugins install <packageName>` - Download and hot-install an OpenClaw-compatible plugin from NPM:
  ```bash
  oat plugins install @tencent-weixin/openclaw-weixin
  ```
- `oat plugins uninstall <pluginId>` - Remove a plugin physically from disk, wiping its cached sessions and credentials.

### 3) Visual Plugin Center (Desktop)
OAT Desktop includes a native **Plugin Center** to:
- View status cards of installed plugins and active accounts.
- Enter NPM package names to download and hot-install plugins dynamically in one click.
- Configure new accounts dynamically via visual form fields compiled directly from the plugin's configuration schema (`configSchema`).
- Guide users on scanning WeChat interactive QR codes in their CLI terminals.

## Acknowledgments


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
