# Docker タスク実行環境

`runtime.mode: "docker"` を設定すると、各 Admin、Leader、Worker セッションは独立したコンテナで動作します。タスクキュー、Git ブランチ、レビュー依頼、リリース承認はホスト上の Orchestrator が引き続き管理します。

移行は一方向です。`local_process` から `docker` へ移行できますが、Docker 化したプロジェクトをプロセス分離へ戻すことはできません。この方針は `.oat/runtime-policy.json` に保存されます。

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

イメージには Node.js 22 または互換バージョンと、プロジェクトが必要とするツールを含める必要があります。現在の Agent の Git worktree だけが `/workspace` に読み書き可能でマウントされ、OAT runtime と pi データは読み取り専用です。ツール呼び出しは JSONL stdio 経由でホストに戻り、Orchestrator が実行します。

- 既定のネットワークは `bridge` です。オフライン作業やローカルモデルには `none` を使います。
- `OPENAI_*` と `ANTHROPIC_*` はホストに設定されている場合だけ渡されます。
- `extra_args` は CPU、メモリ、PID、ulimit、`/tmp` tmpfs、読み取り専用、`cap-drop=ALL`、`no-new-privileges` のみに制限されます。mount、privileged、device、Docker socket は拒否されます。
- Docker socket、ホストの home、プロジェクトの主リポジトリをマウントしないでください。OAT が提供するタスク worktree のみ許可されます。
- 各セッションは `docker run --rm -i` を使い、リセットやタスク切替時に再作成されます。Git とレビューの証拠はホストの `state_dir/git-collaboration/` に残ります。
- Desktop で Engine 状態、OAT コンテナ、制限付きログを表示し、待機中 Agent を安全に再起動できます。
