# Agent Resources：対話型のプロジェクト・チーム作成

`oat resources` は、人事のように組織リソースを扱うための対話入口です。宣言的な設定を手書きさせる代わりに質問で情報を収集し、`team.json` を生成して検証します。

## 使い方

```bash
oat resources
oat resources ./my-project/team.json
oat resources ./team.json --force
```

既存の設定は `--force` を指定しない限り上書きされません。

## ヒアリング内容と結果

このアシスタントは次の情報を収集します。

1. プロジェクト名、リポジトリ、production ブランチ
2. 既定モデル、プロバイダープロトコル、任意の接続設定
3. `local_process` または `docker` の実行環境、Docker イメージ、ネットワーク、リソース制限
4. チームごとの識別子、Leader の責任、許可パス、Worker 数

生成される Admin prompt は、プロジェクトガバナンス、チーム配置、状態分析、リリース承認に限定されます。Leader と Worker の prompt は、デフォルトで Git レビュー協働フローに従います。

出力は書き込み前に起動時と同じ `TeamFileSchema` で検証されるため、そのまま `oat start` に渡せます。本番の API キーは生成ファイルに書かず、安全な環境変数またはシークレットマネージャから注入してください。

ダッシュボードにも **Agent Resources** の入口があり、同じ情報をガイド付きフォームで収集し、選択したプロジェクトの設定として保存します。
