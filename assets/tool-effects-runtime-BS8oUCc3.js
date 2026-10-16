var e=`# 工具副作用网关与对账

> 更新：2026-10-16。BLH-039～041 的生产工具网关和首批状态查询已实现。全部能力仍受默认关闭的 \`budgetExecution.enabled\` 控制；Hard 保持 No-Go。

## 接入范围

两条 Agent 工具路径使用同一父进程 \`ToolEffectService\`：

- OAT 自定义工具：本地和 Docker Provider 在调用注册的 execute 函数之前经过 Tool Guard，工具权限来源是当前 Agent 的真实工具注册表。
- SDK 工具：runner 在 Agent 的 beforeToolCall/afterToolCall 上安装网关，保留 SDK 原有扩展钩子；read、grep、find、ls、write、edit、bash 在执行前申请许可，执行后回传结果摘要。没有明确策略的扩展工具不会自动获得权限。

自定义 OAT 工具不会在 runner 重复计量。普通 Task 没有 Program execution context 时沿用原行为。

## 执行协议

每个操作使用 \`SHA-256(attemptId + toolCallId)\` 派生稳定 operation key。相同 ID 和请求的重放不会再次执行；相同 ID 携带不同参数、主体或上下文返回冲突。旧 operation 的回放不能跨新 Attempt 继续执行。

执行前校验 Program、Work Package、Attempt、epoch、owner、lease expiry、fencing token、barrier、实际注册工具权限及预算信封归属。异步预处理文件状态之后会再次校验；父进程自定义 execute 调用前也会再次检查执行上下文。

以下状态在 SQLite 事务中写入，提交成功后才允许发送操作：

\`\`\`text
Tool Guard → prepared → dispatched
                       ├→ confirmed（收到正常工具回执）
                       └→ uncertain → reconciled（迟到回执或状态查询）
\`\`\`

Soft 在工作包信封内为每次调用预留一个 \`toolCalls\` 单位，完成或结果未知时幂等结算一个单位，不重复冻结根账户。工作包及账户须显式分配该维度；缺失按零额度处理。Shadow 仅记录预算 would-block，不消耗额度；身份、权限和防重检查仍生效。工具调用次数不代表任意外部服务的货币成本，尚未配置的外部收费上界不能据此声称受 Hard 保证。

Program 工作包须由已有计划调度器派发，不能通过 create-task、dispatch-worker-tasks、assign-leader-task 或会生成普通重试任务的拒绝审核路径绕过预算创建子任务；这些调用返回 \`UNBUDGETED_DELEGATION_DENIED\`。普通 Task 的委派行为不受此网关改变。

## 超时、重复请求与恢复

OAT execute 等待默认最多 30 秒。超时或抛错不能证明副作用没有发生，操作保持 uncertain，调用次数按一次结算；超时不等于底层请求已取消。相同操作不会自动重发，换一个 toolCallId 重发同一未决请求也会被参数摘要检测拦截。

工具函数之后返回正常结果时，可以把 uncertain 更新为 reconciled，但不重复扣费。迟到回执只更新副作用账本和预算，不能推进 Work Package 或解除 barrier。确认过的操作不会保存或自动重播原始工具输出；重放会返回既有状态和 operation key 的错误提示。

程序中止和停机时将未收到回执的操作归入 uncertain 并尝试状态查询，快照据此保留未决操作。工作包结束、租约过期和失败路径也会触发对账。存在 prepared/dispatched/uncertain 操作时，自动验收不会把 Program 标成完整交付。

## 首批实际状态查询

| 操作 | 查询证据 |
| --- | --- |
| write | 当前文件 SHA-256 与预期内容摘要一致 |
| edit | 支持唯一 oldText 精确替换时的预期 postimage 摘要；其他编辑结果无自动推断 |
| report-progress | TaskManager 保存的 message/stage 摘要一致 |
| notify-complete、submit-review | 同 Program/Attempt 的已完成或待审核任务及 Git 交付记录 |
| approve-release、push-release | 对应 ReleaseProposal 的 approvedAt/pushedAt 与 headSha |
| review-worker-branch | 对应审核的持久化状态与 headSha |

文件查询拒绝工作区外路径和符号链接，读取上限为 10 MiB；Docker 的 \`/workspace/\` 路径由受信 Provider 映射到对应宿主工作区。只有正向 postcondition 才能确认；文件缺失或内容不同不能证明历史操作未发生。

查询复用现有文件、任务、Git 审核及发布持久化事实，不重新执行原工具。父进程每 10 秒持续查询未决操作，包含暂停项目；仍在当前进程执行的操作不会被后台轮询误判。单次查询默认最多 10 秒。异常、超时、不支持查询或无法确认时保留 uncertain。bash 内部的任意网络/命令组合没有通用状态查询，不会以“重新执行一次”代替对账。

## 隐私与查询接口

网关持久化参数摘要、执行身份、必要的资源 ID、工作区内目标路径和结果摘要；不保存完整参数、文件正文、命令文本、原始工具输出或凭据。常规回执的 \`evidence=tool_completed\` 表示工具函数正常返回；外部状态的后续确认以对应查询证据为准，不能据此推断 bash 中每一个嵌套操作都具备独立幂等性。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | \`/api/experimental/programs/:id/effects\` | 当前项目最近 200 条操作、摘要、状态与回执 |
| POST | \`/api/experimental/programs/:id/effects/reconcile\` | 执行只查询、不重发的对账，返回已归并数量和未决操作 |

接口仅在实验父开关开启时注册，并按当前项目验证 Program 归属。Hard 下拒绝没有幂等能力证据的高影响工具；当前发布 Gate 仍不允许启用 Hard。

## 验证范围

新增回归覆盖真实 Execution DB/预算信封、并发投递、不同参数冲突、权限/owner/epoch/fencing、额度耗尽、超时和迟到回执、服务重建后的文件/任务状态对账、容器路径映射、查询竞态、查询超时以及未决操作阻止最终完成。SDK 钩子测试覆盖扩展阻断、参数修改、自定义工具防止重复计量和普通 Task 兼容行为。

自动化验证没有调用真实外部收费工具或生产 Git 远端，也不能替代 Docker daemon、跨实例故障恢复及 Provider 幂等能力的正式发布验证。
`;export{e as default};