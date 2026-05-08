# クイックスタートガイド

このガイドではローカル環境で、宣言的な `Admin -> Leader -> Worker` の agent 管理構造を最小ステップで動かす方法を説明します。

## 1. skills を設定（任意）

Skills は [`npx skills`](https://github.com/vercel-labs/skills) で管理されます。`team.json` で `SkillEntry` 形式で skill ソースを宣言すると、OAT が起動時に各 agent の workspace に自動インストールします。

各 `SkillEntry` には：
- `source`：skill ソース（GitHub shorthand `vercel-labs/agent-skills`、完全な URL、またはローカルパス）
- `names`（任意）：インストールする特定の skill 名。省略または `["*"]` で全てインストール

`team.json` での例：
```json
"skills": [
  { "source": "vercel-labs/agent-skills", "names": ["frontend-design"] },
  { "source": "./my-local-skills" }
]
```

起動時に OAT は各 entry に対して `npx skills add` を実行し、`<workspace>/skills/` にインストールし、pi-coding-agent 互換のため `.pi/skills` シンボリックリンクを作成します。agent は自身の workspace から自動的に skills を読み込みます。

> ヒント：skills なしでも開始できます。設定で `"skills": []` のままにしてください。

## 2. Git リポジトリとブランチを準備（推奨）

このプロジェクトは `project.base_branch`（デフォルト `main`；指定できるのは `main` または `master` のみ）へマージし、各 agent のために git worktree workspace を作成します。

開始前に確認：

- `team.json -> project.repo` は git リポジトリを指していること（通常 `.`）
- `project.repo` が相対パスなら `team.json` のディレクトリ基準で解決されること
- リポジトリに `project.base_branch` で指定したブランチが存在すること（`main` または `master`、設定と一致）
- リポジトリが `git worktree` をサポートしていること

## 3. `team.json` を作成（コア）

`team.json` はどこに置いてもよいですが、管理しやすいようリポジトリのルートに置くのがおすすめです。

以下は「最小スケルトン」例です（モデルと prompt は自分の内容に置き換えてください）：

```json
{
  "model": "default",
  "project": { "name": "open-agent-team-demo", "repo": ".", "base_branch": "main" },
  "models": { "default": "openai/gpt-4o-mini" },
  "providers": { "openai": { "compatible_type": "openai", "base_url": "https://api.openai.com/v1", "api_key": "sk-..." } },
  "admin": {
    "name": "admin",
    "description": "最終集約と納品を担当するプロジェクトマネージャ",
    "model": "default",
    "prompt": "You are the project manager (Admin).\\nYour job is to summarize the final delivery and review team changelogs.",
    "skills": []
  },
  "teams": [
    {
      "name": "frontend",
      "branch_prefix": "team/frontend",
      "leader": {
        "name": "frontend-lead",
        "description": "フロントリード。タスクを分解し worker に実行を依頼する",
        "model": "default",
        "prompt": "You are the Leader agent for the frontend team.",
        "skills": [],
        "repos": ["src/", "package.json"]
      },
      "worker": {
        "total": 3,
        "model": "default",
        "prompt": "You are a Worker engineer.",
        "extra_skills": []
      }
    }
  ]
}
```

最低限、次を満たしてください：

- `admin.prompt`、`leader.prompt`、`worker.prompt` が空でないこと（または `*.md` のファイルパス形式）
- モデル継承を理解しておくこと：`worker.model -> leader.model -> admin.model -> model`（トップレベル `model` のみ定義し、必要箇所だけ上書き可能）
- `teams[]` に少なくとも 1 つのチームが入っていること
- `leader.repos` に worker が重点的に扱うパスを指定すること（sparse-checkout の allowlist に対応）

## 4. Orchestrator を起動

実行：

```bash
oat start team.json "<goal>" --port 3100
```

- `--port`：Orchestrator の HTTP ポート（ツールコールバックで使われます）
- `<goal>`：最終的に達成したいゴール（Leader の prompt に注入されます）

出力/ログの言語を指定する場合：

```bash
oat start team.json "<goal>" --port 3100 --lang zh-CN
```

## 5. 実行結果で確認すること

よくある確認ポイント：

- Orchestrator が起動し、指定したポートで listen していること
- worker の workspace が `workspace.root_dir` 配下に出現すること（デフォルト `<team.json のディレクトリ>/workspaces/<agentId>`）
- worker が完了すると workspace ルートの `CHANGELOG.md` を更新すること
- worker のブランチが該当する leader ブランチにマージされること
- leader が `project.base_branch` にマージされた後、Orchestrator がその leader と workers をクリーンアップ（プロセス + workspace）

## 6. 状態確認 / 停止

orchestrator 状態を確認（`state_dir` 配下の `orchestrator.json`）：

```bash
oat status
```

引数を省略した場合、現在ディレクトリの `team.json` から `state_dir`（同階層の `.oat/state`）を推定します。`team.json` が見つからない場合はエラーになります。

停止（orchestrator の pid に SIGTERM を送る）：

```bash
oat stop
```

## 7. ドキュメント表示（多言語）

CLI で doc を出力できます。例えば：

```bash
oat docs guide --lang fr
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
```
