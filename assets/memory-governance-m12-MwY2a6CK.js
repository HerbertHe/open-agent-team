var e=`# M12 记忆候选治理运行手册

M12 在结构化提取之后，把 L2 candidate 转换为可审计的事实演化记录。SQLite 始终是权威源；只有 \`active\` L2/L3 会进入检索索引。

## 治理顺序

1. 检查 \`validFrom/validTo\`。已过期候选进入 \`superseded\`，非法区间进入 \`disputed\`。
2. 对同一 Agent 的 subject/predicate/object 做规范化 exact 匹配，合并来源并保留 \`verified_by\` 关系。
3. subject/predicate 相同但 object 不同视为冲突，建立双向 \`contradicts\`；旧 active 保持唯一当前事实并在提示中显示冲突警告。
4. 若存在全局 Embedding Profile，使用同一 identity 的 dense embedding 生成 \`semantic_duplicate\` 建议。建议不自动合并、激活或覆盖事实。
5. 可信内部事实达到两个独立证据后可激活 L2；L3 自动晋升还要求 \`trust>=90\`、没有未解决冲突，并满足 \`memory.l3.minEvidence\`（最低为 2）。

独立证据按 \`sourceType + sourceAgentId + taskId\` 计数。同一 Agent 在同一任务中的重复汇报只计一次。Channel 与 A2A 的 trust 上限低于自动激活阈值，并且代码还会检查来源全部为 internal，因此外部来源不能通过重复提交自动晋升。

每条候选保存 \`governance_version=m12-v1\` checkpoint。没有新候选或新证据时不会在每轮做梦中重复调用 Embedding；新候选到达后仍会把已经评估的候选作为 exact/conflict/semantic 比较对象。

## 人工确认

Desktop 记忆面板可切换“候选记忆”和“冲突待确认”，点击“确认为当前事实”。对应 API：

\`\`\`http
POST /memory/:id/confirm
Content-Type: application/json

{"confirmedBy":"desktop-user"}
\`\`\`

确认普通候选会将其设为 active。确认冲突候选会在一个 SQLite 事务中将旧 active 转为 superseded，建立 \`supersedes\` 关系，再激活新事实，因此新旧配置不会同时作为当前事实注入。确认 exact duplicate 时只合并到现有 canonical，不创建第二条 active。

人工晋升 L3 继续使用 \`POST /memory/:id/promote\`，只接受 active L2。历史版本、冲突关系、来源和确认人均保留审计。
若用户选择“遗忘” disputed candidate，该建议视为拒绝，当前事实上的未解决冲突标记会清除，但历史关系仍保留审计。

## 语义治理降级

语义匹配复用 Project 的全局 \`memory.embeddingRef\`，不调用 Python，也不直接打开 Zvec collection。没有 Profile、模型失败或余额不足时，只记录脱敏降级原因，exact duplicate、冲突、有效期和人工确认仍正常工作，不影响 Agent 任务。

## 回滚

将 \`memory.extraction.enabled=false\` 并重启 Project，即停止新增候选和自动治理。已有 candidate/disputed/superseded 及关系审计全部保留，只有 active 记忆继续召回。无需删除 SQLite 或重建 Zvec。

## 验证

\`\`\`bash
pnpm test:memory:governance
pnpm test:memory:migrations
pnpm test:memory
pnpm exec tsc --noEmit
pnpm run build
pnpm --dir desktop run lint
pnpm --dir desktop run build
\`\`\`
`;export{e as default};