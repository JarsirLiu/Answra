# Note：回复详情面板在模型失败后保留本轮，并清理本地兜底

状态：已实施

## 问题

截图答题遇到模型请求失败时，回复条能显示错误，但展开「当前对话」面板仍只显示「发送后将在这里显示本轮对话」：看不到本轮题目截图、补充文字和错误。用户期望失败轮与正常回复一样保留在本轮对话里。

同时确认两点产品约束：

- 叉掉回复条后，本轮会话必须立即清空；再次发送时，发送条展开的详情面板应展示新会话。
- 详情面板是只读的，不需要继续打字的输入框。

## 涉及范围

- 代码/模块：`apps/agent/src/conversation/runtime.ts`、`apps/desktop/src/main/conversation/conversationIpc.ts`、`packages/ui/src/app/useReplyWorkflow.ts`、`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/app/ReplyBarWindowApp.tsx`、`packages/ui/src/components/panels/ReplyDetails.tsx`、`packages/ui/src/components/panels/ReplyConversationPopover.tsx`。
- UI/进程/协议/持久化表面：截图答题失败轮的 agent 内存保留、回复条关闭清理、详情面板数据来源与只读形态；不新增持久化，不把答题内容写入磁盘或长期会话历史。
- 相关 Note：[回复条展开详情为空](./2026-10-18-reply-details-empty-ephemeral-conversation.md)、[截图答题详情面板按轮次重置并流式输出当前轮](./2026-10-31-reply-details-reset-per-round.md)、[笔试截图一次性图片对话 V1](../feature/2026-10-11-ephemeral-exam-image-chat-v1.md)、[后端拥有会话与内存仓储](../architecture/2026-10-12-conversation-memory-store-port.md)。

## 根因

1. 会话不是模型回复后才创建。UI 发送时先生成 `screenshot-<uuid>` 并调用 `createConversation`；agent 的 `startRun` 先 `beginEphemeralRun` 写入用户消息和助手占位，再调用模型。真实请求已经进入模型调用。
2. 真实失败来自云端网关：接口返回 `403`，错误文案为 `No model service is configured for this plan yet. Please contact the administrator.`。本地解密 auth 确认当前套餐含 `text.chat` / `image.answer` 端点，属于服务端套餐模型配置问题，不是客户端未建会话。
3. 真正让面板为空的代码问题是 `ConversationRuntime.execute()` 的 `finally` 无条件执行 `if (ephemeral) await this.store.clear(conversationId)`：失败轮也被清空。详情面板晚订阅只能拿到空快照，之前的增量又因 revision 游标被丢弃。
4. 上一版用 `failedSubmission` / `pendingUser` 在 renderer 补一条本地用户消息，属于第二份真相来源；它掩盖了运行时生命周期错误，也让面板内容与真实会话脱节。
5. 回复条关闭时没有清空本轮会话；主进程 `ClearMessages` 又只允许常驻会话，`screenshot-` 失败轮无法显式释放。

## 决定

- agent 运行时保留失败轮：`execute` 记录是否收到 `error` chunk；成功和取消仍即时 `clear`，失败轮保留消息与 journal 供详情面板读取。下一次 `beginEphemeralRun` 会清掉上一次失败残留。
- 详情面板只读 agent 会话：删除 `failedSubmission` / `pendingUser` 本地补消息逻辑，`ReplyConversationPopover` 直接渲染 `useReplyConversation` 的 messages。
- 叉掉回复条即清理本轮：`closeReplyBar` 在 streaming 时取消并重置本地轮次，在 done 时调用 `clearPending()` 清空 store；退出 reply slot 同样释放。
- 主进程允许主窗口清空 `screenshot-` 会话，使失败轮的关闭清理真正到达 agent store；仍拒绝回复窗等非法 sender，不开放任意会话 ID。
- 删除详情面板的打字输入框及 `bridge` / `conversationId` 输入相关 props，面板保持只读。
- 下一轮发送继续生成新的 `screenshot-<uuid>`；`useReplyConversation` 按新的 `conversationId` 重订阅并归零游标，因此展开时只显示新会话。

## 修复

