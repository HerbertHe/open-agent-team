var e=`# Quick Start Guide

This guide helps you run the declarative \`Admin -> Leader -> Worker\` agent management structure locally with the minimal set of steps.

## 1. Install

**Via One-liner Script (Recommended):**

**macOS & Linux:**
\`\`\`bash
curl -fsSL https://oat.ibert.me/install.sh | bash
\`\`\`

**Windows:**
\`\`\`powershell
powershell -c "irm https://oat.ibert.me/install.ps1 | iex"
\`\`\`

**Via NPM:**

\`\`\`bash
npm i open-agent-team -g
\`\`\`

This installs the \`oat\` CLI globally. You can verify the installation with:

\`\`\`bash
oat --help
\`\`\`

## 2. Configure skills (optional)

Skills are managed via [\`npx skills\`](https://github.com/vercel-labs/skills). You declare skill sources in \`team.json\` using the \`SkillEntry\` format, and OAT automatically installs them into each agent's workspace on startup.

Each \`SkillEntry\` has:
- \`source\`: a skill source (GitHub shorthand like \`vercel-labs/agent-skills\`, full URL, or local path)
- \`names\` (optional): specific skill names to install; omit or use \`["*"]\` for all

Example in \`team.json\`:
\`\`\`json
"skills": [
  { "source": "vercel-labs/agent-skills", "names": ["frontend-design"] },
  { "source": "./my-local-skills" }
]
\`\`\`

At startup, OAT runs \`npx skills add\` for each entry, installs skills into \`<workspace>/skills/\`, and creates a \`.pi/skills\` symlink for pi-coding-agent compatibility. The agent automatically discovers and loads skills from its workspace.

> Tip: You can start without any skills — just leave \`"skills": []\` in your config.

## 3. Prepare your Git repository and branches (recommended)

This project merges into \`project.base_branch\` (default \`main\`; only \`main\` or \`master\` are valid) and creates a git worktree workspace for each agent.

Before you start, confirm:

- \`team.json -> project.repo\` points to a git repository (usually \`.\`)
- if \`project.repo\` is relative, it is resolved from the \`team.json\` directory
- the branch named by \`project.base_branch\` exists in the repo (\`main\` or \`master\`, matching your config)
- your repo supports \`git worktree\` (works out-of-the-box in most environments)

## 4. Write \`team.json\` (core)

\`team.json\` can be placed anywhere, but it is recommended to keep it in your repository root (or another easy-to-manage location).

Here is a "minimal skeleton" example (replace model and prompts with your own content):

\`\`\`json
{
  "model": "default",
  "project": { "name": "open-agent-team-demo", "repo": ".", "base_branch": "main" },
  "models": { "default": "openai/gpt-4o-mini" },
  "providers": { "openai": { "compatible_type": "openai", "base_url": "https://api.openai.com/v1", "api_key": "sk-..." } },
  "admin": {
    "name": "admin",
    "description": "Project manager responsible for final aggregation and delivery",
    "model": "default",
    "prompt": "You are the project manager (Admin).\\\\nYour job is to summarize the final delivery and review team changelogs.",
    "skills": []
  },
  "teams": [
    {
      "name": "frontend",
      "branch_prefix": "team/frontend",
      "leader": {
        "name": "frontend-lead",
        "description": "Frontend lead; break down tasks and dispatch to workers",
        "model": "default",
        "prompt": "You are the Leader agent for the frontend team.",
        "skills": [],
        "repos": ["src/", "package.json"]
      },
      "worker": {
        "total": 3,
        "model": "default",
        "prompt": "You are a Worker engineer.",
        "extra_skills": []
      }
    }
  ]
}
\`\`\`

At minimum, make sure:

- \`admin.prompt\`, \`leader.prompt\`, \`worker.prompt\` are not empty (or use \`*.md\` file path forms)
- model inheritance is clear: \`worker.model -> leader.model -> admin.model -> model\` (you can define only top-level \`model\` and override selectively)
- \`teams[]\` contains at least one team
- \`leader.repos\` lists the paths you want workers to focus on (maps to sparse-checkout allowlist)

## 5. Start Orchestrator

Run:

\`\`\`bash
oat start team.json [goal]
\`\`\`

- \`[goal]\`: the final project goal injected into the Leader prompt

If you want to set output/log language:

\`\`\`bash
oat start team.json [goal] --lang zh-CN
\`\`\`

On startup, OAT creates a symlink under \`~/.oat/projects/\` pointing to the project directory, enabling multi-project management.

## 6. Using OAT Desktop

Open OAT Desktop to manage registered projects. It includes:

- **Project overview**: project information and running/stopped project management
- **Project Status**: real-time SSE event stream, Agent topology graph, progress reports. Supports switching between different project instances
- **Project Config**: edit the project's \`team.json\` online with Shiki-highlighted JSON preview. Saving automatically restarts the project
- **Settings**: global settings such as log retention days

### Multi-project support

Desktop supports managing multiple projects simultaneously. Use the project tree to switch projects; projects are displayed by their configured name.

## 7. Observe what you should see

Common observation points:

- Orchestrator starts and listens on the auto-assigned or specified port
- task worktrees and persisted manifests appear under \`state_dir/git-collaboration/\`
- each Worker submits a self-tested \`submit-review\` request with a branch, SHA, changed files, tests, and artifact path
- Leader explicitly reviews before merging a Worker branch into its integration branch
- Admin approves a release proposal before MergeController serially updates \`project.base_branch\`

## 8. Status / stop

Check orchestrator state (read \`orchestrator.json\` under \`state_dir\`):

\`\`\`bash
oat list
\`\`\`

Without arguments, it infers \`state_dir\` from \`team.json\` in the current directory (same-level \`.oat/state\`); if \`team.json\` is not found, it throws an error.

Stop (send SIGTERM to the orchestrator pid):

\`\`\`bash
oat stop
\`\`\`

## 9. REST API Reference

The Orchestrator exposes the following management API:

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/api/projects\` | List all registered projects |
| DELETE | \`/api/projects/:name\` | Delete a project (must be stopped first) |
| GET | \`/api/projects/:name/config\` | Read project's team.json |
| PUT | \`/api/projects/:name/config\` | Update project's team.json |
| POST | \`/api/projects/:name/restart\` | Restart a project |
| GET | \`/api/team-config\` | Read current project's team.json |
| PUT | \`/api/team-config\` | Update current project's team.json |
| GET | \`/api/global-config\` | Read global config (oat.json) |
| PUT | \`/api/global-config\` | Update global config |

## 10. View docs (multi-language)

You can print doc contents via CLI, for example:

\`\`\`bash
oat docs guide --lang fr
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
\`\`\`
`;export{e as default};