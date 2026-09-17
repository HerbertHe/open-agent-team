var e=`# 文件共享知识库

> 状态：第一至第四批已完成，更新于 2026-09-16。

## 边界

共享知识与 Agent 私有记忆是两个领域：

- 记忆属于单个 Admin、Leader 或 Worker，只能由该所有者在运行时检索；
- 知识属于项目或团队，以文件为事实源，可被权限范围内的多个 Agent 检索；
- 私有记忆不会自动晋升为共享知识；模型思考、流式 token 和临时草稿也不会进入知识库；
- Agent 通过提交经过评审的知识文件发布知识，用户通过 Desktop 上传文件发布知识；后台服务只负责解析、分块和索引，没有中央“做梦 Agent”。

## 文件空间

默认目录均相对于 \`project.repo\`：

\`\`\`text
knowledge/
├── project/                 # 整个项目可读
├── teams/<teamId>/          # 指定团队及 Admin 可读
└── uploads/
    ├── project/             # 用户上传的项目知识
    └── teams/<teamId>/      # 用户上传的团队知识
\`\`\`

Agent 的系统提示会说明发布路径。Agent 在自己的任务 worktree 中产出文件，文件通过既有 Worker → Leader → Admin Git 交付链合并到项目仓库后，\`KnowledgeService\` 才会看到并摄取它。这样代码评审、文件历史与知识发布使用同一条交付链。

Desktop 上传由受信 Electron 主进程读取本地文件，再通过 IPC 以 \`application/octet-stream\` 传给当前 Project Orchestrator。Renderer 不获得任意本地路径读取能力。团队上传必须匹配 \`team.json\` 中真实存在的 Team。

## 摄取和存储

\`KnowledgeService\` 在启动时建立目录并扫描，随后按 \`knowledge.watcher.debounceMs\` 周期合并扫描。每个文件执行：

1. canonical path 根目录校验，忽略符号链接、隐藏文件和编辑器临时文件；
2. 文件大小、扩展名和内容哈希校验；
3. PDF/DOCX 文本提取或 UTF-8 文本解析；
4. 按 token 预算与 overlap 做确定性分块；
5. 将文件写入 \`knowledge_sources\`、分块写入 \`knowledge_chunks\`；
6. 将每个分块投影为 \`semantic_documents(resource_type=knowledge)\`；
7. 由 Semantic Outbox 同步到当前 active Zvec collection revision。

知识与记忆使用同一个 \`memory.db\`。SQLite 是 canonical 数据和权限来源，Zvec 是可重建派生索引；Embedding Profile、维度、距离度量、collection revision、重建、激活、回滚、重试、dead letter 和批量 \`optimize()\` 策略均与记忆索引共用。

支持 \`.md/.mdx/.txt\`、JSON/YAML/TOML/XML、HTML、常见源码、PDF 和 DOCX。扫描件 PDF 暂不做 OCR。默认单文件上限为 50 MiB。

## 检索与权限

任务下发前，\`TaskManager\` 并行检索当前 Agent 的私有记忆和允许读取的共享知识：

- Admin：项目知识和所有团队知识；
- Leader / Worker：项目知识和自己所在团队的知识；
- restricted：必须显式列出 Agent；
- 外部 Agent：默认禁止。

Knowledge 检索将 lexical、Zvec Dense 和 Zvec FTS 结果做 RRF 合并。Zvec 首先使用倒排字段过滤 \`project_id\`、\`level=KNOWLEDGE\`、状态和可见性；随后必须回到 SQLite canonical document 做权限 hydration。过滤表达失败、索引不可用或 Embedding identity 不匹配时 fail closed 或退回 lexical，不会扩大权限。

命中结果以 \`<KNOWLEDGE_CONTEXT>\` 注入，并明确标记为“参考资料而非操作指令”。结构化 \`KnowledgeReference\` 会持久化到任务快照，并在 Desktop 的“参考知识库”区域显示文件、标题、行号、团队和内容哈希来源。

## 运维和 Desktop

入口为「全局设置 → 共享知识库」。页面展示：

- 知识源、分块、ready/failed/unsupported 数量；
- pending/indexed/failed/dead-letter 索引状态；
- 配置的上传根目录；
- 项目或团队文件上传、重新扫描、失败重试和用户上传删除。

工作区和 Agent 产出的文件在管理页只读。删除接口只接受 \`origin=user_upload\`，并再次检查 canonical path 位于配置的上传根目录；它不能成为任意项目文件删除能力。删除文件后 canonical 文档标记为 deleted，Semantic Outbox 负责从所有可写 revision 删除派生向量。

本地 API：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| \`GET\` | \`/knowledge/operations\` | 知识源、分块和索引运维快照 |
| \`POST\` | \`/knowledge/uploads\` | 二进制文件上传；文件名和可选 Team 通过受信请求头传递 |
| \`POST\` | \`/knowledge/scan\` | 等待当前扫描结束后执行一次全新扫描 |
| \`POST\` | \`/knowledge/sources/:id/retry\` | 重新解析失败或不支持的来源 |
| \`DELETE\` | \`/knowledge/sources/:id\` | 删除用户上传来源；拒绝工作区来源 |

## 配置

\`\`\`json
{
  "knowledge": {
    "enabled": true,
    "roots": {
      "project": "knowledge/project",
      "teams": "knowledge/teams",
      "uploads": "knowledge/uploads"
    },
    "watcher": { "enabled": true, "debounceMs": 1000 },
    "ingestion": {
      "maxFileSizeMb": 50,
      "chunkTokens": 1000,
      "chunkOverlapTokens": 120
    }
  }
}
\`\`\`

知识没有第二套 Embedding 或 Zvec 配置；它继承 \`memory.embeddingRef\`、\`memory.retrieval\` 和 \`memory.zvec\`。当 backend 为 lexical 或没有 active collection 时，知识仍可用 lexical 检索。

## 验证

\`\`\`bash
pnpm run test:memory
pnpm exec tsc --noEmit
pnpm --filter ./desktop run lint
pnpm run build
pnpm run build:desktop
\`\`\`

回归测试覆盖文件新增、修订、删除、大小失败、PDF/DOCX、项目/团队权限、用户上传、路径逃逸拒绝、运维快照、Semantic Outbox 和共享 Zvec collection 写入。

详细决策与分批边界见 [ADR 0002：Agent 私有记忆与文件共享知识](./adr/0002-agent-memory-file-knowledge.md)。
`;export{e as default};