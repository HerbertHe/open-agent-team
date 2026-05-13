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
  | "admin_git_push_success"
  | "admin_git_push_failed"
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
  | "model_inheritance_missing"
  | "team_json_not_found_oat_env"
  | "team_json_not_found"
  | "provider_docker_disabled"
  | "workspace_provider_unimplemented"
  | "worker_registered"
  | "worker_task_dispatched"
  | "worker_already_registered"
  | "worker_not_registered"
  | "started_in_background"
  | "dashboard_hint"
  | "project_not_found"
  | "project_running_cannot_rm"
  | "project_removed_success"
  | "init_team_json_exists"
  | "init_success"
  | "dashboard_no_projects"
  | "no_oat_projects_found";

const messages: Record<Lang, Record<MessageKey, string>> = {
  en: {
    orchestrator_started: "Orchestrator started.",
    start_observability_hint:
      "Orchestrator is running on port {port}. Use `oat dashboard` to open the management console.",
    dashboard_dist_missing:
      "Web UI static files not found ({path}). Run `npm run build` in the package to build dashboard/dist (included when installing from npm).",
    orchestrator_listening_on: "Orchestrator listening on {port}",
    orchestrator_shutting_down: "Shutting down (signal: {signal}); stopping agent runtimes.",
    stop_signal_sent: "Stop signal sent.",
    orchestrator_json_not_found: "orchestrator.json not found.",
    orchestrator_pid_not_found: "No pid found in orchestrator.json.",
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
    admin_git_push_success: "Admin pushed successfully to remote {remote} (branch: {branch}).",
    admin_git_push_failed: "Admin push to remote failed: {error}",
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
    model_inheritance_missing:
      "Missing model for {fieldPath}. Set it explicitly, or provide a parent model (team.worker.model -> team.leader.model -> admin.model -> model).",
    team_json_not_found_oat_env: "team.json not found (OAT_TEAM_JSON): {path}",
    team_json_not_found: "team.json not found: {path} (cd to project dir or set OAT_TEAM_JSON)",
    provider_docker_disabled: "DockerProvider is not enabled. Use local_process runtime.",
    workspace_provider_unimplemented: 'Workspace provider "{provider}" is not implemented yet',
    worker_registered: "Worker registered and runtime ready.",
    worker_task_dispatched: "Dispatched task to worker.",
    worker_already_registered: "Worker already exists: {workerId}",
    worker_not_registered: "No registered worker for id: {workerId}. Workers are pre-spawned at startup.",
    started_in_background: "Orchestrator started in background. Logs are written to {logPath}",
    dashboard_hint: "Please use `oat dashboard` to open the management console.",
    project_not_found: "Project not found or not linked: {projectId}",
    project_running_cannot_rm: "Cannot remove running project. Please run `oat stop {projectId}` first.",
    project_removed_success: "Project removed successfully: {projectId}",
    init_team_json_exists: "team.json already exists in the current directory.",
    init_success: "Initialized team.json in the current directory.",
    dashboard_no_projects: "No projects found locally. Please run `oat start` or `oat init` to create a project first.",
    no_oat_projects_found: "No OAT projects found.",
  },
  "zh-CN": {
    orchestrator_started: "编排器已启动。",
    start_observability_hint:
      "编排器已在端口 {port} 上运行。使用 `oat dashboard` 打开管理台。",
    dashboard_dist_missing:
      "未找到观测面板静态资源（{path}）。请在该包目录执行 npm run build 生成 dashboard/dist（npm 安装包时通常已包含）。",
    orchestrator_listening_on: "编排器正在监听端口 {port}",
    orchestrator_shutting_down: "正在关闭（信号：{signal}），正在停止各 Agent 运行时进程。",
    stop_signal_sent: "已发送停止信号。",
    orchestrator_json_not_found: "未找到 orchestrator.json。",
    orchestrator_pid_not_found: "在 orchestrator.json 中未找到 pid。",
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
    admin_git_push_success: "Admin 完成后成功推送到远端 {remote} (分支: {branch})。",
    admin_git_push_failed: "Admin 推送到远端失败: {error}",
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
    model_inheritance_missing:
      "缺少模型配置：{fieldPath}。请显式设置，或在上级提供模型（team.worker.model -> team.leader.model -> admin.model -> model）。",
    team_json_not_found_oat_env: "未找到 team.json（OAT_TEAM_JSON）：{path}",
    team_json_not_found: "未找到 team.json：{path}（请切换到项目目录或设置 OAT_TEAM_JSON）",
    provider_docker_disabled: "DockerProvider 未启用，请使用 local_process 运行时。",
    workspace_provider_unimplemented: "Workspace 策略「{provider}」尚未实现",
    worker_registered: "Worker 已注册，运行时就绪。",
    worker_task_dispatched: "已向 Worker 下发任务。",
    worker_already_registered: "Worker 已存在：{workerId}",
    worker_not_registered: "未找到已注册的 Worker：{workerId}。Worker 在启动时已预先创建。",
    started_in_background: "Orchestrator 已在后台启动。日志已写入：{logPath}",
    dashboard_hint: "请使用 `oat dashboard` 打开管理台。",
    project_not_found: "未找到项目或项目未链接：{projectId}",
    project_running_cannot_rm: "项目正在运行，无法删除。请先运行 `oat stop {projectId}`。",
    project_removed_success: "项目已成功移除：{projectId}",
    init_team_json_exists: "当前目录已存在 team.json。",
    init_success: "已在当前目录初始化 team.json。",
    dashboard_no_projects: "本地未发现任何项目，请先运行 `oat start` 或 `oat init` 来创建一个项目。",
    no_oat_projects_found: "未找到任何 OAT 项目。",
  },
  fr: {
    orchestrator_started: "Orchestrateur démarré.",
    start_observability_hint:
      "L'orchestrateur est en cours d'exécution sur le port {port}. Utilisez `oat dashboard` pour ouvrir la console de gestion.",
    dashboard_dist_missing:
      "Fichiers statiques du tableau de bord introuvables ({path}). Exécutez `npm run build` pour produire dashboard/dist.",
    orchestrator_listening_on: "Orchestrateur à l'écoute sur le port {port}",
    orchestrator_shutting_down: "Arrêt (signal : {signal}) ; arrêt des runtimes d'agents.",
    stop_signal_sent: "Signal d'arrêt envoyé.",
    orchestrator_json_not_found: "Fichier orchestrator.json introuvable.",
    orchestrator_pid_not_found: "Aucun pid trouvé dans orchestrator.json.",
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
    admin_git_push_success: "Le Admin a été poussé avec succès vers le remote {remote} (branche: {branch}).",
    admin_git_push_failed: "Échec de la poussée du Admin vers le remote : {error}",
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
    model_inheritance_missing:
      "Modèle manquant pour {fieldPath}. Définissez-le explicitement ou fournissez un modèle parent (team.worker.model -> team.leader.model -> admin.model -> model).",
    team_json_not_found_oat_env: "team.json introuvable (OAT_TEAM_JSON) : {path}",
    team_json_not_found: "team.json introuvable : {path} (placez-vous dans le projet ou définissez OAT_TEAM_JSON)",
    provider_docker_disabled: "DockerProvider n'est pas activé. Utilisez le runtime local_process.",
    workspace_provider_unimplemented: 'Le fournisseur de workspace « {provider} » n\'est pas encore implémenté',
    worker_registered: "Worker enregistré, runtime prêt.",
    worker_task_dispatched: "Tâche envoyée au worker.",
    worker_already_registered: "Worker déjà présent : {workerId}",
    worker_not_registered: "Aucun worker enregistré pour {workerId}. Les workers sont pré-créés au démarrage.",
    started_in_background: "L'orchestrateur a démarré en arrière-plan. Journaux écrits dans {logPath}",
    dashboard_hint: "Veuillez utiliser `oat dashboard` pour ouvrir la console de gestion.",
    project_not_found: "Projet introuvable ou non lié : {projectId}",
    project_running_cannot_rm: "Impossible de supprimer un projet en cours d'exécution. Veuillez d'abord exécuter `oat stop {projectId}`.",
    project_removed_success: "Projet supprimé avec succès : {projectId}",
    init_team_json_exists: "team.json existe déjà dans le répertoire courant.",
    init_success: "team.json initialisé dans le répertoire courant.",
    dashboard_no_projects: "Aucun projet trouvé localement. Veuillez d'abord exécuter `oat start` ou `oat init` pour créer un projet.",
    no_oat_projects_found: "Aucun projet OAT trouvé.",
  },
  ja: {
    orchestrator_started: "オーケストレーターを開始しました。",
    start_observability_hint:
      "オーケストレーターはポート {port} で実行中です。`oat dashboard` で管理コンソールを開いてください。",
    dashboard_dist_missing:
      "ダッシュボードの静的ファイルが見つかりません（{path}）。dashboard/dist を生成するには `npm run build` を実行してください。",
    orchestrator_listening_on: "オーケストレーターはポート {port} で待機中です。",
    orchestrator_shutting_down: "シャットダウン中（シグナル: {signal}）。エージェントのランタイムを停止します。",
    stop_signal_sent: "停止シグナルを送信しました。",
    orchestrator_json_not_found: "orchestrator.json が見つかりません。",
    orchestrator_pid_not_found: "orchestrator.json に pid が見つかりません。",
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
    admin_git_push_success: "Admin のリモート {remote} への push が成功しました (ブランチ: {branch})。",
    admin_git_push_failed: "Admin のリモートへの push が失敗しました: {error}",
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
    model_inheritance_missing:
      "{fieldPath} のモデルがありません。明示的に設定するか、親モデルを指定してください（team.worker.model -> team.leader.model -> admin.model -> model）。",
    team_json_not_found_oat_env: "team.json が見つかりません（OAT_TEAM_JSON）: {path}",
    team_json_not_found: "team.json が見つかりません: {path}（プロジェクトディレクトリに移動するか OAT_TEAM_JSON を設定してください）",
    provider_docker_disabled: "DockerProvider は無効です。local_process ランタイムを使用してください。",
    workspace_provider_unimplemented: "Workspace プロバイダー「{provider}」は未実装です",
    worker_registered: "Worker を登録し、ランタイム準備完了。",
    worker_task_dispatched: "Worker にタスクを送信しました。",
    worker_already_registered: "Worker は既に存在します: {workerId}",
    worker_not_registered: "登録済み Worker がありません: {workerId}。Worker は起動時に事前生成されます。",
    started_in_background: "Orchestrator がバックグラウンドで開始されました。ログは {logPath} に書き込まれます",
    dashboard_hint: "管理コンソールを開くには `oat dashboard` を使用してください。",
    project_not_found: "プロジェクトが見つからないか、リンクされていません: {projectId}",
    project_running_cannot_rm: "実行中のプロジェクトは削除できません。先に `oat stop {projectId}` を実行してください。",
    project_removed_success: "プロジェクトが正常に削除されました: {projectId}",
    init_team_json_exists: "現在のディレクトリに team.json が既に存在します。",
    init_success: "現在のディレクトリに team.json を初期化しました。",
    dashboard_no_projects: "ローカルにプロジェクトが見つかりません。まず `oat start` または `oat init` を実行してプロジェクトを作成してください。",
    no_oat_projects_found: "OAT プロジェクトは見つかりませんでした。",
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

