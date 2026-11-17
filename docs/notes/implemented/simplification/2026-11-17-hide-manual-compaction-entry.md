# Note：隐藏对话头部的手动压缩入口

状态：已实施

## 问题

对话面板头部同时放了「历史」「新对话」「压缩」「清空」四个文字按钮，窄面板下按钮被压缩到换行，出现「新对/话」「压/缩」这类竖排文字，头部观感拥挤。用户明确表示头部只需要查看历史会话、新建会话和清空会话，压缩入口不需要展示，手动压缩以后再做。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/ChatPanel.tsx`、`packages/ui/src/components/panels/ChatPanel.css`、`packages/ui/src/app/ChatFeaturePanel.tsx`、`packages/ui/test/ChatPanel.test.tsx`
- UI 表面：AI 对话面板头部动作区；自动压缩状态行和压缩边界卡不受影响
- 相关 Note：[中性主操作与控件亮面](../feature/2026-11-17-neutral-primary-action-and-control-face.md)

## 移除内容

- 头部「压缩」按钮、摘要指令表单、手动压缩结果提示，以及对应的 `onCompact` / `compactDisabledReason` / `compactNotice` 状态与 CSS。
- 保留 `bridge.compactConversation` 和自动压缩状态展示；本次只移除手动入口，不删除底层能力。

## 决定

- 对话头部只保留「历史」「新对话」「清空」三个动作；没有可清空会话时仍按原逻辑不渲染或禁用清空入口。
- 头部动作按钮固定为单行不换行、不参与 flex 收缩，避免窄宽度下中文标签逐字换行。
- 自动压缩仍通过 `ContextCompactionNotice` 和 `CompactionBoundaryCard` 展示，不把自动压缩误删。

## 重新引入条件

- 手动压缩入口必须重新设计位置，不能恢复四按钮并排；入口应避免继续挤压头部宽度。
- 重新引入时需同时恢复 `onCompact` / 状态提示 / 表单、`ChatFeaturePanel` 接线和 `ChatPanel.test.tsx` 覆盖，并更新本 Note。
- 若只恢复底层 `bridge.compactConversation` 而不提供 UI，不属于重新引入手动入口。

## 曾考虑的替代方案

- **只用 CSS 隐藏「压缩」按钮：** 舍弃。DOM 里仍保留不可达的表单和状态，测试也会继续覆盖不存在的入口。
- **保留按钮但禁用并提示「以后支持」：** 舍弃。用户明确说不需要展示，禁用按钮仍占头部宽度并继续制造拥挤。
- **连自动压缩状态一起删除：** 舍弃。自动压缩是运行时上下文管理的一部分，不是手动入口；删除会让用户看不到长对话被摘要。
- **把四个按钮改成图标：** 舍弃。用户要求的是减少动作，不是换一套需要猜测含义的图标。

## 后果与防回退

- 用户暂时不能从 UI 手动触发上下文压缩；自动压缩和压缩边界仍正常展示。
- 头部在窄面板下不再出现中文标签竖排；新增头部动作必须重新评估宽度，不能无限追加文字按钮。
- `ChatPanel` 不再接收手动压缩相关 props；重新引入时需同步 `ChatFeaturePanel` 的接线和测试。

## 验证

- 自动化：`pnpm --filter @answra/ui exec vitest run test/ChatPanel.test.tsx`（8 项通过）
- 自动化：`pnpm --filter @answra/ui test`（329 项通过）、`pnpm --filter @answra/ui typecheck`、`pnpm lint`
- 需要实机验证：窄面板下头部只显示「历史」「新对话」「清空」且文字不换行；长对话自动压缩状态仍可见。

## 风险

- 移除手动压缩入口后，用户只能依赖自动压缩；如果后续需要手动控制摘要重点，必须重新设计入口位置，而不是恢复四按钮并排。
