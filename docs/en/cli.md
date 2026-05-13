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

Start the Orchestrator as a background daemon to manage your agent team based on the configuration file. Use `oat dashboard` to view it in real-time.

**Usage:**
```bash
oat start [options]
```

**Options:**
- `--config <path>`: Path to your `team.json` configuration file. If omitted, defaults to `./team.json` in the current working directory, or the path specified by the `OAT_TEAM_JSON` environment variable.
- `--goal <text>`: An optional final project goal prompt injected into the Leader agents. Alternatively, you can pass it as a trailing argument: `oat start team.json "My goal"`.
- `--port <number>`: Port number for the Orchestrator's HTTP server (Observability Dashboard API). Default is `0` (auto-scans for an available port starting from 8787).

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

## `oat dashboard`

Open the global OAT Web Dashboard in your default browser. The dashboard connects to running orchestrator instances automatically to provide real-time observability, project management, and achievement tracking.

**Usage:**
```bash
oat dashboard
```

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
