# Note：移除桌面 AI 对话的清理提示

状态：已实施

## 问题

桌面 `ChatPanel` 在旧工具结果被清理后显示 `ContextPruningNotice`：

`已清理 N 个旧工具结果，节省约 X token`

但清理只替换模型请求里的工具结果副本，transcript 和界面中的工具结果仍完整保留，用户看不到任何对应变化。这条提示属于内部优化播报，和刚移除的上下文占用行一样容易让人以为历史内容被删改。用户明确认为桌面不需要这条提示。

## 涉及范围

- `packages/ui/src/components/panels/ChatPanel.tsx`：删除 `contextPruning` prop、内容指纹条目和渲染。
- `packages/ui/src/app/ChatFeaturePanel.tsx`：不再向 `ChatPanel` 传 `conversation.contextPruning`。
- `packages/ui/src/components/chat/ContextPruningNotice.tsx`：删除组件。
- `packages/ui/src/components/chat/index.ts`：删除组件导出。
- `packages/ui/test/ChatPanel.test.tsx`：删除清理提示渲染测试与 prop 桩。
- 相关 Note：[移除桌面 AI 对话的上下文占用行](2026-11-17-remove-desktop-context-usage-notice.md)、[256k 上下文预算与旧工具结果清理](../architecture/2026-11-13-context-budget-and-tool-result-clearing.md)。

## 影响表面

- 桌面 AI 对话不再显示“已清理 N 个旧工具结果，节省约 X token”。
- 工具结果仍完整保留在 transcript 和界面中；清理只影响模型投影，不改变可见历史。
- CLI 仍保留清理提示与状态行；本次只改桌面展示。
- `ConversationSnapshot.contextPruning`、`ContextPruningStatus` 和 `contextPruningLabel` 保留，CLI 与诊断继续使用。

## 决定

- 删除桌面 `ContextPruningNotice` 及 `ChatPanel` 的 `contextPruning` prop，不再在对话流末尾播报清理结果。
- 不修改 `ContextPreparation` 写入的 `contextPruning`，也不修改 snapshot 契约。
- CLI 的清理提示保持原样；`prunedCount > 0` 才出现的条件不变。

## 曾考虑的替代方案

- **保留提示但缩短文案：** 仍是无用户可见变化的内部播报，且“已清理”会继续让人误解历史被删除；舍弃。
- **只在长会话或首次清理时显示：** 仍需要额外 UI 状态来源，且清理量与用户操作无关；舍弃。
- **同时移除 CLI 的清理提示：** CLI 是终端宿主，状态行/尾部提示对开发者有诊断价值，用户本次只反馈桌面；不做。
- **删除 snapshot 或 `ContextPreparation` 的 `contextPruning`：** 会破坏 CLI 与诊断能力；只删桌面展示，舍弃删除数据链路。

## 后果与防回退

- 桌面对话不再有清理播报；需要判断上下文是否被清理时使用 CLI 状态行、`/status` 或日志。
- 防回退：
  - 不得在桌面重新渲染工具结果清理数量或节省 token 的播报；
  - CLI 清理提示必须继续由 `ContextPruningStatus` 且仅在 `prunedCount > 0` 时展示；
  - 不得把阈值当作清理节省量传给清理提示；
  - 不得删除 snapshot 中的 `contextPruning` 数据链路。

## 验证

- `pnpm --filter @answra/ui exec vitest run test/ChatPanel.test.tsx`
- `pnpm --filter @answra/ui test`
- `pnpm --filter @answra/ui typecheck`
- `pnpm --filter @answra/desktop typecheck`
- 覆盖：`ChatPanel` 不再渲染清理文案；无 `contextPruning` prop 的类型检查通过；CLI 清理提示与共享 `contextPruningLabel` 不受影响。
