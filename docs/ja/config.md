# team.json 設定リファレンス（完全なパラメータ辞書）

`team.json` は宣言的に agent チーム設定を記述するための入口です。Orchestrator はこれを読み取り、解析し、静的な `Admin / Leader` を起動した上で、`Leader` の要求に応じて動的に `Worker` agent を作成します。
このファイルはプロジェクトルートの `schema/v1.json` で検証できます。

同時に loader は、実行時に次の2種類の「補完/解析」を行います：

- `prompt` フィールドは、プロンプト本文を直接書くか、`*.md` で終わるファイルパスとして指定できます（loader がファイル内容を読み込み、置換します）
- `model` フィールドは alias を受け付けます。alias はトップレベルの `models` マッピングから解決され、実際の model id に置換されます

以下にフィールド一覧（型 / 必須 / デフォルト / 用途）を示します。

## 1. トップレベル設定

| フィールド | 必須 | 型 | デフォルト | 用途 |
| --- | --- | --- | --- | --- |
| `model` | いいえ | string | - | 全体で共通のデフォルトモデル（admin/leader/worker のフォールバック） |
| `providers` | いいえ | object | 下記参照 | モデルプロバイダ接続の全体設定（推奨エントリ） |
| `project` | はい | object | - | プロジェクトのメタ情報：ログ/プロンプト、git のベースブランチ、リポジトリパスに使われます |
| `models` | はい | record<string, string> | - | モデル alias のマップ（admin/leader/worker で利用） |
| `admin` | はい | object | - | Admin agent の定義：prompt、model、skills |
| `teams` | はい | array | - | 各チームには 1 つの Leader と Worker の定義が含まれます |
| `runtime` | いいえ | object | 下表参照 | 実行モード、ベースポート、状態ディレクトリ |
| `workspace` | いいえ | object | 下表参照 | workspace の戦略、root dir、git lfs/sparse-checkout 挙動 |

## 2. `project`

| フィールド | 必須 | 型 | デフォルト | 意味 |
| --- | --- | --- | --- | --- |
| `project.name` | はい | string | - | プロジェクト名（プロンプト/ログで利用） |
| `project.repo` | はい | string | - | Git リポジトリのパス（workspace 管理と skills 読み込みで利用。相対パスは `team.json` のディレクトリ基準で解決） |
| `project.base_branch` | いいえ | `main` \| `master` | `"main"` | Leader 完了後のマージ先；`main` または `master` のみ（スキーマで検証） |

## 3. `models`（モデル alias マッピング）

| フィールド | 必須 | 型 | デフォルト | 意味 |
| --- | --- | --- | --- | --- |
| `models` | はい | record<string, string> | - | キー＝alias（例：`default`）、値＝実モデル id（例：`anthropic/...`） |

loader の挙動：

- モデル継承チェーン：`worker.model -> leader.model -> admin.model -> model`（左が優先、右がフォールバック）
- 最終的に選ばれたモデル値が `models` に存在する場合、その値はマッピング値に置換されます
- それ以外の場合は、最終値はそのまま保持されます

## 4. `admin`

| フィールド | 必須 | 型 | デフォルト | 意味 |
| --- | --- | --- | --- | --- |
| `admin.name` | はい | string | - | Admin agent の名前（workspace 内の agent markdown meta に書かれます） |
| `admin.description` | はい | string | - | Admin の責務テキスト（`team.json` に記入します） |
| `admin.model` | いいえ | string | トップレベル `model` を継承 | Admin が使う model（alias でも可） |
| `admin.prompt` | はい | string | - | Admin の prompt（`*.md` ファイルパスを受け付けます） |
| `admin.skills` | いいえ | string[] | `[]` | Admin workspace に注入する skills |

## 5. `runtime`

> `runtime` は任意です。指定がない場合、loader は下記デフォルトを使用します。

| フィールド | 必須 | 型 | デフォルト | 意味 |
| --- | --- | --- | --- | --- |
| `runtime.mode` | いいえ | enum (`local_process` \| `flue`) | `local_process` | runtime モード（現状は `local_process` のみ実装） |
| `runtime.pi.agentDir` | いいえ | string | `~/.pi/agent` | pi-coding-agent グローバル agent ディレクトリ（認証情報・設定・カスタムモデル用） |
| `runtime.persistence.state_dir` | いいえ | string | `"<team.json のディレクトリ>/.oat/state"` | Orchestrator の状態ディレクトリ（`status/stop` は `orchestrator.json` を読む） |

`~` の展開：

- `runtime.persistence.state_dir` を省略した場合、`team.json` と同じディレクトリ配下の `.oat/state` がデフォルトになります
- `runtime.persistence.state_dir` は `~` プレフィックスをサポートし、loader が実ユーザーの home に展開します
- `runtime.persistence.state_dir` が相対パスの場合、`team.json` のディレクトリ基準で解決されます

## 5.1 `providers`（グローバル接続設定）

