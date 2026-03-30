# Agent Team Architecture (Orchestrator + OpenCode)

## 1. Overview: How the declarative team is realized

This project provides a “declarative agent team” workflow: you declare `Admin / Leader / Worker` roles, models, skills, and team branch/workspace strategies in `team.json`; at runtime the Orchestrator reads the config and does the following:

- Start static `Admin` and each Team’s `Leader` (these remain running until a leader finishes and triggers cleanup)
- When a `Leader` needs more “engineer-level executors”, it requests Orchestrator to dynamically create `Worker` agents via tools
- `Worker` works inside its own isolated git worktree workspace, making concrete changes and producing `CHANGELOG.md`
- Orchestrator merges each `Worker` branch back into the corresponding `Leader` branch, and asks `Leader` to summarize the workers’ CHANGELOGs
- After each `Leader` completes aggregation, Orchestrator merges the leader branch into `project.base_branch`, and asks `Admin` for the final delivery summary and report

The relationships can be understood as:

- `Admin`: the project manager (final aggregation & delivery)
- `Leader`: the team lead (breaks down tasks, schedules workers, aggregates results)
- `Worker`: the engineer (executes tasks, submits changes, writes CHANGELOG)

## 2. Component split (code module responsibilities)

### Orchestrator (the orchestration entry)

Orchestrator lives in `src/orchestrator/orchestrator.ts` and is mainly responsible for:

- Computing each agent’s `workspacePath`, ports, models, and skills based on `ResolvedConfig`
- Injecting and starting `Admin` and all `Leader` agents
- Registering Orchestrator HTTP tool routes (so OpenCode tools can call back)
- Writing the OpenCode-required “agent markdown / tools / plugins / meta information” into each workspace (via `workspace-inject`)

At startup, Orchestrator primarily:

1. Generates and starts `Admin` and `Leader` (static agents)
2. Starts an HTTP server and waits for tool callbacks (dynamic worker creation/merge/report are all handled through these endpoints)

### TaskManager (dynamic scheduling and merge back-report)

The dynamic part is handled by `src/orchestrator/task-manager.ts`. Its core responsibilities are:

- Accept `Leader` requests: `POST /tool/request_workers`
- Dynamically create a `Worker` locally for each task (worktree workspace + skill injection + runtime start)
- Accept completion notifications from `Worker`/`Leader`: `POST /tool/notify_complete`
- Perform git merges:
  - `Worker` branch -> `Leader` branch
  - `Leader` branch -> `project.base_branch`
- Ask `Leader`/`Admin` to summarize based on CHANGELOG
- Cleanup (stop runtime + remove workspace)

### RuntimeProvider (how OpenCode processes are started)

The default runtime implementation is `local_process`, implemented in `src/sandbox/local-process.ts`:

- Start a separate `opencode serve --port <agentPort>` process for each agent
- Run the process with the corresponding `workspacePath` as the working directory
- `stop` sends `SIGTERM` to the corresponding process

> Extension point: `RuntimeModeEnum.flue` exists as an enum value in code, but the current implementation focuses on `local_process`.

### WorkspaceProvider (workspace isolation and git worktree management)

Workspace strategy is provided by `src/workspace/workspace-provider.ts` factory. By default it uses `WorktreeWorkspaceProvider`:

- Create a git worktree workspace per agent/branch: directory like `<workspace.root_dir>/<spec.id>`
- Use `sparse-checkout` to reduce large repo footprint (paths are allowed by `team.leader.repos`)
- Optionally execute `git lfs pull`
- Cleanup by `git worktree remove --force` and deleting the directory

> Extension point: `workspace.provider` currently only materializes `worktree`. Other strategies (`shared_clone/full_clone`) remain placeholder implementations in the factory.

### SkillResolver (sync skills into workspace)

Implemented in `src/skills/skill-resolver.ts`:

- Read `skills/<skill-name>/SKILL.md` from the repository root (using `config.project.repo` as repo root)
- Copy each selected skill’s `SKILL.md` into `<workspacePath>/.opencode/skills/<skill-name>/SKILL.md`

### Git + documentation pipeline: MergeManager / ChangelogManager

