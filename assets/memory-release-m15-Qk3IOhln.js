var e=`# M15 记忆系统发布评审与运维手册

> 状态：实施完成，默认策略保持 opt-in  
> 评审日期：2026-09-14  
> Zvec：\`@zvec/zvec\` 0.7.0 Node SDK

## 发布决定

M15 已补齐发布矩阵、跨进程重建限流、保守资源预算、备份恢复、许可证检查和 CI packaged smoke，但本次评审**不把 Zvec 主动检索改为默认开启**。

原因：

1. macOS arm64 的本地未签名 packaged smoke 已有实测证据，但签名和公证产物仍需在正式发布身份下验证；
2. Linux x64/arm64、Windows x64 的真实 packaged smoke 已加入 CI，必须以对应构建产物通过为准；
3. Zvec 0.7.0 没有 macOS x64 binding，该平台不能发布 Zvec 能力；
4. M09 的确定性 fixture 证明检索管线，不代表任意生产 Embedding Profile 的质量；每个 Project 仍需单独评测后进入主动白名单。

因此安全默认值保持：\`backend=lexical\`、\`memoryRetrieval.enabled=false\`、精确 Project allowlist 为空。可先使用 shadow，满足质量和稳定性门禁后再逐 Project 启用 active。

## 平台矩阵

| 平台 | Zvec binding | 发布策略 | 门禁 |
| --- | --- | --- | --- |
| macOS arm64 | \`@zvec/bindings-darwin-arm64\` | 支持 | DMG 构建、asar unpack、Jieba 中文 FTS、真实 packaged smoke；正式发布另需签名/公证 |
| macOS x64 | 无 | 不发布 Zvec | 保持 lexical；不得把 x64 artifact 标为 Zvec-ready |
| Linux x64 | \`@zvec/bindings-linux-x64\` / musl variant | 支持 | AppImage、xvfb packaged smoke |
| Linux arm64 | \`@zvec/bindings-linux-arm64\` / musl variant | 支持 | arm64 runner 上构建和 packaged smoke |
| Windows x64 | \`@zvec/bindings-win32-x64\` | 支持 | NSIS x64、packaged smoke |
| Windows ia32 | 无 | 不支持 | Desktop target 已移除 |

所有 binding 在 Desktop 中使用精确 \`0.7.0\` optional dependency，并继续通过 \`asarUnpack\` 解包原生库和 Jieba 字典。CI 不允许仅以 TypeScript 构建替代 packaged smoke。

本机 macOS arm64 CI-mode 实测：未签名 \`.app\` 约 437 MiB、DMG 约 160 MiB，其中 Zvec 原生 binding 为 24,368,392 bytes。该数字是完整应用体积，不等于 Zvec 的净增量；各目标平台应保留 artifact size 历史并在异常增长时阻断发布。

## 资源和性能预算

重建开始前展示并在服务端检查：

- active L2/L3 条目数；
- \`ceil(itemCount / batchSize)\` 个 Embedding batch；
- 按可检索字符数除以 4 得出的近似 token 数；
- FP32 裸向量大小；
- 已保留 collection 大小；
- 新 collection 估算：\`SQLite bytes + 2 × raw vector bytes\`；
- 临时/compaction 预留：新 collection 估算的 25%；
- 峰值下限：\`SQLite + retained collections + estimated new collection + temporary overhead\`。

token 和 batch 是供应商无关的用量估算。货币成本必须按实际 Embedding Provider 的实时价格在启用前计算，OAT 不内置可能过期的价格表。HNSW、FTS、文件系统和真实语料仍可能超过估算，因此生产环境应在页面估算之外保留额外余量。

多个 Desktop Project 分属不同 Orchestrator 进程。M15 使用 \`~/.oat/locks/memory-index-rebuild.lock\` 跨进程串行化 rebuild/resume/activate/rollback；进程内队列继续禁止同一 Project 重复排队。持有租约的 PID 存活时不会被超时抢占；崩溃后其他进程可回收死 PID 租约。Agent 的正常模型调用仍不经过此低优先级重建队列。

激活 collection 后，Project 进程会立即启动常驻增量 Index Worker，并每 5 秒按 Outbox lease 消费一个受限批次。该调度器单飞执行，显式 rebuild/resume/activate/rollback 会等待在途增量批次并在运行期间阻止新批次；Embedding 402、超时或 Zvec 写入错误只更新重试/dead letter 和脱敏健康告警，不向 Agent 运行时抛出。优雅停机先停止调度并等待在途批次，再释放只读索引、写 worker 和 SQLite。

## 备份

Zvec 是可重建派生索引，备份只保存 SQLite 权威数据库和 manifest/checksum，不复制 collection：

\`\`\`bash
oat memory backup ./backups/my-project-2026-09-14 --config ./team.json
\`\`\`

备份目录包含：

\`\`\`text
manifest.json   # Project、格式、SQLite schema、SHA-256、恢复策略
memory.db       # better-sqlite3 在线 backup API 生成的一致快照
\`\`\`

备份过程可在 Project 运行时执行。创建后会执行 SQLite \`integrity_check\` 并计算 SHA-256。目标目录默认不允许覆盖。

全局 \`models.json\`、\`oat.json\` 和 \`team.json\` 不含在 Project 记忆备份内，应使用现有配置备份流程另行保存，并按秘密管理要求保护 Provider 凭据。

## 恢复、升级与降级

恢复必须先停止 Project，并精确确认 Project ID：

\`\`\`bash
oat stop <project-id>
oat memory restore ./backups/my-project-2026-09-14 \\
  --config ./team.json \\
  --confirm <project-id>
\`\`\`

恢复流程会验证 Project、manifest、SHA-256、SQLite 完整性和 schema version，然后：

1. 将当前数据库重命名为带时间戳的 \`.pre-restore-*\` 副本；
2. 原子放置恢复数据库；
3. 将现有 Zvec 根目录重命名为 \`.pre-restore-*\` 隔离目录；
4. Project 重启后先以 lexical 工作；
5. 用户在「全局设置 → 记忆管理」重建、验证并激活 collection。

升级遵循 SQLite 增量迁移和新 collection 重建，不原地修改 vector schema。降级前先备份；旧版本若无法理解更高 SQLite schema，应恢复升级前备份，而不是手工回写 \`user_version\`。Zvec/Embedding 版本回退必须使用仍保留的 immutable Profile 和 collection；否则恢复 SQLite 后重新构建。

## 故障门禁

发布前必须执行：

\`\`\`bash
pnpm test:memory:release
pnpm test:memory
pnpm run test:memory:zvec
pnpm exec tsc --noEmit
pnpm run build
pnpm --dir desktop run lint
pnpm --dir desktop run package:ci
node scripts/run-packaged-zvec-smoke.mjs
\`\`\`

覆盖范围包括：402 暂停和显式继续、429/超时/维度错误、损坏或删除 collection 后 lexical fallback、重建中断恢复、旧新索引双写与回滚、active collection 常驻增量消费、调度错误不终止 Agent、停机等待在途批次、权限零越界、跨进程并发限制、备份 checksum/完整性/跨 Project 拒绝，以及 packaged Jieba/Dense/FTS 实际调用。

## G4 结论

| 门禁 | 结论 |
| --- | --- |
| G1 Node/Electron 兼容性 | macOS arm64 本地通过；其余支持平台由新增 CI artifact smoke 持续验证 |
| G2 检索质量 | 确定性 fixture 通过；生产 Profile 仍需逐 Project 评测 |
| G3 权限 | Admin/Leader/Worker/外部 Worker/资源主管 fixture 零越权通过 |
| 连续运行与故障注入 | 自动化覆盖通过；正式发布仍需目标平台 CI 结果 |
| 默认开启 | **不批准，保持 opt-in** |

M15 的“完成”表示发布机制和评审已落地，不等于默认开启。未来只有在签名/公证、全部目标平台 packaged smoke、生产 Profile 质量评测和连续运行证据均通过后，才能提交新的独立产品决策。

## 许可证

记忆链路的主要直接依赖：

| 组件 | 锁定版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| Open Agent Team | 当前发布版本 | MIT | Orchestrator/Desktop |
| \`@zvec/zvec\` 及平台 binding | 0.7.0 | Apache-2.0 | Node 原生向量/FTS collection |
| \`better-sqlite3\` | 13.0.3 | MIT | 权威记忆数据库与在线备份 |
| Electron | 43.4.1 | MIT | Desktop 运行时 |

正式 artifact 仍应保留 electron-builder 生成的第三方许可证清单，并由 \`scripts/verify-zvec-release.mjs\` 检查核心许可证、版本、binding、架构和 asar 配置漂移。
`;export{e as default};