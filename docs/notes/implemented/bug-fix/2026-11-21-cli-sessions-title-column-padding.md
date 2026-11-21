# Note：CLI 会话列表长标题挤压固定列

状态：已实施

## 问题

`/sessions` 面板按终端列宽计算标题最大宽度时，没有扣除 `PanelFrame` 内容区左右各 2 列的 padding。短标题不受影响；长标题把整行撑到终端宽度后，Ink 收缩固定列文本，时间戳最后一个字符被截掉，测试无法稳定读到 `2026-11-17 09:28`。

## 涉及范围

- `apps/cli/src/tui/panels/sessionsPanel.tsx`
- `apps/cli/test/tui/panels/sessionsPanel.test.tsx` 的长标题回归用例

## 根因

`titleColumns = columns - LABEL_PREFIX_COLUMNS - SESSION_ID_COLUMNS - SESSION_STAMP_COLUMNS` 只扣除了行内固定列，没有扣除 `PanelFrame` 的 `paddingX={2}`。固定列与标题相加超过实际内容宽度，布局把固定列压缩。

## 修复

新增 `PANEL_CONTENT_PADDING_COLUMNS = 4`，从标题列预算中扣除面板左右 padding，使固定列始终完整显示，标题只在剩余列内截断。

## 决定

标题列是 sessions 面板自己的展示预算，由面板按 `PanelFrame` 已知的 `paddingX` 显式扣除；不修改 `PanelFrame` 的 padding，也不在共享布局层引入新的宽度上下文。

## 曾考虑的替代方案

- **给固定列 `<Text>` 加 `flexShrink={0}`。** 能让固定列不被压缩，但长标题仍按未扣除 padding 的宽度预算渲染，整行超过内容区后会被父容器裁切；实测该方案仍不能稳定保留时间戳。
- **缩短标题预算到终端列宽的一半。** 能避免挤压，但短终端上标题过短、宽终端上浪费空间，且仍是猜测值而不是扣除真实 padding。
- **让 `PanelFrame` 通过 context 暴露内容宽度。** 更通用，但当前只有 sessions 面板出现该问题；为单一消费者引入跨组件宽度上下文属于过早抽象。

## 后果与防回退

- 长标题不再挤压 ID 与时间戳；标题仍保持单行、超宽截断。
- `PanelFrame` 的 padding 变化时必须同步该常量；当前通过长标题测试压住回归。
- 该常量只属于 sessions 面板的展示预算，不进入共享布局层。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/panels/sessionsPanel.test.tsx`：11 项通过，包含长标题、固定列对齐、翻页、删除确认与错误展示。
