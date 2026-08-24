# OAT CLI リファレンス

`oat` コマンドラインインターフェースは、Open Agent Team Orchestrator の管理、状態の検査、およびドキュメントの表示を行うためのツールを提供します。

## グローバルオプション

- `-v, --version`：バージョン番号を出力します。
- `--lang <lang>`：CLI メッセージおよびドキュメントの出力言語。サポートされる値：`en`, `zh-CN`, `fr`, `ja`。
- `-h, --help`：CLI または特定のコマンドのヘルプを表示します。

---

## `oat init`

現在のディレクトリに新しい `team.json` 設定ファイルを初期化します（組み込みのサンプル設定をコピーします）。

**使用法：**
```bash
oat init
```

## `oat start`

設定ファイルに基づいて Agent チームを管理・スケジュールするために Orchestrator をバックグラウンドで起動します。リアルタイム管理には OAT Desktop を使用してください。

**使用法：**
```bash
oat start [options]
```

**オプション：**
- `--config <path>`：`team.json` 設定ファイルのパス。省略した場合、カレントディレクトリの `./team.json`、または環境変数 `OAT_TEAM_JSON` で指定されたパスが使用されます。
- `--goal <text>`：プロジェクトの最終目標（任意）。Leader エージェントのプロンプトに注入されます。または、コマンドの末尾に引数として渡すこともできます：`oat start team.json "私の目標"`。

---

## `oat list` / `oat ls`

すべてのローカル OAT プロジェクトの Orchestrator の現在のステータス（実行中かどうか、PID、ポートなど）をグローバルに確認します。

**使用法：**
```bash
oat list
# または
oat ls
```

---

## `oat stop`

実行中の Orchestrator に正常なシャットダウンシグナル（SIGINT）を送信します。Orchestrator は全てのエージェントランタイムとワークスペースを安全に停止します。

**使用法：**
```bash
oat stop [options] [projectId]
```

**オプション：**
- `--all`：実行中のすべての OAT プロジェクトを停止します。`--all` を使用する場合、`projectId` は不要です。

**引数：**
- `projectId`：プロジェクトのID。`oat list` コマンドで確認できます。`--all` が指定されていない場合は必須です。

---

## `oat rm`

指定されたプロジェクトのすべての OAT 状態データとワークスペースディレクトリを完全に削除します。プロジェクトは削除する前に停止している必要があります。元のリポジトリは削除されません。

**使用法：**
```bash
oat rm [options] <projectId>
```

**引数：**
- `projectId`：プロジェクトのID。`oat list` コマンドで確認できます。

---

## `oat inspect`

Orchestrator によって作成されたローカルワークスペースを検査し、現在の状態を一覧表示します。

**使用法：**
```bash
oat inspect [options] [stateDir] [workspaceRoot]
```

**引数：**
- `stateDir`：状態ディレクトリ。
- `workspaceRoot`：ワークスペースが保存されているディレクトリ（デフォルト：`workspaces`）。

**オプション：**
- `--limit <number>`：表示するワークスペースエントリの最大数（デフォルト：50）。

---

## `oat docs`

ドキュメントのコンテンツをターミナルに直接出力します。

**使用法：**
```bash
oat docs [options] <name>
```

**引数：**
- `name`：表示するドキュメントの名前。利用可能なドキュメント：`architecture`、`config`、`guide`、`cli`。

**例：**
```bash
oat docs config --lang ja
```

---

## `oat channels`

ロードされたプッシュチャネルプラグイン、設定されたすべてのアカウント、アクティブなセッション（WeChat QRログインなど）、および全体のステータスを表示します。

**使用法：**
```bash
oat channels
```

---

## `oat channel login`

状態を持つチャネル（WeChatなど）にインタラクティブにスキャンログインして設定します。

**使用法：**
```bash
oat channel login <channelId> <accountId>
```

**引数：**
- `channelId`：ターゲットチャネルのタイプ（例：`weixin`）。
- `accountId`：このログインセッションの識別子。

**例：**
```bash
oat channel login weixin my-wechat
```

---

## `oat plugins install`

NPM から OpenClaw 互換のプッシュチャネルプラグインを動的にダウンロードし、ホットインストールします。

**使用法：**
```bash
oat plugins install <packageName>
```

**引数：**
- `packageName`：プラグインの NPM パッケージ名（例：`@tencent-weixin/openclaw-weixin`）。

---

## `oat plugins uninstall`

インストールされたプラグインをシステムから動的にアンインストールし、関連するすべてのセッションファイルと設定情報を安全に削除します。

**使用法：**
```bash
oat plugins uninstall <pluginId>
```

**引数：**
- `pluginId` : アンインストールするプラグインの ID（例：`openclaw-weixin`）。
