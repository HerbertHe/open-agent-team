# Git collaboration and delivery workflow

OAT uses Git as the sole code-collaboration boundary. The Admin owns the control plane, the Leader owns review and integration, and Workers deliver only short-lived, verifiable branches.

## Workflow

1. The Admin assigns a WorkItem to a Leader.
2. The Leader delegates only genuinely independent implementation work to Workers. Conflicting work is queued or split again.
3. For every task, a Worker creates `oat/<team>/<taskId>/attempt-<n>` from the `main`/`master` SHA fixed when the task was created.
4. The Worker implements and self-tests, commits, then calls `submit-review`. The request records the commit, changed files, tests, and artifact paths; it merges nothing.
5. The Leader uses `list-review-requests`, verifies the evidence, and uses `review-worker-branch` either to approve integration into `oat/<team>/<workItem>/integration` or to request changes.
6. After integration tests pass, the Leader calls `submit-release-proposal`.
7. The Admin accepts or rejects with `approve-release`. When accepted, the MergeController serializes the operation with a global lock and atomically updates `main`/`master` through Git `update-ref`.
8. Remote publication is optional. With `workspace.git.push_enabled`, identity, and remote configured, Admin explicitly calls `push-release`. It performs a non-force push only for the current merged release.

If the production branch has changed, release fails without overwriting the newer commit.

Every Agent worktree has push URLs disabled. Agent subprocesses do not inherit Git/SSH credential variables. The only supported remote-write path is the role-checked Admin tool running in the Orchestrator against the main repository.

## Task queue and conflict avoidance

Every agent has its own FIFO queue. Task creation first checks queued work, `conflictKey`, and declared resources. A Leader must not assign multiple Workers work that modifies the same files, APIs, migrations, or tests. Workers never replace a busy Worker or a Leader; they wait for their turn.

## Artifacts and temporary files

Runtime artifacts are kept outside worktrees in `<runtime.persistence.state_dir>/git-collaboration/`:

- `tasks/`: branch, base SHA, test evidence, and changed files;
- `reviews/`: review requests and Leader decisions;
- `releases/`: Admin decisions and merge commits;
- `worktrees/`: temporary Worker, Leader, and MergeController worktrees.

Task worktrees contain only source code, tests, and intentionally versioned documentation. Logs, Agent metadata, drafts, and session files must never become Git artifacts.

## API

- `GET /tasks`, `POST /tasks`, `PATCH /tasks/:id`, `DELETE /tasks/:id`
- `GET /reviews?leaderId=<id>` and `POST /reviews/<id>`
- `GET /releases` and `POST /releases/<id>/approval`
- `GET /git/status` and `PUT /git/config` (there is deliberately no generic HTTP push endpoint)

Upward reports refer to `artifactPath`, branch, base/head SHA, `changedFiles`, and `tests`, instead of copying a complete work log.
