var e=`# Agent Resources：对话式项目与团队创建

\`oat resources\` 是组织资源管理员（类似 HR）的交互入口。它不要求用户手写声明式配置，而是通过问答收集项目、模型、运行环境、团队职责和 Worker 容量，最后生成并校验 \`team.json\`。

## 使用

\`\`\`bash
oat resources
oat resources ./my-project/team.json
oat resources ./team.json --force
\`\`\`

已有配置默认不会覆盖；需要替换时使用 \`--force\`。

## 访谈内容

1. 项目名称、仓库位置和生产分支；
2. 默认模型、供应商协议及可选连接信息；
3. \`local_process\` 或 \`docker\` 运行环境；Docker 镜像、网络和资源限制；
4. 每个团队的标识、Leader 职责、允许路径和 Worker 容量。

生成的 Admin prompt 限定为项目治理、团队调配、状态分析和发布审批；Leader/Worker prompt 默认采用 Git review 协作流程。

输出会在写入前由同一份 \`TeamFileSchema\` 校验，因此可直接交给 \`oat start\`。生产 API key 建议通过安全的环境变量或密钥管理器注入，避免写入生成文件。
`;export{e as default};