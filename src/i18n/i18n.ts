import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  | "no_oat_projects_found"
  | "channels_title"
  | "channels_no_plugins"
  | "channels_stateful"
  | "channels_stateless"
  | "channels_no_accounts"
  | "channels_account_status"
  | "channels_session_active"
  | "channels_session_expired"
  | "channels_failed"
  | "channel_usage"
  | "channel_plugin_missing"
  | "channel_stateless_no_login"
  | "channel_login_start"
  | "channel_login_success"
  | "channel_login_failed"
  | "plugins_usage"
  | "plugins_installing"
  | "plugins_installed_success"
  | "plugins_installed_hint"
  | "plugins_install_failed"
  | "plugins_uninstalling"
  | "plugins_uninstalled_success"
  | "plugins_uninstall_failed"
  | "channels_running"
  | "list_projects_title"
  | "list_project_id"
  | "list_project_path"
  | "list_project_status"
  | "list_project_uptime"
  | "status_running"
  | "status_stopped"
  | "stop_usage"
  | "stop_success"
  | "stop_none_running"
  | "rm_failed"
  | "log_cleaned_stale_project_links"
  | "log_errors_cleaning_project_links"
  | "log_cleaned_old_agent_logs"
  | "log_agent_log_cleanup_failed"
  | "dashboard_build_not_found"
  | "dashboard_serving_at"
  | "reusing_port"
  | "no_port_available"
  | "init_failed"
  | "channel_validation_failed"
  | "cli_description"
  | "cli_lang_desc"
  | "start_desc"
  | "start_config_desc"
  | "start_goal_desc"
  | "start_port_desc"
  | "start_daemon_desc"
  | "list_desc"
  | "stop_desc"
  | "stop_arg_desc"
  | "stop_all_desc"
  | "rm_desc"
  | "rm_arg_desc"
  | "inspect_desc"
  | "inspect_state_desc"
  | "inspect_ws_desc"
  | "inspect_limit_desc"
  | "docs_desc"
  | "docs_arg_desc"
  | "dashboard_desc"
  | "init_desc"
  | "channels_desc"
  | "channel_desc"
  | "channel_login_desc"
  | "channel_login_arg_channel"
  | "channel_login_arg_account"
  | "plugins_desc"
  | "plugins_install_desc"
  | "plugins_install_arg_package"
  | "plugins_uninstall_desc"
  | "plugins_uninstall_arg_plugin";


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
    channels_title: "OAT Notification Channels Status:",
    channels_no_plugins: "  No channel plugins loaded.",
    channels_stateful: "Stateful",
    channels_stateless: "Stateless",
    channels_no_accounts: "No accounts configured.",
    channels_account_status: "Account: {account} [Status: {status}]",
    channels_session_active: "🔐 Session Active (Logged In)",
    channels_session_expired: "🔑 Session Expired (Not Logged In)",
    channels_failed: "Failed to retrieve channels status: {error}",
    channel_usage: "Usage: oat channel login <channelId> <accountId>",
    channel_plugin_missing: "\n【Plugin Missing ❌】Channel plugin '{channelId}' was not found in system or external directories.\nPlease run the following command to add WeChat/target plugin to enable high-level channels:\n  oat plugins install \"@tencent-weixin/openclaw-weixin\"\n",
    channel_stateless_no_login: "Channel '{channelId}' is stateless or does not require interactive terminal QR login.",
    channel_login_start: "Starting interactive QR scan session for channel '{channelId}', account '{accountId}'...",
    channel_login_success: "Successfully logged in! Session cache saved to: {sessionCachePath}",
    channel_login_failed: "Interactive login encountered a fatal error: {error}",
    plugins_usage: "Usage: oat plugins install <packageName> / oat plugins uninstall <pluginId>",
    plugins_installing: "Installing compatibility plugin '{packageName}'...",
    plugins_installed_success: "Successfully installed plugin '{packageName}' into global plugins directory!",
    plugins_installed_hint: "Run 'oat channels' to verify.",
    plugins_install_failed: "Plugin installation failed: {error}",
    plugins_uninstalling: "Uninstalling compatibility plugin '{pluginId}'...",
    plugins_uninstalled_success: "Successfully uninstalled plugin '{pluginId}' and wiped related sessions & configs!",
    plugins_uninstall_failed: "Uninstall failed: {error}",
    channels_running: "🚀 Running",
    list_projects_title: "\nOAT Projects ({count}):\n",
    list_project_id: "  Project: {id}",
    list_project_path: "  Path:    {path}",
    list_project_status: "  Status:  {status}",
    list_project_uptime: "  Uptime:  {uptime} mins",
    status_running: "RUNNING (PID: {pid}, Port: {port})",
    status_stopped: "STOPPED",
    stop_usage: "Please specify a <projectId> or use --all to stop all projects.",
    stop_success: "Stopped project: {projectId}",
    stop_none_running: "No running projects found to stop.",
    rm_failed: "Failed to remove project data: {error}",
    log_cleaned_stale_project_links: "Cleaned stale project links",
    log_errors_cleaning_project_links: "Errors cleaning project links",
    log_cleaned_old_agent_logs: "Cleaned old agent logs",
    log_agent_log_cleanup_failed: "Agent log cleanup failed",
    dashboard_build_not_found: "Dashboard build not found. Run `pnpm build:dashboard` first.",
    dashboard_already_running: "Dashboard is already running. Opening {url}",
    dashboard_serving_at: "Dashboard serving at {url}",
    reusing_port: "Reusing port {savedPort} from previous state",
    no_port_available: "No available port found in range {start}–{end}",
    init_failed: "Failed to initialize team.json: {error}",
    channel_validation_failed: "[Configuration Error ❌] Channel '{channelId}' configuration validation failed:",
    cli_description: "Agent Team Orchestrator",
    cli_lang_desc: "Output language: en | zh-CN | fr | ja",
    start_desc: "Start orchestrator (team.json: --config or cwd/team.json / OAT_TEAM_JSON)",
    start_config_desc: "path to team.json (default: ./team.json under cwd, or OAT_TEAM_JSON when set)",
    start_goal_desc: "project goal prompt (optional)",
    start_port_desc: "orchestrator HTTP port (0 = auto)",
    start_daemon_desc: "run orchestrator in background (internal use)",
    list_desc: "List all local OAT projects and their orchestrator status",
    stop_desc: "Stop running OAT projects",
    stop_arg_desc: "Project ID to stop",
    stop_all_desc: "Stop all running projects",
    rm_desc: "Remove a project link and its local runtime states/workspaces",
    rm_arg_desc: "Project ID to remove",
    inspect_desc: "Inspect workspace and runtime agent execution progress",
    inspect_state_desc: "path to state directory",
    inspect_ws_desc: "path to workspace root",
    inspect_limit_desc: "max workspace entries to show",
    docs_desc: "Open or view OAT documentation",
    docs_arg_desc: "documentation topic: architecture | config | guide | cli",
    dashboard_desc: "Open the OAT dashboard in the default browser",
    init_desc: "Initialize a new team.json in the current directory",
    channels_desc: "List all configured channels, loaded plugins, and login sessions",
    channel_desc: "Manage individual channels (e.g. interactive terminal QR login)",
    channel_login_desc: "Interactive terminal QR sweep scan for stateful channels (WeChat)",
    channel_login_arg_channel: "Channel plugin ID, e.g. weixin or openclaw-slack",
    channel_login_arg_account: "Unique account identifier",
    plugins_desc: "Manage compatibility plugins (install, uninstall)",
    plugins_install_desc: "Download and install an OpenClaw compatible plugin from NPM",
    plugins_install_arg_package: "NPM package name or local path of the plugin",
    plugins_uninstall_desc: "Uninstall a global compatibility plugin and remove all sessions/configs",
    plugins_uninstall_arg_plugin: "The ID of the plugin, e.g. openclaw-weixin",
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
    channels_title: "OAT 通知渠道状态：",
    channels_no_plugins: "  未加载任何渠道插件。",
    channels_stateful: "有状态",
    channels_stateless: "无状态",
    channels_no_accounts: "未配置任何账号。",
    channels_account_status: "账号：{account} [状态：{status}]",
    channels_session_active: "🔐 会话处于活动状态（已登录）",
    channels_session_expired: "🔑 会话已过期（未登录）",
    channels_failed: "获取渠道状态失败：{error}",
    channel_usage: "用法：oat channel login <channelId> <accountId>",
    channel_plugin_missing: "\n【插件缺失 ❌】未在系统或外部装载目录中找到渠道插件 '{channelId}'。\n请先运行以下命令添加微信/目标插件以启用高阶通道：\n  oat plugins install \"@tencent-weixin/openclaw-weixin\"\n",
    channel_stateless_no_login: "渠道 '{channelId}' 为无状态或不需要交互式终端二维码登录。",
    channel_login_start: "正在为渠道 '{channelId}' 账号 '{accountId}' 启动交互式二维码扫码会话...",
    channel_login_success: "成功登录！会话缓存已保存到：{sessionCachePath}",
    channel_login_failed: "交互式登录遇到致命错误：{error}",
    plugins_usage: "用法：oat plugins install <packageName> / oat plugins uninstall <pluginId>",
    plugins_installing: "正在安装兼容性插件 '{packageName}'...",
    plugins_installed_success: "成功将插件 '{packageName}' 安装到全局插件目录！",
    plugins_installed_hint: "运行 'oat channels' 进行验证。",
    plugins_install_failed: "插件安装失败：{error}",
    plugins_uninstalling: "正在卸载兼容性插件 '{pluginId}'...",
    plugins_uninstalled_success: "成功卸载插件 '{pluginId}' 并擦除了相关的会话和配置！",
    plugins_uninstall_failed: "卸载失败：{error}",
    channels_running: "🚀 正在运行",
    list_projects_title: "\nOAT 项目数量 ({count})：\n",
    list_project_id: "  项目：{id}",
    list_project_path: "  路径：   {path}",
    list_project_status: "  状态：   {status}",
    list_project_uptime: "  运行时间：{uptime} 分钟",
    status_running: "运行中 (PID: {pid}, 端口: {port})",
    status_stopped: "已停止",
    stop_usage: "请指定 <projectId> 或使用 --all 停止所有项目。",
    stop_success: "已停止项目：{projectId}",
    stop_none_running: "未找到正在运行的项目。",
    rm_failed: "移除项目数据失败：{error}",
    log_cleaned_stale_project_links: "清理了过期的项目链接",
    log_errors_cleaning_project_links: "清理项目链接时出错",
    log_cleaned_old_agent_logs: "清理了旧的 Agent 日志",
    log_agent_log_cleanup_failed: "Agent 日志清理失败",
    dashboard_build_not_found: "未找到观测面板构建产物。请先运行 `pnpm build:dashboard`。",
    dashboard_already_running: "观测面板已在运行，正在打开 {url}",
    dashboard_serving_at: "观测面板正在运行于 {url}",
    reusing_port: "复用上次运行状态中的端口 {savedPort}",
    no_port_available: "在范围 {start}–{end} 内未找到可用端口",
    init_failed: "初始化 team.json 失败：{error}",
    channel_validation_failed: "【全局配置格式错误 ❌】渠道 '{channelId}' 参数校验未通过:",
    cli_description: "智能体团队编排器 (Agent Team Orchestrator)",
    cli_lang_desc: "输出语言：en | zh-CN | fr | ja",
    start_desc: "启动编排器（可通过 --config 指定 team.json，或者默认使用当前目录下的 team.json / OAT_TEAM_JSON 环境变量）",
    start_config_desc: "team.json 的路径（默认：当前目录下的 ./team.json，或当设置了 OAT_TEAM_JSON 时的对应值）",
    start_goal_desc: "项目目标 Prompt（可选）",
    start_port_desc: "编排器 HTTP 端口（0 为自动分配）",
    start_daemon_desc: "在后台运行编排器（内部使用）",
    list_desc: "列出所有本地的 OAT 项目及其编排器运行状态",
    stop_desc: "停止运行中的 OAT 项目",
    stop_arg_desc: "要停止的项目 ID",
    stop_all_desc: "停止所有运行中的项目",
    rm_desc: "删除项目链接及其本地运行时状态和工作区数据",
    rm_arg_desc: "要移除的项目 ID",
    inspect_desc: "巡检工作区以及运行时 Agent 执行进度",
    inspect_state_desc: "状态目录的路径",
    inspect_ws_desc: "工作区根目录路径",
    inspect_limit_desc: "要展示的的最大工作区记录数",
    docs_desc: "查看或阅读 OAT 框架多语言详细文档",
    docs_arg_desc: "文档主题：architecture | config | guide | cli",
    dashboard_desc: "在默认浏览器中打开 OAT 观测面板",
    init_desc: "在当前目录下初始化一个新的 team.json 配置",
    channels_desc: "列出所有已配置的通知渠道、已加载插件以及登录会话状态",
    channel_desc: "管理单个渠道（例如，进行交互式终端二维码扫码登录）",
    channel_login_desc: "为有状态渠道（如微信）启动交互式终端二维码扫码登录会话",
    channel_login_arg_channel: "渠道插件 ID，例如 weixin 或 openclaw-slack",
    channel_login_arg_account: "唯一的账号标识符",
    plugins_desc: "管理兼容性插件（安装、卸载）",
    plugins_install_desc: "从 NPM 下载并安装 OpenClaw 兼容的外部渠道插件",
    plugins_install_arg_package: "插件的 NPM 包名或本地路径",
    plugins_uninstall_desc: "卸载全局安装的兼容性插件，并移除相关的会话和配置信息",
    plugins_uninstall_arg_plugin: "插件 ID，例如 openclaw-weixin",
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
    channels_title: "Statut des canaux de notification OAT :",
    channels_no_plugins: "  Aucun plug-in de canal chargé.",
    channels_stateful: "Avec état",
    channels_stateless: "Sans état",
    channels_no_accounts: "Aucun compte configuré.",
    channels_account_status: "Compte : {account} [Statut : {status}]",
    channels_session_active: "🔐 Session active (connectée)",
    channels_session_expired: "🔑 Session expirée (non connectée)",
    channels_failed: "Échec de la récupération du statut des canaux : {error}",
    channel_usage: "Utilisation : oat channel login <channelId> <accountId>",
    channel_plugin_missing: "\n【Plug-in manquant ❌】Le plug-in de canal '{channelId}' n'a pas été trouvé dans le système ou les répertoires externes.\nVeuillez d'abord exécuter la commande suivante pour ajouter le plug-in WeChat/cible afin d'activer les canaux de haut niveau :\n  oat plugins install \"@tencent-weixin/openclaw-weixin\"\n",
    channel_stateless_no_login: "Le canal '{channelId}' est sans état ou ne nécessite pas de connexion QR par terminal interactif.",
    channel_login_start: "Démarrage de la session de scan QR interactif pour le canal '{channelId}', compte '{accountId}'...",
    channel_login_success: "Connexion réussie ! Cache de session enregistré sous : {sessionCachePath}",
    channel_login_failed: "La connexion interactive a rencontré une erreur fatale : {error}",
    plugins_usage: "Utilisation : oat plugins install <packageName> / oat plugins uninstall <pluginId>",
    plugins_installing: "Installation du plug-in de compatibilité '{packageName}'...",
    plugins_installed_success: "Plug-in '{packageName}' installé avec succès dans le répertoire des plug-ins globaux !",
    plugins_installed_hint: "Exécutez 'oat channels' pour vérifier.",
    plugins_install_failed: "Échec de l'installation du plug-in : {error}",
    plugins_uninstalling: "Désinstallation du plug-in de compatibilité '{pluginId}'...",
    plugins_uninstalled_success: "Le plug-in '{pluginId}' a été désinstallé avec succès et les sessions et configurations associées ont été effacées !",
    plugins_uninstall_failed: "Échec de la désinstallation : {error}",
    channels_running: "🚀 En cours d'exécution",
    list_projects_title: "\nProjets OAT ({count}) :\n",
    list_project_id: "  Projet : {id}",
    list_project_path: "  Chemin :  {path}",
    list_project_status: "  Statut : {status}",
    list_project_uptime: "  Uptime : {uptime} min",
    status_running: "EN COURS D'EXÉCUTION (PID : {pid}, Port : {port})",
    status_stopped: "ARRÊTÉ",
    stop_usage: "Veuillez spécifier un <projectId> ou utiliser --all pour arrêter tous les projets.",
    stop_success: "Projet arrêté : {projectId}",
    stop_none_running: "Aucun projet en cours d'exécution trouvé à arrêter.",
    rm_failed: "Échec de la suppression des données du projet : {error}",
    log_cleaned_stale_project_links: "Liens de projets obsolètes nettoyés",
    log_errors_cleaning_project_links: "Erreurs lors du nettoyage des liens de projets",
    log_cleaned_old_agent_logs: "Anciens journaux d'agents nettoyés",
    log_agent_log_cleanup_failed: "Échec du nettoyage des journaux d'agents",
    dashboard_build_not_found: "Build du tableau de bord introuvable. Exécutez d'abord `pnpm build:dashboard`.",
    dashboard_already_running: "Le tableau de bord est déjà en cours d'exécution. Ouverture de {url}",
    dashboard_serving_at: "Tableau de bord disponible sur {url}",
    reusing_port: "Réutilisation du port {savedPort} de l'état précédent",
    no_port_available: "Aucun port disponible trouvé dans la plage {start}–{end}",
    init_failed: "Échec de l'initialisation de team.json : {error}",
    channel_validation_failed: "[Erreur de configuration ❌] Échec de la validation de la configuration du canal '{channelId}' :",
    cli_description: "Orchestrateur de Team d'Agents",
    cli_lang_desc: "Langue de sortie : en | zh-CN | fr | ja",
    start_desc: "Démarrer l'orchestrateur (team.json : --config ou cwd/team.json / OAT_TEAM_JSON)",
    start_config_desc: "chemin vers team.json (par défaut : ./team.json sous cwd, ou OAT_TEAM_JSON s'il est défini)",
    start_goal_desc: "invite d'objectif de projet (facultatif)",
    start_port_desc: "port HTTP de l'orchestrateur (0 = auto)",
    start_daemon_desc: "exécuter l'orchestrateur en arrière-plan (usage interne)",
    list_desc: "Lister tous les projets OAT locaux et leur statut d'orchestrateur",
    stop_desc: "Arrêter les projets OAT en cours d'exécution",
    stop_arg_desc: "ID de projet à arrêter",
    stop_all_desc: "Arrêter tous les projets en cours d'exécution",
    rm_desc: "Supprimer un lien de projet et ses états/workspaces de runtime locaux",
    rm_arg_desc: "ID de projet à supprimer",
    inspect_desc: "Inspecter le workspace et la progression de l'exécution de l'agent",
    inspect_state_desc: "chemin vers le répertoire d'état",
    inspect_ws_desc: "chemin vers la racine du workspace",
    inspect_limit_desc: "nombre maximal d'entrées de workspace à afficher",
    docs_desc: "Ouvrir ou afficher la documentation OAT",
    docs_arg_desc: "sujet de documentation : architecture | config | guide | cli",
    dashboard_desc: "Ouvrir le tableau de bord OAT dans le navigateur par défaut",
    init_desc: "Initialiser un nouveau team.json dans le répertoire courant",
    channels_desc: "Lister tous les canaux configurés, les plug-ins chargés et les sessions de connexion",
    channel_desc: "Gérer les canaux individuels (par exemple, connexion QR de terminal interactif)",
    channel_login_desc: "Scan QR de terminal interactif pour les canaux avec état (WeChat)",
    channel_login_arg_channel: "ID du plug-in de canal, par exemple weixin ou openclaw-slack",
    channel_login_arg_account: "Identifiant de compte unique",
    plugins_desc: "Gérer les plug-ins de compatibilité (installer, désinstaller)",
    plugins_install_desc: "Télécharger et installer un plug-in compatible OpenClaw depuis NPM",
    plugins_install_arg_package: "Nom du package NPM ou chemin local du plug-in",
    plugins_uninstall_desc: "Désinstaller un plug-in de compatibilité globale et supprimer toutes les sessions/configs",
    plugins_uninstall_arg_plugin: "L'ID du plug-in, par exemple openclaw-weixin",
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
    channels_title: "OAT 通知チャネルのステータス:",
    channels_no_plugins: "  チャネルプラグインがロードされていません。",
    channels_stateful: "ステートフル",
    channels_stateless: "ステートレス",
    channels_no_accounts: "アカウントが設定されていません。",
    channels_account_status: "アカウント: {account} [ステータス: {status}]",
    channels_session_active: "🔐 セッション有効 (ログイン済み)",
    channels_session_expired: "🔑 セッション期限切れ (未ログイン)",
    channels_failed: "チャネルステータスの取得に失敗しました: {error}",
    channel_usage: "使用法: oat channel login <channelId> <accountId>",
    channel_plugin_missing: "\n【プラグインがありません ❌】システムまたは外部ディレクトリにチャネルプラグイン '{channelId}' が見つかりませんでした。\n高機能チャネルを有効にするには、まず次のコマンドを実行して WeChat/対象プラグインを追加してください:\n  oat plugins install \"@tencent-weixin/openclaw-weixin\"\n",
    channel_stateless_no_login: "チャネル '{channelId}' はステートレスであるか、インタラクティブな端末 QR ログインを必要としません。",
    channel_login_start: "チャネル '{channelId}'、アカウント '{accountId}' のインタラクティブ QR スキャンセッションを開始しています...",
    channel_login_success: "ログインに成功しました！セッションキャッシュは次の場所に保存されました: {sessionCachePath}",
    channel_login_failed: "インタラクティブログインで致命的なエラーが発生しました: {error}",
    plugins_usage: "使用法: oat plugins install <packageName> / oat plugins uninstall <pluginId>",
    plugins_installing: "互換性プラグイン '{packageName}' をインストールしています...",
    plugins_installed_success: "グローバルプラグインディレクトリにプラグイン '{packageName}' を正常にインストールしました！",
    plugins_installed_hint: "確認するには 'oat channels' を実行してください。",
    plugins_install_failed: "プラグインのインストールに失敗しました: {error}",
    plugins_uninstalling: "互換性プラグイン '{pluginId}' をアンインストールしています...",
    plugins_uninstalled_success: "プラグイン '{pluginId}' を正常にアンインストールし、関連するセッションと設定を削除しました！",
    plugins_uninstall_failed: "アンインストールに失敗しました: {error}",
    channels_running: "🚀 実行中",
    list_projects_title: "\nOAT プロジェクト ({count}):\n",
    list_project_id: "  プロジェクト: {id}",
    list_project_path: "  パス:    {path}",
    list_project_status: "  ステータス: {status}",
    list_project_uptime: "  稼働時間: {uptime} 分",
    status_running: "実行中 (PID: {pid}, ポート: {port})",
    status_stopped: "停止",
    stop_usage: "プロジェクトを指定するか、--all を使用してすべてのプロジェクトを停止してください。",
    stop_success: "プロジェクトを停止しました: {projectId}",
    stop_none_running: "停止する実行中のプロジェクトが見つかりません。",
    rm_failed: "プロジェクトデータの削除に失敗しました: {error}",
    log_cleaned_stale_project_links: "古いプロジェクトリンクをクリーンアップしました",
    log_errors_cleaning_project_links: "プロジェクトリンクのクリーンアップ中にエラーが発生しました",
    log_cleaned_old_agent_logs: "古いエージェントログをクリーンアップしました",
    log_agent_log_cleanup_failed: "エージェントログのクリーンアップに失敗しました",
    dashboard_build_not_found: "ダッシュボードのビルドが見つかりません。先に `pnpm build:dashboard` を実行してください。",
    dashboard_already_running: "ダッシュボードは既に起動しています。{url} を開いています",
    dashboard_serving_at: "ダッシュボードを {url} で起動しました",
    reusing_port: "以前の状態から保存されたポート {savedPort} を再利用しています",
    no_port_available: "範囲 {start}–{end} 内に使用可能なポートが見つかりません",
    init_failed: "team.json の初期化に失敗しました: {error}",
    channel_validation_failed: "【グローバル設定フォーマットエラー ❌】チャネル '{channelId}' のパラメータ検証に失敗しました:",
    cli_description: "スマートエージェントチームのオーケストレーター (Agent Team Orchestrator)",
    cli_lang_desc: "出力言語：en | zh-CN | fr | ja",
    start_desc: "オーケストレーターの開始（--config で team.json を指定可能、または現在のディレクトリの team.json / OAT_TEAM_JSON 環境変数を使用）",
    start_config_desc: "team.json へのパス（デフォルト：現在のディレクトリの ./team.json、または OAT_TEAM_JSON が設定されている場合はその値）",
    start_goal_desc: "プロジェクト目標プロンプト（オプション）",
    start_port_desc: "オーケストレーターの HTTP ポート（0 = 自動割り当て）",
    start_daemon_desc: "オーケストレーターをバックグラウンドで起動（内部使用）",
    list_desc: "すべてのローカル OAT プロジェクトとそのオーケストレーターのステータスを一覧表示",
    stop_desc: "実行中の OAT プロジェクトを停止",
    stop_arg_desc: "停止するプロジェクト ID",
    stop_all_desc: "実行中のすべてのプロジェクトを停止",
    rm_desc: "プロジェクトのリンクとローカルランタイムの状態/ワークスペースを削除",
    rm_arg_desc: "削除するプロジェクト ID",
    inspect_desc: "ワークスペースとランタイムエージェントの実行進行状況を検査",
    inspect_state_desc: "状態ディレクトリのパス",
    inspect_ws_desc: "ワークスペースのルートパス",
    inspect_limit_desc: "表示する最大ワークスペースエントリー数",
    docs_desc: "OAT ドキュメントを開くか表示",
    docs_arg_desc: "ドキュメントトピック：architecture | config | guide | cli",
    dashboard_desc: "デフォルトのブラウザで OAT ダッシュボードを開く",
    init_desc: "現在のディレクトリに新しい team.json を初期化",
    channels_desc: "構成されたすべてのチャネル、ロードされたプラグイン、およびログインセッションを一覧表示",
    channel_desc: "個々のチャネルの管理（例：インタラクティブな端末 QR ログイン）",
    channel_login_desc: "状態保存チャネル（WeChatなど）用のインタラクティブな端末 QR スキャン",
    channel_login_arg_channel: "チャネルプラグイン ID（例：weixin または openclaw-slack）",
    channel_login_arg_account: "一意のアカウント識別子",
    plugins_desc: "互換性プラグインの管理（インストール、アンインストール）",
    plugins_install_desc: "NPM から OpenClaw 互換プラグインをダウンロードしてインストール",
    plugins_install_arg_package: "プラグイン of NPM パッケージ名またはローカルパス",
    plugins_uninstall_desc: "グローバル互換性プラグインをアンインストールし、関連するすべてのセッションと設定をクリーンアップ",
    plugins_uninstall_arg_plugin: "プラグインの ID（例：openclaw-weixin）",
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

export async function loadLangFromOatJson(): Promise<Lang | null> {
  const p = path.join(os.homedir(), ".oat", "oat.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as any;
    const lang = parsed?.language ?? parsed?.lang ?? parsed?.i18n?.language ?? parsed?.i18n?.lang;
    return toLang(lang);
  } catch {
    return null;
  }
}