| フィールド | 必須 | 型 | デフォルト | 意味 |
| --- | --- | --- | --- | --- |
| `providers.env` | いいえ | record<string, string> | `{}` | 各 `pi AgentSession` プロセスに注入する環境変数（平文） |
| `providers.env_from` | いいえ | record<string, string> | `{}` | key は注入名、value は **orchestrator プロセス** 上のソース環境変数名。`providers.env` に同名が既にある場合は **スキップ**（OS から上書きしない） |
| `providers.openai_compatible.base_url` | いいえ | string | - | `OPENAI_BASE_URL` へ自動マッピング |
| `providers.openai_compatible.api_key` | いいえ | string | - | `OPENAI_API_KEY` へ自動マッピング（平文のため非推奨）。設定時は既にマージ済みの `OPENAI_API_KEY` を上書き |
| `providers.openai_compatible.api_key_env` | いいえ | string | - | `api_key` 未設定時：値は **環境変数名**。**まず** マージ済み設定（`providers.env` と適用済み `env_from`）から解決し、**なければ** 現在プロセスの環境から読み、子の `OPENAI_API_KEY` に注入 |

注記（マージ順）：

1. `providers.env` を先に適用。
2. `providers.env_from` は、まだ存在しないキーにだけ適用。
3. 最後に `providers.openai_compatible`：`base_url` / `api_key` を直接反映。`api_key` がなく `api_key_env` だけある場合は上表どおり（設定を OS より優先）。
4. 秘密は OS 変数への `env_from` / `api_key_env`、またはコミットしないローカルの `providers.env` が無難。
5. `env_from` でソースが OS にない、または `api_key_env` が設定・OS 双方で空、のとき warning。

## 6. `workspace`

> `workspace` は任意です。指定がない場合、loader は下記デフォルトを使用します。

| フィールド | 必須 | 型 | デフォルト | 意味 |
| --- | --- | --- | --- | --- |
| `workspace.provider` | いいえ | enum (`worktree` \| `shared_clone` \| `full_clone`) | `worktree` | workspace 戦略（現在 `worktree` のみ実装） |
| `workspace.root_dir` | いいえ | string | `"<team.json のディレクトリ>/workspaces"` | workspace の root ディレクトリ |
| `workspace.persistent` | いいえ | boolean | `true` | 現時点で区別した挙動として未実装（placeholder） |
| `workspace.git.remote` | いいえ | string | `"origin"` | placeholder：worktree 作成で remote 名を直接使いません |
| `workspace.git.lfs` | いいえ | enum (`pull` \| `skip` \| `allow_pull_deny_change`) | `pull` | `worktree` provider では `pull` のときだけ `git lfs pull` を実行 |
| `workspace.sparse_checkout.enabled` | いいえ | boolean | `true` | sparse-checkout を有効化（paths は `teams[].leader.repos` に依存） |

`~` の展開：

- `workspace.root_dir` を省略した場合、`team.json` と同じディレクトリ配下の `workspaces` がデフォルトになります
- `workspace.root_dir` は `~` プレフィックスをサポートし、loader が実ユーザーの home に展開します
- `workspace.root_dir` が相対パスの場合、`team.json` のディレクトリ基準で解決されます

## 7. `teams[]`

各チームには以下が含まれます：

- `team.name`：チーム識別子
- `team.branch_prefix`：leader/worker のブランチ名を作る際のプレフィックス
- `team.leader`：Leader の定義（静的に起動）
- `team.worker`：Worker の定義（Leader 実行中に動的に作成）

### 7.1 team 基本フィールド

| フィールド | 必須 | 型 | デフォルト | 意味 |
| --- | --- | --- | --- | --- |
| `teams[].name` | はい | string | - | チーム名（workspace/scope の識別と agent 名称に使われます） |
| `teams[].branch_prefix` | はい | string | - | worker/leader のブランチ名の基底 |

### 7.2 `teams[].leader`

| フィールド | 必須 | 型 | デフォルト | 意味 |
| --- | --- | --- | --- | --- |
| `leader.name` | はい | string | - | チーム内の leader 名（prompt コンテキスト構築に使われます） |
| `leader.description` | はい | string | - | leader の責務テキスト |
| `leader.model` | いいえ | string | `admin.model`（またはトップレベル `model`）を継承 | leader が使う model（alias でも可） |
| `leader.prompt` | はい | string | - | leader の prompt（`*.md` のファイルパスを受け付けます） |
| `leader.skills` | いいえ | string[] | `[]` | worker と共有する skills（spawn 時に継承し注入されます） |
| `leader.repos` | いいえ | string[] | `[]` | sparse-checkout の allowlist パス（worker が見たり変更できる範囲） |

### 7.3 `teams[].worker`

| フィールド | 必須 | 型 | デフォルト | 意味 |
| --- | --- | --- | --- | --- |
| `worker.total` | はい | number(int, >0) | - | 期待される worker プール数。team 起動時に事前作成し、停止は orchestrator 終了時 (`stopAll`) |
| `worker.model` | いいえ | string | `leader.model` を継承 | Worker が使う model（alias でも可） |
| `worker.prompt` | はい | string | - | worker の prompt（`*.md` ファイルパスも可） |
| `worker.extra_skills` | いいえ | string[] | `[]` | spawn 時に leader.skills の上に追加される skills |
| `worker.lifecycle` | いいえ | enum | `ephemeral_after_merge_to_main` | main へマージした後の cleanup 戦略（実装上は leader 完了時に常に cleanup されます） |
| `worker.skill_sync` | いいえ | enum | `inherit_and_inject_on_spawn` | spawn 時の skill 同期戦略（現状は「継承して注入」で動作。`manual` は未完全実装） |
