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
  | "providers_env_from_missing"
  | "providers_openai_api_key_env_not_found"
  | "git_lfs_pull_failed"
  | "git_repo_auto_initialized"
  | "worker_spawned"
  | "worker_merged_into_leader"
  | "docs_file_not_found"
  | "agent_not_found"
  | "team_not_found"
  | "leader_has_no_team"
  | "requested_workers_exceed_max"
  | "worker_model_missing"
  | "leader_not_found_for_team"
  | "leader_team_missing"
  | "admin_not_found"
  | "admin_model_missing"
  | "leader_model_missing";

const messages: Record<Lang, Record<MessageKey, string>> = {
  en: {
    orchestrator_started: "Orchestrator started.",
    orchestrator_listening_on: "Orchestrator listening on {port}",
    stop_signal_sent: "Stop signal sent.",
    orchestrator_json_not_found: "orchestrator.json not found.",
    orchestrator_pid_not_found: "No pid found in orchestrator.json.",
    providers_env_from_missing: "providers.env_from references missing env: {sourceEnvName} -> {targetKey}",
    providers_openai_api_key_env_not_found: "providers.openai_compatible.api_key_env not found: {name}",
    git_lfs_pull_failed: "git lfs pull failed. Continuing anyway.",
    git_repo_auto_initialized:
      "No Git repo at {repo}; initialized with an empty commit on branch {branch}.",
    worker_spawned: "Worker spawned.",
    worker_merged_into_leader: "Worker merged into leader.",
    docs_file_not_found: "Docs file not found: {file}",
    agent_not_found: "Agent not found: {agentId}",
    team_not_found: "Team not found: {teamName}",
    leader_has_no_team: "Leader has no team: {leaderId}",
    requested_workers_exceed_max: "Requested workers ({workerCount}) exceed teams[{teamName}].worker.max ({max}).",
    worker_model_missing: "Resolved config missing teams[{teamName}].worker.model",
    leader_not_found_for_team: "Leader not found for team: {teamName}",
    leader_team_missing: "Leader team missing.",
    admin_not_found: "Admin not found.",
    admin_model_missing: "Resolved config missing admin.model",
    leader_model_missing: "Resolved config missing teams[{teamName}].leader.model",
  },
  "zh-CN": {
    orchestrator_started: "编排器已启动。",
    orchestrator_listening_on: "编排器正在监听端口 {port}",
    stop_signal_sent: "已发送停止信号。",
    orchestrator_json_not_found: "未找到 orchestrator.json。",
    orchestrator_pid_not_found: "在 orchestrator.json 中未找到 pid。",
    providers_env_from_missing: "providers.env_from 引用了不存在的环境变量：{sourceEnvName} -> {targetKey}",
    providers_openai_api_key_env_not_found: "未找到 providers.openai_compatible.api_key_env 指定的环境变量：{name}",
    git_lfs_pull_failed: "git lfs pull 失败，将继续运行。",
    git_repo_auto_initialized: "路径 {repo} 未检测到 Git 仓库；已 git init 并完成分支 {branch} 上的空初始提交。",
    worker_spawned: "已生成 Worker。",
    worker_merged_into_leader: "Worker 已合并到 Leader。",
    docs_file_not_found: "未找到文档文件：{file}",
    agent_not_found: "未找到 Agent：{agentId}",
    team_not_found: "未找到 Team：{teamName}",
    leader_has_no_team: "Leader 未绑定 Team：{leaderId}",
    requested_workers_exceed_max: "请求的 Worker 数量（{workerCount}）超过 teams[{teamName}].worker.max（{max}）。",
    worker_model_missing: "解析后的配置缺少 teams[{teamName}].worker.model",
    leader_not_found_for_team: "未找到 Team 对应的 Leader：{teamName}",
    leader_team_missing: "缺少 Leader 所属 Team。",
    admin_not_found: "未找到 Admin。",
    admin_model_missing: "解析后的配置缺少 admin.model",
    leader_model_missing: "解析后的配置缺少 teams[{teamName}].leader.model",
  },
  fr: {
    orchestrator_started: "Orchestrateur démarré.",
    orchestrator_listening_on: "Orchestrateur à l'écoute sur le port {port}",
    stop_signal_sent: "Signal d'arrêt envoyé.",
    orchestrator_json_not_found: "Fichier orchestrator.json introuvable.",
    orchestrator_pid_not_found: "Aucun pid trouvé dans orchestrator.json.",
    providers_env_from_missing: "providers.env_from référence une variable d'environnement manquante : {sourceEnvName} -> {targetKey}",
    providers_openai_api_key_env_not_found: "providers.openai_compatible.api_key_env introuvable : {name}",
    git_lfs_pull_failed: "git lfs pull a échoué. Continuer quand même.",
    git_repo_auto_initialized:
      "Aucun dépôt Git dans {repo} ; initialisation avec un commit vide sur la branche {branch}.",
    worker_spawned: "Worker démarré.",
    worker_merged_into_leader: "Worker fusionné dans le leader.",
    docs_file_not_found: "Fichier de documentation introuvable : {file}",
    agent_not_found: "Agent introuvable : {agentId}",
    team_not_found: "Team introuvable : {teamName}",
    leader_has_no_team: "Le leader n'a pas de team : {leaderId}",
    requested_workers_exceed_max: "Le nombre de workers demandé ({workerCount}) dépasse teams[{teamName}].worker.max ({max}).",
    worker_model_missing: "Configuration résolue manquante : teams[{teamName}].worker.model",
    leader_not_found_for_team: "Leader introuvable pour la team : {teamName}",
    leader_team_missing: "Team du leader manquante.",
    admin_not_found: "Admin introuvable.",
    admin_model_missing: "Configuration résolue manquante : admin.model",
    leader_model_missing: "Configuration résolue manquante : teams[{teamName}].leader.model",
  },
  ja: {
    orchestrator_started: "オーケストレーターを開始しました。",
    orchestrator_listening_on: "オーケストレーターはポート {port} で待機中です。",
    stop_signal_sent: "停止シグナルを送信しました。",
    orchestrator_json_not_found: "orchestrator.json が見つかりません。",
    orchestrator_pid_not_found: "orchestrator.json に pid が見つかりません。",
    providers_env_from_missing: "providers.env_from が存在しない環境変数を参照しています: {sourceEnvName} -> {targetKey}",
    providers_openai_api_key_env_not_found: "providers.openai_compatible.api_key_env が見つかりません: {name}",
    git_lfs_pull_failed: "git lfs pull に失敗しました。それでも続行します。",
    git_repo_auto_initialized:
      "{repo} に Git リポジトリがありません。git init を実行し、ブランチ {branch} で空の初期コミットを作成しました。",
    worker_spawned: "Worker を起動しました。",
    worker_merged_into_leader: "Worker をリーダーにマージしました。",
    docs_file_not_found: "ドキュメントファイルが見つかりません: {file}",
    agent_not_found: "Agent が見つかりません: {agentId}",
    team_not_found: "Team が見つかりません: {teamName}",
    leader_has_no_team: "Leader に Team がありません: {leaderId}",
    requested_workers_exceed_max: "要求された Worker 数（{workerCount}）が teams[{teamName}].worker.max（{max}）を超えています。",
    worker_model_missing: "解決済み設定に teams[{teamName}].worker.model がありません",
    leader_not_found_for_team: "Team に対応する Leader が見つかりません: {teamName}",
    leader_team_missing: "Leader の Team がありません。",
    admin_not_found: "Admin が見つかりません。",
    admin_model_missing: "解決済み設定に admin.model がありません",
    leader_model_missing: "解決済み設定に teams[{teamName}].leader.model がありません",
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

