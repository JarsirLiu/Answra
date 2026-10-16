# Note：回复条完成态保留答案

状态：已实施

## 问题

笔试/截图模式下模型回复完成后，回复条被主窗口立即关闭并回退到悬浮导航栏（`replyBarWindowController.setState(null)` 关闭独立窗口）。用户来不及看清最终答案，也无法在同一窗口展开详细面板查看思考过程。该行为来自此前“完成后恢复发送条”的决定，与现在“先看到答案、再由用户自行收起”的预期冲突。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`、`packages/ui/src/app/useReplyWorkflow.ts`、`packages/ui/src/components/panels/ReplyBar.tsx`。
- UI/进程/协议/持久化表面：截图回复工作流完成态、独立回复条 `ReplyBarState.phase`、主窗口悬浮条显隐与恢复。
- 相关 Note：[回复工作流边界](../architecture/2026-10-11-reply-workflow-boundary.md)、[回复条悬浮展开实时对话](2026-10-12-reply-bar-hover-conversation.md)、被取代的 [截图答题完成后恢复发送条](../../archived/bug-fix/2026-10-13-screenshot-completion-return.md)。

## 决定

在 `ReplyPhase` 增加 `done` 形态：`performSend` 收到成功终态后不再调用 `onWorkflowFinish`，而是切到 `done` 并保留 `conversationId` 与本轮回复文本。回复条停在完成态继续显示答案，用户可自行「收起回复条」回到悬浮发送条，或展开详细面板查看思考过程。工作流生命周期仍由主 renderer 持有（`useReplyWorkflow` + `SurfaceState.workflow`），回复条窗口不新增完成态判断或关闭逻辑。

## 影响表面

- 完成后的回复条保留活动流摘要（最终答案），不再自动消失、不回退到悬浮导航栏。
- 完成态操作组为：展开/固定详细面板（独立窗口）、继续截图、收起回复条；不渲染“取消回复并返回发送”。
- `ReplyBarState.phase` 增加 `done`；`readReplyBarState` 在 `done` 下强制 `replyPending=false`，避免残留“进行中”停止键。
- 失败仍回到 `composing` 保留截图与草稿可重试；取消仍回到同一发送条；两种路径不变。

## 曾考虑的替代方案

- **完成即关并恢复发送条（原决定）：** 用户看不到答案，也无法在同一窗口查看思考过程；作为缺陷被反馈，因此反转。
- **完成后仅把 phase 改回 `composing`：** 编辑态不渲染 `replyText`，答案仍不可见，无法满足“先看到答案再收起”，因此不采用。
- **让回复条窗口自行判断完成并关闭：** 会让独立窗口拥有工作流生命周期，破坏主 renderer 统一持有状态的边界，因此仍由主 renderer 推送完成态。
- **完成态自动延时关闭：** 用户阅读速度不可控，仍可能来不及看完，因此改为等用户显式收起。

## 后果与防回退

- 完成后回复条不自动回退到悬浮导航栏；只有用户收起（`close` 动作）或原生关闭才结束工作流、恢复主窗口。
- `done` 态必须保留 `conversationId`，否则独立回复条的详细面板无法加载本轮会话；仅当用户再次截图发送时由 `performSend` 覆盖为新会话。
- 工作流生命周期仍归主 renderer；不得让回复条窗口自行关闭或判断完成，也不得为完成态引入第二套窗口控制路径。

## 验证

- UI 测试覆盖：完成后答案仍可见、不显示“取消回复并返回发送”、点击“收起回复条”才恢复“截图提问”；独立回复条完成态渲染答案并发送 `close` 动作。
- 运行 `pnpm notes:check`、`pnpm verify`。
