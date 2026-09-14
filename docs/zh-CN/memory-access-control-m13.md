# M13 记忆访问控制运行手册

M13 将角色、Project、Team、private/global scope 和外部来源信任统一到 `MemoryActor` 与 `MemoryPolicy`。SQLite 仍是权威边界；Zvec filter 只负责提前减少候选，不能替代回表鉴权。

## 权限矩阵

| 主体 | 长期读取 | candidate 写入 | canonical 修改 |
| --- | --- | --- | --- |
| 用户 | 当前 Project 全部状态 | 人工操作 | 确认、晋升、遗忘 |
| Admin | 当前 Project 的 project/team/global、本人 private | 内部候选 | 授权范围内 |
| Leader | 本 team、本人 private、项目内 global；project 需显式授权 | 内部候选 | 本 team；project 需显式授权 |
| Worker | 无 | 由 Orchestrator 归属到团队流程 | 无 |
| A2A 外部 Worker | 无 | 仅 private 且 trust≤30 | 无 |
| 资源主管 | 已授权在线 Project 的 project/global | 无 | 无 |

Leader 的 project-scope 授权在 Project `team.json` 中配置：

```json
{
  "memory": {
    "access": {
      "leaderProjectScopeTeams": ["platform"]
    }
  }
}
```

列表使用 Team 名称，默认空。授权只扩大该 Leader 的读取范围；不会让其读取其他主体的 private，也不会授予 Worker 或外部 Worker长期记忆权限。

Worker 不直接获得 SQLite/Zvec 工具，也不自行查询长期索引。任务所需上下文由 Orchestrator 控制。外部 Worker 即使伪造 Admin 名称、global 标记或 project scope，也会在候选提交、Zvec filter 和 SQLite hydration 多层 fail closed。

## 联邦搜索

Desktop 资源主管提供 `oat-search-project-memory` 只读工具。协调器只向明确授权且在线的 Project Orchestrator 调用：

```text
POST /memory/federated-search
{ "query": "...", "limit": 20 }
```

Project 端固定把请求解析为当前 Project 的 `resource_manager` Actor，客户端不能提交任意角色。离线 Project 返回 unavailable；Desktop 不打开离线 Project 的 SQLite 或 Zvec 文件。每个 Project 仍独立执行 lexical/Zvec 降级、有效期、scope 和 SQLite 二次鉴权。

端点还要求本次 Orchestrator 启动生成的 federation capability。令牌只写入 `0600` 的运行状态文件，由 Desktop 主进程读取并放入 `X-OAT-Memory-Federation-Token`；无令牌或旧令牌请求返回 403 并记录 denied 审计。令牌不会进入 Agent prompt、Zvec、日志或 API 响应。

## 审计

schema v7 新增 `memory_access_audit`，记录：

- Actor ID、角色、正式/外部身份、Project 与 Team；
- list/retrieve/inject/federated_search/candidate_write/govern/confirm/promote/forget；
- allowed/denied、脱敏原因、目标 memory ID 和有限的计数元数据。

`GET /memory/access-audits?limit=100` 供后续 M14 Desktop 可观测页面使用。审计不保存 embedding、API key 或完整用户提示；疑似 token/secret 的字符串会脱敏。

## 回滚

关闭资源主管记忆工具或不调用 `/memory/federated-search` 即可停止联邦查询。各 Project 的 Admin/Leader 当前项目边界、SQLite lexical fallback 和既有 canonical memory 保持可用。不要通过关闭 SQLite 回表鉴权来回滚；它是所有 Zvec 模式的最终安全边界。

## 验证

```bash
pnpm test:memory:policy
pnpm test:memory
pnpm exec tsc --noEmit
pnpm run build
pnpm --dir desktop run lint
pnpm --dir desktop run build
```

专项 fixture 覆盖用户、Admin、Leader、Worker、A2A 外部 Worker、资源主管、跨 Team、跨 Project、离线 Project、恶意 candidate scope 和审计脱敏，越权命中必须为零。
