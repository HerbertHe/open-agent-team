# クイックスタートガイド

このガイドではローカル環境で、宣言的な `Admin -> Leader -> Worker` の agent 管理構造を最小ステップで動かす方法を説明します。

## 1. インストール

**ワンライナースクリプトによるインストール (推奨):**

**macOS & Linux:**
```bash
curl -fsSL https://oat.ibert.me/install.sh | bash
```

**Windows:**
```powershell
powershell -c "irm https://oat.ibert.me/install.ps1 | iex"
```

**NPM を使用したインストール:**

```bash
npm i open-agent-team -g
```

これにより `oat` CLI がグローバルにインストールされます。以下のコマンドでインストールを確認できます：

```bash
oat --help
```

## 2. skills を設定（任意）

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
oat start team.json [goal]
```

- `[goal]`：最終的に達成したいゴール（Leader の prompt に注入されます）

出力/ログの言語を指定する場合：

```bash
oat start team.json [goal] --lang zh-CN
```

起動時、OAT は `~/.oat/projects/` にプロジェクトディレクトリへのシンボリックリンクを作成し、マルチプロジェクト管理を可能にします。

## 5. ダッシュボードの使用

OAT には Web ダッシュボードが組み込まれており、Orchestrator 起動後に自動で利用可能になります。ブラウザで `http://localhost:<port>` を開いてください。

Orchestratorを起動せずに、ダッシュボードのみを単独で起動することもできます：

```bash
oat dashboard
```

このコマンドはローカルの静的サーバーを起動し、デフォルトブラウザで自動的にダッシュボードを開きます。

ダッシュボードには以下のページがあります：

- **ダッシュボード**：プロジェクト情報の概要、実行中のプロジェクト一覧（削除操作付き）
- **プロジェクト状態**：リアルタイム SSE イベントストリーム、Agent トポロジーグラフ、進捗レポート。異なるプロジェクトインスタンス間の切り替えに対応
- **プロジェクト設定**：プロジェクトの `team.json` をオンラインで編集。Shiki によるシンタックスハイライト付き JSON プレビュー。保存すると自動的にプロジェクトが再起動されます
- **設定**：ログ保持日数などのグローバル設定

### マルチプロジェクト対応

ダッシュボードは複数の実行中プロジェクトを同時に管理できます。「プロジェクト状態」と「プロジェクト設定」ページでプロジェクトセレクターを使って切り替えます。表示形式は `設定名 (プロジェクトID)` です。

## 6. 実行結果で確認すること

よくある確認ポイント：

- Orchestrator が起動し、自動割り当てまたは指定されたポートで listen していること
- worker の workspace が `workspace.root_dir` 配下に出現すること（デフォルト `<team.json のディレクトリ>/workspaces/<agentId>`）
- worker が完了すると workspace ルートの `CHANGELOG.md` を更新すること
- worker のブランチが該当する leader ブランチにマージされること
- leader が `project.base_branch` にマージされた後、Orchestrator がその leader と workers をクリーンアップ（プロセス + workspace）

## 7. 状態確認 / 停止

orchestrator 状態を確認（`state_dir` 配下の `orchestrator.json`）：

```bash
oat list
```

引数を省略した場合、現在ディレクトリの `team.json` から `state_dir`（同階層の `.oat/state`）を推定します。`team.json` が見つからない場合はエラーになります。

停止（orchestrator の pid に SIGTERM を送る）：

```bash
oat stop
```

## 8. REST API リファレンス

Orchestrator は以下の管理 API を提供します：

| メソッド | パス | 説明 |
|----------|------|------|
| GET | `/api/projects` | 登録済みプロジェクト一覧 |
| DELETE | `/api/projects/:name` | プロジェクトを削除（停止済みが必要） |
| GET | `/api/projects/:name/config` | プロジェクトの team.json を読み取り |
| PUT | `/api/projects/:name/config` | プロジェクトの team.json を更新 |
| POST | `/api/projects/:name/restart` | プロジェクトを再起動 |
| GET | `/api/team-config` | 現在のプロジェクトの team.json を読み取り |
| PUT | `/api/team-config` | 現在のプロジェクトの team.json を更新 |
| GET | `/api/global-config` | グローバル設定 (oat.yaml) を読み取り |
| PUT | `/api/global-config` | グローバル設定を更新 |

## 9. ドキュメント表示（多言語）

CLI で doc を出力できます。例えば：

```bash
oat docs guide --lang fr
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
```

