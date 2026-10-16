# 重规划、规则路由与收尾运行时

更新：2026-10-16。对应第六项后续任务 / BLH-042～046 常驻集成。

实验父开关启用后，Coordinator 在任务对账及确定性验收之后调用 `ProgramLifecycleRuntime`，再选择下一批工作。该流程由持久化 Wakeup 驱动。本流程的数据沿用现有 Plan、Attempt、Evidence、Audit、Snapshot 和 Closeout 表；后续 Schema v7 增加独立的[跨实例调度所有权](./cross-instance-scheduling-runtime.md)。

## 有限重试和自动计划切换

终态 Attempt 通过稳定审计 ID 记录一次观察结果，重启或重复 tick 不会重复累加失败。成功清空连续失败计数，失败类别变化也重新计数。普通执行失败和验收失败分别计数。

第一次确定失败时，服务检查原执行分区剩余额度，将工作包恢复为 runnable；新派发使用新 Attempt、租约和 Reservation。连续两次同类失败时，在旧计划的执行和验收都已结束之后创建下一版 Plan。默认最多自动切换两次计划，同一 stable key 累计六次失败也会停止，避免失败类别交替造成无限重试。

自动切换只重建**已经批准的定义与 Scope Tier**，保留原 Prompt、验收标准、时间约束、目标和 hard envelope，不扩大预算，不从 validation/closeout 等保护分区借款。新 Plan/Work Package 使用新 ID，依赖 ID 一并重映射；旧计划原子变为 superseded，新计划成为活动计划。不同目标、验收或范围需要走显式审批流程，当前自动策略不会生成这些授权变化。

继承完成项要求前一完成 Attempt 对全部 criterion 都有通过且绑定 SHA/digest 的证据；生产路径还要求验证器版本一致。证据复制到新完成 Attempt，并在审计中记录来源 Work Package 和 Attempt。缺少证据时停止并收尾，不把旧包伪装成完成，也不静默重新执行已完成包。继承使用的是既有验证时点的证据；它不证明外部工件之后未发生变化。

uncertain/expired Attempt 或预算账目不会进入自动重试。已存在的未决副作用仍由 Effect Reconciler 查询，无法确认时报告保留不确定性。失败工作包若已执行过高影响副作用，即使有成功回执也不自动重放整个包，以免新 Attempt 重复发送或发布。

## 受配置约束的模型选择

`budgetExecution.modelRouting` 是可选的可信配置。未配置时沿用 Agent 已配置模型；配置后从符合角色、团队约束且空闲的现有 Agent 中选择模型，不动态重启 Agent 切换模型。

示例（模型别名需存在于项目或全局模型配置中，价格需包含在 Program 创建时的快照中）：

```json
{
  "budgetExecution": {
    "enabled": true,
    "mode": "shadow",
    "modelRouting": {
      "requiredCapabilities": ["code"],
      "risk": "medium",
      "candidates": [
        { "modelRef": "worker-model", "capabilities": ["code"], "maximumRisk": "high", "qualityTier": 1 }
      ]
    }
  }
}
```

候选模型必须满足配置中的能力和风险要求，且 Program 冻结价格与当前价格一致。规则在满足预算模式的 quality tier 限制后按价格和模型引用确定排序：commit 允许 tier ≤ 1，closeout 允许 tier 0；执行调度本身在 closeout 模式停止。无合格空闲 Agent 时保持调度阻塞，不自动放宽规则。每次生产选择前重读全局模型配置；每次实际模型调用仍经过原有预算/价格闸门。

派发审计固定所选 Agent 的模型引用；模型调用服务除了校验配置模型，还校验 Attempt 对应的派发模型。Prompt 无权更换候选、能力、风险、quality tier 或所选模型。未知价格无法成为动态路由候选，Hard 模式仍因既有发布门禁而关闭。

## 停止、恢复点、对账与报告

工作完成、执行预算不足、强制任务过期、未知执行结果、重试或重规划次数耗尽时，生命周期服务调用 `ProgramCloseoutRuntime`：

1. 复用 `cancel_closeout` 控制协议推进 epoch、冻结 Barrier、停止在途执行并保存 Snapshot。
2. 检查恢复点属于当前 Program、Plan 和 epoch，并验证 Snapshot 完整性。
3. 等待验证器及工具操作停稳，逐 Attempt 对账模型调用与副作用。
4. 原子保存预算、任务、证据与不确定性报告，并进入 completed 或 incomplete。

停止后尚未完成报告的 `closing_out` Program 仍由 Wakeup 消费，不派发新任务；重启后可以继续最终对账和报告。若恢复点缺失、损坏或过期则保持关闭新执行并报告错误，不跳过验证。

从未激活的 Reservation 尝试由子到父释放，活跃 Reservation 无法确认结算时转为 uncertain；created/active/uncertain/expired 账目、未决副作用和未结束/未知 Attempt 都阻止完整交付。强制任务按活动计划批准的 Scope Tier 统计，该范围内被取消的强制项仍算未完成；证据只使用该工作包最新完成 Attempt，不把历史失败证据误认为当前验收，也不以单条成功证据代替全部标准。

报告持久化在 `program_closeouts`，包含恢复点 ID、各预算分区的 limit/spent/reserved、未完成任务、证据 ID 和交付判定原因。既有 `GET /api/experimental/programs/:id/view` 响应新增 `closeoutReport`，重复收尾返回同一报告。

## 验证与边界

真实 SQLite 回归覆盖从正式计划审批到任务派发、验收、重试、跨重启的计划切换、证据继承、最终收尾；另有计划切换故障回滚、强制任务取消、缺失证据、预算耗尽中止、closing_out 恢复、模型能力/风险/价格选择和模型身份防升级测试。配置回归验证路由字段及项目模型别名解析。

当前策略是已有批准定义上的有限执行重规划。生成新目标/Prompt/验收的规划器、细化任务级能力策略、其他验收/Provider Adapter、远端运行时迁移、真实 Provider/容器长期演练仍属于后续工作。父开关继续默认关闭，合成或本地回归不能替代真实 Shadow/Soft 发布证据。
