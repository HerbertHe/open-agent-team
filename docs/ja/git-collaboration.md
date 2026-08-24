# Git コラボレーションとデリバリーフロー

OAT は Git をコード協働の唯一の境界として使います。Admin はコントロールプレーン、Leader はレビューと統合の責任者、Worker はレビュー可能な短命ブランチだけを成果として渡します。

## フロー

1. Admin が WorkItem を Leader に割り当てます。
2. Leader は実装上まったく独立しているタスクだけを Worker に渡します。競合するタスクはキューに置くか、再分割します。
3. Worker は各タスクについて、作成時に固定した `main`/`master` の SHA から `oat/<team>/<taskId>/attempt-<n>` を作成します。
4. Worker は実装と自己テストを完了して commit し、`submit-review` を呼び出します。依頼には commit、変更ファイル、テスト、成果物パスが記録されますが、コードはマージされません。
5. Leader は `list-review-requests` で証拠を確認し、`review-worker-branch` で `oat/<team>/<workItem>/integration` への統合を承認するか、修正を依頼します。
6. integration ブランチでの統合テスト後、Leader は `submit-release-proposal` を呼び出します。
7. Admin が `approve-release` で承認または却下します。承認時は MergeController がグローバルな直列ロックを取り、Git `update-ref` により `main`/`master` をアトミックに更新します。
8. リモート公開は任意です。`workspace.git.push_enabled`、有効な ID、リモートを設定した後、Admin が `push-release` を明示的に呼び出します。現在のマージ済みリリースだけを force なしで push します。

本番ブランチが先に変更されていた場合、リリースは新しい commit を上書きせずに失敗します。

すべての Agent worktree で push URL は無効化され、Agent 子プロセスは Git/SSH 認証環境変数を継承しません。対応する唯一のリモート書き込み経路は、Orchestrator 内でロール検証される Admin ツールです。

## タスクキューと競合防止

各 agent は固有の FIFO キューを持ちます。タスク作成時には、すでに待機中のタスク、`conflictKey`、宣言されたリソースを確認します。同じファイル、API、マイグレーション、テストを変更するタスクを Leader が複数の Worker に並行して渡してはいけません。Worker が忙しいときに Leader が代わりに実装したり、Worker を置き換えたりすることはなく、タスクは順番を待ちます。

## 成果物と一時ファイル

実行データは worktree の外、`<runtime.persistence.state_dir>/git-collaboration/` に保存されます。

- `tasks/`: ブランチ、ベース SHA、テスト証拠、変更ファイル
- `reviews/`: レビュー依頼と Leader の決定
- `releases/`: Admin のリリース決定とマージ commit
- `worktrees/`: Worker、Leader、MergeController の一時 worktree

タスク worktree にはプロジェクトのソース、テスト、意図的にバージョン管理するドキュメントだけを置きます。ログ、Agent メタデータ、下書き、セッションファイルを Git の成果物にしてはいけません。

## API

- `GET /tasks`, `POST /tasks`, `PATCH /tasks/:id`, `DELETE /tasks/:id`
- `GET /reviews?leaderId=<id>` と `POST /reviews/<id>`
- `GET /releases` と `POST /releases/<id>/approval`
- `GET /git/status` と `PUT /git/config`（汎用 HTTP push API は提供しません）

上位への報告では、完全な作業ログではなく `artifactPath`、ブランチ、base/head SHA、`changedFiles`、`tests` を参照します。
