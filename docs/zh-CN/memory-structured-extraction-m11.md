# M11 结构化记忆提取运行手册

M11 在空闲做梦阶段把事件提取为原子事实候选。候选不是权威记忆：只有通过 M12 的冲突、去重、有效期与独立证据治理后才可能激活；未激活候选不会进入 Zvec、不会参与 lexical 检索、不会注入 Agent 提示。

## 配置

```json
{
  "memory": {
    "extraction": {
      "enabled": true,
      "model": "memory-extractor",
      "version": "m11-v1",
      "timeoutMs": 15000,
      "maxInputChars": 4000,
      "maxOutputTokens": 800,
      "maxFactsPerEvent": 5,
      "maxAttempts": 3
    }
  },
  "models": {
    "memory-extractor": "openai/gpt-4.1-mini"
  },
  "providers": {
    "openai": {
      "compatible_type": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "..."
    }
  }
}
```

`model` 可写模型别名或 `provider/model`。它和聊天模型、Embedding Profile 相互独立。当前支持 OpenAI-compatible Chat Completions 与 Anthropic Messages。未配置模型、Provider 不存在、配置不安全或 `enabled=false` 时，系统保持原有确定性 L2 沉淀，不阻止项目启动。

## 安全边界

- 事件正文作为 JSON 数据放入 user message，并明确声明为不可信内容。
- OpenAI-compatible 请求使用 strict JSON Schema；Anthropic 请求强制调用固定 tool；返回后都通过本地严格 Zod Schema。
- 额外字段、非法枚举、越界数值、非法时间或超量事实会拒绝整次响应，不部分写入。
- 模型建议的 scope 只能被代码收紧：Admin 内部事件最大 project，Leader/Worker 最大 team；Channel 与 A2A 最大 private。
- trust 不由模型提供。内部 Admin/Leader/Worker 上限为 100/90/80，Channel/A2A 上限为 40/30。
- 常见凭据在事件捕获和错误审计阶段脱敏；API key 不写入数据库。

## 数据与重试

通过验证的事实先写为 `level=L2`、`status=candidate`、`schema_version=3`、`index_state=not_applicable`，同时保存 subject、predicate、object、scope、trust、source event、模型和 extraction version。随后由 M12 治理；只有 active 结果才会进入索引。

`memory_extraction_runs` 记录成功、空结果拒绝或失败、候选数量、输入字符、供应商返回的输入输出 token、延迟和脱敏错误。失败事件在后续做梦轮次重试；达到 `maxAttempts` 后停止，避免无限计费。单事件失败不会让做梦或 Agent 任务失败。

## 回滚

将 `memory.extraction.enabled` 设置为 `false` 并重启 Project。之后新事件恢复原有确定性沉淀；既有 candidate 保留供审计，但继续不被召回或索引。回滚不删除 SQLite 或 Zvec 数据。

## 验证

```bash
pnpm test:memory:extraction
pnpm test:memory:migrations
pnpm test:memory
pnpm exec tsc --noEmit
pnpm run build
```
