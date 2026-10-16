var e=`# 模型调用计量与自动验收运行时

> 更新：2026-10-15。SDK 调用级预算入口与首批确定性自动验收已接入生产调度；功能仍受 \`budgetExecution.enabled\` 默认关闭的父开关控制，Hard 仍为 No-Go。

## 模型调用预算

\`agent-runner\` 在 SDK 的共享 \`Agent.streamFunction\` 上安装 \`installBudgetedStream()\`。该入口委派给 SDK 原有的 ModelRuntime，工具续轮、会话重试、压缩和摘要都会重新经过此入口。普通 Task 没有 Program execution context 时沿用原调用和重试设置。

每次受管 SDK 调用生成独立 operation ID，通过本地 child-process IPC 或 Docker JSON IPC 完成：

1. runner 提交 begin，携带 Attempt 上下文、实际模型身份和用量上界；
2. 父进程 \`ModelCallService\` 校验 barrier、epoch、owner、lease、fencing 和任务预算信封的关联；
3. 使用 Program 的冻结价格快照与当前模型目录检查价格，并执行 Shadow Model Guard；
4. Soft 在任务信封内部创建、激活子 Reservation，不重复冻结根账户额度；Shadow 仅记录 would-block；
5. 父进程确认后才能发出模型请求；受管调用显式设置 \`maxRetries=0\`，SDK 会话层重试会作为新调用重新申请；
6. runner 在交付模型终态前等待 finish 确认，父进程经 Usage Reconciler 按冻结价格幂等结算；可用 usage 不足、错误、abort 或结果丢失时按预留上界保守结算。

输入上界使用模型 context window；输出上界采用调用的 maxTokens，并受模型最大输出限制；cache read/write 也按 context window 做保守估算。这可能导致 Soft 拒绝实际成本更低的请求，不能把它解释成精确 token 预测。任务信封和账户须显式包含需要的 moneyMicros、inputTokens、outputTokens、modelCalls 等预算维度；缺少维度按零额度处理。

父进程会校验实际调用模型与 Session 配置一致，并从冻结价格的完整模型名、全局别名或 providerId/modelId 解析价格。价格缺失或变更在 Soft 下拒绝新调用，在 Shadow 下记录 would-block。中止后到达的 finish 只结算既有调用，不推进 Work Package 状态。终止、租约过期或进入验收时会对没有 finish 的调用做保守对账；重复对账不重复扣费。

审计中的 \`metering=sdk_reported_not_authoritative\` 明确表示用量来自 SDK 回报。当前实现没有获得所有 Provider 的权威账单查询和真实 request ID 证据，不能承诺 Provider exactly-once、隐藏重试完全可控或 Hard 预算保证。合成的 operation ID 不冒充 Provider request ID。

## 自动验收与依赖推进

Task 进入 ReviewPending 时仍维持运行态并续租；仅在既有 TaskManager 确认 Task Completed 后进入 verifying。\`ProgramVerificationRuntime\` 随调度 tick 执行验收，使用任务保存的 Git 工作区，缺少该路径时尝试当前 Runtime Session 工作区。

首批内置验证器：

| 类型 | 验证行为 | 证据 |
| --- | --- | --- |
| file_exists | 检查工作区相对路径、普通文件及可选期望 digest | 文件 SHA-256 或失败记录 digest |
| command_exit_zero | 在任务运行边界执行已批准的命令，检查退出码 | 命令结果/输出 digest，日志不保存原始输出 |
| test_report | 读取 JSON \`{ "passed": 3, "failed": 0 }\`，校验非负安全整数和阈值 | 报告原始内容 SHA-256 |

文件读取拒绝绝对路径、\`..\`、symlink 和超过 10 MiB 的文件。命令执行的有效超时不超过 300 秒，输出缓冲最多 64 KiB；本地运行时回收命令进程树，Docker 运行时创建独立验收容器并在返回前删除、核验容器。中止和停机先取消并等待在途验收，再生成快照或关闭数据库；Docker 容器无法确认清理时不报告静默成功。

证据绑定 Attempt、criterion、验证器版本与 artifact digest；存在 Git HEAD 时也绑定 SHA，并校验任务记录的 headSha 及验证前后 HEAD 一致。重复 tick 使用同 Attempt/criterion 已存证据，避免重跑已经持久化的验收命令。每个异步验证结果提交前重新检查 epoch、barrier、lease、fencing 和工作包状态，迟到验证结果不能推进状态。

全部验收通过才把 Attempt/Work Package 标为 completed，失败则标为 failed；释放任务信封未消费余额并写入 Outbox 投影。依赖全部完成的 planned/blocked 工作包转 runnable，可在该 tick 继续调度。活动计划全部进入 completed/cancelled 后触发 Closeout，最终报告仍要求 mandatory 验收证据和账目归宿；历史提案不计入当前交付范围。

2026-10-16 已接入[工具副作用网关与对账](./tool-effects-runtime.md)。验收前会保守处理工具未决回执；存在 prepared/dispatched/uncertain Effect 时保留 Program 运行态等待对账，不会把已通过文件检查等同于完整交付。

缺少工作区、验收条件、验证器或外部证据时保持 verifying，并写入 verification_blocked 审计。schema_valid、metric_threshold、external_state、human_approval 和 llm_judge 尚无内置生产 Adapter，不会伪造成功。批准定义内的有限重规划和安全收尾现已接入，见[重规划、规则路由与收尾运行时](./replanning-routing-closeout-runtime.md)；跨实例验证执行协调和真实 Provider/容器发布验证仍是独立工作。

## 验证范围

\`model-verification-integration.test.ts\` 从 Program 草案、计划准入与审批开始，使用真实 Execution DB、Ledger、Lease 和 Coordinator 验证逐调用结算、未知结果、价格漂移、Shadow、验收失败、依赖推进、最终 Closeout、中止竞态和命令取消。\`budgeted-stream.test.ts\` 使用可控模型流验证请求前授权、续轮独立身份、重试配置和终态前结算。

这些测试不发起真实 Provider 计费请求，也不代替 Docker daemon、跨平台进程回收和正式发布环境的集成验证。
`;export{e as default};