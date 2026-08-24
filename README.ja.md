# オープンエージェントチーム

<p align="center">
  <img src="./logo/logo.svg" width="200" alt="Open Agent Team Logo" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/open-agent-team"><img src="https://img.shields.io/npm/v/open-agent-team?style=flat-square" alt="NPM Version" /></a>
  <a href="https://www.npmjs.com/package/open-agent-team"><img src="https://img.shields.io/npm/dt/open-agent-team?style=flat-square" alt="NPM Downloads" /></a>
</p>


本プロジェクトは、宣言的な **agent team** を次の 3 層構造で構築できるようにします：

`Admin -> Leader -> Worker`

`team.json` でロール、モデル、共有スキル、workspace/git の方針を宣言します。実行時、Orchestrator は全てのエージェント（`Admin`、`Leader`、および事前生成された `Worker` プール）を起動し、`Leader` が `Worker` にタスクを分配します。各 `Worker` は `CHANGELOG.md` を更新し、その内容は上位へ次のように集約されます：

`Worker CHANGELOG` -> `Leader CHANGELOG` -> 最終的な `Admin` のサマリー。全てのロール（Admin、Leader、Worker）は、それぞれの `CHANGELOG.md` を**追記（APPEND）**方式で更新するよう厳格に指示されます。

## クイックスタート

### 1. インストール

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

### 2. `team.json` を作成

プロジェクトルートに `team.json` を作成します（完全な例は [team.example.json](./team.example.json) を参照）：

```bash
oat init
```

### 3. チームを起動

```bash
oat start team.json
```

### 4. OAT Desktop を開く

Desktop でプロジェクト、タスク、リアルタイム監視、設定、使用量、成果、プラグイン、チャネル、Git 配信、Docker ランタイムを管理します。

## 重要な概念

### 宣言的な設定（`team.json`）

- `team.json` は以下を定義します：
  - 全体のデフォルトモデル（`model`、任意）
  - グローバルなプロバイダ接続設定（`providers`、任意）
  - プロジェクトメタ情報（`project`；`project.base_branch` は `main` または `master` のみ、既定は `main`）
  - モデル alias のマッピング（`models`）
  - `Admin` agent の設定（`admin`）
  - チームごとの設定（`teams[]`: `Leader` + `Worker`）
- `admin.prompt` / `leader.prompt` / `worker.prompt` が `.md` で終わる場合、loader はファイルパスとして扱い、ファイル内容を prompt テキストとして読み込みます。
- モデル継承チェーン：`worker.model -> leader.model -> admin.model -> model`（どの階層でも上書き可能）。

詳細なフィールド参照：`oat docs config --lang ja`。

### 隔離された workspace（git worktree）

デフォルトでは各 agent は `git worktree` を使って隔離された workspace 上で動作し、作成先は：

- `workspace.root_dir`（デフォルト：`<team.json のディレクトリ>/workspaces`）

大規模リポジトリでは sparse-checkout を有効にできます。worker 側の sparse-checkout paths は `teams[].leader.repos` から取得します。

### スキル管理（`npx skills`）

