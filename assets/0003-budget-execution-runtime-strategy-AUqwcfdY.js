var e=`# ADR 0003：预算执行 Runtime 接入与 Hard-mode Gate

- 状态：已接受（BLH-004）
- 日期：2026-10-10

## 背景

BLH-002 证明当前 \`pi-coding-agent\` 的 Agent 首轮、工具续轮、手工/自动压缩和分支摘要复用统一 \`Agent.streamFunction\`，最终委派给注入的 \`ModelRuntime.streamSimple\`。SDK 同时公开 Provider 请求前后事件及 \`AgentSession.abort()\`。

但现有公共契约不能证明：

1. Provider 内部每次自动重试都有独立、可拒绝的前置 Hook；
2. 所有 Provider 都返回稳定 request ID 和权威 billable usage。

BLH-003 又规定 Provider 配置不能自证价格上界、usage、输出限制、幂等、状态查询和 abort 能力；这些能力必须有 verified 证据。

## 决策

1. shadow/soft 首选 **SDK ModelRuntime Wrapper**，不新增网络代理。
2. 当前 Runtime 证据和默认 Provider Profile 下，hard 为 **No-Go**。
3. 请求 hard 但预检失败时，\`effectiveMode=none\` 并拒绝启用；绝不静默降级到 soft/shadow。
4. shadow/soft 可以启动，但必须返回同一组 hard limitations，且 \`hardGuaranteeActive=false\`。
5. hard 只有在 Runtime Gate 与所有选中 Provider Gate 同时通过时才可启用。
6. Provider 必须显式选择；无 Profile、探针失败、unknown、unsupported 或非 verified 能力全部 fail closed。

## 为什么先选 SDK Wrapper

- 覆盖 Agent 首轮、工具续轮、压缩和摘要路径；
- 无需处理 TLS、流式转发、Provider 方言和凭据代理；
- 可先实现 shadow 计量和 soft 决策，风险较小；
- 保持 Provider 原始客户端和认证路径不变。

## Hard 的解除条件

满足下列任一 Runtime 路径，并同时通过 Provider Gate：

1. SDK 升级：公共契约保证每次底层 Provider attempt 都经过可拒绝 Hook，并提供稳定 request ID/usage；或
2. OAT Metering Proxy：所有受支持 Provider 请求强制经由代理，代理负责 reservation、逐 attempt 身份、输出上限、usage 和对账。

如果采用 Proxy，必须先另立 ADR 处理流式背压、断连、TLS、认证隔离、Provider 方言、幂等和单点故障。BLH-004 不实现 Proxy。

## 结构化预检

\`evaluateBudgetExecutionPreflight()\` 输出：

\`\`\`text
status: disabled | ready | rejected
requestedMode: shadow | soft | hard
effectiveMode: disabled | none | shadow | soft | hard
hardGuaranteeActive: boolean
integrationStrategy: sdk_model_runtime_wrapper
blockers[]
limitations[]
\`\`\`

阻塞原因区分 configuration、runtime 和 provider，并携带稳定 code/subject，供调用方和审计使用。

## 后果

- 可以继续 BLH-005 及 shadow/soft 基础设施工作。
- 当前版本不能对用户宣称 hard 预算保证。
- SDK 或 Provider 能力变化必须重新运行 BLH-002/003 测试和本预检。
- 预检本身保持纯函数；Orchestrator 已在实验父开关开启时调用它，并通过 \`assertConfiguredReleaseMode()\` 校验发布 Gate。Soft 启动要求 passed Shadow Gate；Hard 启动同时要求 passed Hard Gate 与实时预检通过。当前真实 Runtime/Provider 证据不足，Hard 仍被拒绝。
`;export{e as default};