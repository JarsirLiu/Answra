# Note：移除桌面 AI 对话的上下文占用行

状态：已实施

## 问题

桌面 `ChatPanel` 在每轮回复后显示 `ContextUsageNotice`：

`上下文约 2.3k / 216k（1%）· 工具清理 172k · 摘要压缩 216k`

首轮只有 2.3k，不可能发生工具清理，但“工具清理 172k”与清理事件文案 `已清理 N 个旧工具结果，节省 X token` 长得太近，用户把 172k 读成“已清理 172k”，误以为第一轮就触发了清理。该行还把“当前用量”和“触发阈值”混在同一句里，既不解释阈值含义，也没有可操作信息；用户明确认为这行 UI 没有意义。

## 涉及范围

- `packages/ui/src/components/panels/ChatPanel.tsx`：删除 `contextUsage` prop 与渲染。
- `packages/ui/src/app/ChatFeaturePanel.tsx`：不再向 `ChatPanel` 传 `conversation.contextUsage`。
- `packages/ui/src/components/chat/ContextUsageNotice.tsx`：删除组件。
- `packages/ui/src/components/chat/index.ts`：删除组件导出。
- `packages/ui/src/app/contextUsage.ts`：删除只服务该组件文案的 `contextUsageLabel`。
- `packages/ui/src/app/conversationView.ts`：删除 `contextUsageLabel` 再导出。
- `packages/ui/test/ChatPanel.test.tsx`：移除 usage 渲染断言，保留真实清理提示断言。
- 相关 Note：[256k 上下文预算与旧工具结果清理](../architecture/2026-11-13-context-budget-and-tool-result-clearing.md)、[上下文压缩与归档](../../proposed/architecture/2026-11-13-conversation-context-compaction-and-archive.md)。

## 影响表面

- 桌面 AI 对话不再显示常驻的“上下文约 / 工具清理阈值 / 摘要压缩阈值”行。
- 真实发生旧工具结果清理时，仍显示 `ContextPruningNotice`，文案是“已清理 N 个旧工具结果，节省约 X token”；该提示只由 `ContextPruningStatus` 驱动，`prunedCount > 0` 才出现。
- CLI 状态行的 `ctx N%`、`/status` 的完整用量和 CLI 尾部清理提示不变。
- `ConversationSnapshot.contextUsage` 与 `ConversationView.contextUsage` 保留，CLI 和其他消费者继续使用；本次只改桌面展示。

## 决定

- 删除桌面 `ContextUsageNotice` 及其 `ChatPanel` prop，不再在对话流末尾显示上下文占用/阈值行。
- 保留 `contextUsagePercent`、`formatContextTokens` 和 `contextPruningLabel`，分别供 CLI 状态行、`/status` 与清理提示使用。
- 不修改 `ContextPreparation` 写入的 `contextUsage`，也不修改 snapshot 契约。
- 不在桌面用阈值替代清理事件；阈值不是清理结果，不能出现在“已清理”语义的提示里。

## 曾考虑的替代方案

- **只改文案为“清理阈值 172k / 压缩阈值 216k”：** 能消除部分误解，但用户明确表示这行 UI 没有意义；保留仍需解释阈值，舍弃。
- **只在接近阈值或已触发时显示：** 低占用时没有信息，触发后又与真实清理提示重复；判断“接近”还要引入新的 UI 状态来源，舍弃。
- **同时移除 CLI 的 `ctx N%` 状态行：** 用户只反馈桌面；CLI 状态行是紧凑的进度指示，`/status` 仍保留详细值，不在本次范围。
- **删除 snapshot 或 `ContextPreparation` 的 `contextUsage`：** 会破坏 CLI 与其他消费者，且用量本身仍有诊断价值；只删桌面展示，舍弃删除数据链路。

## 后果与防回退

- 桌面对话更干净，不再出现“没清理却像清理了”的歧义行。
- 代价是桌面不再显示当前上下文占用；需要诊断时使用 CLI 状态行、`/status` 或日志。
- 防回退：
  - 不得在桌面用 `usedTokens` / `pruneAt` / `compactAt` 拼出暗示“已清理”的常驻文案；
  - 真实清理提示必须继续由 `ContextPruningStatus` 且仅在 `prunedCount > 0` 时展示；
  - 不得把阈值当作清理节省量传给 `ContextPruningNotice`；
  - 重新引入用量展示时，必须把“当前占用”和“触发阈值”分成不同语义，并明确阈值不是已发生事件。

## 验证

- `pnpm --filter @answra/ui exec vitest run test/ChatPanel.test.tsx`
- `pnpm --filter @answra/ui typecheck`
- 覆盖：删除 usage 渲染后，`ChatPanel` 仍显示真实 `ContextPruningStatus` 文案；无 `contextUsage` prop 的类型检查通过。
