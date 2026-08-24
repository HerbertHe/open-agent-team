var e=`# 3 層 Agent メモリアーキテクチャ

> ステータス：設計提案であり、まだ実装されていません。人間が読める \`CHANGELOG.md\` を残したまま、それだけを唯一の協働メモリにする方式を置き換えます。

## 目的

メモリは、再起動後に目標とテストを復元し、タスク作成前に競合を検出し、決定を証拠に結び付け、コンテキスト注入量を制限します。すべての情報にはスコープ、ソース、バージョン、レビュー状態があります。

## レイヤー

| レイヤー | 役割 | 保存先と期間 |
| --- | --- | --- |
| L1 | セッションとタスクのホットコンテキスト：目標、テスト、ブロッカー、次の手順 | インメモリ \`Map\`、短い TTL、1,000–2,000 token 予算 |
| L2 | 構造化された協働事実：タスク、リソース主張、決定、レビュー | \`<state_dir>/memory.sqlite\` の SQLite WAL + FTS5 |
| L3 | CHANGELOG、イベント、commit、diff、承認済みバージョンのアーカイブと意味検索 | ローカルファイル/インデックス。必要に応じて差し替え可能なベクトルストア |

L1 は \`agentId + taskId + sessionId\` に属します。L2 は \`task → agent → team → project → global\` のスコープでレビュー可能な情報だけを共有します。L3 はコンテキストを圧迫しないよう必要時だけ検索します。

## 権限、証拠、競合

Worker は L1 を書き、L2 への引き継ぎを提案できます。Leader はチーム事実をレビューして昇格し、Admin だけがプロジェクトの事実や決定を公開できます。昇格にはタスク、commit、テスト、イベント、ファイル、レビューの少なくとも一つの証拠を引用します。修正は新しいバージョンを作り、古いものを \`superseded\` にします。

\`create task\` の前に L2 のゲートが \`resource_claims\`、アクティブなコンテキスト、\`conflictKey\` を照会します。競合時はタスクを拒否、直列化、または真に独立したものへ再分割します。

## 予定インターフェース

提案ツールは \`memory-context-get\`、\`memory-search\`、\`memory-propose\`、\`memory-promote\`、\`memory-supersede\`、\`memory-claim-resources\`、\`memory-check-conflicts\`、\`memory-forget\` で、同等の REST API を持ちます。ダッシュボードは L1 の現在コンテキスト、レビュー待ち L2、ソース・日付・信頼度・バージョンチェーン付きの L3 アーカイブを表示します。

## 段階的な導入

1. \`MemoryProvider\` 契約、監査、マイグレーションを定義する。
2. SQLite/FTS5 を使った L1 + L2 とキューの競合チェックを提供する。
3. L3 アーカイブをインデックス化し、キーワード/ベクトルのハイブリッド検索を追加する。
4. 多段検索が実証された要件になった時だけ、Graphiti などの時間グラフを評価する。

設計の参考： [Letta](https://github.com/letta-ai/letta)、[Mem0](https://github.com/mem0ai/mem0)、[LangGraph Persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)、[Graphiti](https://github.com/getzep/graphiti)、[OpenMemory](https://github.com/CaviraOSS/OpenMemory)。
`;export{e as default};