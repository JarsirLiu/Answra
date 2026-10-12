# Note：对话浮层底部只读 composer

状态：已实施

## 问题

悬浮对话面板只有可滚动消息，没有稳定的底部容器，视觉上像一张内容卡片而非完整的对话表面。首版只读 composer 比例过大，按钮图标与输入区也不协调。导航栏打开的 AI 对话面板使用另一套较高的输入区、文字发送按钮和较大的截图卡片，两个对话入口的视觉结构不一致。隐身模式下还需要明确告知用户这里不能输入，避免把只读 transcript 误认为可发送的输入区域。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/ConversationComposer.tsx`、`packages/ui/src/components/panels/ConversationComposer.css`、`packages/ui/src/components/panels/ChatPanel.tsx`、`packages/ui/src/components/panels/ReplyConversationPopover.tsx`。
- UI/进程/协议/持久化表面：导航栏 AI 对话面板的可编辑 composer、回复条窗口的只读 composer 及两处消息/图片视觉；不新增发送能力或 IPC。
- 相关 Note：[回复条悬浮展开实时对话](./2026-10-12-reply-bar-hover-conversation.md)。

## 决定

抽出共用 composer 组件和样式，固定在各自消息滚动区下方。输入区采用紧凑单行起始高度、较小图标按钮与圆形发送按钮；主 AI 对话面板继续通过原有回调处理输入、附件、发送和停止，只读悬浮面板显示禁用状态。隐身模式显示明确的不可输入提示。两种对话面板的用户消息气泡和截图预览使用一致的紧凑样式，不显示图片文件名。

## 影响表面

- 对话消息仍在各自独立滚动区域中，composer 固定在面板底部；消息增长不会把 composer 推出面板。
- 共用组件只统一输入外观与键盘提交行为，业务仍由主面板现有回调持有；只读模式不接 workflow 或 IPC。
- 共用 composer 使用 Answra UI 主题令牌，保持 26px 图标按钮、12px 图标和单行起始输入高度；不复制 AICSS Pro 实现，本地 AICSS checkout 公开包中没有 Agent composer 源码，README 明确 Pro 组件不随公开源码发布。
- 回复条窗口只把已有 `stealth` 状态传给视图用于提示文案，不新增主进程通道或改变消息生命周期。

## 曾考虑的替代方案

- **复用 AICSS Agent composer：** 本地公开仓库不存在该组件，公开 README 说明 Pro 组件不包含在仓库中；不依赖不可见的付费源码。
- **把 composer 做成可发送输入框：** 会为只读 transcript 增加第二个消息入口，绕开现有回复工作流和单一发送责任；当前没有对应产品设计，因此保持只读。
- **分别维护两套 composer CSS：** 两个对话入口已出现高度和图标风格分叉；改用一个可编辑/只读共用组件，避免后续再次漂移。

## 后果与防回退

只读悬浮面板显示固定底部容器，但它不是可交互的发送功能。不要给只读 textarea 添加 `onChange` 或启用图标按钮；若未来要从浮层发送消息，应先定义其与主回复条工作流的统一状态和权限边界。可编辑主面板继续由 `FloatingBarApp` 持有消息与附件状态，composer 不得复制业务状态。

## 验证

- 自动化测试确认只读模式 textarea 与图标按钮处于禁用态、隐身模式提示正确；UI 全量测试、类型检查、Biome 与 Note 门禁通过。
- 本地公开 AICSS 源码中未发现 Agent composer；README 说明 Pro 组件不公开分发。