- `src/git/merge-manager.ts`: performs `merge --no-ff` for `worker->leader` and `leader->main`
- `src/changelog/changelog-manager.ts`: reads `CHANGELOG.md` from the workspace root directory

## 3. Runtime flow (from start to delivery)

Below is the end-to-end “main flow”:

```mermaid
flowchart TD
  U[User] --> CLI[oat start team.json "<goal>" --port PORT]
  CLI --> O[Orchestrator.start()]
  O --> A[Start Admin agent]
  O --> L[Start Leader agent(s)]
  L -->|tool request-workers(tasks[])| O
  O --> W[Create Worker agents dynamically]
  W -->|tool notify-complete(changelog)| O
  O -->|merge worker->leader + prompt leader to summarize| L
  L -->|tool notify-complete(changelog)| O
  O -->|merge leader->main + prompt admin to summarize| A
  O --> C[Cleanup leader/workers workspace & processes]
```

### 3.1 Startup phase: Admin + Leader injection

Orchestrator sets up each static agent:

- Compute ports:
  - `Admin` uses `config.runtime.ports.base`
  - `Leader` uses `base + 1 + index`
- Create workspace (worktree provider)
- Inject skills, tools, plugins, agent markdown, and `.oat/* meta`

Key injection is implemented in `src/opencode/workspace-inject.ts`:

- `writeAgentMarkdown()`: writes `<workspacePath>/.opencode/agents/<agentName>.md`
- `writeCustomTools()`: writes `<workspacePath>/.opencode/tools/*.ts` (including request-workers, notify-complete, etc.)
- `writeCustomPlugins()`: writes `.opencode/plugins/commit-guard.ts` and `scope-guard.ts`
- `writeOatOrchestratorMeta()`: writes `.oat/orchestrator.json` (so tools can discover Orchestrator `baseUrl`)
- `writeOatAgentMeta()`: writes `.oat/agent.json` (role information; worker push allowlist, etc.)

### 3.2 Worker dynamic creation: Leader requests tasks

`Leader` calls a tool named `request-workers` with a payload like:

```json
{ "tasks": [ { "index": 0, "prompt": "..." }, { "index": 1, "prompt": "..." } ] }
```

Orchestrator handles `POST /tool/request_workers` in `TaskManager.requestWorkers()`:

- Uses `tasks.length` as the worker count
- For each task allocates:
  - `workerId = <team.name>-worker-<index>`
  - `branch = <team.branch_prefix>/worker-<index>`
  - `port = allocatePort()` (based on the runtime next available port)
  - `workspacePath = <workspace.root_dir>/<workerId>`
- Create worker workspace: `workspaceProvider.ensureWorkspace(spec, team.leader.repos)`
- Inject skills:
  - worker skills = `leader.skills` + `team.worker.extra_skills`
- Inject worker’s oat meta, agent markdown, and tools/plugins
- Start the `opencode serve` runtime and create an OpenCode session
- Send prompt to worker:
  - the task prompt from `tasks[i].prompt`
  - worker must update `CHANGELOG.md` at the workspace root
  - after finishing, worker must call `notify-complete` and set the `changelog` argument to the prepared CHANGELOG content

### 3.3 Merge + report: worker->leader->admin

When `Worker` calls `POST /tool/notify_complete`:

1. `TaskManager.handleWorkerComplete()`:
   - Read/use the provided `changelog` argument (if not provided, it reads worker workspace’s `CHANGELOG.md`)
   - Execute git merge: `worker.spec.branch -> leader.spec.branch`
   - Use the leader agent’s session to prompt the leader to aggregate the worker’s CHANGELOG into its own CHANGELOG

2. When the `Leader` finally calls `notify-complete`:
   - `TaskManager.handleLeaderComplete()` executes git merge: `leader.spec.branch -> project.base_branch`
   - Reads the leader’s `CHANGELOG.md` (or uses the changelog passed via notify-complete)
   - Prompts `Admin` via its session to produce the final summary including that team’s CHANGELOG
   - Cleanup the leader and its workers’ processes and workspaces (stop + remove)

## 4. Workspace isolation and git strategy

### 4.1 worktree layout

The default workspace provider is `worktree`. Each workspace directory is under:

