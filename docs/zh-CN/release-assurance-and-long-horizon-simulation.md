# BLH-051～055 长周期仿真、安全评审与发布 Gate

> 状态：Gate 机制、证据持久化、确定性仿真和 Hard 启动阻断已实现。产品父开关仍默认关闭。代码完成不等于线上观察期已经完成；缺少真实证据时 Gate 的正确结果是 `blocked`。

## 1. 90 天虚拟时钟仿真

`LongHorizonSimulator` 使用 seed 驱动的确定性 PRNG，在单进程数毫秒内模拟至少 90 个虚拟日和多个 Program。场景包含每日唤醒、暂停期间唤醒抑制、进程重启、新 execution epoch、系统时钟回拨、价格变化、审批延迟、Provider 429/5xx/402、重规划和保护收尾预算。该快速模型标记为 `evidenceLevel=synthetic`，只能用于确定性和策略回归，不能授权 Soft/Hard。

仿真以逻辑单调时钟做调度判断，墙钟回拨不会令已发生的事件“回到过去”。结果记录 seed、事件计数、核心不变量和 trace digest；相同 seed 和输入必须产生完全相同的结果。结果持久化到 `simulation_runs`。Soft/Hard Gate 只接受标记为 `integrated`、且真实运行 Execution DB、Ledger、Lease、Effect、Snapshot、Resume 与故障注入路径的结果；合成结果必须 fail closed。

必须保持为零的不变量包括：预算超支、重复外部副作用、旧 fencing token 副作用、迟到事件推进状态、快照秘密泄漏、跳过预检恢复，以及重启后不可解释 Program。

## 2. 安全威胁模型评审

每次评审必须覆盖以下五类威胁，不能省略或重复：

| 威胁 | 主要控制 | Gate 规则 |
| --- | --- | --- |
| Prompt 注入控制执行 | 结构化 control intent、Tool Guard、按钮确认 | open high/critical 阻止 Soft/Hard |
| Prompt 要求提升预算/模型 | Budget Ledger 分区、规则路由、未知价格拒绝 | Prompt 不是预算或路由授权源 |
| 快照泄露秘密 | 路径边界、秘密文件名拒绝、symlink/大小/digest 校验 | 未提供控制证据不能标记 mitigated |
| 旧 epoch/fencing token | Execution Barrier、Lease fencing、迟到事件隔离 | 外部副作用必须在 dispatch 前拒绝 |
| 权限绕过 | permitted tool、预算、epoch、lease、Provider 能力联合检查 | open high/critical 阻止 Soft/Hard |

`mitigated` finding 必须带 `controlRefs`。Soft 要求没有未缓解的 high/critical；Hard 进一步要求所有 finding 均为 `mitigated`，不接受风险接受代替控制关闭。评审及 digest 持久化到 `threat_model_reviews`。

## 3. 发布 Gate

### Shadow Gate

- 至少一个明确 opt-in 项目；
- 真实观察期至少 7 天且存在模型调用；
- Shadow 不得阻断现有调用；
- usage 100% 可归属；
- empirical P90 coverage 不低于配置目标；
- 安全评审允许进入 Soft。

### Soft Gate

- Shadow Gate 已通过；
- 低风险 Program 观察至少 7 天；
- minimum-tier 完成率严格高于固定均分预算基线；
- 至少一次停止/恢复演练且零失败；
- 重复外部副作用为零；
- 90 天仿真通过；
- 安全评审没有开放 high/critical。

### Hard 实验 Gate

- Soft Gate 已通过；
- Runtime 与所有选中 Provider 的 Hard preflight 通过；
- 90 天仿真、安全评审、全部不变量和灾难恢复均通过；
- Provider 能力证据仍在有效期。

Gate 决策的完整 evidence、blocker、digest 写入 append-only 的 `release_gate_records`。启动时会重新计算并核对 digest，损坏或不一致的记录不能授权 Hard。`HardModeCircuitBreaker` 一旦发现能力退化、证据过期或不变量违规，立即锁定并拒绝后续新调用；不会自动恢复。Orchestrator 启动时，`mode=hard` 还必须同时存在最近的 passed Hard Gate 和实时 preflight，否则启动失败，不能静默降为 Soft/Shadow。

## 4. 当前发布结论

当前仓库完成的是 Gate 的实现和可重复验证，不伪造生产观察数据。默认配置仍为：

```json
{ "budgetExecution": { "enabled": false, "mode": "shadow" } }
```

现有 Runtime 证据对 Provider 内部重试和权威 usage/request identity 仍为 partial，因此真实配置请求 Hard 时会被实时 preflight 拒绝。只有未来写入真实 Shadow/Soft 观察证据、关闭安全 finding，并获得 verified Provider/Runtime 能力后，Hard Gate 才可能通过。
