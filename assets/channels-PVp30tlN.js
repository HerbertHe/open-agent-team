var e=`# Channel 连接与智能体分配

OAT Desktop 在插件层兼容 OpenClaw Channel 插件，不安装、启动或依赖 OpenClaw Runtime/Gateway。插件由 OAT Desktop 主进程加载，账号配置和 Project 绑定属于全局资源，因此即使没有选中或启动 Project，也可以查看和编辑 Channel。

## 插件契约

插件需要提供 \`openclaw.plugin.json\`。OAT 识别以下 OpenClaw 字段：

- \`channels\`：插件拥有的 Channel ID。
- \`channelConfigs.<channelId>.schema\`：账号配置 JSON Schema。
- \`channelConfigs.<channelId>.uiHints\`：字段名称、占位内容和敏感字段提示。
- \`package.json#openclaw.extensions\` 或 \`runtimeExtensions\`：运行时入口。
- \`registerChannel\`、\`registerHook\`/\`on\`、\`registerService\` 和 Channel inbound dispatch 注册表面。

旧版 \`entryPoint\`、顶层 \`configSchema\` 和 \`@openclaw/plugin-sdk\` 仍作为兼容入口保留。Channel ID 和插件 ID 是开放字符串；连接状态和绑定目标使用 OAT enum。

## 默认路由

每个 Channel 账号默认不生成显式绑定。收到消息时：

1. 如果该 \`channelId + accountId\` 没有显式绑定，消息交给全局智能体资源主管，资源主管的回复通过同一账号返回。
2. 如果账号绑定了 Project Admin，消息会作为任务进入该 Project 的 \`admin\` Agent 队列。
3. 如果账号绑定了 Team 管理 Agent，消息会进入现有的 \`<team>-lead\` 队列。
4. Project 未启动时消息保存在持久化 inbox，Project 恢复后再投递；\`messageId\` 用于幂等去重。
5. Project/Team Admin 完成任务后，最终进度或交付摘要会通过原 Channel 账号和会话上下文返回。

显式绑定保存在 \`~/.oat/oat.json\` 的 \`channelBindings\` 中，但账号密钥不会通过 Desktop Renderer API 返回。旧项目的 \`admin.push_channel\` 会在首次读取时迁移为 Project Admin 绑定。

## Desktop 页面

“Channels”是全局页面，支持：

- 根据插件提供的 JSON Schema 和 UI hints 动态生成账号表单。
- 显示插件加载、账号配置和运行时连接状态。
- 将账号分配给资源主管或任一 Project Admin。
- 微信兼容插件的 QR 登录。
- 删除账号时同步删除对应绑定。

Channel 连接统一位于“全局设置 → 通道连接”，不再提供独立顶栏入口，也不在该页面提供插件搜索或安装。页面只展示已经随 OAT 提供或已经安装的兼容 Channel，并负责连接账号、查看状态和分配目标。Project 左侧图标仍显示绑定到该 Project 的 Channel 数量，点击图标会直接进入全局设置的通道连接子菜单。

新建账号后默认由智能体资源主管处理消息，不需要创建显式绑定。Desktop 的新绑定选项只提供智能体资源主管和各 Project Admin；旧版 Team Admin 绑定继续兼容读取，但需要在页面中改选 Project Admin 完成迁移。全局设置的高级 JSON 编辑器不会显示或覆盖 Channel 账号和绑定。

## 插件入站接口

兼容插件可以通过 OAT SDK runtime 分发入站消息：

\`\`\`ts
await api.runtime.channel.inbound.dispatch({
  channelId: "telegram",
  accountId: "default",
  messageId: "message-1",
  conversationId: "chat-1",
  senderId: "user-1",
  text: "请汇报当前智能体资源",
});
\`\`\`

OAT 返回 \`replied\` 或 \`queued\` 状态。插件应把 \`messageId\` 和 \`conversationId\` 放入 metadata，以便 outbound adapter 保持原生会话或线程上下文。

## 安全边界

- 插件安装使用参数化 \`spawn\`，不执行拼接后的 shell 命令。
- Desktop Renderer 只能看到账号 ID 和脱敏状态，不能读取账号密钥。
- 插件包是可执行代码，安装前应确认发布者和版本。
- Channel 消息仍是外部不可信输入，不会绕过 Admin、资源主管或工具权限。
- 所有接收入站消息的账号都必须配置 \`allowFrom\`，且入站消息必须携带匹配的 \`senderId\`；资源主管会话按 Channel、账号和 conversation 隔离。
- Channel 配置不会赋予资源主管启动、停止或重启 Project、本地进程或 Docker 的权限。
`;export{e as default};