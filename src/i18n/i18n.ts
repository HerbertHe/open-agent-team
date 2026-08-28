import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type Lang = "en" | "zh-CN" | "fr" | "ja";

type MessageKey =
  | "orchestrator_started"
  | "start_observability_hint"
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
  | "workspace_provider_unimplemented"
  | "worker_registered"
  | "worker_task_dispatched"
  | "worker_already_registered"
  | "worker_not_registered"
  | "started_in_background"
  | "desktop_hint"
  | "project_not_found"
  | "project_running_cannot_rm"
  | "project_removed_success"
  | "init_team_json_exists"
  | "init_success"
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
  | "plugins_uninstall_arg_plugin"
  | "scheduler_persist_failed"
  | "scheduler_snapshot_quarantined"
  | "scheduler_restart_workflow_failed"
  | "scheduler_target_missing"
  | "scheduler_restart_event_failed"
  | "scheduler_root_delivery_completed"
  | "scheduler_root_delivery_rejected"
  | "scheduler_owner_unavailable"
  | "scheduler_event_delivery_failed"
  | "scheduler_daily_capacity"
  | "scheduler_parent_not_found"
  | "scheduler_prompt_required"
  | "scheduler_task_conflict"
  | "scheduler_task_not_found"
  | "scheduler_only_queued_modifiable"
  | "scheduler_reorder_invalid"
  | "scheduler_delete_active"
  | "scheduler_delete_has_children"
  | "scheduler_unsupported_role"
  | "scheduler_worker_no_team"
  | "scheduler_leader_unavailable_review"
  | "scheduler_role_expected"
  | "scheduler_worker_no_active_git_task"
  | "scheduler_task_no_leader_owner"
  | "scheduler_task_no_leader_workflow"
  | "scheduler_review_commit_required"
  | "scheduler_review_not_owned"
  | "scheduler_review_original_missing"
  | "scheduler_review_changes_requested"
  | "scheduler_review_wrong_branch"
  | "scheduler_leader_no_active_work"
  | "scheduler_release_unfinished_children"
  | "scheduler_release_requires_review"
  | "scheduler_release_transition_invalid"
  | "scheduler_worker_count_invalid"
  | "scheduler_dispatch_no_active_workflow"
  | "scheduler_dispatch_requires_tasks"
  | "scheduler_dispatch_requires_independence"
  | "scheduler_no_registered_workers"
  | "scheduler_dispatch_prompt_required"
  | "scheduler_duplicate_conflict_key"
  | "scheduler_notify_role_mismatch"
  | "scheduler_worker_must_submit_review"
  | "scheduler_leader_completion_blocked"
  | "git_remote_name_invalid"
  | "git_remote_url_requires_name"
  | "git_push_requires_remote"
  | "git_push_requires_identity"
  | "git_push_remote_not_configured"
  | "git_push_requires_merged_release"
  | "git_push_disabled"
  | "git_push_release_not_head"
  | "git_push_commit_identity_mismatch"
  | "git_base_worktree_dirty"
  | "scheduler_delegated"
  | "scheduler_leader_crashed"
  | "scheduler_admin_no_active_task"
  | "scheduler_leader_task_queued"
  | "scheduler_release_proposal_required"
  | "scheduler_release_waiting_approval"
  | "notification_delivery_success"
  | "notification_progress"
  | "notification_agent_crashed"
  | "scheduler_agent_crashed"
  | "operation_failed"
  | "runtime_docker_required"
  | "docker_extra_arg_unsafe"
  | "docker_runtime_bundle_missing"
  | "docker_command_timeout"
  | "docker_agent_already_running"
  | "docker_container_name_conflict"
  | "docker_agent_exited"
  | "docker_agent_start_timeout"
  | "docker_agent_not_running"
  | "docker_network_invalid"
  | "docker_extra_args_invalid"
  | "docker_runtime_downgrade_forbidden"
  | "docker_runtime_not_enabled"
  | "docker_agent_restart_busy"
  | "docker_git_worktree_invalid"
  | "docker_engine_unavailable"
  | "docker_container_cleanup_failed"
  | "image_redirect_limit"
  | "image_download_failed"
  | "worker_pool_pre_spawn"
  | "resources_file_exists"
  | "resources_intro"
  | "resources_project_name"
  | "resources_repo_path"
  | "resources_base_branch"
  | "resources_base_branch_invalid"
  | "resources_default_model"
  | "resources_provider_protocol"
  | "resources_provider_protocol_invalid"
  | "resources_provider_base_url"
  | "resources_provider_api_key"
  | "resources_runtime_mode"
  | "resources_runtime_mode_invalid"
  | "resources_docker_image"
  | "resources_docker_network"
  | "resources_docker_extra_args"
  | "resources_team_count"
  | "resources_positive_integer"
  | "resources_team_heading"
  | "resources_team_id"
  | "resources_leader_responsibility"
  | "resources_worker_capacity"
  | "resources_allowed_paths";


