# Note：截图答题详情面板按轮次重置并流式输出当前轮

状态：已实施

## 问题

用户反馈：截图答题的展开详情面板（「当前对话」）在连续多轮答题时一直显示某一条固定的历史答题记录（如上一轮的「答案：D」），新一轮流式输出不出现；期望与普通对话一致——每次截图答题后面板从空白开始，实时流式输出本轮思考与答案。

## 涉及范围

- 代码/模块：`packages/ui/src/app/useReplyConversation.ts`（hook 重置语义）、`packages/ui/test/replyConversation.test.tsx`（fake store 按会话隔离）、`packages/ui/test/FloatingBarApp.test.tsx`（连续两轮 e2e 与 conversation bridge mock 语义修正）。
- UI/进程/协议/持久化表面：仅 renderer UI 的回复详情订阅状态生命周期；IPC 契约、agent 线协议与会话持久化不变（答题会话仍是 ephemeral）。
- 相关 Note：[回复条展开详情为空](2026-10-18-reply-details-empty-ephemeral-conversation.md)、[悬浮导航功能槽就地回复架构](../architecture/2026-10-18-in-place-reply-slot-and-feature-slot.md)。

## 根因

1. `performSend` 每次发送都生成全新 `screenshot-<uuid>` 会话 id，且 agent 侧 `beginEphemeralRun` 让每个会话的 revision **从 1 重新计数**。
2. `useReplyConversation` 的 effect 依赖 `[conversationId, enabled, platform]`，但本地 `messages` state 与 `revisionRef` 游标**只在 disabled 分支清零**。`ReplyDetails` 全程挂载（`enabled` 恒为 true），换会话时 effect 重跑但旧内容与游标原样保留。
3. 结果是两条症状叠加：新轮事件 revision（1、2、…）小于旧游标，被 `revision <= revisionRef.current` 直接当成"已应用"丢弃——新一轮的流式输出永远不出现；面板继续渲染上一轮的本地缓存，即用户看到的"固定的某次答题记录"。

## 决定

1. `useReplyConversation` 的 effect 每次重跑都是一次全新订阅会话：在函数体开头无条件 `revisionRef.current = 0` 并 `setState(EMPTY_STATE)`，disabled 分支与之合并（不再重复清零）。这样轮内（同一会话）仍保留 2026-10-18 Note 的 `capturedRound` 防覆盖语义，跨轮（新会话 id）则整体归零、重新按事件累积。
2. 测试基建同步对齐 agent 真实语义：`FloatingBarApp.test.tsx` 的 conversation mock 在发送时先发布 revision 1 的 `messages-appended`（对齐 `beginRun` / `beginEphemeralRun`），emit 闭包按会话 id 重置 revision；`replyConversation.test.tsx` 的 fake store 改为按 conversationId 隔离 revision/journal/messages。

## 修复

- `packages/ui/src/app/useReplyConversation.ts`：effect 体开头无条件 `revisionRef.current = 0; setState(EMPTY_STATE)`，disabled 分支与之合并；正文注释写明"每次 effect 重跑都是全新订阅会话，换会话时新轮 revision 从 1 重新计数"的前提。
- `packages/ui/test/replyConversation.test.tsx`：fake store 按会话隔离 revision/journal/messages；新增跨轮清空与旧轮迟到事件两项测试。
- `packages/ui/test/FloatingBarApp.test.tsx`：conversation mock 补齐 `beginRun` 语义（发送先发布 revision 1 的 `messages-appended`，emit 闭包按会话 id 重置 revision）；新增连续两轮 e2e 测试。

## 曾考虑的替代方案

- **新一轮截图时在 `useReplyWorkflow` 里主动清空旧 `conversationId`：** 舍弃。会推翻 2026-10-18 Note 的防回退约定（本轮会话只随 reply slot 退出清空，收起回发送条后还要展开回看），且清空时机分散在工作流、订阅两侧，仍治不了"游标不复位"本身。
- **面板改回按轮卸载重新挂载（换会话时 `key` 重建）：** 舍弃。靠组件稳定性掩盖 hook 状态不合法的问题，且 `ReplyDetails` 还有"收起时保持订阅"的语义，卸载反而破坏 2026-10-18 Note 的生命周期约定。
- **改用 `useChat`（与普通对话同一条 hook）：** 舍弃。答题会话是 ephemeral、完成即被 store 清空，`useChat` 的常驻 transcript 语义与之冲突；这正是 2026-10-18 Note 已论证并选择全程订阅方案的原因。

## 后果与防回退

- `useReplyConversation` 不得恢复"只在 disabled 分支清零"：新增一条订阅重绑定路径（无论 enabled、conversationId 还是 platform 变化）都必须伴随 state 与 revision 游标归零。
- 轮内行为不变：运行结束后 ephemeral 清空快照仍只推进游标不清本地内容（`capturedRound` 守卫保留），完成态收起回发送条后仍可展开回看本轮。
- 测试 mock 的会话语义（先 `messages-appended` 占 revision 1、流事件接续同一序列、按会话 id 重置）不得简化回"每订阅独立 revision 计数"：UI 订阅依赖跨模块的 revision 连续性，mock 偏离会掩盖真实 bug。

## 验证

- `packages/ui/test/replyConversation.test.tsx` 新增"starts each new answer round from a clean panel and streams only the new round"与"ignores late events of a previous round after switching to a new round"；临时回退 hook 修复验证两项均失败且失败信息与用户症状一致，恢复后通过。
- `packages/ui/test/FloatingBarApp.test.tsx` 新增"clears the details panel for each new screenshot answer round"：连续两轮答题后展开面板，仅含第二轮答案、无第一轮残留。
- `pnpm --filter @answra/ui test`：23 个测试文件 167 项全部通过；biome 与 `pnpm --filter @answra/ui typecheck` 通过。