スキルは [`npx skills`](https://github.com/vercel-labs/skills) で管理し、`team.json` で `SkillEntry` オブジェクトとして宣言します：

- 各 entry は `source`（GitHub リポジトリ、URL、ローカルパス）と任意の `names` フィルタを指定
- 起動時に OAT は各 entry に `npx skills add` を実行し、`<workspace>/skills/` にインストール
- pi-coding-agent 互換のため `.pi/skills` シンボリックリンクを作成

### CHANGELOG に基づく協業

エージェントを初期化する際、Orchestrator はシステム制約を注入します：

- すべてのロール（Admin、Leader、Worker）は、workspace ルートの `CHANGELOG.md` に**追記**で更新する必要があります（コード変更が無い場合でも理由を記録します）。
- 日常の中間出力（ノート、ドラフト、ログなど）はすべて `.oat/workspaces/<agentId>/records/<date>/` の下に保存する必要があります。
- Worker と Leader は `notify-complete` を呼び、用意した `CHANGELOG.md` の内容を上位へ伝えるために渡します。

## クイックスタート

### 1) skills を設定（任意）

`team.json` で `SkillEntry` 形式で skill ソースを宣言します：

```json
"skills": [{ "source": "vercel-labs/agent-skills", "names": ["frontend-design"] }]
```

### 2) `team.json` を作成

参照：

- `docs/ja/guide.md`（例 + 起動手順）
- `docs/ja/config.md`（フィールド参照）

### 3) Orchestrator を起動

```bash
oat start team.json [goal]
```


言語指定：

```bash
oat start team.json [goal] --lang zh-CN
```

**OAT Desktop** はリアルタイム監視、プロジェクト設定編集、グローバル設定、複数プロジェクト管理、タスク操作、各 Agent の作業記録と `CHANGELOG.md` 成果閲覧を提供します。

### 4) よく使うコマンド

```bash
oat list
oat stop
oat docs architecture --lang ja
oat docs config --lang ja
oat docs guide --lang ja
```

## 協業の流れ（概要）

1. Orchestrator は `npx skills add` でスキルをインストールし、`Admin`、各 `Leader`、および `Worker` プール（size = `teams[].worker.total`）を事前生成します。
2. `Leader` は `tasks` のリストを含めて `dispatch-worker-tasks` ツールを呼び出します。
3. Orchestrator は、事前生成された `Worker` プールにタスクを送信します：
   - 対象 worker に接続
   - タスク prompt を送信
4. `Worker` は：
   - workspace ルートの `CHANGELOG.md` に追記
   - `notify-complete` を呼び、用意した `CHANGELOG.md` を渡す
5. Orchestrator は全ての変更を自動コミット（`git add -A && git commit`）し、`Worker -> Leader` をマージ、`Leader` に要約させた後 `Leader -> project.base_branch` をマージします。
6. 各 agent の git コミットには固有のローカルアイデンティティが付与されます（例：`worker-0-teamName@project-projectName.oat`）。
7. Orchestrator は worker プールを shutdown まで保持します。オーケストレーター終了時の `stopAll` のみがプロセスを停止/破棄します。

## 現在の実装要点（コードに合わせて）

- runtime mode：`local_process` が実装済み（異なるポートで複数のエージェントプロセスを起動）
- workspaces：`worktree` provider が実装済み。他 provider は placeholder です。
- `teams[].worker.total` の worker プールサイズは起動時の事前作成で反映されます。leader 完了後も worker はクリーンアップされず、オーケストレーター終了時にのみ破棄されます。

## プッシュチャネル通知と OpenClaw プラグイン

OAT は、タスクの進捗、エージェントのクラッシュ、および最終成果を外部のチャットチャネル（例：Slack、Discord、WeChat）に送信することをサポートしており、OpenClaw プラグインエコシステムと完全に互換性があります。

### 1) 設定ファイル (`~/.oat/oat.json`)
すべてのグローバル設定は、`~/.oat/oat.json` に標準 JSON 形式でネイティブに保存されます。チャネルの一般的な設定構造は以下の通りです：

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

タスクマネージャのプッシュ通知をチャネルにルーティングするには、`team.json` 内の `admin.push_channel` でターゲットを宣言します：
```json
"admin": {
  "name": "AdminAgent",
  "push_channel": {
    "channel": "openclaw-slack",
    "account": "team-slack"
  }
}
```

### 2) CLI コマンド
互換プラグインとアカウントをターミナルから直接管理します：

- `oat channels` - ロードされたすべてのプラグイン、設定されたアカウント、およびアクティブな WeChat セッションを表示します。
- `oat channel login <channelId> <accountId>` - 状態を持つチャネル（例：WeChat）用の、ターミナル内インタラクティブ ASCII QR コードスキャナー設定と認証情報の保存：
  ```bash
  oat channel login weixin my-wechat
  ```
- `oat plugins install <packageName>` - NPM から OpenClaw 互換のプラグインをダウンロードし、動的にホットインストールします：
  ```bash
  oat plugins install @tencent-weixin/openclaw-weixin
  ```
- `oat plugins uninstall <pluginId>` - プラグインをディスクから物理的に削除し、キャッシュされたセッションと認証情報を消去します。

### 3) ビジュアルプラグインセンター (Web ダッシュボード)
OAT の Web ダッシュボードには、美しいグラスモフィズム風の **プラグインセンター** (`/plugins`) ページが含まれており、視覚的に以下の操作が行えます：
- インストールされているプラグインとアクティブなアカウントのステータスカードを表示。
- NPM パッケージ名を入力して、ワンクリックでプラグインを動的にホットインストール。
- プラグインの構成スキーマ (`configSchema`) から直接コンパイルされたフォームフィールドを介して、アカウント設定を動的に追加・編集。
- CLI ターミナルで WeChat インタラクティブ QR コードをスキャンするユーザーガイドの表示。

## 謝辞


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
