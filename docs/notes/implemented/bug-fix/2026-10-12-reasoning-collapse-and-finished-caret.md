# Note：修正思考折叠方向与完成态光标

状态：已实施

## 问题

思考块收起时的箭头朝上而不是向右，展开和收起缺少一致的自然反馈。另一个问题是流式文本组件在 AI SDK 消息完成后仍渲染黑色光标，回复尾部看起来像残留的黑点。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/AicssConversationPrimitives.tsx`、`packages/ui/src/components/panels/ReplyConversationPopover.css`。
- UI/进程/协议/持久化表面：思考块的本地折叠交互，以及 AI SDK `UIMessageChunk` 的终态到 assistant `ConversationMessage.status` 的展示映射。
- 相关 Note：[回复条悬浮展开实时对话](../feature/2026-10-12-reply-bar-hover-conversation.md)。

## 根因

折叠箭头的默认旋转角度是 180 度，视觉指向上方；同时 `AicssStreamingText` 无条件渲染 caret，即使 `streaming` 已为 false。runtime 已经发出标准 `finish` / `abort` chunk，仓储也会发布 `run-finished` 并设置最终消息状态，但 caret 没有读取该展示状态。

## 决定

折叠时 ChevronDown 旋转 270 度指向右侧，展开时回到向下方向，保留缓动旋转。思考正文使用可插值的 grid 行高与透明度过渡；折叠时移除正文顶部间距，避免留下空隙。仅在 assistant 消息仍处于流式状态时渲染 caret，收到标准终态后立即移除。

## 修复

将折叠态图标从 180 度改为 -90 度，正文顶部间距改为随折叠状态同步过渡；完成态不再挂载 caret。用 UI 回归测试覆盖 streaming 到 complete 的光标切换。

## 曾考虑的替代方案

- **用 `finish` chunk 在组件内单独维护第二份完成状态：** chunk 到达与仓储 `run-finished` 已由不同订阅路径消费，重复维护状态可能短暂不同步；使用已持久到消息投影的 `status` 更稳定。
- **卸载整段思考组件来模拟折叠：** 会失去组件内展开状态，也没有过渡；继续用单一 reasoning block 的 grid/opacity 过渡。

## 后果与防回退

AI SDK `finish` 对应仓储的 `complete` 状态，`abort` 对应中断状态。不要把流式 caret 永久渲染在完成的答案尾部。新增测试应同时覆盖折叠方向、`aria-expanded` 切换和终态 caret 移除；正文与思考仍是相邻独立块。

## 验证

- 自动化测试验证流式阶段显示 caret、消息完成后移除 caret；思考折叠方向通过 CSS 的 `aria-expanded` 状态选择器实现，并由展开/收起交互测试覆盖。
- 运行 UI 测试、类型检查、Biome、`pnpm notes:check` 和 `git diff --check`。