- `apps/agent/src/conversation/runtime.ts`：记录本轮是否收到 `error` chunk；`finally` 仅在非失败轮执行 ephemeral `store.clear()`，失败轮保留到下一次 `beginEphemeralRun`。
- `packages/ui/src/app/useReplyWorkflow.ts`：初始化轮次状态；删除 `ReplySubmission` / `failedSubmission`；`closeReplyBar` 在 done 时调用 `clearPending()`，在 streaming 时取消并重置本地轮次；`exitReply` 统一释放。
- `packages/ui/src/app/FloatingBarApp.tsx`：移除 `pendingReplyUser` 与失败提交合并，`ReplyDetails` 只接 `conversationId` / `error`。
- `packages/ui/src/components/panels/ReplyConversationPopover.tsx`：删除本地补用户消息、打字输入框与相关 bridge props，面板改为只读渲染会话消息。
- `packages/ui/src/components/panels/ReplyDetails.tsx` / `ReplyBarWindowApp.tsx`：同步删除 `pendingUser` 和输入相关参数。
- `apps/desktop/src/main/conversation/conversationIpc.ts`：`ClearMessages` 允许主窗口清空 `screenshot-` 一次性会话，仍拒绝非法 sender。

## 曾考虑的替代方案

- **继续在 renderer 保留失败提交快照并补用户气泡：** 会让 UI 与会话存储各存一份本轮输入，失败原因和消息顺序都可能分叉；用户明确要求清理兜底，舍弃。
- **失败轮也立即清空，只靠 desktop 缓存最后快照：** 引入第二份会话真相来源，并绕开 agent store 的 revision/订阅契约；舍弃。
- **允许主窗口清空任意会话 ID：** 破坏「清空是破坏性操作」的最小授权面；只放行 `screenshot-` 一次性会话，保留常驻会话白名单。
- **保留详情面板输入框：** 面板会再次成为发送入口，需要重复处理发送失败、附件和登录态；当前产品只需要查看本轮结果，删除输入框。

## 后果与防回退

- 失败轮只保留在 agent 内存中，直到用户关闭回复条或开始下一轮；它不是可恢复历史，也不落盘，不进入其他常驻会话。
- 不要把 `execute` 的失败保留改回无条件 `clear`，也不要只在 UI 侧缓存失败消息；失败轮可见性依赖 agent store 保留 + 详情面板全程订阅。
- 关闭回复条必须同时清理 agent store 与本地轮次状态；主进程 `ClearMessages` 必须继续允许 `screenshot-` 前缀，否则失败轮会残留到下一轮。
- 详情面板保持只读；不要再把 `draft`、附件或发送逻辑传回 `ReplyConversationPopover`。
- 成功/取消轮仍应立即释放；只有收到 `error` chunk 的轮次才保留，避免 ephemeral 会话无界增长。
- 新一轮发送必须使用新的 `screenshot-<uuid>`；详情 hook 依赖 conversationId 变化重置 revision，不能复用旧 ID。

## 验证

- `apps/agent/test/conversation/runtime.test.ts` 新增「keeps a failed ephemeral round until the next round claims the conversation」：用 403 模拟网关错误，断言失败轮保留 user/assistant 与 error 事件，下一轮成功后清空。
- `packages/ui/test/FloatingBarApp.test.tsx` 新增/改写：
  - 「keeps a failed model round in the current conversation panel」断言面板内仍有题目截图、错误文案，且没有输入框。
  - 「clears the round when closing the reply bar and shows the next round in details」断言关闭时调用 `clearConversationMessages`，下一轮面板只显示新答案。
- `packages/ui/test/ReplyBarWindowApp.test.tsx` 断言展开面板只读、无输入框与发送按钮。
- `apps/desktop/test/conversationIpc.test.ts` 断言主窗口可清空 `screenshot-` 会话，回复窗仍被拒绝。
- 已通过：`pnpm --filter @answra/agent test -- conversation/runtime.test.ts`（16 项）、`pnpm --filter @answra/ui test`（25 个文件、196 项）、`pnpm --filter @answra/desktop test`（41 个文件、263 项）、`pnpm --filter @answra/desktop typecheck`、`pnpm --filter @answra/agent typecheck`。
- `pnpm notes:check` 通过（4 份本次 Note、20 个变更文件）；`pnpm verify` 通过（biome、typecheck、全部测试、架构检查）。
- 尚需 Windows 实机验证：真实 403 下展开面板可见截图与错误；叉掉回复条后重新截图发送，新面板只显示新轮；面板无输入框。