- `<workspace.root_dir>/<agentId>` (for example: `<team.json dir>/workspaces/frontend-worker-0`)

All agent workspaces come from the same git repository:

- `config.project.repo` defines the git repository root directory
- if `config.project.repo` is relative, it is resolved from the `team.json` directory
- If a workspace does not exist yet, Orchestrator will:
  - for an existing branch: `git worktree add <path> <branch>`
  - for a missing branch: `git worktree add <path> -b <branch>` (create from current HEAD)

### 4.2 sparse-checkout and team repos allowlist

When `workspace.sparse_checkout.enabled=true` and the leader provides `leader.repos`:

- the worker workspace will run:
  - `sparse-checkout init --cone`
  - `sparse-checkout set <leader.repos...>`

This implies:

- `leader.repos` acts as an allowlist for paths the worker can see/modify, rather than “an extra git repository”

### 4.3 LFS strategy

If `workspace.git.lfs=pull`:

- after creating the workspace, it runs `git lfs pull`

If it fails, it logs a warning and continues without blocking Orchestrator.

### 4.4 Submission safety: commit-guard and allowed push range

Worker push restrictions are enforced by the injected plugin:

- `writeCustomPlugins()` writes `commit-guard.ts` into the worker workspace
- default worker `allowedPushPattern`:
  - `.*\/worker-\d+`
- for Admin/Leader: push is allowed by default

Additionally, commit-guard blocks `git add -A` / `git add --all` (encouraging allowlist staging).

> Note: Orchestrator’s final merges rely on local `git merge` (via `MergeManager`), not on forcing workers to push to any remote first.

## 5. Orchestrator tool API (for OpenCode calls)

After Orchestrator starts, it listens on `--port <PORT>` (provided by the CLI) and registers these tool routes:

- `POST /tool/request_workers`
  - Purpose: leader requests worker creation and dispatches tasks
  - Input: `{ "leaderId": "<leaderId>", "tasks": [{ "index": 0, "prompt": "..." }] }`
  - Output: `{ "workerIds": ["<team>-worker-0", ...] }`
- `POST /tool/notify_complete`
  - Purpose: notify orchestrator that an agent completed work (Orchestrator then performs merge + summarization)
  - Input: `{ "agentRole": "worker|leader|admin", "agentId": "<id>", "changelog"?: "<string>" }`
- `POST /tool/report_progress`
  - Purpose: placeholder implementation (currently returns ok)
- `POST /tool/generate_changelog`
  - Purpose: read a workspace’s `CHANGELOG.md` by `agentId`

## 6. Configuration driver points and key defaults

The runtime behavior is primarily bound to these `team.json` fields:

- Roles and prompts:
  - `admin.prompt`, `teams[].leader.prompt`, `teams[].worker.prompt`
  - prompt value can be `*.md` file path (loader reads and substitutes file content)
- Models:
  - top-level `model` provides a global default model
  - model inheritance chain: `worker.model -> leader.model -> admin.model -> model`
  - `models` is used for alias mapping of the final selected model (for example: `default -> anthropic/...`)
  - top-level `providers` provides global provider integration (base_url/key env injection into `opencode serve`)
  - if a model string does not contain `/`, the provider defaults to `anthropic`
- Workspace:
  - `workspace.root_dir` determines where worktrees are created
  - `teams[].leader.repos` determines sparse-checkout paths
- Merge targets:
  - `project.base_branch` determines the leader merge target; only `main` or `master` are allowed

## 7. Current implementation boundaries and extension points

To avoid “documentation promises beyond implementation”, here are the current boundaries:

- `runtime.mode`: currently only implements `local_process`; `flue` is not fully implemented
- `workspace.provider`: currently only implements `worktree`; other strategies are not implemented yet
- `team.worker.total`: worker pool size; workers are pre-created at team startup and stopped/deleted only when the orchestrator exits (`stopAll`)
- `team.worker.lifecycle` / `team.worker.skill_sync`: although schema/loader define default values, the current implementation does not branch on these fields yet (leader completion no longer cleans up the worker pool)

If you want these “configuration intents” to be fully enforced in code, I can help extend `TaskManager` to apply `lifecycle` behavior and `skill_sync` logic.
