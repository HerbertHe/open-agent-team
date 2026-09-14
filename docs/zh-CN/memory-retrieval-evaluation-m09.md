# M09 记忆检索评测与调参报告

> 状态：完成  
> 评测日期：2026-09-10  
> 范围：M00 固定 corpus、真实 `@zvec/zvec` Node SDK 查询管线、确定性语义 Embedding fixture

## 结论

M09 的 CI fixture 门禁 G2 通过，候选策略为 `hybrid_governance`。这只证明 OAT 的 Dense、Jieba FTS、exact、RRF、权限过滤和治理管线在固定语义 fixture 下满足门禁，不代表任意生产 Embedding 模型都达到相同质量，也不会在本阶段切换生产 Prompt。M10 对具体 Project 放量前仍需使用其实际 Embedding Profile 重跑同一评测协议。

固定调参结果：

- Dense cosine distance 上限：`0.45`，超过该距离的候选不进入融合，避免无结果查询仍返回任意近邻；
- 普通召回路由 RRF `k=60`；
- exact 路由 RRF `k=50`；
- 时效治理使用 30 天指数衰减；
- 治理后每种 memory kind 最多 `3` 条；
- Prompt 结果上限：`5` 条；候选召回上限：`30` 条。

## G2 门禁

| 指标 | 固定阈值 | 本次结果 |
| --- | ---: | ---: |
| Recall@5 相对 lexical 提升 | ≥ 0.20 | +0.2857 |
| 中文 Recall@5 相对提升 | ≥ 0.40 | +0.50 |
| 改写查询 Recall@5 相对提升 | ≥ 0.50 | +1.00 |
| 越权命中 | 0 | 0 |
| 错误注入率 | 不高于 lexical | 通过 |
| P95 本地检索延迟 | ≤ 100 ms | 约 2 ms（本次样本） |
| 平均 Prompt token 比例 | ≤ lexical × 1.25 | 约 0.54 × |

## 策略对比

以下延迟是单次本机样本，会因机器负载变化；CI 只对固定上限做断言。token 数使用中日韩字符按单 token、其余字符按约四字符一 token，并包含每条记录固定格式开销的确定性估算。

| 策略 | Recall@5 | MRR | 中文 Recall@5 | 改写 Recall@5 | 错误查询率 | 错误条目率 | 越权命中 | 平均 Prompt tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 0.7143 | 0.7143 | 0.50 | 0.00 | 0.2222 | 0.1463 | 0 | 136.00 |
| dense | 1.0000 | 1.0000 | 1.00 | 1.00 | 0.2222 | 0.2222 | 0 | 30.78 |
| FTS | 1.0000 | 0.9286 | 1.00 | 1.00 | 0.2222 | 0.0645 | 0 | 106.89 |
| hybrid | 1.0000 | 0.9286 | 1.00 | 1.00 | 0.2222 | 0.0645 | 0 | 106.89 |
| hybrid + governance | 1.0000 | 1.0000 | 1.00 | 1.00 | 0.2222 | 0.0952 | 0 | 73.56 |

`hybrid_governance` 的错误查询率与 lexical 持平、错误条目率降低；无结果查询经 Dense distance 门槛后不再注入任意近邻。冲突事实仍可能同时成为候选，当前依赖时效和治理排序把新事实排在前面；完整的事实替代/矛盾图由 M12 实现。

## 可重复执行

```bash
pnpm test:memory:evaluation
```

测试会创建临时 SQLite 与真实 FLAT/COSINE Zvec collection，写入 M00 corpus，依次执行五种策略，输出完整 JSON 报告，然后清理临时目录。Embedding 使用 `m09-semantic-fixture-v1`，只编码 fixture 中声明的中英文等价概念，确保离线和 CI 可重复。

## M10 前置约束

1. 不得因为本报告通过就全局启用 Hybrid；M09 仍保持 Shadow。
2. M10 白名单 Project 必须使用实际全局 Embedding Profile 重跑协议，并保存模型 identity、collection revision、数据规模和机器信息。
3. 实际模型若未通过同一门禁，保持 lexical 或 Shadow。
4. 任意权限命中、错误注入率回归、P95 超限或 token 超预算都阻止放量。
