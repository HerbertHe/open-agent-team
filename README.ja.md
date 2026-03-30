# オープンエージェントチーム（Orchestrator + OpenCode）

本プロジェクトは、宣言的な **agent team** を次の 3 層構造で構築できるようにします：

`Admin -> Leader -> Worker`

`team.json` でロール、モデル、共有スキル、workspace/git の方針を宣言します。実行時、Orchestrator は静的エージェント（`Admin` と全ての `Leader`）を起動し、`Leader` の要求に応じて `Worker` を動的に生成します。各 `Worker` は `CHANGELOG.md` を更新し、その内容は上位へ次のように集約されます：

`Worker CHANGELOG` -> `Leader CHANGELOG` -> 最終的な `Admin` のサマリー。

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

### スキル共有と注入

スキルは OpenCode の `SKILL.md` 規約に従います：

- 元データ：リポジトリルート（`project.repo`。相対パスの場合は `team.json` のディレクトリ基準で解決）配下の `skills/<skill-name>/SKILL.md`
- 各 workspace への注入先：`.opencode/skills/<skill-name>/SKILL.md`

### CHANGELOG に基づく協業

`Worker` が生成されるとき、Orchestrator は worker の prompt にシステム制約を注入します：

- workspace ルートの `CHANGELOG.md` を作成/更新（コード変更が無くても必須）
- `notify-complete` を呼び、用意した `CHANGELOG.md` の内容を渡す

## クイックスタート

### 1) skills を準備

`project.repo` から解決されるリポジトリルートで次を作成します：

`skills/<skill-name>/SKILL.md`

### 2) `team.json` を作成

参照：

- `docs/ja/guide.md`（例 + 起動手順）
- `docs/ja/config.md`（フィールド参照）

### 3) Orchestrator を起動

```bash
oat start team.json "<goal>" --port 3100
```

言語指定：

```bash
oat start team.json "<goal>" --port 3100 --lang zh-CN
```

### 4) よく使うコマンド

```bash
oat status
oat stop
oat docs architecture --lang ja
oat docs config --lang ja
oat docs guide --lang ja
```

## 協業の流れ（概要）

1. Orchestrator はスキル/ツール/プラグインを注入し、`Admin` と各 `Leader` を起動します。
2. `Leader` は `tasks` のリストを含めて `request-workers` ツールを呼び出します。
3. Orchestrator は、あらかじめ作成された `Worker` プール（size = `teams[].worker.total`）にタスクを送信します：
   - 対象 worker に接続
   - タスク prompt を送信
4. `Worker` は：
   - workspace ルートの `CHANGELOG.md` を更新
   - `notify-complete` を呼び、用意した `CHANGELOG.md` を渡す
5. Orchestrator は `Worker -> Leader` をマージし、`Leader` に要約させた後 `Leader -> project.base_branch` をマージします。
6. Orchestrator は worker プールを shutdown まで保持します。オーケストレーター終了時の `stopAll` のみがプロセスを停止/破棄します。

## 現在の実装要点（コードに合わせて）

- runtime mode：`local_process` が実装済み（異なるポートで複数の `opencode serve` を起動）
- workspaces：`worktree` provider が実装済み。他 provider は placeholder です。
- `teams[].worker.total` の worker プールサイズは起動時の事前作成で反映されます。leader 完了後も worker はクリーンアップされず、オーケストレーター終了時にのみ破棄されます。

## LICENSE

MIT &copy; Herbert He
