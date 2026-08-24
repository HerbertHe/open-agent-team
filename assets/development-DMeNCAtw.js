var e=`# 开发规范

## 图标

- 不要为常见 UI 操作手写 SVG、Unicode 图标或自行绘制图标。
- Web 与 Desktop renderer 优先使用 Iconify 图标库；Desktop React renderer 统一通过 Antfu 的 \`unplugin-icons\` 按需导入，例如 \`import IconRefresh from '~icons/lucide/refresh-cw'\`。
- 选择语义明确、线条风格一致的图标集。Desktop 默认使用 \`@iconify-json/lucide\`；只有 Lucide 缺少合适图标时，才评估其他 Iconify 集合。
- 图标按钮必须提供可读的 \`aria-label\` 与 \`title\`；仅图标操作不得依赖颜色或悬浮状态来表达含义。
- 产品 Logo 不是通用操作图标。始终复用仓库内的品牌资产，不得以临时 emoji 或重新生成的图案替代。

## Desktop renderer

- Renderer 使用 React、TypeScript、Tailwind CSS 和 Less。Tailwind 用于布局与设计 token，Less 用于主题变量、复杂状态和跨断点样式。
- Renderer 不直接进行网络请求；所有 Orchestrator、控制面、Provider 与流式请求必须经 preload IPC，由 Electron 主进程执行。
- Agent 会话使用 Vercel AI SDK 的 transport 接口；自定义 transport 仍必须使用受信任 IPC，而非 renderer \`fetch\`。
`;export{e as default};