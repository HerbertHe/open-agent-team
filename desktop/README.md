# Open Agent Team Desktop

Electron-vite desktop control center for local Open Agent Team projects.

## What it does

- Detects a compatible system Node.js runtime (`>=22 <25`) and an `oat` CLI.
- On first run, automatically installs a private Node.js 22 runtime when needed. The archive comes from the official Node.js v22 channel and is verified against its published SHA-256 checksum before extraction.
- Installs or updates OAT under the application data directory, without mutating the user's global npm installation.
- Reads projects registered in `~/.oat/projects`, resolves their local Orchestrator state, and renders a bee-themed project hive.
- Derives each bee's state from the project's agent graph and task queue.
- Provides native control-center pages over the selected Orchestrator API: project status, task queue CRUD, observability, team/global configuration, Agent Resources, plugins, channels, Git, and Docker.
- Includes persisted light, dark, and system themes plus Simplified Chinese, English, French, and Japanese navigation.

## Commands

```bash
pnpm --filter desktop dev
pnpm --filter desktop build
pnpm --filter desktop lint
pnpm --filter desktop package
```

`package` creates a platform-specific distributable in `desktop/release/`. The build configuration targets macOS `arm64` (DMG) and Windows `ia32` / x86 (NSIS); run it on the target OS for its native installer format.

## Security model

- `contextIsolation` and Electron sandbox are enabled; Node integration and `<webview>` are disabled.
- The preload bridge exposes only runtime status, install/update, and project listing methods.
- Child processes use `spawn(..., { shell: false })` with fixed command arguments; renderer data never becomes a shell command.
- External links are opened by the operating system and never receive Electron window privileges.
- The renderer communicates only through the restricted preload bridge and validated local Orchestrator targets.