const messages: Record<Lang, Record<MessageKey, string>> = {
  en: {
    orchestrator_started: "Orchestrator started.",
    start_observability_hint:
      "Orchestrator is running on port {port}. Open OAT Desktop to manage it.",
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
    workspace_provider_unimplemented: 'Workspace provider "{provider}" is not implemented yet',
    worker_registered: "Worker registered and runtime ready.",
    worker_task_dispatched: "Dispatched task to worker.",
    worker_already_registered: "Worker already exists: {workerId}",
    worker_not_registered: "No registered worker for id: {workerId}. Workers are pre-spawned at startup.",
    started_in_background: "Orchestrator started in background. Logs are written to {logPath}",
    desktop_hint: "Open OAT Desktop to manage projects and agents.",
    project_not_found: "Project not found or not linked: {projectId}",
    project_running_cannot_rm: "Cannot remove running project. Please run `oat stop {projectId}` first.",
    project_removed_success: "Project removed successfully: {projectId}",
    init_team_json_exists: "team.json already exists in the current directory.",
    init_success: "Initialized team.json in the current directory.",
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
    scheduler_persist_failed: "Failed to persist scheduler state: {error}",
    scheduler_snapshot_quarantined: "Invalid scheduler snapshot quarantined: {path}",
    scheduler_restart_workflow_failed: "The orchestrator restarted before this workflow reached a terminal state; recover or reassign it.",
    scheduler_target_missing: "Configured target Agent no longer exists: {agentId}",
    scheduler_restart_event_failed: "The orchestrator restarted before this event was acknowledged; recover the persisted review manually.",
    scheduler_owner_unavailable: "The owning Leader workflow is no longer available.",
    scheduler_event_delivery_failed: "Scheduler event delivery failed during {operation}: {error}",
    scheduler_daily_capacity: "Daily task capacity reached for {date}.",
    scheduler_parent_not_found: "Parent task not found: {taskId}",
    scheduler_prompt_required: "{operation}: prompt must be non-empty.",
    scheduler_task_conflict: "Task conflicts with active task {taskId} ({status}).",
    scheduler_task_not_found: "Task not found: {taskId}",
    scheduler_only_queued_modifiable: "Only queued tasks can be modified: {taskId}",
    scheduler_reorder_invalid: "Task reorder must include every queued task for the selected Agent exactly once.",
    scheduler_delete_active: "Cannot delete active task {taskId}; wait for its workflow to finish or cancel it.",
    scheduler_delete_has_children: "Cannot delete task {taskId} while {count} child task record(s) still reference it.",
    scheduler_unsupported_role: "Tasks cannot target role {role}.",
    scheduler_worker_no_team: "Worker {agentId} has no team.",
    scheduler_leader_unavailable_review: "Leader {leaderId} is unavailable; review {reviewId} remains persisted for recovery.",
    scheduler_role_expected: "Agent {agentId} must have role {role}.",
    scheduler_worker_no_active_git_task: "Worker {agentId} has no active Git task to submit.",
    scheduler_task_no_leader_owner: "Task {taskId} has no Leader owner.",
    scheduler_task_no_leader_workflow: "Task {taskId} has no persisted Leader workflow.",
    scheduler_review_commit_required: "Review submission requires a committed change for {taskId}.",
    scheduler_review_not_owned: "Review {reviewId} is not owned by {leaderId}.",
    scheduler_review_original_missing: "Original task {taskId} is unavailable for a changes-requested retry.",
    scheduler_review_changes_requested: "Changes requested in review {reviewId}: {note}",
    scheduler_review_wrong_branch: "Leader must review from integration branch {expected}; current branch is {actual}.",
    scheduler_leader_no_active_work: "Leader {leaderId} has no active work item.",
    scheduler_release_unfinished_children: "Release proposal blocked by {count} unfinished child task(s).",
    scheduler_release_requires_review: "A release proposal requires at least one merged, reviewed Worker branch.",
    scheduler_release_transition_invalid: "Release {proposalId} is already {status} and cannot be {action}.",
    scheduler_worker_count_invalid: "Worker count must be an integer greater than zero.",
    scheduler_dispatch_no_active_workflow: "Leader {leaderId} has no active workflow to dispatch.",
    scheduler_dispatch_requires_tasks: "Worker dispatch requires at least one implementation task.",
    scheduler_dispatch_requires_independence: "A multi-Worker dispatch requires every task to be independent; each implementation Worker must run its own tests.",
    scheduler_no_registered_workers: "No registered Workers are available for team {teamName}.",
    scheduler_dispatch_prompt_required: "Every dispatched Worker task must have a non-empty prompt.",
    scheduler_duplicate_conflict_key: "Dispatch contains duplicate conflict key: {key}",
    scheduler_notify_role_mismatch: "Completion role mismatch: Agent {agentId} is {actual}, not {expected}.",
    scheduler_worker_must_submit_review: "Workers must submit a review after committing and self-testing; completion cannot merge a Worker branch.",
    scheduler_leader_completion_blocked: "Leader {leaderId} cannot complete while {count} Worker task(s) remain active.",
    git_remote_name_invalid: "The Git remote name contains unsupported characters.",
    git_remote_url_requires_name: "A Git remote URL requires a remote name.",
    git_push_requires_remote: "Remote publishing requires a configured Git remote.",
    git_push_requires_identity: "Remote publishing requires a valid local Git user name and email.",
    git_push_remote_not_configured: "Git remote {remote} is not configured in this repository.",
    git_push_requires_merged_release: "Release {proposalId} must be merged locally before it can be pushed.",
    git_push_disabled: "Remote publishing is disabled for this project.",
    git_push_release_not_head: "Release {proposalId} is not the current base-branch head and cannot be pushed.",
    git_push_commit_identity_mismatch: "Release {proposalId} was not merged with the configured Git identity and cannot be pushed.",
    git_base_worktree_dirty: "The worktree for base branch {branch} has local changes or moved during release approval. Clean it before merging.",
    scheduler_delegated: "Task delegated to {leaderName} ({taskId}); progress and delivery will be reported here.",
    scheduler_leader_crashed: "Leader {leaderId} has crashed and cannot accept work.",
    scheduler_admin_no_active_task: "Admin {adminId} has no active task to delegate.",
    scheduler_leader_task_queued: "Leader task queued: {taskId}",
    scheduler_release_proposal_required: "The Leader must submit a release proposal after integration tests before completing the work item.",
    scheduler_release_waiting_approval: "Team {teamName} completed implementation and integration tests and submitted release proposal {proposalId}. Waiting for Admin approval; final delivery status will be updated afterward.",
    scheduler_root_delivery_completed: "Release {proposalId} was approved and merged. The original operator task is complete.",
    scheduler_root_delivery_rejected: "Release {proposalId} was rejected. The original operator task failed: {note}",
    notification_delivery_success: "Delivery succeeded: Admin pushed the approved release to {remote} ({branch}).",
    notification_progress: "Agent {agentId} progress — stage: {stage}; message: {message}",
    notification_agent_crashed: "Agent {agentId} ({role}) crashed: {error}",
    scheduler_agent_crashed: "Agent crashed: {error}",
    operation_failed: "Operation {operation} failed: {error}",
    runtime_docker_required: "runtime.docker is required when runtime mode is Docker.",
    docker_extra_arg_unsafe: "Docker argument {arg} is not allowed. Only bounded resource and hardening flags are supported.",
    docker_runtime_bundle_missing: "The Docker Agent runtime bundle could not be located. Build or reinstall OAT first.",
    docker_command_timeout: "The Docker command timed out.",
    docker_agent_already_running: "Docker Agent {agentId} is already running.",
    docker_container_name_conflict: "Docker container name {name} is owned by another container.",
    docker_agent_exited: "Docker Agent {agentId} exited with code {code}.",
    docker_agent_start_timeout: "Docker Agent {agentId} did not become ready before the timeout.",
    docker_agent_not_running: "Docker Agent {agentId} is not running.",
    docker_network_invalid: "The Docker network mode is invalid.",
    docker_extra_args_invalid: "runtime.docker.extra_args must be an array of strings.",
    docker_runtime_downgrade_forbidden: "A project migrated to Docker isolation cannot be changed back to local process isolation.",
    docker_runtime_not_enabled: "This project is not using the Docker runtime.",
    docker_agent_restart_busy: "Docker Agent {agentId} has active work and cannot be restarted.",
    docker_git_worktree_invalid: "The Git worktree metadata for Docker Agent {agentId} is outside the repository common directory.",
    docker_engine_unavailable: "Docker Engine is unavailable: {error}",
    docker_container_cleanup_failed: "The stale OAT container {name} could not be removed: {error}",
    image_redirect_limit: "Image download exceeded the redirect limit.",
    image_download_failed: "Image download failed with HTTP status {status}.",
    worker_pool_pre_spawn: "Pre-spawning Worker pool for team {teamName} ({count} Workers).",
    resources_file_exists: "{path} already exists. Run again with --force to replace it.",
    resources_intro: "Open Agent Team · Agent Resources\nA guided interview will create and validate team.json.",
    resources_project_name: "Project name",
    resources_repo_path: "Repository path",
    resources_base_branch: "Production branch (main/master)",
    resources_base_branch_invalid: "Production branch must be main or master.",
    resources_default_model: "Default model (provider/model)",
    resources_provider_protocol: "Provider protocol (openai/anthropic)",
    resources_provider_protocol_invalid: "Provider protocol must be openai or anthropic.",
    resources_provider_base_url: "Provider base URL (optional)",
    resources_provider_api_key: "Provider API key (optional; avoid committing real secrets)",
    resources_runtime_mode: "Runtime isolation (local_process/docker)",
    resources_runtime_mode_invalid: "Runtime must be local_process or docker.",
    resources_docker_image: "Docker image",
    resources_docker_network: "Docker network (none/bridge/host)",
    resources_docker_extra_args: "Docker extra arguments, comma-separated (optional)",
    resources_team_count: "How many teams?",
    resources_positive_integer: "{field} must be a positive integer.",
    resources_team_heading: "Team {index}/{count}",
    resources_team_id: "Team identifier",
    resources_leader_responsibility: "Leader responsibility",
    resources_worker_capacity: "Worker capacity",
    resources_allowed_paths: "Allowed repository paths, comma-separated (optional)",
  },
  "zh-CN": {
    orchestrator_started: "编排器已启动。",
    start_observability_hint:
      "编排器已在端口 {port} 上运行。请打开 OAT Desktop 进行管理。",
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
    workspace_provider_unimplemented: "Workspace 策略「{provider}」尚未实现",
    worker_registered: "Worker 已注册，运行时就绪。",
    worker_task_dispatched: "已向 Worker 下发任务。",
    worker_already_registered: "Worker 已存在：{workerId}",
    worker_not_registered: "未找到已注册的 Worker：{workerId}。Worker 在启动时已预先创建。",
    started_in_background: "Orchestrator 已在后台启动。日志已写入：{logPath}",
    desktop_hint: "请打开 OAT Desktop 管理项目和 Agent。",
    project_not_found: "未找到项目或项目未链接：{projectId}",
    project_running_cannot_rm: "项目正在运行，无法删除。请先运行 `oat stop {projectId}`。",
    project_removed_success: "项目已成功移除：{projectId}",
    init_team_json_exists: "当前目录已存在 team.json。",
    init_success: "已在当前目录初始化 team.json。",
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
    scheduler_persist_failed: "调度器状态持久化失败：{error}",
    scheduler_snapshot_quarantined: "无效的调度器快照已隔离：{path}",
    scheduler_restart_workflow_failed: "编排器在工作流进入终态前重启，请恢复或重新分配该任务。",
    scheduler_target_missing: "配置中的目标 Agent 已不存在：{agentId}",
    scheduler_restart_event_failed: "编排器在事件确认前重启，请手动恢复已持久化的评审。",
    scheduler_owner_unavailable: "所属 Leader 工作流已不可用。",
    scheduler_event_delivery_failed: "调度事件在 {operation} 阶段投递失败：{error}",
    scheduler_daily_capacity: "{date} 的每日任务容量已用尽。",
    scheduler_parent_not_found: "未找到父任务：{taskId}",
    scheduler_prompt_required: "{operation}：提示内容不能为空。",
    scheduler_task_conflict: "任务与活动任务 {taskId}（{status}）冲突。",
    scheduler_task_not_found: "未找到任务：{taskId}",
    scheduler_only_queued_modifiable: "只能修改排队中的任务：{taskId}",
    scheduler_reorder_invalid: "任务重排必须且只能包含所选 Agent 的全部排队任务。",
    scheduler_delete_active: "无法删除活动任务 {taskId}；请等待工作流结束或取消任务。",
    scheduler_delete_has_children: "无法删除任务 {taskId}，仍有 {count} 条子任务记录引用它。",
    scheduler_unsupported_role: "任务不能分配给角色 {role}。",
    scheduler_worker_no_team: "Worker {agentId} 不属于任何团队。",
    scheduler_leader_unavailable_review: "Leader {leaderId} 不可用；评审 {reviewId} 已保留以供恢复。",
    scheduler_role_expected: "Agent {agentId} 必须是 {role} 角色。",
    scheduler_worker_no_active_git_task: "Worker {agentId} 没有可提交的活动 Git 任务。",
    scheduler_task_no_leader_owner: "任务 {taskId} 没有 Leader 负责人。",
    scheduler_task_no_leader_workflow: "任务 {taskId} 没有已持久化的 Leader 工作流。",
    scheduler_review_commit_required: "提交评审前必须为任务 {taskId} 创建提交。",
    scheduler_review_not_owned: "评审 {reviewId} 不属于 Leader {leaderId}。",
    scheduler_review_original_missing: "原任务 {taskId} 不可用，无法创建修改重试任务。",
    scheduler_review_changes_requested: "评审 {reviewId} 要求修改：{note}",
    scheduler_review_wrong_branch: "Leader 必须在集成分支 {expected} 上评审；当前分支为 {actual}。",
    scheduler_leader_no_active_work: "Leader {leaderId} 没有活动任务。",
    scheduler_release_unfinished_children: "仍有 {count} 个未完成子任务，无法提交发布提案。",
    scheduler_release_requires_review: "发布提案至少需要一个已合并且已评审的 Worker 分支。",
    scheduler_release_transition_invalid: "发布提案 {proposalId} 已处于 {status} 状态，无法执行{action}。",
    scheduler_worker_count_invalid: "Worker 数量必须是大于零的整数。",
    scheduler_dispatch_no_active_workflow: "Leader {leaderId} 没有可分派的活动工作流。",
    scheduler_dispatch_requires_tasks: "Worker 分派至少需要一个实现任务。",
    scheduler_dispatch_requires_independence: "多 Worker 分派要求所有任务相互独立，且每个实现 Worker 必须自行测试。",
    scheduler_no_registered_workers: "团队 {teamName} 没有可用的已注册 Worker。",
    scheduler_dispatch_prompt_required: "每个分派给 Worker 的任务都必须包含非空提示内容。",
    scheduler_duplicate_conflict_key: "分派中包含重复的冲突键：{key}",
    scheduler_notify_role_mismatch: "完成通知角色不匹配：Agent {agentId} 是 {actual}，不是 {expected}。",
    scheduler_worker_must_submit_review: "Worker 必须在提交并自测后发起评审；完成通知不能合并 Worker 分支。",
    scheduler_leader_completion_blocked: "仍有 {count} 个 Worker 任务处于活动状态，Leader {leaderId} 无法完成。",
    git_remote_name_invalid: "Git 远程名称包含不支持的字符。",
    git_remote_url_requires_name: "配置 Git 远程地址时必须同时填写远程名称。",
    git_push_requires_remote: "启用远程发布前必须配置 Git 远程仓库。",
    git_push_requires_identity: "启用远程发布前必须配置有效的本地 Git 用户名和邮箱。",
    git_push_remote_not_configured: "当前仓库未配置 Git 远程 {remote}。",
    git_push_requires_merged_release: "发布提案 {proposalId} 必须先完成本地合并才能推送。",
    git_push_disabled: "当前项目未启用远程发布。",
    git_push_release_not_head: "发布提案 {proposalId} 不是当前主分支 HEAD，不能推送。",
    git_push_commit_identity_mismatch: "发布提案 {proposalId} 的合并提交未使用当前配置的 Git 身份，不能推送。",
    git_base_worktree_dirty: "主分支 {branch} 的 worktree 存在本地修改或在审批期间发生移动，请先清理后再合并。",
    scheduler_delegated: "任务已分配给 {leaderName}（{taskId}），后续进度和交付结果会在此汇报。",
    scheduler_leader_crashed: "Leader {leaderId} 已崩溃，无法接收任务。",
    scheduler_admin_no_active_task: "Admin {adminId} 没有可分派的活动任务。",
    scheduler_leader_task_queued: "Leader 任务已排队：{taskId}",
    scheduler_release_proposal_required: "Leader 必须在集成测试后提交发布提案，才能完成当前任务。",
    scheduler_release_waiting_approval: "团队「{teamName}」已完成实现与集成测试，并提交发布提案 {proposalId}。正在等待 Admin 审批，完成后会更新最终交付状态。",
    scheduler_root_delivery_completed: "发布提案 {proposalId} 已审批并完成合并，原始任务交付完成。",
    scheduler_root_delivery_rejected: "发布提案 {proposalId} 未通过审批，原始任务失败：{note}",
    notification_delivery_success: "交付成功：Admin 已将审批通过的发布推送到 {remote}（{branch}）。",
    notification_progress: "Agent {agentId} 进度——阶段：{stage}；消息：{message}",
    notification_agent_crashed: "Agent {agentId}（{role}）已崩溃：{error}",
    scheduler_agent_crashed: "Agent 已崩溃：{error}",
    operation_failed: "操作 {operation} 失败：{error}",
    runtime_docker_required: "Docker 运行模式必须配置 runtime.docker。",
    docker_extra_arg_unsafe: "不允许使用 Docker 参数 {arg}；仅支持受限的资源和安全加固参数。",
    docker_runtime_bundle_missing: "找不到 Docker Agent runtime 构建产物，请先构建或重新安装 OAT。",
    docker_command_timeout: "Docker 命令执行超时。",
    docker_agent_already_running: "Docker Agent {agentId} 已在运行。",
    docker_container_name_conflict: "Docker 容器名称 {name} 已被其他容器占用。",
    docker_agent_exited: "Docker Agent {agentId} 已退出，退出码为 {code}。",
    docker_agent_start_timeout: "Docker Agent {agentId} 未能在超时前就绪。",
    docker_agent_not_running: "Docker Agent {agentId} 未运行。",
    docker_network_invalid: "Docker 网络模式无效。",
    docker_extra_args_invalid: "runtime.docker.extra_args 必须是字符串数组。",
    docker_runtime_downgrade_forbidden: "项目迁移到 Docker 隔离后，不允许降级回本地进程隔离。",
    docker_runtime_not_enabled: "当前项目未使用 Docker runtime。",
    docker_agent_restart_busy: "Docker Agent {agentId} 正在处理任务，不能重启。",
    docker_git_worktree_invalid: "Docker Agent {agentId} 的 Git worktree 元数据不在仓库 common dir 内。",
    docker_engine_unavailable: "Docker Engine 不可用：{error}",
    docker_container_cleanup_failed: "无法清理旧的 OAT 容器 {name}：{error}",
    image_redirect_limit: "图片下载超过重定向次数限制。",
    image_download_failed: "图片下载失败，HTTP 状态码：{status}。",
    worker_pool_pre_spawn: "正在为团队 {teamName} 预创建 Worker 池（{count} 个）。",
    resources_file_exists: "{path} 已存在，请使用 --force 重新运行以覆盖。",
    resources_intro: "Open Agent Team · Agent 资源配置\n引导式问答将创建并校验 team.json。",
    resources_project_name: "项目名称",
    resources_repo_path: "仓库路径",
    resources_base_branch: "生产分支（main/master）",
    resources_base_branch_invalid: "生产分支必须是 main 或 master。",
    resources_default_model: "默认模型（provider/model）",
    resources_provider_protocol: "Provider 协议（openai/anthropic）",
    resources_provider_protocol_invalid: "Provider 协议必须是 openai 或 anthropic。",
    resources_provider_base_url: "Provider 基础 URL（可选）",
    resources_provider_api_key: "Provider API Key（可选；请勿提交真实密钥）",
    resources_runtime_mode: "运行隔离模式（local_process/docker）",
    resources_runtime_mode_invalid: "运行模式必须是 local_process 或 docker。",
    resources_docker_image: "Docker 镜像",
    resources_docker_network: "Docker 网络（none/bridge/host）",
    resources_docker_extra_args: "Docker 附加参数，逗号分隔（可选）",
    resources_team_count: "团队数量",
    resources_positive_integer: "{field} 必须是正整数。",
    resources_team_heading: "团队 {index}/{count}",
    resources_team_id: "团队标识",
    resources_leader_responsibility: "Leader 职责",
    resources_worker_capacity: "Worker 容量",
    resources_allowed_paths: "允许的仓库路径，逗号分隔（可选）",
  },
  fr: {
    orchestrator_started: "Orchestrateur démarré.",
    start_observability_hint:
      "L'orchestrateur est en cours d'exécution sur le port {port}. Ouvrez OAT Desktop pour le gérer.",
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
    workspace_provider_unimplemented: 'Le fournisseur de workspace « {provider} » n\'est pas encore implémenté',
    worker_registered: "Worker enregistré, runtime prêt.",
    worker_task_dispatched: "Tâche envoyée au worker.",
    worker_already_registered: "Worker déjà présent : {workerId}",
    worker_not_registered: "Aucun worker enregistré pour {workerId}. Les workers sont pré-créés au démarrage.",
    started_in_background: "L'orchestrateur a démarré en arrière-plan. Journaux écrits dans {logPath}",
    desktop_hint: "Ouvrez OAT Desktop pour gérer les projets et les agents.",
    project_not_found: "Projet introuvable ou non lié : {projectId}",
    project_running_cannot_rm: "Impossible de supprimer un projet en cours d'exécution. Veuillez d'abord exécuter `oat stop {projectId}`.",
    project_removed_success: "Projet supprimé avec succès : {projectId}",
    init_team_json_exists: "team.json existe déjà dans le répertoire courant.",
    init_success: "team.json initialisé dans le répertoire courant.",
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
    scheduler_persist_failed: "Échec de la persistance de l'état du planificateur : {error}",
    scheduler_snapshot_quarantined: "Instantané du planificateur invalide mis en quarantaine : {path}",
    scheduler_restart_workflow_failed: "L'orchestrateur a redémarré avant l'état terminal du flux ; restaurez-le ou réaffectez-le.",
    scheduler_target_missing: "L'Agent cible configuré n'existe plus : {agentId}",
    scheduler_restart_event_failed: "L'orchestrateur a redémarré avant l'acquittement ; restaurez manuellement la revue persistée.",
    scheduler_owner_unavailable: "Le flux du Leader propriétaire n'est plus disponible.",
    scheduler_event_delivery_failed: "Échec de livraison de l'événement pendant {operation} : {error}",
    scheduler_daily_capacity: "Capacité quotidienne de tâches atteinte pour {date}.",
    scheduler_parent_not_found: "Tâche parente introuvable : {taskId}",
    scheduler_prompt_required: "{operation} : le contenu ne peut pas être vide.",
    scheduler_task_conflict: "La tâche entre en conflit avec la tâche active {taskId} ({status}).",
    scheduler_task_not_found: "Tâche introuvable : {taskId}",
    scheduler_only_queued_modifiable: "Seules les tâches en attente peuvent être modifiées : {taskId}",
    scheduler_reorder_invalid: "Le réordonnancement doit contenir exactement toutes les tâches en attente de l'Agent sélectionné.",
    scheduler_delete_active: "Impossible de supprimer la tâche active {taskId} ; attendez la fin ou annulez-la.",
    scheduler_delete_has_children: "Impossible de supprimer {taskId} : {count} tâche(s) enfant la référencent encore.",
    scheduler_unsupported_role: "Une tâche ne peut pas cibler le rôle {role}.",
    scheduler_worker_no_team: "Le Worker {agentId} n'appartient à aucune équipe.",
    scheduler_leader_unavailable_review: "Le Leader {leaderId} est indisponible ; la revue {reviewId} reste persistée pour récupération.",
    scheduler_role_expected: "L'Agent {agentId} doit avoir le rôle {role}.",
    scheduler_worker_no_active_git_task: "Le Worker {agentId} n'a aucune tâche Git active à soumettre.",
    scheduler_task_no_leader_owner: "La tâche {taskId} n'a pas de Leader propriétaire.",
    scheduler_task_no_leader_workflow: "La tâche {taskId} n'a pas de flux Leader persisté.",
    scheduler_review_commit_required: "La revue exige un commit pour la tâche {taskId}.",
    scheduler_review_not_owned: "La revue {reviewId} n'appartient pas au Leader {leaderId}.",
    scheduler_review_original_missing: "La tâche d'origine {taskId} est indisponible pour une nouvelle tentative.",
    scheduler_review_changes_requested: "Modifications demandées dans la revue {reviewId} : {note}",
    scheduler_review_wrong_branch: "La revue doit être faite depuis {expected} ; branche actuelle : {actual}.",
    scheduler_leader_no_active_work: "Le Leader {leaderId} n'a aucun travail actif.",
    scheduler_release_unfinished_children: "La proposition est bloquée par {count} tâche(s) enfant inachevée(s).",
    scheduler_release_requires_review: "Une proposition exige au moins une branche Worker fusionnée et revue.",
    scheduler_release_transition_invalid: "La proposition {proposalId} est déjà {status} et ne peut pas être {action}.",
    scheduler_worker_count_invalid: "Le nombre de Workers doit être un entier supérieur à zéro.",
    scheduler_dispatch_no_active_workflow: "Le Leader {leaderId} n'a aucun flux actif à distribuer.",
    scheduler_dispatch_requires_tasks: "La distribution exige au moins une tâche d'implémentation.",
    scheduler_dispatch_requires_independence: "Une distribution multi-Worker exige des tâches indépendantes et des tests exécutés par chaque Worker.",
    scheduler_no_registered_workers: "Aucun Worker enregistré n'est disponible pour l'équipe {teamName}.",
    scheduler_dispatch_prompt_required: "Chaque tâche Worker distribuée doit avoir un contenu non vide.",
    scheduler_duplicate_conflict_key: "La distribution contient une clé de conflit en double : {key}",
    scheduler_notify_role_mismatch: "Rôle de fin incohérent : l'Agent {agentId} est {actual}, pas {expected}.",
    scheduler_worker_must_submit_review: "Les Workers doivent soumettre une revue après commit et autotest ; la fin ne fusionne pas leur branche.",
    scheduler_leader_completion_blocked: "Le Leader {leaderId} ne peut pas terminer : {count} tâche(s) Worker restent actives.",
    git_remote_name_invalid: "Le nom du dépôt Git distant contient des caractères non pris en charge.",
    git_remote_url_requires_name: "Une URL Git distante nécessite un nom de dépôt distant.",
    git_push_requires_remote: "La publication distante nécessite un dépôt Git distant configuré.",
    git_push_requires_identity: "La publication distante nécessite un nom et un e-mail Git locaux valides.",
    git_push_remote_not_configured: "Le dépôt Git distant {remote} n'est pas configuré.",
    git_push_requires_merged_release: "La version {proposalId} doit être fusionnée localement avant le push.",
    git_push_disabled: "La publication distante est désactivée pour ce projet.",
    git_push_release_not_head: "La version {proposalId} n'est pas le HEAD actuel de la branche de base.",
    git_push_commit_identity_mismatch: "La version {proposalId} n'a pas été fusionnée avec l'identité Git configurée.",
    git_base_worktree_dirty: "Le worktree de la branche {branch} contient des modifications locales ou a changé pendant l'approbation.",
    scheduler_delegated: "Tâche déléguée à {leaderName} ({taskId}) ; la progression et la livraison seront rapportées ici.",
    scheduler_leader_crashed: "Le Leader {leaderId} a planté et ne peut pas accepter de travail.",
    scheduler_admin_no_active_task: "L'Admin {adminId} n'a aucune tâche active à déléguer.",
    scheduler_leader_task_queued: "Tâche du Leader mise en file : {taskId}",
    scheduler_release_proposal_required: "Le Leader doit soumettre une proposition après les tests d'intégration avant de terminer.",
    scheduler_release_waiting_approval: "L'équipe {teamName} a terminé l'implémentation et les tests et soumis la proposition {proposalId}. En attente de l'approbation Admin avant le statut final.",
    scheduler_root_delivery_completed: "La proposition {proposalId} a été approuvée et fusionnée. La tâche initiale est terminée.",
    scheduler_root_delivery_rejected: "La proposition {proposalId} a été rejetée. La tâche initiale a échoué : {note}",
    notification_delivery_success: "Livraison réussie : l'Admin a poussé la version approuvée vers {remote} ({branch}).",
    notification_progress: "Progression de l'Agent {agentId} — étape : {stage} ; message : {message}",
    notification_agent_crashed: "L'Agent {agentId} ({role}) a planté : {error}",
    scheduler_agent_crashed: "L'Agent a planté : {error}",
    operation_failed: "Échec de l'opération {operation} : {error}",
    runtime_docker_required: "runtime.docker est requis lorsque le mode d'exécution est Docker.",
    docker_extra_arg_unsafe: "L'argument Docker {arg} n'est pas autorisé ; seuls les paramètres de ressources et de sécurité limités sont acceptés.",
    docker_runtime_bundle_missing: "Le bundle Docker Agent est introuvable. Compilez ou réinstallez OAT.",
    docker_command_timeout: "La commande Docker a expiré.",
    docker_agent_already_running: "L'Agent Docker {agentId} est déjà actif.",
    docker_container_name_conflict: "Le nom de conteneur Docker {name} appartient à un autre conteneur.",
    docker_agent_exited: "L'Agent Docker {agentId} s'est arrêté avec le code {code}.",
    docker_agent_start_timeout: "L'Agent Docker {agentId} n'était pas prêt avant l'expiration.",
    docker_agent_not_running: "L'Agent Docker {agentId} n'est pas actif.",
    docker_network_invalid: "Le mode réseau Docker est invalide.",
    docker_extra_args_invalid: "runtime.docker.extra_args doit être un tableau de chaînes.",
    docker_runtime_downgrade_forbidden: "Un projet migré vers Docker ne peut pas revenir à l'isolation par processus local.",
    docker_runtime_not_enabled: "Ce projet n'utilise pas le runtime Docker.",
    docker_agent_restart_busy: "L'Agent Docker {agentId} a un travail actif et ne peut pas redémarrer.",
    docker_git_worktree_invalid: "Les métadonnées Git de l'Agent Docker {agentId} sont hors du répertoire commun.",
    docker_engine_unavailable: "Docker Engine est indisponible : {error}",
    docker_container_cleanup_failed: "L'ancien conteneur OAT {name} n'a pas pu être supprimé : {error}",
    image_redirect_limit: "Le téléchargement de l'image a dépassé la limite de redirections.",
    image_download_failed: "Échec du téléchargement de l'image, statut HTTP {status}.",
    worker_pool_pre_spawn: "Précréation du pool Worker pour l'équipe {teamName} ({count} Workers).",
    resources_file_exists: "{path} existe déjà. Relancez avec --force pour le remplacer.",
    resources_intro: "Open Agent Team · Ressources des Agents\nUn entretien guidé va créer et valider team.json.",
    resources_project_name: "Nom du projet",
    resources_repo_path: "Chemin du dépôt",
    resources_base_branch: "Branche de production (main/master)",
    resources_base_branch_invalid: "La branche de production doit être main ou master.",
    resources_default_model: "Modèle par défaut (provider/model)",
    resources_provider_protocol: "Protocole du fournisseur (openai/anthropic)",
    resources_provider_protocol_invalid: "Le protocole doit être openai ou anthropic.",
    resources_provider_base_url: "URL de base du fournisseur (facultatif)",
    resources_provider_api_key: "Clé API du fournisseur (facultatif ; ne validez pas de vrai secret)",
    resources_runtime_mode: "Isolation d'exécution (local_process/docker)",
    resources_runtime_mode_invalid: "Le mode doit être local_process ou docker.",
    resources_docker_image: "Image Docker",
    resources_docker_network: "Réseau Docker (none/bridge/host)",
    resources_docker_extra_args: "Arguments Docker supplémentaires, séparés par des virgules (facultatif)",
    resources_team_count: "Nombre d'équipes",
    resources_positive_integer: "{field} doit être un entier positif.",
    resources_team_heading: "Équipe {index}/{count}",
    resources_team_id: "Identifiant de l'équipe",
    resources_leader_responsibility: "Responsabilité du Leader",
    resources_worker_capacity: "Capacité des Workers",
    resources_allowed_paths: "Chemins de dépôt autorisés, séparés par des virgules (facultatif)",
  },
  ja: {
    orchestrator_started: "オーケストレーターを開始しました。",
    start_observability_hint:
      "オーケストレーターはポート {port} で実行中です。OAT Desktop で管理してください。",
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
    workspace_provider_unimplemented: "Workspace プロバイダー「{provider}」は未実装です",
    worker_registered: "Worker を登録し、ランタイム準備完了。",
    worker_task_dispatched: "Worker にタスクを送信しました。",
    worker_already_registered: "Worker は既に存在します: {workerId}",
    worker_not_registered: "登録済み Worker がありません: {workerId}。Worker は起動時に事前生成されます。",
    started_in_background: "Orchestrator がバックグラウンドで開始されました。ログは {logPath} に書き込まれます",
    desktop_hint: "OAT Desktop でプロジェクトと Agent を管理してください。",
    project_not_found: "プロジェクトが見つからないか、リンクされていません: {projectId}",
    project_running_cannot_rm: "実行中のプロジェクトは削除できません。先に `oat stop {projectId}` を実行してください。",
    project_removed_success: "プロジェクトが正常に削除されました: {projectId}",
    init_team_json_exists: "現在のディレクトリに team.json が既に存在します。",
    init_success: "現在のディレクトリに team.json を初期化しました。",
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
    scheduler_persist_failed: "スケジューラー状態の保存に失敗しました：{error}",
    scheduler_snapshot_quarantined: "無効なスケジューラースナップショットを隔離しました：{path}",
    scheduler_restart_workflow_failed: "ワークフローが終端状態になる前にオーケストレーターが再起動しました。復旧または再割り当てしてください。",
    scheduler_target_missing: "設定された対象 Agent は存在しません：{agentId}",
    scheduler_restart_event_failed: "イベント確認前に再起動しました。保存済みレビューを手動で復旧してください。",
    scheduler_owner_unavailable: "所有 Leader のワークフローは利用できません。",
    scheduler_event_delivery_failed: "{operation} 中のイベント配信に失敗しました：{error}",
    scheduler_daily_capacity: "{date} の日次タスク上限に達しました。",
    scheduler_parent_not_found: "親タスクが見つかりません：{taskId}",
    scheduler_prompt_required: "{operation}：内容を空にできません。",
    scheduler_task_conflict: "タスクは実行中のタスク {taskId}（{status}）と競合します。",
    scheduler_task_not_found: "タスクが見つかりません：{taskId}",
    scheduler_only_queued_modifiable: "変更できるのは待機中タスクのみです：{taskId}",
    scheduler_reorder_invalid: "並べ替えには対象 Agent の全待機タスクを重複なく含める必要があります。",
    scheduler_delete_active: "実行中タスク {taskId} は削除できません。完了を待つかキャンセルしてください。",
    scheduler_delete_has_children: "{count} 件の子タスクから参照されているため {taskId} を削除できません。",
    scheduler_unsupported_role: "ロール {role} をタスクの対象にはできません。",
    scheduler_worker_no_team: "Worker {agentId} はチームに所属していません。",
    scheduler_leader_unavailable_review: "Leader {leaderId} は利用できません。レビュー {reviewId} は復旧用に保存されています。",
    scheduler_role_expected: "Agent {agentId} のロールは {role} である必要があります。",
    scheduler_worker_no_active_git_task: "Worker {agentId} には提出可能な Git タスクがありません。",
    scheduler_task_no_leader_owner: "タスク {taskId} に Leader 所有者がいません。",
    scheduler_task_no_leader_workflow: "タスク {taskId} に保存済み Leader ワークフローがありません。",
    scheduler_review_commit_required: "タスク {taskId} のレビュー提出にはコミットが必要です。",
    scheduler_review_not_owned: "レビュー {reviewId} は Leader {leaderId} の所有ではありません。",
    scheduler_review_original_missing: "元タスク {taskId} がなく、修正再試行を作成できません。",
    scheduler_review_changes_requested: "レビュー {reviewId} で修正が要求されました：{note}",
    scheduler_review_wrong_branch: "レビューは {expected} で行う必要があります。現在のブランチ：{actual}。",
    scheduler_leader_no_active_work: "Leader {leaderId} に実行中の作業はありません。",
    scheduler_release_unfinished_children: "未完了の子タスクが {count} 件あるためリリース提案できません。",
    scheduler_release_requires_review: "リリース提案には、レビュー済みでマージ済みの Worker ブランチが必要です。",
    scheduler_release_transition_invalid: "リリース {proposalId} は既に {status} のため {action} できません。",
    scheduler_worker_count_invalid: "Worker 数は 0 より大きい整数である必要があります。",
    scheduler_dispatch_no_active_workflow: "Leader {leaderId} に割り当て可能な実行中ワークフローがありません。",
    scheduler_dispatch_requires_tasks: "Worker への割り当てには実装タスクが少なくとも 1 件必要です。",
    scheduler_dispatch_requires_independence: "複数 Worker への割り当ては独立タスクに限り、各 Worker が自身でテストする必要があります。",
    scheduler_no_registered_workers: "チーム {teamName} に利用可能な登録済み Worker がいません。",
    scheduler_dispatch_prompt_required: "各 Worker タスクには空でない内容が必要です。",
    scheduler_duplicate_conflict_key: "割り当てに重複する競合キーがあります：{key}",
    scheduler_notify_role_mismatch: "完了ロールが不一致です：Agent {agentId} は {actual} であり {expected} ではありません。",
    scheduler_worker_must_submit_review: "Worker はコミットと自己テスト後にレビューを提出する必要があり、完了通知ではブランチをマージできません。",
    scheduler_leader_completion_blocked: "Worker タスクが {count} 件実行中のため Leader {leaderId} は完了できません。",
    git_remote_name_invalid: "Git リモート名に未対応の文字が含まれています。",
    git_remote_url_requires_name: "Git リモート URL にはリモート名が必要です。",
    git_push_requires_remote: "リモート公開には Git リモートの設定が必要です。",
    git_push_requires_identity: "リモート公開には有効なローカル Git ユーザー名とメールが必要です。",
    git_push_remote_not_configured: "Git リモート {remote} はこのリポジトリに設定されていません。",
    git_push_requires_merged_release: "リリース {proposalId} は push 前にローカルでマージする必要があります。",
    git_push_disabled: "このプロジェクトではリモート公開が無効です。",
    git_push_release_not_head: "リリース {proposalId} は現在のベースブランチ HEAD ではないため push できません。",
    git_push_commit_identity_mismatch: "リリース {proposalId} は設定済み Git ID でマージされていないため push できません。",
    git_base_worktree_dirty: "ベースブランチ {branch} の worktree にローカル変更があるか、承認中に移動しました。",
    scheduler_delegated: "タスクを {leaderName}（{taskId}）へ割り当てました。進捗と成果はここに報告されます。",
    scheduler_leader_crashed: "Leader {leaderId} はクラッシュしており、作業を受け付けられません。",
    scheduler_admin_no_active_task: "Admin {adminId} に割り当て可能な実行中タスクがありません。",
    scheduler_leader_task_queued: "Leader タスクを待機列に追加しました：{taskId}",
    scheduler_release_proposal_required: "Leader は統合テスト後にリリース提案を提出してから作業を完了する必要があります。",
    scheduler_release_waiting_approval: "チーム「{teamName}」は実装と統合テストを完了し、リリース提案 {proposalId} を提出しました。Admin の承認後に最終状態を更新します。",
    scheduler_root_delivery_completed: "リリース提案 {proposalId} は承認・マージされ、元のタスクは完了しました。",
    scheduler_root_delivery_rejected: "リリース提案 {proposalId} は却下され、元のタスクは失敗しました：{note}",
    notification_delivery_success: "配信成功：Admin が承認済みリリースを {remote}（{branch}）へ push しました。",
    notification_progress: "Agent {agentId} の進捗 — 段階：{stage}、メッセージ：{message}",
    notification_agent_crashed: "Agent {agentId}（{role}）がクラッシュしました：{error}",
    scheduler_agent_crashed: "Agent がクラッシュしました：{error}",
    operation_failed: "操作 {operation} に失敗しました：{error}",
    runtime_docker_required: "Docker 実行モードでは runtime.docker の設定が必要です。",
    docker_extra_arg_unsafe: "Docker 引数 {arg} は許可されていません。制限されたリソース・強化設定のみ使用できます。",
    docker_runtime_bundle_missing: "Docker Agent runtime bundle が見つかりません。OAT をビルドまたは再インストールしてください。",
    docker_command_timeout: "Docker コマンドがタイムアウトしました。",
    docker_agent_already_running: "Docker Agent {agentId} は既に実行中です。",
    docker_container_name_conflict: "Docker コンテナ名 {name} は別のコンテナが使用しています。",
    docker_agent_exited: "Docker Agent {agentId} はコード {code} で終了しました。",
    docker_agent_start_timeout: "Docker Agent {agentId} は時間内に準備完了になりませんでした。",
    docker_agent_not_running: "Docker Agent {agentId} は実行されていません。",
    docker_network_invalid: "Docker ネットワークモードが無効です。",
    docker_extra_args_invalid: "runtime.docker.extra_args は文字列配列である必要があります。",
    docker_runtime_downgrade_forbidden: "Docker 分離へ移行したプロジェクトをローカルプロセス分離へ戻すことはできません。",
    docker_runtime_not_enabled: "このプロジェクトは Docker runtime を使用していません。",
    docker_agent_restart_busy: "Docker Agent {agentId} は作業中のため再起動できません。",
    docker_git_worktree_invalid: "Docker Agent {agentId} の Git worktree メタデータが common dir 外にあります。",
    docker_engine_unavailable: "Docker Engine を利用できません: {error}",
    docker_container_cleanup_failed: "古い OAT コンテナ {name} を削除できませんでした: {error}",
    image_redirect_limit: "画像ダウンロードがリダイレクト上限を超えました。",
    image_download_failed: "画像ダウンロードに失敗しました。HTTP ステータス：{status}。",
    worker_pool_pre_spawn: "チーム {teamName} の Worker プールを事前作成しています（{count} 件）。",
    resources_file_exists: "{path} は既に存在します。置換するには --force を付けて再実行してください。",
    resources_intro: "Open Agent Team · Agent リソース\nガイド付き質問で team.json を作成し検証します。",
    resources_project_name: "プロジェクト名",
    resources_repo_path: "リポジトリパス",
    resources_base_branch: "本番ブランチ（main/master）",
    resources_base_branch_invalid: "本番ブランチは main または master である必要があります。",
    resources_default_model: "既定モデル（provider/model）",
    resources_provider_protocol: "Provider プロトコル（openai/anthropic）",
    resources_provider_protocol_invalid: "Provider プロトコルは openai または anthropic である必要があります。",
    resources_provider_base_url: "Provider ベース URL（任意）",
    resources_provider_api_key: "Provider API キー（任意。実際の秘密情報をコミットしないでください）",
    resources_runtime_mode: "実行隔離（local_process/docker）",
    resources_runtime_mode_invalid: "実行モードは local_process または docker である必要があります。",
    resources_docker_image: "Docker イメージ",
    resources_docker_network: "Docker ネットワーク（none/bridge/host）",
    resources_docker_extra_args: "Docker 追加引数、カンマ区切り（任意）",
    resources_team_count: "チーム数",
    resources_positive_integer: "{field} は正の整数である必要があります。",
    resources_team_heading: "チーム {index}/{count}",
    resources_team_id: "チーム識別子",
    resources_leader_responsibility: "Leader の責任",
    resources_worker_capacity: "Worker 数",
    resources_allowed_paths: "許可するリポジトリパス、カンマ区切り（任意）",
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
