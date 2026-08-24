var e=`# 使用指南（快速上手）

本指南帮助你在本地用最少步骤跑通声明式的 \`Admin -> Leader -> Worker\` agent 管理结构。

## 1. 安装

**通过一键脚本安装 (推荐):**

**macOS & Linux:**
\`\`\`bash
curl -fsSL https://oat.ibert.me/install.sh | bash
\`\`\`

**Windows:**
\`\`\`powershell
powershell -c "irm https://oat.ibert.me/install.ps1 | iex"
\`\`\`

**通过 NPM 安装:**

\`\`\`bash
npm i open-agent-team -g
\`\`\`

安装完成后，你可以通过以下命令验证：

\`\`\`bash
oat --help
\`\`\`

## 2. 配置 skills（可选）

Skills 通过 [\`npx skills\`](https://github.com/vercel-labs/skills) 进行管理。你在 \`team.json\` 中以 \`SkillEntry\` 格式声明 skill 来源，OAT 会在启动时自动将其安装到各 agent 的 workspace 中。

每个 \`SkillEntry\` 包含：
- \`source\`：skill 来源（GitHub 简写如 \`vercel-labs/agent-skills\`、完整 URL 或本地路径）
- \`names\`（可选）：要安装的特定 skill 名称；省略或使用 \`["*"]\` 安装全部

在 \`team.json\` 中的示例：
\`\`\`json
"skills": [
  { "source": "vercel-labs/agent-skills", "names": ["frontend-design"] },
  { "source": "./my-local-skills" }
]
\`\`\`

启动时，OAT 会为每个 entry 执行 \`npx skills add\`，将 skills 安装到 \`<workspace>/skills/\` 目录，并创建 \`.pi/skills\` 符号链接以兼容 pi-coding-agent。Agent 会自动从其工作区发现并加载 skills。

> 提示：你可以不配置任何 skills——只需在配置中保留 \`"skills": []\` 即可。

## 3. 准备 Git 仓库与分支（建议）

该项目会基于 \`project.base_branch\` 执行合并（默认 \`main\`；仅允许 \`main\` 或 \`master\`），并为每个 agent 创建 git worktree workspace。

建议你确认：

- \`team.json -> project.repo\` 指向一个 git 仓库（通常写 \`.\`）
- 若 \`project.repo\` 为相对路径，会按 \`team.json\` 所在目录解析
- 仓库中存在 \`project.base_branch\` 所配置的分支（\`main\` 或 \`master\`，与配置一致）
- 你的仓库支持 \`git worktree\`（大多数情况下开箱即用）

## 4. 编写 \`team.json\`（核心）

\`team.json\` 位于仓库任意位置均可，但推荐放到仓库根目录或你容易管理的路径。

下面给一个"最小骨架"示例（你需要把模型与 prompt 换成自己的内容）：

\`\`\`json
{
  "model": "default",
  "project": { "name": "open-agent-team-demo", "repo": ".", "base_branch": "main" },
  "models": { "default": "openai/gpt-4o-mini" },
  "providers": { "openai": { "compatible_type": "openai", "base_url": "https://api.openai.com/v1", "api_key": "sk-..." } },
  "admin": {
    "name": "admin",
    "description": "项目经理，负责最终汇总交付",
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
        "description": "前端负责人，负责拆分任务并请求 worker 执行",
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

你需要至少保证：

- \`admin.prompt\`、\`leader.prompt\`、\`worker.prompt\` 不为空（也可以写成 \`*.md\` 文件路径）
- 模型继承关系清晰：\`worker.model -> leader.model -> admin.model -> model\`（可只配置顶层 \`model\`，按需覆写）
- \`teams[]\` 至少配置一个 team
- \`leader.repos\` 给出你希望 worker 重点关注的路径（对应 sparse-checkout set）

## 5. 启动 Orchestrator

在你的终端执行：

\`\`\`bash
oat start team.json [goal]
\`\`\`

- \`[goal]\`：最终要达成的项目目标（会注入到 Leader prompt 中）

如果你要指定输出语言：

\`\`\`bash
oat start team.json [goal] --lang zh-CN
\`\`\`

启动后，OAT 会在 \`~/.oat/projects/\` 下创建指向项目目录的符号链接，以支持多项目管理。

## 6. 使用 OAT Desktop

打开 OAT Desktop 管理已注册项目。它包含以下页面：

- **项目总览**：项目信息和运行中/已停止项目管理
- **项目状态**：实时 SSE 事件流、Agent 拓扑图、进度汇报。支持切换不同项目实例进行观测
- **项目配置**：在线编辑项目的 \`team.json\` 配置，带有 Shiki 语法高亮的 JSON 实时预览。保存后自动重启对应项目
- **设置**：日志保留天数等全局配置

### 多项目支持

Desktop 支持同时管理多个项目，可通过左侧项目树切换。

## 7. 观察执行结果（你应该看到什么）

常见观察点：

- Orchestrator 启动后会监听自动分配或指定的端口
- 任务 worktree 和持久化 manifest 位于 \`state_dir/git-collaboration/\`
- Worker 完成自测后会提交包含分支、SHA、变更文件、测试和产物路径的 \`submit-review\` 请求
- Leader 在 merge 前显式 review，再将 Worker 分支合入 integration 分支
- Admin 批准 release proposal 后，MergeController 才会串行更新 \`project.base_branch\`

## 8. 查看状态 / 停止

查看 orchestrator 状态（读取 \`state_dir\` 下的 \`orchestrator.json\`）：

\`\`\`bash
oat list
\`\`\`

不传参数时会默认按当前目录下的 \`team.json\` 推导 \`state_dir\`（即同级 \`.oat/state\`）；若未检测到 \`team.json\` 会直接报错。

停止（向 orchestrator pid 发 SIGTERM）：

\`\`\`bash
oat stop
\`\`\`

## 9. REST API 参考

Orchestrator 启动后提供以下管理 API：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | \`/api/projects\` | 获取所有已注册项目列表 |
| DELETE | \`/api/projects/:name\` | 删除项目（需先停止） |
| GET | \`/api/projects/:name/config\` | 读取指定项目的 team.json |
| PUT | \`/api/projects/:name/config\` | 更新指定项目的 team.json |
| POST | \`/api/projects/:name/restart\` | 重启指定项目 |
| GET | \`/api/team-config\` | 读取当前项目的 team.json |
| PUT | \`/api/team-config\` | 更新当前项目的 team.json |
| GET | \`/api/global-config\` | 读取全局配置 (oat.json) |
| PUT | \`/api/global-config\` | 更新全局配置 |

## 10. 查看文档（多语言）

你可以用 CLI 直接输出 docs 文件内容，例如：

\`\`\`bash
oat docs guide --lang fr
oat docs architecture --lang zh-CN
oat docs config --lang zh-CN
\`\`\`
`;export{e as default};