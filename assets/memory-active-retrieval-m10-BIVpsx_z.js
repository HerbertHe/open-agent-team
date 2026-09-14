var e=`# M10 受控检索运行手册

M10 让经过评测的少量 Project 使用 Zvec 检索 L2/L3，同时保持 SQLite 为权威数据源、L1 为时间序读取，并在任何检索故障下继续执行 Agent 任务。

## 启用前检查

1. 为 Project 配置有效的全局 Embedding Profile；\`zvec_fts\` 可不配置 Embedding，\`zvec_hybrid\` 必须配置。
2. 使用目标 Profile 跑 M09 评测，确认召回、越权、延迟和 token 指标满足门禁。
3. 完成 collection 构建、追赶和原子激活，确认 active pointer 与 manifest identity 一致。
4. 先把 Project 设置为 \`shadow=true\`，观察检索审计和降级原因。

## 受控启用

在 Project 配置中选择 \`zvec_fts\` 或 \`zvec_hybrid\`，关闭 shadow，并设置超时、连续失败阈值和冷却时间。然后在 Desktop「全局设置 → 全局模型 → 记忆检索放量」开启总开关，勾选目标 Project，保存并重启该 Project。

等价的 \`~/.oat/oat.json\` 配置为：

\`\`\`json
{
  "memoryRetrieval": {
    "enabled": true,
    "projectAllowlist": ["my-project"]
  }
}
\`\`\`

白名单值必须与 \`team.json\` 中 \`project.name\` 完全一致，区分大小写，不支持 \`*\`。Project backend、全局总开关、精确白名单三项缺一不可；\`shadow=true\` 会覆盖主动模式。

## 状态判断

\`GET /memory/overview\` 和 Desktop 记忆面板显示：

- \`mode\`：\`lexical\`、\`shadow\` 或 \`active\`；
- \`configuredBackend\` / \`effectiveBackend\`：配置值与本次运行实际使用值；
- \`circuitState\`：\`closed\`、\`open\` 或 \`half_open\`；
- \`consecutiveFailures\`、\`fallbackCount\`、最近降级原因和时间；
- 熔断恢复时间与最近成功时间。

active 且 effective 为 Zvec 表示主动结果生效；active 但 effective 为 lexical 表示已安全回退。部分 Dense/FTS 路由失败时 effective 仍为 Zvec，因为其他路由结果仍生效，同时最近降级原因会说明失败路由。

## 故障行为

- collection 缺失、损坏、identity 不匹配、Embedding 失败或整体查询超时：使用 lexical L2/L3，L1 不受影响。
- 连续失败达到阈值：熔断器打开，冷却期内不请求 Zvec；期满只允许一个半开探测，成功后关闭，失败则重新冷却。
- token 超预算：按 L1、L3、L2 顺序保留完整条目，不截断单条记忆。
- 超时限制 Agent 的等待时间，但无法取消已经进入 Zvec 原生 SDK 的查询；该查询会在后台完成并被正常回收。

## 回滚

最快的全局回滚是在 Desktop 关闭“记忆检索放量”，保存并重启 Project。单项目回滚可从白名单移除该项目，或把 Project backend 改为 \`lexical\`。需要继续采样但不影响提示时设置 \`shadow=true\`。

回滚不迁移或删除 SQLite，也不要求删除 Zvec collection。若 collection 本身异常，使用 M07 的重建/回滚流程处理；不要手工覆盖 active pointer。

## 验证命令

\`\`\`bash
pnpm test:memory:active
pnpm test:memory
pnpm exec tsc --noEmit
pnpm --dir desktop run lint
pnpm --dir desktop run build
\`\`\`
`;export{e as default};