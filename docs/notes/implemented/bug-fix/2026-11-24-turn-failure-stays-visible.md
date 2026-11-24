# Note：Turn 失败原因不再一闪而过

状态：已实施

## 问题

切换到新模型后，CLI 连续多次发送没有任何回复，transcript 里一条 assistant 消息也没有；错误提示只闪一下随即消失，用户无法判断发生了什么，只能靠翻数据库才知道是 `Insufficient balance`。

会话数据可以复现：失败 Turn 只有 `user` 与 `turn-end` 两条条目，`turn-end.errorText` 里保存着真实原因。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/app/conversationView.ts`：snapshot 不再无条件清除错误。
  - `packages/ui/src/app/conversationItems.ts`：新的用户消息清除上一轮错误。
- 测试：`packages/ui/test/conversationView.test.ts`。
- UI/进程/协议/持久化表面：CLI transcript 尾部错误行；不改变 Agent 事件、快照 schema、数据库结构。
- 相关 Note：[会话持久化契约](../../proposed/architecture/2026-11-23-session-persistence-contract.md)。

## 决定

失败提示的可见性由 durable `turn-end.errorText` 决定：snapshot 不得清除视图里已有的 `error`，只有新的用户消息到达或会话被清空时才失效。

## 根因

`foldSessionItemFrame` 处理 `turn-end` 时会把 `payload.errorText` 写进 `ConversationView.error`，TUI 的 `TranscriptTail` 也确实渲染 `view.error`。但 Turn 收口后 `SessionItemRecorder.finishTurn` 紧接着推送一次 snapshot，而 `applyConversationSnapshot` 无条件把 `error` 置为 `undefined`。

于是顺序是：durable `turn-end` 帧写入错误 → snapshot 立刻清空 → 用户只看到一帧的闪烁。

## 修复

- `applyConversationSnapshot` 保留视图里已有的 `error`；只有快照没有任何消息（会话被清空或被切到空会话）时才丢弃。
- 新的 `user` 条目到达时清除 `error`：上一轮失败提示的失效点由「下一条用户输入」定义，而不是由任意 snapshot 定义。

## 曾考虑的替代方案

- **在 `ConversationSnapshot` 增加 `lastTurnError` 字段：** 暂不采用。需要改共享 schema、内存记录、SQLite 状态 payload 与恢复流程，才能换来「重启后仍显示」，本次先解决「刚失败就看不见」。
- **用不会自动过期的通知展示：** 舍弃。通知是瞬时层，重启即丢，且与 transcript 位置脱节。
- **失败时合成一条 assistant 消息写进 transcript：** 舍弃。fold 结果同时是模型上下文来源，合成错误正文会被送进下一次请求。
- **让 snapshot 携带错误文本并覆盖视图：** 舍弃。snapshot 不承载 Turn 归因，错误文本的 durable 来源仍是 `turn-end` 条目。

## 后果与防回退

- 错误只存在于 UI 视图，不进入模型上下文，也不改变 `turn-end` 条目。
- 失败提示的存活期是「直到下一次用户发送」；不得改回「snapshot 无条件清除」，否则会重新引入闪烁。
- 会话被清空（空消息快照）时必须丢弃旧错误，避免把上一会话的失败带到空视图。
- 重启后不会重放历史失败提示；真实原因仍可从 `turn-end.errorText` 读取。需要长期可见时应另做历史投影，而不是放宽 snapshot 合并规则。

## 验证

- `pnpm --filter @answra/ui exec vitest run test/conversationView.test.ts`：27 项通过，包含「收口 snapshot 保留失败文本」「空快照清除失败文本」「下一条用户消息清除失败文本」。
- `pnpm --filter @answra/ui typecheck`：通过。
- 实机验证：故意用不可用模型/错误余额发送一次，失败原因应停留在输入框上方，直到再次发送。
