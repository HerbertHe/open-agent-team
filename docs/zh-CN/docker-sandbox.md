# Docker 任务运行环境

设置 `runtime.mode: "docker"` 后，每个 Admin、Leader、Worker 会话在独立容器中运行；任务队列、Git 分支、review request 与发布审批仍由宿主 Orchestrator 管理。

迁移是单向的：项目可以从 `local_process` 迁移到 `docker`，但之后不能降级回进程隔离。OAT 会把该策略持久化到 `.oat/runtime-policy.json`，手工修改 `team.json` 也不能绕过。

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

镜像必须提供 Node.js 22 或兼容版本，以及项目执行所需工具。容器只挂载当前 Agent 的 Git worktree 到 `/workspace`；OAT runtime 和 pi 数据只读挂载。工具调用通过 JSONL stdio 回传宿主，仍由 Orchestrator 执行。

- 默认 `network` 为 `bridge`，可访问远程模型 API；本地模型或离线任务可用 `none`。
- `OPENAI_*` 和 `ANTHROPIC_*` 仅在宿主已配置时透传。
- `extra_args` 仅允许 CPU、内存、PID、ulimit、`/tmp` tmpfs、只读、`cap-drop=ALL` 和 `no-new-privileges`；挂载、环境变量、privileged、设备、namespace 和 Docker socket 参数均会被拒绝。
- 禁止挂载 Docker socket、宿主 home 或项目主仓库；仅允许 OAT 提供任务 worktree。
- 每个 session 使用 `docker run --rm -i`；会话重置或任务切换时重建容器，Git 与 review 工件仍保存在宿主 `state_dir/git-collaboration/`。
- 容器具有稳定的 OAT 名称和项目/Agent/角色标签。Desktop 可查看 Engine 状态、容器清单、受限日志，并安全重启空闲 Agent session。
