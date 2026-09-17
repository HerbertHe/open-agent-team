var e=`# ADR-0001：Zvec Node/Electron 兼容性门禁

> 状态：Accepted（macOS arm64 本地门禁）  
> 日期：2026-09-03  
> 对应里程碑：M01

## 决策

OAT 锁定 \`@zvec/zvec\` \`0.7.0\`，允许继续实施 Zvec 记忆索引，但仍保持默认禁用。M01 只证明依赖可被当前 Node 和 macOS arm64 Electron 产物加载，不代表生产检索已经接入，也不授权在未验证平台默认发布。

核心与 Desktop 均使用精确版本，避免原生二进制和 JavaScript API 在安装时漂移。兼容性测试覆盖批量 upsert 及逐项 status、fetch、标量 filter、向量查询、Jieba 中文 FTS、Dense + FTS 的 RRF 融合以及关闭重开恢复。

## 实测环境与结果

| 项目 | Node 测试 | packaged Electron 测试 |
| --- | --- | --- |
| 平台 | macOS arm64 | macOS arm64 |
| 运行时 | Node 22.22.1 | Electron 43.4.1 / Node 24.18.1 |
| modules ABI | 127 | 148 |
| N-API | 10 | 10 |
| Zvec | 0.7.0 | 0.7.0 |
| 原生 binding | darwin-arm64 | darwin-arm64，位于 \`app.asar.unpacked\` |
| binding 大小 | 24,368,392 bytes | 24,368,392 bytes |
| 操作矩阵 | 全部通过 | 全部通过 |

本机安装的 Zvec binding 包约 \`29 MB\`。M15 复测的未签名 \`.app\` 约 \`437 MiB\`、DMG 约 \`160 MiB\`，产物内 binding 为 \`24,368,392 bytes\`。应用总体大小不是 Zvec 的纯增量；后续若要优化安装包，仍需通过有/无 Zvec 的同配置产物测量真实增量。

## 打包配置

Electron 必须解包原生库与 Jieba 字典：

\`\`\`json
{
  "asarUnpack": [
    "node_modules/@zvec/**/*.node",
    "node_modules/@zvec/**/jieba_dict/**/*"
  ]
}
\`\`\`

打包模式下必须在 \`ZVecInitialize()\` 之前调用 \`ZVecSetDefaultJiebaDictDir()\`，将字典目录指向：

\`\`\`text
Resources/app.asar.unpacked/node_modules/@zvec/<platform-binding>/jieba_dict
\`\`\`

如果仍使用 \`app.asar\` 内的默认路径，Jieba 原生代码会直接 \`SIGABRT\`，JavaScript \`try/catch\` 无法降级。兼容性 smoke 因此既验证字典文件存在，也执行真实中文 FTS。

## API 偏差

\`@zvec/zvec\` 0.7.0 的实际 TypeScript API 没有显式 \`flush\` 方法。M01 以 \`closeSync()\` 后 \`ZVecOpen()\` 并读取原文档作为持久化与进程重启恢复边界，报告字段明确记录 \`explicitFlushApi: false\`。后续 M06 不得虚构 flush 调用；批处理 durability 必须围绕 close、outbox checkpoint 和重开恢复设计。

electron-vite 打包动态模块时还会生成 CommonJS \`require\` 适配代码，因此 smoke 内部的 \`createRequire()\` 绑定必须使用其他变量名，避免产物发生重复声明。

## 平台门禁

| 平台 | 状态 | 发布约束 |
| --- | --- | --- |
| macOS arm64 | 本地 unsigned packaged app 已通过 | 可继续开发；正式发布前仍需签名/公证验证 |
| macOS x64 | 未验证，且 Zvec 0.7.0 未声明对应预编译 binding | Zvec 保持禁用 |
| Linux x64/arm64 | binding 与运行时路径保留 | 当前 CI 不构建 Linux App；如恢复发布需重新加入原生 runner packaged smoke |
| Windows x64 | M15 已迁移 Desktop target 并加入 packaged smoke | CI 产物通过后允许 Project opt-in |
| Windows ia32 | 不受 Zvec 0.7.0 支持 | M15 已从 Desktop release target 移除 |

electron-builder 还提示 pnpm 10+ 不保证自动打入传递的平台 optional binding。建立跨平台流水线时，应在各平台构建配置中显式声明相应 \`@zvec/bindings-*\` optional dependency，并对最终产物执行本 smoke，而不能只跑 Node 单元测试。

本地签名流程仍未完成，因此没有把“签名/公证产物”记为通过。M15 的默认值评审据此保持 opt-in；详见 [M15 发布评审](../memory-release-m15.md)。

## 可重复验证

\`\`\`bash
pnpm run test:memory:zvec
pnpm --dir desktop run build
OAT_ZVEC_COMPATIBILITY_SMOKE=1 \\
OAT_ZVEC_COMPATIBILITY_REPORT=/tmp/oat-zvec-electron-packaged.json \\
./desktop/release/mac-arm64/OAT.app/Contents/MacOS/OAT
\`\`\`

最后一条命令必须针对实际打包产物执行。成功时退出码为 0，并输出 \`OAT_ZVEC_COMPATIBILITY_OK\`。
`;export{e as default};