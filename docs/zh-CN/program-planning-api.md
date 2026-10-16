# Program 计划提交、准入与审批 API

> 状态：业务服务和 API 已实现，2026-10-15。全部路由仅在 `budgetExecution.enabled=true` 时注册，父开关默认关闭；沿用本地 Orchestrator / trusted Desktop 边界。

该入口将现有 Plan Validator、成本估算、Admission Controller、Scope Tier 选择、Repository 和原子激活服务串联起来。调用方提交工作包定义；状态、归属、版本、revision 和时间戳由服务端生成，不能从请求伪造已完成或已激活状态。

## 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/experimental/programs/:id/plans` | 原子保存计划和工作包，Program 转入 planning |
| GET | `/api/experimental/programs/:id/plans/:planId` | 查询计划、工作包、已保存估算和三档准入结果 |
| POST | `/api/experimental/programs/:id/plans/:planId/admission` | 估算、准入和范围选择；可行或待人工确认的计划进入 awaiting_approval |
| POST | `/api/experimental/programs/:id/plans/:planId/approve` | 明确确认后原子激活计划、绑定 Program 并生成 runnable 工作包事件 |

上述路由均在当前项目范围内查询 Program，并验证 Plan 属于路径中的 Program。输入使用 strict Schema。非法输入返回 HTTP 400；不存在或归属不符返回 404；版本、状态、准入或预算冲突返回 409，响应包含稳定 `code`；未预期的存储失败返回 500。

## 使用流程

先通过已有 `POST /api/experimental/programs` 创建带预算账户和价格快照的 Program 草案。以下示例假定草案 ID 为 `program-1`，revision 为 0，minimum 账户至少有 20 moneyMicros 可用额度。

### 1. 提交计划

向 `/api/experimental/programs/program-1/plans` 提交：

```json
{
  "id": "plan-1",
  "expectedProgramRevision": 0,
  "createdBy": "admin",
  "workPackages": [{
    "id": "work-1",
    "stableKey": "deliver-result",
    "title": "生成结果文件",
    "prompt": "实现需求并生成 result.json，提交验证结果。",
    "targetAgentRole": "worker",
    "scopeTier": "minimum",
    "mandatory": true,
    "priority": 1,
    "hardEnvelope": { "moneyMicros": 20 },
    "acceptanceCriteria": [{ "id": "result-exists", "type": "file_exists", "path": "result.json" }]
  }]
}
```

成功返回 HTTP 201，以及 `program`、`plan`、`workPackages`。Program revision 变为 1，Plan revision 为 0。实际调用始终使用响应中的 revision；不要假设固定增量。

提交时拒绝环、悬空依赖、归属错误、重复 stable key、空预算信封及 mandatory 工作缺少验收条件等情况。创建和保存依赖、验收条件任一步失败会全部回滚。

### 2. 准入评估

向 `/api/experimental/programs/program-1/plans/plan-1/admission` 提交：

```json
{
  "expectedProgramRevision": 1,
  "expectedPlanRevision": 0,
  "targetProbability": 0.9,
  "samples": 1000,
  "seed": "program-1-plan-1"
}
```

可选 `deadlineSeconds` 指定模拟期限，范围为 1～31,536,000 秒；`samples` 范围为 100～20,000，默认 1000。返回估算、minimum/standard/stretch 决策和 `selection`；估算和准入结果存入既有 Execution DB 表，无需新增迁移。

首期入口使用服务端冷启动估算，尚未接入生产历史样本自动校准，不接受客户端提交 baseline、置信度或准入结果。因此正常结果为 `calibrated=false`、`requiresHumanApproval=true`，不提供联合成功概率，范围仅建议 minimum。准入仍会检查 minimum 和 upgrade_pool 的逐维硬信封，不能借用 validation/closeout 等保护账户；minimum 放不下时计划转为 rejected，不会因未校准而绕过预算限制。计划还必须包含 mandatory minimum 工作包。

待确认时 Program 和 Plan 都进入 awaiting_approval；本示例响应中的两个 revision 均为 2。评估不会派发任务，也不会生成 runnable 事件。

### 3. 审批并激活

向 `/api/experimental/programs/program-1/plans/plan-1/approve` 提交：

```json
{
  "expectedProgramRevision": 2,
  "expectedPlanRevision": 2,
  "selectedTier": "minimum",
  "confirmed": true,
  "acceptUncalibratedRisk": true,
  "approvedBy": "desktop-user"
}
```

未校准计划必须同时显式确认和接受风险，只允许 minimum；已校准但不可行的档位不能靠人工确认绕过。审批会重新检查当前账户可用额度；若评估后余额减少则返回 `BUDGET_CHANGED`。

激活在同一事务中保存实际选定 Scope Tier、激活 Plan、将 Program 置为 admitted、取消所选档位外的工作包、开放根工作包并写入 Outbox 和审批审计。失败全部回滚。既有 Program Coordinator 随后会在调度 tick 中处理 admitted Program，无需手工改数据库。

## 版本与实现边界

- 计划定义提交后不原地修改。修改方案需使用新 Plan ID 和 Work Package ID 再次提交，版本号由服务端递增；只有最新提案可评估或批准。
- 新提案会推进 Program revision，使旧审批失效；即使调用方刷新 Program revision，也不能批准旧提案。
- 当前仅接受 draft/planning/awaiting_approval Program 的新计划；运行期自动重规划不属于此入口。
- 审批激活不代表任务已经交付。SDK 调用级预算和首批确定性自动验收已接入，详情见[模型调用计量与自动验收运行时](./model-metering-verification-runtime.md)；其他验收 Adapter 和 Provider 权威计费仍待补齐，Hard 保持 No-Go。
- 本次提供服务端 API；Desktop 计划编辑和审批表单未包含在本次实现中。

## 验证

`src/program/program-planning-service.test.ts` 覆盖完整服务流程、计划激活后进入现有调度器、默认关闭、项目/计划归属、非法输入、过期审批、预算变化、未校准风险确认和事务回滚。HTTP 路由处理器通过请求/响应适配器调用验证，未启动真实网络服务。
