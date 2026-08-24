# OAT CLI Reference

The `oat` command-line interface provides tools for managing your Open Agent Team Orchestrator, inspecting states, and viewing documentation.

## Global Options

- `-v, --version`: Output the version number.
- `--lang <lang>`: Output language for CLI messages and docs. Supported values: `en`, `zh-CN`, `fr`, `ja`.
- `-h, --help`: Display help for the CLI or a specific command.

---

## `oat init`

Initialize a new `team.json` configuration file in the current directory (by copying the built-in example configuration).

**Usage:**
```bash
oat init
```

## `oat start`

Start the Orchestrator as a background daemon to manage your agent team based on the configuration file. Use OAT Desktop for real-time management.

**Usage:**
```bash
oat start [options]
```

**Options:**
- `--config <path>`: Path to your `team.json` configuration file. If omitted, defaults to `./team.json` in the current working directory, or the path specified by the `OAT_TEAM_JSON` environment variable.
- `--goal <text>`: An optional final project goal prompt injected into the Leader agents. Alternatively, you can pass it as a trailing argument: `oat start team.json "My goal"`.

---

## `oat list` / `oat ls`

Check the current status of all local OAT Orchestrators globally (whether they are running, PID, port, etc.).

**Usage:**
```bash
oat list
# or
oat ls
```

---

## `oat stop`

Send a graceful shutdown signal (SIGINT) to the running Orchestrator. The Orchestrator will stop all agent runtimes and workspaces safely.

**Usage:**
```bash
oat stop [options] [projectId]
```

**Options:**
- `--all`: Stop all running OAT projects. If `--all` is used, `projectId` is not required.

**Arguments:**
- `projectId`: The project ID, which can be found using the `oat list` command. Required if `--all` is not specified.

---

## `oat rm`

Completely remove all OAT state data and workspace directories for the specified project. The project must be stopped before it can be removed. This will NOT delete your original repository.

**Usage:**
```bash
oat rm [options] <projectId>
```

**Arguments:**
- `projectId`: The project ID, which can be found using the `oat list` command.

---

## `oat inspect`

Inspect the local workspaces created by the Orchestrator and list their current states.

**Usage:**
```bash
oat inspect [options] [stateDir] [workspaceRoot]
```

**Arguments:**
- `stateDir`: The state directory.
- `workspaceRoot`: The directory where workspaces are stored (defaults to `workspaces`).

**Options:**
- `--limit <number>`: Maximum number of workspace entries to display (default: 50).

---

## `oat docs`

Output documentation content directly to the terminal.

**Usage:**
```bash
oat docs [options] <name>
```

**Arguments:**
- `name`: Name of the document to display. Available docs: `architecture`, `config`, `guide`, `cli`.

**Example:**
```bash
oat docs config --lang en
```

---

## `oat channels`

Inspect loaded push channel plugins, all configured accounts, active sessions (such as WeChat QR logins), and overall status.

**Usage:**
```bash
oat channels
```

---

## `oat channel login`

Interactively log into a stateful push channel (e.g. WeChat scanning guide).

**Usage:**
```bash
oat channel login <channelId> <accountId>
```

**Arguments:**
- `channelId`: The target channel type (e.g., `weixin`).
- `accountId`: The identifier for this new channel login session.

**Example:**
```bash
oat channel login weixin my-wechat
```

---

## `oat plugins install`

Download and hot-install an OpenClaw-compatible push channel plugin from NPM dynamically.

**Usage:**
```bash
oat plugins install <packageName>
```

**Arguments:**
- `packageName`: The NPM package name of the plugin (e.g., `@tencent-weixin/openclaw-weixin`).

---

## `oat plugins uninstall`

Uninstall an installed plugin dynamically from the system, wiping all associated session files and credentials safely.

**Usage:**
```bash
oat plugins uninstall <pluginId>
```

**Arguments:**
- `pluginId`: The ID of the plugin to uninstall (e.g., `openclaw-weixin`).
