var e=`# BLH-007 Program 领域 Schema v1

> 日期：2026-10-10
> 状态：已实现并验证；Repository 尚未接入这些 Schema。

## 已定义对象

\`\`\`text
BudgetVector
BudgetAllocation
Program
PlanVersion
WorkPackage
WorkPackageAttempt
\`\`\`

所有对象使用 Zod strict Schema。进入业务层的数据库 JSON、API 输入和 Agent 工具输入必须先解析，不能用 TypeScript 类型断言绕过运行时校验。

## 数值规则

- 金额只使用非负整数微单位 \`moneyMicros\`。
- Token、模型调用、工具调用和外部单位均为非负安全整数。
- 拒绝负数、小数、\`NaN\`、Infinity 和超过 \`Number.MAX_SAFE_INTEGER\` 的值。
- \`BudgetVector\` 拒绝未知维度；扩展维度只能放在 \`externalUnits\`，且 key 使用受限字符集。

## 标识符和对象规则

- Project、Program、Plan、Work Package 和 Attempt ID 使用独立 branded type。
- ID 长度上限 128，拒绝空白及非受控字符。
- Program goal、Work Package prompt/title 均有长度上限。
- 依赖和 conflict key 不允许重复，Work Package 不能依赖自身。
- Plan 不能以自己作为 parent，Work Package ID 列表不能重复。
- created/updated、notBefore/deadline、started/completed 时间不能逆序。

## 状态转换

实现了四张显式转换图：

\`\`\`text
ProgramStatus
PlanVersionStatus
WorkPackageStatus
AttemptStatus
\`\`\`

只有图中声明的直接边可以执行。终态不能重新进入运行态，相同状态也不是合法转换；幂等请求应由 request ID/revision 层处理，不能伪装成状态转换。

非法转换抛出：

\`\`\`text
InvalidDomainTransitionError
code = INVALID_DOMAIN_TRANSITION
\`\`\`

## 后续接入

BLH-008 Repository 必须在写入前解析 Schema，并在 CAS 更新状态前调用对应 transition guard。数据库 CHECK/foreign key 与运行时 Schema 是互补约束，不能互相替代。
`;export{e as default};