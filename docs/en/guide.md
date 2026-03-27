# Quick Start Guide

This guide helps you run the declarative `Admin -> Leader -> Worker` agent management structure locally with the minimal set of steps.

## 1. Prepare skills (required)

Orchestrator reads skill definitions from `team.yaml`’s `project.repo` path and injects them into each agent workspace.

In your git repository root, prepare:

- `skills/<skill-name>/SKILL.md`

Example:

```text
skills/
  doc-search/
    SKILL.md
  coding-assistant/
    SKILL.md
```

> Tip: If you don’t have skills yet, you can still start by creating an empty or minimal `SKILL.md` to make the injection and tool-calling flow work end-to-end.

## 2. Prepare your Git repository and branches (recommended)

This project merges into `project.base_branch` (default `main`) and creates a git worktree workspace for each agent.

Before you start, confirm:

- `team.yaml -> project.repo` points to a git repository (usually `.`)
- `project.base_branch` exists (for example `main`)
- your repo supports `git worktree` (works out-of-the-box in most environments)

## 3. Write `team.yaml` (core)

`team.yaml` can be placed anywhere, but it is recommended to keep it in your repository root (or another easy-to-manage location).

Here is a “minimal skeleton” example (replace model and prompts with your own content, and fill in real skill names):

```yaml
model: default

project:
  name: open-agent-team-demo
  repo: .
  base_branch: main

models:
  default: anthropic/claude-3-5-sonnet-20240620

admin:
  name: admin
  description: Project manager responsible for final aggregation and delivery
  model: default
  prompt: |
    You are the project manager (Admin).
    Your job is to summarize the final delivery and review team changelogs.
  skills: []

teams:
  - name: frontend
    branch_prefix: team/frontend
    leader:
      name: frontend-lead
      description: Frontend lead; break down tasks and request workers to execute
      model: default
      prompt: |
        You are the Leader agent for the frontend team.
        When you need engineers to implement tasks in parallel, call tool request-workers with a JSON body:
        { "tasks": [ { "index": 0, "prompt": "..." }, { "index": 1, "prompt": "..." } ] }

        After workers finish, summarize all worker CHANGELOGs into your own CHANGELOG.
      skills: []
      repos:
        - src/
        - package.json
    worker:
      max: 3
      model: default
      prompt: |
        You are a Worker engineer.
        For your assigned task:
        1) Modify code in this workspace.
        2) Update CHANGELOG.md at the workspace root with what you did and why.
        3) Call tool notify-complete with changelog set to the CHANGELOG content.
      extra_skills: []
```

At minimum, make sure:

- `admin.prompt`, `leader.prompt`, `worker.prompt` are not empty (or use `*.md` file path forms)
- model inheritance is clear: `worker.model -> leader.model -> admin.model -> model` (you can define only top-level `model` and override selectively)
- `teams[]` contains at least one team
- `leader.repos` lists the paths you want workers to focus on (maps to sparse-checkout allowlist)

## 4. Start Orchestrator

Run:

```bash
oat start team.yaml "<goal>" --port 3100
```

- `--port`: Orchestrator HTTP port (used by tool callbacks)
- `<goal>`: the final project goal injected into the Leader prompt

If you want to set output/log language:

```bash
oat start team.yaml "<goal>" --port 3100 --lang zh-CN
```

## 5. Observe what you should see

Common observation points:

- Orchestrator starts and listens on the port you provided
- worker workspaces appear under `workspace.root_dir` (default `~/.oat/workspaces/<agentId>`)
- each worker updates its workspace root `CHANGELOG.md` when finished
- worker branches are merged into the corresponding leader branches
- after a leader merges into `project.base_branch`, Orchestrator cleans up that leader and its workers (process + workspace)

## 6. Status / stop

Check orchestrator state (read `orchestrator.json` under `state_dir`):

```bash
oat status "~/.oat/state"
```

Stop (send SIGTERM to the orchestrator pid):

```bash
oat stop "~/.oat/state"
```

## 7. View docs (multi-language)

You can print doc contents via CLI, for example:

```bash
oat docs guide --lang fr
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
```
