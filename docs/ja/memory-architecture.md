# Admin / Leader 向け3層メモリ

> 状態：2026-08-26 実装済み。

メモリの所有者は Admin と Leader です。Worker の有効なイベントは対応する Leader に帰属します。取得したメモリは「誤りうる過去の文脈」として明示され、現在の指示を上書きしません。

保存には WAL モードのローカル `better-sqlite3` を使い、既定のパスは `<state_dir>/memory/memory.db` です。

| 層 | 用途 |
| --- | --- |
| L1 | 最近のタスク、進捗、応答、失敗。Agent ごとの上限と TTL あり |
| L2 | アイドル時に統合されたエピソード、判断、失敗パターン。反復で証拠数・信頼度・重要度が上昇 |
| L3 | 証拠閾値で自動昇格、または Desktop から手動昇格した安定知識 |

夢モードは、実行中の prompt がなく、`queued`、`running`、`waiting`、`review_pending` のタスクもない場合だけ動作します。処理件数を制限したトランザクションで L2 統合、L3 昇格、L2 期限切れ、L1 TTL 清掃を行います。新規タスクはキャンセルを要求します。

生の payload 全体は保存しません。有用なテキストだけを最大 4,000 文字で保存し、一般的な API key、token、secret の形式を伏せ字にします。Admin はプロジェクト内の L2/L3 を検索でき、Leader は自分のメモリだけを検索できます。

API は `GET /memory/overview`、`GET /memory`、`POST /memory/dream`、`POST /memory/:id/promote`、`POST /memory/:id/forget` です。

Desktop では Admin / Leader 選択時に脳アイコンが表示されます。ダイアログから各層、証拠数、ソース数、信頼度、重要度、夢モードの状態を確認し、L2 の昇格と忘却を実行できます。Worker には表示されません。

現在の検索は語彙の一致、重要度、信頼度、経過時間による決定的な方式です。Embedding、時間知識グラフ、LLM リフレクターは将来の拡張であり、現時点の依存関係ではありません。

検証：`pnpm test:memory`、`pnpm exec tsc --noEmit`、`pnpm run build`、`pnpm --filter desktop run build`。
