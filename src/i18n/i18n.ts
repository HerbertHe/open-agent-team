import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

export type Lang = "en" | "zh-CN" | "fr" | "ja";

type MessageKey =
  | "orchestrator_started"
  | "orchestrator_listening_on"
  | "stop_signal_sent"
  | "orchestrator_json_not_found"
  | "orchestrator_pid_not_found"
  | "git_lfs_pull_failed"
  | "git_repo_auto_initialized"
  | "worker_spawned"
  | "worker_merged_into_leader"
  | "docs_file_not_found";

const messages: Record<Lang, Record<MessageKey, string>> = {
  en: {
    orchestrator_started: "Orchestrator started.",
    orchestrator_listening_on: "Orchestrator listening on {port}",
    stop_signal_sent: "Stop signal sent.",
    orchestrator_json_not_found: "orchestrator.json not found.",
    orchestrator_pid_not_found: "No pid found in orchestrator.json.",
    git_lfs_pull_failed: "git lfs pull failed. Continuing anyway.",
    git_repo_auto_initialized:
      "No Git repo at {repo}; initialized with an empty commit on branch {branch}.",
    worker_spawned: "Worker spawned.",
    worker_merged_into_leader: "Worker merged into leader.",
    docs_file_not_found: "Docs file not found: {file}",
  },
  "zh-CN": {
    orchestrator_started: "编排器已启动。",
    orchestrator_listening_on: "编排器正在监听端口 {port}",
    stop_signal_sent: "已发送停止信号。",
    orchestrator_json_not_found: "未找到 orchestrator.json。",
    orchestrator_pid_not_found: "在 orchestrator.json 中未找到 pid。",
    git_lfs_pull_failed: "git lfs pull 失败，将继续运行。",
    git_repo_auto_initialized: "路径 {repo} 未检测到 Git 仓库；已 git init 并完成分支 {branch} 上的空初始提交。",
    worker_spawned: "已生成 Worker。",
    worker_merged_into_leader: "Worker 已合并到 Leader。",
    docs_file_not_found: "未找到文档文件：{file}",
  },
  fr: {
    orchestrator_started: "Orchestrateur démarré.",
    orchestrator_listening_on: "Orchestrateur à l'écoute sur le port {port}",
    stop_signal_sent: "Signal d'arrêt envoyé.",
    orchestrator_json_not_found: "Fichier orchestrator.json introuvable.",
    orchestrator_pid_not_found: "Aucun pid trouvé dans orchestrator.json.",
    git_lfs_pull_failed: "git lfs pull a échoué. Continuer quand même.",
    git_repo_auto_initialized:
      "Aucun dépôt Git dans {repo} ; initialisation avec un commit vide sur la branche {branch}.",
    worker_spawned: "Worker démarré.",
    worker_merged_into_leader: "Worker fusionné dans le leader.",
    docs_file_not_found: "Fichier de documentation introuvable : {file}",
  },
  ja: {
    orchestrator_started: "オーケストレーターを開始しました。",
    orchestrator_listening_on: "オーケストレーターはポート {port} で待機中です。",
    stop_signal_sent: "停止シグナルを送信しました。",
    orchestrator_json_not_found: "orchestrator.json が見つかりません。",
    orchestrator_pid_not_found: "orchestrator.json に pid が見つかりません。",
    git_lfs_pull_failed: "git lfs pull に失敗しました。それでも続行します。",
    git_repo_auto_initialized:
      "{repo} に Git リポジトリがありません。git init を実行し、ブランチ {branch} で空の初期コミットを作成しました。",
    worker_spawned: "Worker を起動しました。",
    worker_merged_into_leader: "Worker をリーダーにマージしました。",
    docs_file_not_found: "ドキュメントファイルが見つかりません: {file}",
  },
};

let currentLang: Lang = "en";

export function setLang(lang: Lang): void {
  currentLang = lang;
}

export function getLang(): Lang {
  return currentLang;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let s = messages[currentLang][key] ?? messages.en[key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

function toLang(v: any): Lang | null {
  if (v === "en") return "en";
  if (v === "zh-CN" || v === "zh") return "zh-CN";
  if (v === "fr" || v === "fr-FR") return "fr";
  if (v === "ja" || v === "ja-JP") return "ja";
  return null;
}

export async function loadLangFromOatYaml(): Promise<Lang | null> {
  const p = path.join(os.homedir(), ".oat", "oat.yaml");
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = yaml.load(raw) as any;
    const lang = parsed?.language ?? parsed?.lang ?? parsed?.i18n?.language ?? parsed?.i18n?.lang;
    return toLang(lang);
  } catch {
    return null;
  }
}

