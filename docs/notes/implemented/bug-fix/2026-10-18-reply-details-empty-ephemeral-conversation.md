# Note：回复条展开详情为空

状态：已实施

## 问题

在「悬浮导航功能槽就地回复」重做后实测：完成一次答题回复，点回复条上的展开键，详情面板只显示占位文案「发送后将在这里显示本轮对话」，看不到本轮题目截图与答案——即 `useReplyConversation` 返回的 `messages` 恒为空。流式期间展开能看到内容，完成后再展开为空。

## 涉及范围

- 代码/模块：`packages/ui/src/app/useReplyConversation.ts`、`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/components/panels/ReplyDetails.tsx`、`packages/ui/src/app/useReplyWorkflow.ts`、新增 `packages/ui/test/replyConversation.test.tsx`、`packages/ui/test/FloatingBarApp.test.tsx`。
- UI/进程/协议/持久化表面：答复详情面板的数据来源与订阅生命周期；回复工作流的本轮会话 id 生命周期。协议与持久化不变（答题会话本来就是临时的，不落盘）。
- 相关 Note：[悬浮导航功能槽就地回复架构](../architecture/2026-10-18-in-place-reply-slot-and-feature-slot.md)。

## 根因

1. 答题会话是**一次性的（ephemeral）**：`apps/agent/src/conversation/runtime.ts` 的 `runAnswer` 走 `startRun(..., ephemeral = true)`，`execute` 的 `finally` 里 `if (ephemeral) await this.store.clear(conversationId)`。运行一结束，`MemoryConversationStore` 就把该会话的 `messages` 清空（`clear` 只清数据、不发变更）。
2. 重做后的详情面板 `ReplyDetails` **只在展开时挂载**，`useReplyConversation(bridge, conversationId, true)` 于此刻才 `getConversationSnapshot`。此时会话已被清空，拿到的快照 `messages: []` → 空面板。
3. 旧实现（`ReplySlot`）把 `enabled` 设为 `phase === "streaming" || expanded`：流式期间订阅、靠增量事件累积出内容，所以流式期间展开可见；一旦运行结束且未展开就 `enabled = false`，hook 会把 state 重置为 `EMPTY_STATE`，随后再展开同样是空。因此这是长期潜伏的缺陷，重做只是把它暴露成「总是空」。

## 决定

1. 详情订阅的**生命周期 = reply slot 的生命周期**，而不是「面板是否展开」：`ReplyDetails` 在 `featureSlot.kind === "reply"` 期间始终挂载，`enabled = Boolean(conversationId)`；`expanded` 只控制是否渲染 `ReplyConversationPopover`（收起时 return null，但 hook 与订阅保持）。这样从流式第一帧起就订阅、用增量事件把消息累积在本地 state 里，运行时清空后仍能展开回看。
2. 本轮会话 id 跨「收起回复条回发送条」保留：`useReplyWorkflow` 拆出 `resetRoundInput()`（只滚缩略图与草稿），`closeReplyBar` 的 streaming/done 分支调用它而不再 `clearPending()`；`cancelReply` 也不再置空 `conversationId`。**只在退出 reply slot（`onExitReply` / 组件卸载）时**才丢本轮内容，符合用户「退出回复条才清空本次对话内容」的要求；新一次发送仍会生成新 `screenshot-${uuid}` 顶替旧会话。
3. 抹掉订阅早于会话创建造成的瞬时错误：回复工作流先 `setConversationId` 再 `createConversation`，`useReplyConversation` 的首个快照可能命中「会话不存在」。在 `applyContiguous` 应用真实变更时一并 `error: undefined`，避免残留错误卡片。

## 曾考虑的替代方案

- **取消 ephemeral，让答题会话常驻到会话内存：** 舍弃。答题会话含题目截图，常驻会无界增长并扩大隐私暴露面，ephemeral 是刻意的；改为让「展示方」在会话存活期内订阅即可，运行时契约不动。
- **展开时改用事件回放（`readConversationEvents`）重建内容：** 舍弃。`clear` 同时清空 `journal`，回放同样为空；且回放依赖 revision 连续，跨清空不成立。
- **完整保留旧 `ReplySlot` 组件、只把它的展开入口接到导航条：** 舍弃。旧组件把「条体渲染 + 详情订阅」耦合在一起，正是重做要拆开的部分；本次只把订阅搬进 `ReplyDetails` 并延长生命周期，条体仍由 `ReplyBar` 负责。
- **在运行时把 ephemeral 会话的最后快照缓存到 desktop 侧供 UI 读取：** 舍弃。引入第二份会话真相来源，绕开 agent 的 store 契约；本次问题在 UI 侧的订阅时机，不需要新增跨进程缓存。

## 修复

- `ReplyDetails`：新增 `enabled` / `expanded` 两个 prop，`useReplyConversation(bridge, conversationId, enabled)`，`!expanded` 时 return null 但不卸载。
- `FloatingBarApp`：`featureSlot.kind === "reply"` 就渲染 `ReplyDetails`，`enabled={Boolean(conversationId)}`。
- `useReplyWorkflow`：新增 `resetRoundInput()`；`closeReplyBar` 的 streaming/done 分支改为「只清本轮截图与草稿」，`cancelReply` 不再清 `conversationId`。
- `useReplyConversation`：应用真实变更（`messages-appended` / `text-delta` / `run-finished`）时清掉 `error`。

## 后果与防回退

- **不要把 `ReplyDetails` 改回「只在展开时挂载」**，也不要把 `enabled` 缩到只在 `expanded` 时为真：答题会话完成即被运行时清空，晚订阅必然拿到空快照。新增展示答题会话的 UI 必须沿用「会话存活期内持续订阅」的写法。
- 本轮 `conversationId` 只在退出 reply slot 时清空；不要在 `closeReplyBar` 的 streaming/done 分支里恢复 `clearPending()`，否则收起回发送条后展开又变空。
- 运行时的 ephemeral 语义（`runAnswer` 完成后 `store.clear`）不要为了让 UI 好取而改动；这是会话内存与隐私边界。
- `useReplyConversation` 的首个快照失败要能被后续变更自愈（清 `error`），不要再把「会话不存在」当成需要长期展示的错误态。

## 验证

- 新增 `packages/ui/test/replyConversation.test.tsx`：用模仿 agent 语义的假 store（`messages-appended` + 事件 + `run-finished`，随后 `clear` 只清数据不发变更）断言——(1) 全程订阅时，清空后仍保留完成态答案；(2) 反例守卫：运行结束清空后才订阅只能得到空会话，说明必须全程保持订阅。
- `packages/ui/test/FloatingBarApp.test.tsx` 新增「keeps this round's conversation after collapsing the reply bar back to the send bar」：流式期间即按本轮 `screenshot-*` id 拉取快照；收起回发送条后仍能展开「当前对话」。
- `pnpm --filter @answra/ui test`（230+ 项）通过；`pnpm verify` 通过。
