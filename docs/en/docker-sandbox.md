# Docker task runtime

With `runtime.mode: "docker"`, every Admin, Leader, and Worker session runs in its own container. The host Orchestrator continues to manage the task queue, Git branches, review requests, and release approval.

Migration is one-way: a project may move from `local_process` to `docker`, but cannot later return to process isolation. OAT persists this policy under `.oat/runtime-policy.json`, so editing `team.json` manually does not bypass it.

```json
"runtime": {
  "mode": "docker",
  "docker": {
    "image": "node:22-bookworm",
    "network": "bridge",
    "extra_args": ["--cpus=2", "--memory=4g"]
  },
  "persistence": { "state_dir": ".oat/state" }
}
```

The image must provide Node.js 22, or a compatible version, and the tools needed by the project. Only the current Agent's Git worktree is mounted read/write at `/workspace`; the OAT runtime and pi data are mounted read-only. Tool calls are returned to the host through JSONL stdio and are still executed by the Orchestrator.

- The default network is `bridge`; use `none` for offline work or a local model.
- `OPENAI_*` and `ANTHROPIC_*` variables are forwarded only when they exist on the host.
- `extra_args` accepts only CPU, memory, PID, ulimit, `/tmp` tmpfs, read-only, `cap-drop=ALL`, and `no-new-privileges` options. Mount, environment, privilege, device, namespace, and Docker-socket options are rejected.
- Never mount the Docker socket, the host home directory, or the main repository. Only the OAT-provided task worktree is allowed.
- A session uses `docker run --rm -i` and is recreated when it is reset or switches tasks. Git and review artifacts remain on the host under `state_dir/git-collaboration/`.
- Containers receive stable OAT names and project/Agent/role labels. Desktop can inspect Engine status, list containers, read bounded logs, and safely restart an idle Agent session.
