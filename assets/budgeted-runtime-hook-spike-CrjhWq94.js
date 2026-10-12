var e=`# BLH-002 Runtime 调用级 Hook Spike

> 日期：2026-09-22
> 范围：\`@earendil-works/pi-coding-agent\` 0.84.x 现有 SDK 表面。
> 结论：可以继续实现 shadow/soft；现阶段不得启用 hard。

## 覆盖矩阵

| 路径 | 结果 | 证据/限制 |
| --- | --- | --- |
| 首次模型调用 | 支持 | \`createAgentSession\` 为 Agent 安装统一 \`streamFn\`，委派到注入的 \`ModelRuntime.streamSimple\` |
| 工具结果后的续轮 | 支持 | Agent 续轮复用同一个 \`Agent.streamFunction\` |
| Provider 内部自动重试 | 部分支持，hard blocker | \`maxRetries\` 位于 \`streamSimple\` 边界之下；公共契约未保证每次底层重试都有独立前置 Hook |
| 手工压缩 | 支持 | \`AgentSession.compact\` 传入 \`this.agent.streamFunction\` |
| 自动压缩 | 支持 | auto-compaction 传入同一 stream function |
| 分支摘要 | 支持 | branch summarization 使用同一 stream function |
| Provider 请求前 | 支持 | SDK 暴露 \`before_provider_request\` |
| Provider 响应后 | 支持 | SDK 暴露 \`after_provider_response\`，含 HTTP status/headers |
| 运行中止 | 支持 | \`AgentSession.abort()\` 和 \`waitForIdle()\` 为公共 API |
| usage 与请求身份 | 部分支持，hard blocker | 终态消息可见 usage，但公共 Hook 不保证所有 Provider 都返回 request ID 和权威账单 usage |

## Go/No-Go

- **Shadow：Go**。可以在统一 stream 边界估算和记录，不改变调用行为。
- **Soft：Go，需后续任务实现**。可以告警、建议重规划和人工确认。
- **Hard：No-Go**。必须先解决逐次 Provider retry 可观测性，以及 request ID/权威 usage/价格上界能力。

## 自动化证据

\`src/sandbox/runtime-hook-spike.test.ts\` 针对当前锁定 SDK 检查：

1. 注入的 \`ModelRuntime.streamSimple\` 是 Agent 调用的统一入口；
2. 压缩和分支摘要复用相同 stream function；
3. Provider 请求前后 Hook 存在；
4. \`abort()\`/\`waitForIdle()\` 存在；
5. 保守决策始终将两个未解决项列为 hard blocker。

这些测试是升级 SDK 时的兼容性哨兵，不进行真实联网调用，也不接入生产 Runtime。
`;export{e as default};