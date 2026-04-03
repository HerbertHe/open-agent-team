import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

export type Lang = "en" | "zh-CN" | "fr" | "ja";

type MessageKey =
  | "orchestrator_started"
  | "start_observability_hint"
  | "dashboard_dist_missing"
  | "orchestrator_listening_on"
  | "orchestrator_shutting_down"
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
  | "leader_model_missing"
  | "log_startup_context"
  | "log_home_project_link"
  | "log_home_project_link_skipped"
  | "log_orchestrator_json"
  | "log_orchestrator_state"
  | "orchestrator_state_parse_failed"
  | "workspace_root_not_found"
  | "workspace_inspection"
  | "runtime_stop_all_failed"
  | "runtime_ready_timeout"
  | "model_inheritance_missing"
  | "team_json_not_found_oat_env"
  | "team_json_not_found"
  | "provider_docker_disabled"
  | "provider_flue_placeholder"
  | "workspace_provider_unimplemented"
  | "agent_port_base_shifted"
  | "agent_ports_no_contiguous_block"
  | "no_free_worker_port"
  | "worker_registered"
  | "worker_task_dispatched"
  | "worker_already_registered"
  | "worker_not_registered";

const messages: Record<Lang, Record<MessageKey, string>> = {
  en: {
    orchestrator_started: "Orchestrator started.",
    start_observability_hint:
      "Observability dashboard: open http://127.0.0.1:{port}/ in your browser. API: GET /observability/graph, GET /observability/events (SSE).",
    dashboard_dist_missing:
      "Web UI static files not found ({path}). Run `npm run build` in the package to build dashboard/dist (included when installing from npm).",
    orchestrator_listening_on: "Orchestrator listening on {port}",
    orchestrator_shutting_down: "Shutting down (signal: {signal}); stopping agent runtimes.",
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
    requested_workers_exceed_max: "Requested workers ({workerCount}) exceed teams[{teamName}].worker.total ({max}).",
    worker_model_missing: "Resolved config missing teams[{teamName}].worker.model",
    leader_not_found_for_team: "Leader not found for team: {teamName}",
    leader_team_missing: "Leader team missing.",
    admin_not_found: "Admin not found.",
    admin_model_missing: "Resolved config missing admin.model",
    leader_model_missing: "Resolved config missing teams[{teamName}].leader.model",
    log_startup_context: "Startup context",
    log_home_project_link: "Home project link",
    log_home_project_link_skipped: "Home project link skipped",
    log_orchestrator_json: "orchestrator.json",
    log_orchestrator_state: "Orchestrator state",
    orchestrator_state_parse_failed: "Failed to parse orchestrator state: {stateFile}",
    workspace_root_not_found: "Workspace root not found: {workspaceRoot}",
    workspace_inspection: "Workspace inspection",
    runtime_stop_all_failed: "runtimeProvider.stopAll failed",
    runtime_ready_timeout:
      'Timed out waiting for opencode HTTP on 127.0.0.1:{port} ({timeoutMs}ms). Check orchestrator stderr for spawn error / process exited lines; see ~/.local/share/opencode/log/*.log. Common causes: port in use, opencode missing from PATH, or missing model/API env.',
    model_inheritance_missing:
      "Missing model for {fieldPath}. Set it explicitly, or provide a parent model (team.worker.model -> team.leader.model -> admin.model -> model).",
    team_json_not_found_oat_env: "team.json not found (OAT_TEAM_JSON): {path}",
    team_json_not_found: "team.json not found: {path} (cd to project dir or set OAT_TEAM_JSON)",
    provider_docker_disabled: "DockerProvider is not enabled. Use local_process runtime.",
    provider_flue_placeholder: "FlueProvider is optional and not implemented in this repository.",
    workspace_provider_unimplemented: 'Workspace provider "{provider}" is not implemented yet',
    agent_port_base_shifted:
      "runtime.ports.base was {configured}; part of that range was in use. Using {actual} for Admin and Leader opencode serve ports.",
    agent_ports_no_contiguous_block:
      "Could not find {count} consecutive free TCP ports on 127.0.0.1 starting from {base} (searched up to {maxScan} ports ahead).",
    no_free_worker_port: "Could not allocate a free TCP port for a worker after {maxAttempts} attempts.",
    worker_registered: "Worker registered and runtime ready.",
    worker_task_dispatched: "Dispatched task to worker.",
    worker_already_registered: "Worker already exists: {workerId}",
    worker_not_registered: "No registered worker for id: {workerId}. Call register-workers first.",
  },
  "zh-CN": {
    orchestrator_started: "编排器已启动。",
    start_observability_hint:
      "可观测面板：在浏览器打开 http://127.0.0.1:{port}/ 。接口：GET /observability/graph、GET /observability/events（SSE）。",
    dashboard_dist_missing:
      "未找到观测面板静态资源（{path}）。请在该包目录执行 npm run build 生成 dashboard/dist（npm 安装包时通常已包含）。",
    orchestrator_listening_on: "编排器正在监听端口 {port}",
    orchestrator_shutting_down: "正在关闭（信号：{signal}），正在停止各 Agent 运行时进程。",
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
    requested_workers_exceed_max: "请求的 Worker 数量（{workerCount}）超过 teams[{teamName}].worker.total（{max}）。",
    worker_model_missing: "解析后的配置缺少 teams[{teamName}].worker.model",
    leader_not_found_for_team: "未找到 Team 对应的 Leader：{teamName}",
    leader_team_missing: "缺少 Leader 所属 Team。",
    admin_not_found: "未找到 Admin。",
    admin_model_missing: "解析后的配置缺少 admin.model",
    leader_model_missing: "解析后的配置缺少 teams[{teamName}].leader.model",
    log_startup_context: "启动上下文",
    log_home_project_link: "主目录项目链接",
    log_home_project_link_skipped: "已跳过主目录项目链接",
    log_orchestrator_json: "orchestrator.json",
    log_orchestrator_state: "编排器状态",
    orchestrator_state_parse_failed: "解析编排器状态失败：{stateFile}",
    workspace_root_not_found: "未找到 workspace 根目录：{workspaceRoot}",
    workspace_inspection: "Workspace 巡检",
    runtime_stop_all_failed: "runtimeProvider.stopAll 失败",
    runtime_ready_timeout:
      "等待 127.0.0.1:{port} 上的 opencode HTTP 就绪超时（{timeoutMs}ms）。请查看编排器终端中该 agent 的 stderr（含 spawn error / process exited），并打开 ~/.local/share/opencode/log 下最新 .log。常见原因：端口被占用、未安装 opencode 或不在 PATH、模型/API 等环境变量未注入到子进程。",
    model_inheritance_missing:
      "缺少模型配置：{fieldPath}。请显式设置，或在上级提供模型（team.worker.model -> team.leader.model -> admin.model -> model）。",
    team_json_not_found_oat_env: "未找到 team.json（OAT_TEAM_JSON）：{path}",
    team_json_not_found: "未找到 team.json：{path}（请切换到项目目录或设置 OAT_TEAM_JSON）",
    provider_docker_disabled: "DockerProvider 未启用，请使用 local_process 运行时。",
    provider_flue_placeholder: "FlueProvider 为可选项，当前仓库仅提供接口占位。",
    workspace_provider_unimplemented: "Workspace 策略「{provider}」尚未实现",
    agent_port_base_shifted:
      "配置的起始端口为 {configured}，该段内有端口已被占用；Admin 与各 Leader 的 opencode 将自 {actual} 起监听。",
    agent_ports_no_contiguous_block:
      "自 {base} 起在 127.0.0.1 上无法找到 {count} 个连续空闲 TCP 端口（最多向前尝试 {maxScan} 个端口）。",
    no_free_worker_port: "连续尝试 {maxAttempts} 次后仍无法为 Worker 分配到空闲 TCP 端口。",
    worker_registered: "Worker 已注册，运行时就绪。",
    worker_task_dispatched: "已向 Worker 下发任务。",
    worker_already_registered: "Worker 已存在：{workerId}",
    worker_not_registered: "未找到已注册的 Worker：{workerId}。请先调用 register-workers。",
  },
  fr: {
    orchestrator_started: "Orchestrateur démarré.",
    start_observability_hint:
      "Observabilité : ouvrez http://127.0.0.1:{port}/ dans le navigateur. API : GET /observability/graph, GET /observability/events (SSE).",
    dashboard_dist_missing:
      "Fichiers statiques du tableau de bord introuvables ({path}). Exécutez `npm run build` pour produire dashboard/dist.",
    orchestrator_listening_on: "Orchestrateur à l'écoute sur le port {port}",
    orchestrator_shutting_down: "Arrêt (signal : {signal}) ; arrêt des runtimes d'agents.",
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
    requested_workers_exceed_max: "Le nombre de workers demandé ({workerCount}) dépasse teams[{teamName}].worker.total ({max}).",
    worker_model_missing: "Configuration résolue manquante : teams[{teamName}].worker.model",
    leader_not_found_for_team: "Leader introuvable pour la team : {teamName}",
    leader_team_missing: "Team du leader manquante.",
    admin_not_found: "Admin introuvable.",
    admin_model_missing: "Configuration résolue manquante : admin.model",
    leader_model_missing: "Configuration résolue manquante : teams[{teamName}].leader.model",
    log_startup_context: "Contexte de démarrage",
    log_home_project_link: "Lien projet dans le home",
    log_home_project_link_skipped: "Lien projet dans le home ignoré",
    log_orchestrator_json: "orchestrator.json",
    log_orchestrator_state: "État de l'Orchestrateur",
    orchestrator_state_parse_failed: "Échec d'analyse de l'état orchestrateur : {stateFile}",
    workspace_root_not_found: "Racine workspace introuvable : {workspaceRoot}",
    workspace_inspection: "Inspection des workspaces",
    runtime_stop_all_failed: "Échec de runtimeProvider.stopAll",
    runtime_ready_timeout:
      "Délai dépassé en attendant le HTTP opencode sur 127.0.0.1:{port} ({timeoutMs} ms). Le processus a peut-être quitté ; vérifiez que « opencode serve » tourne et consultez les logs du workspace.",
    model_inheritance_missing:
      "Modèle manquant pour {fieldPath}. Définissez-le explicitement ou fournissez un modèle parent (team.worker.model -> team.leader.model -> admin.model -> model).",
    team_json_not_found_oat_env: "team.json introuvable (OAT_TEAM_JSON) : {path}",
    team_json_not_found: "team.json introuvable : {path} (placez-vous dans le projet ou définissez OAT_TEAM_JSON)",
    provider_docker_disabled: "DockerProvider n'est pas activé. Utilisez le runtime local_process.",
    provider_flue_placeholder: "FlueProvider est optionnel et non implémenté dans ce dépôt.",
    workspace_provider_unimplemented: 'Le fournisseur de workspace « {provider} » n\'est pas encore implémenté',
    agent_port_base_shifted:
      "runtime.ports.base était {configured} ; une partie de la plage était occupée. Utilisation de {actual} pour Admin et les Leaders (opencode serve).",
    agent_ports_no_contiguous_block:
      "Impossible de trouver {count} ports TCP libres consécutifs sur 127.0.0.1 à partir de {base} (recherche sur {maxScan} ports au plus).",
    no_free_worker_port: "Impossible d'allouer un port TCP libre pour un worker après {maxAttempts} tentatives.",
    worker_registered: "Worker enregistré, runtime prêt.",
    worker_task_dispatched: "Tâche envoyée au worker.",
    worker_already_registered: "Worker déjà présent : {workerId}",
    worker_not_registered: "Aucun worker enregistré pour {workerId}. Appelez d'abord register-workers.",
  },
  ja: {
    orchestrator_started: "オーケストレーターを開始しました。",
    start_observability_hint:
      "可観測ダッシュボード: ブラウザで http://127.0.0.1:{port}/ を開いてください。API: GET /observability/graph、GET /observability/events（SSE）。",
    dashboard_dist_missing:
      "ダッシュボードの静的ファイルが見つかりません（{path}）。dashboard/dist を生成するには `npm run build` を実行してください。",
    orchestrator_listening_on: "オーケストレーターはポート {port} で待機中です。",
    orchestrator_shutting_down: "シャットダウン中（シグナル: {signal}）。エージェントのランタイムを停止します。",
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
    requested_workers_exceed_max: "要求された Worker 数（{workerCount}）が teams[{teamName}].worker.total（{max}）を超えています。",
    worker_model_missing: "解決済み設定に teams[{teamName}].worker.model がありません",
    leader_not_found_for_team: "Team に対応する Leader が見つかりません: {teamName}",
    leader_team_missing: "Leader の Team がありません。",
    admin_not_found: "Admin が見つかりません。",
    admin_model_missing: "解決済み設定に admin.model がありません",
    leader_model_missing: "解決済み設定に teams[{teamName}].leader.model がありません",
    log_startup_context: "起動コンテキスト",
    log_home_project_link: "ホームのプロジェクトリンク",
    log_home_project_link_skipped: "ホームのプロジェクトリンクをスキップしました",
    log_orchestrator_json: "orchestrator.json",
    log_orchestrator_state: "オーケストレーター状態",
    orchestrator_state_parse_failed: "オーケストレーター状態の解析に失敗しました: {stateFile}",
    workspace_root_not_found: "workspace ルートが見つかりません: {workspaceRoot}",
    workspace_inspection: "workspace 検査",
    runtime_stop_all_failed: "runtimeProvider.stopAll が失敗しました",
    runtime_ready_timeout:
      "127.0.0.1:{port} の opencode HTTP 待機がタイムアウトしました（{timeoutMs}ms）。プロセスが終了した可能性があります。「opencode serve」が動いているか確認し、workspace のログを確認してください。",
    model_inheritance_missing:
      "{fieldPath} のモデルがありません。明示的に設定するか、親モデルを指定してください（team.worker.model -> team.leader.model -> admin.model -> model）。",
    team_json_not_found_oat_env: "team.json が見つかりません（OAT_TEAM_JSON）: {path}",
    team_json_not_found: "team.json が見つかりません: {path}（プロジェクトディレクトリに移動するか OAT_TEAM_JSON を設定してください）",
    provider_docker_disabled: "DockerProvider は無効です。local_process ランタイムを使用してください。",
    provider_flue_placeholder: "FlueProvider は任意で、本リポジトリでは未実装のプレースホルダです。",
    workspace_provider_unimplemented: "Workspace プロバイダー「{provider}」は未実装です",
    agent_port_base_shifted:
      "runtime.ports.base は {configured} でしたが、その範囲に使用中のポートがありました。Admin と各 Leader の opencode は {actual} から使用します。",
    agent_ports_no_contiguous_block:
      "127.0.0.1 で {base} から {count} 個の連続した空き TCP ポートが見つかりません（最大 {maxScan} ポート先まで探索）。",
    no_free_worker_port: "Worker 用の空き TCP ポートを {maxAttempts} 回試行しても確保できませんでした。",
    worker_registered: "Worker を登録し、ランタイム準備完了。",
    worker_task_dispatched: "Worker にタスクを送信しました。",
    worker_already_registered: "Worker は既に存在します: {workerId}",
    worker_not_registered: "登録済み Worker がありません: {workerId}。先に register-workers を呼び出してください。",
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
      s = s.replaceAll(`{${k}}`, String(v ?? ""));
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

