# Note：回复详情面板与悬浮条间距对齐内容面板

状态：已实施

## 问题

主窗口里截图答题的展开详情面板（`ReplyConversationPopover`，「当前对话」）与悬浮条之间没有间距（`margin-top` 缺失，贴着悬浮条），而对话/设置等内容面板（`.content-panel`）统一有 `margin-top: 8px`；同类面板间距不统一。

## 根因

`.content-panel` 在 `PanelShell.css` 上有 `margin-top: 8px` 承担内容面板与悬浮条之间的统一间距；`.reply-conversation-popover` 是独立样式体系（不包 PanelShell），CSS 里没有任何上边距规则，而它在 `.overlay-root` flex column 中直接跟随悬浮条，因此间距为 0。

## 修复

`ReplyConversationPopover.css` 新增 `.overlay-root .reply-conversation-popover { margin-top: 8px; }`，把间距补齐到与内容面板一致。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/ReplyConversationPopover.css`（新增 `.overlay-root .reply-conversation-popover` 间距规则）。
- UI/进程/协议/持久化表面：仅主窗口（`.overlay-root`）的视觉布局；独立回复窗（`ReplyBarWindowApp` / `.reply-window-root`）不受影响，无协议或数据变化。
- 相关 Note：[悬浮导航功能槽就地回复架构](../architecture/2026-10-18-in-place-reply-slot-and-feature-slot.md)。

## 决定

间距作用域限定在 `.overlay-root`（主窗口）内：`margin-top: 8px`，与 `PanelShell.css` 的 `.content-panel` 一致。独立回复窗形态不套用——该形态的条-面板间距来自 `.reply-window-root` 的 `flex gap: 8px`，若 popcorn 自身再加 margin 会双倍。

## 曾考虑的替代方案

- **直接给 `.reply-conversation-popover` 加 `margin-top: 8px`（不加作用域）：** 舍弃。独立回复窗也使用该组件，其布局已有 8px flex gap，双重间距会把该形态撑开。
- **把 popover 宽度/圆角一并对齐 `--surface-w` 与 `--bar-radius + 1px`：** 暂不做。用户本次反馈的是条-面板间距；宽度语义（内容面板跟随悬浮条宽度）与答题面板定宽（560px）是独立决策，待有明确反馈再另立 Note。

## 后果与防回退

- 新增在主窗口渲染的浮层/弹层时，不要假设"所有面板共用同一基类"：`.reply-conversation-popover` 独立于 `.content-panel` 体系，间距需显式对齐。
- 若未来改动 `.reply-window-root` 的 flex gap，需同步检查本规则不会造成主窗口/独立窗间距漂移。

## 验证

- 实机：主窗口答题流展开详情面板，与悬浮条间距、对话/设置面板一致（8px）。
- 自动化：`npx biome check packages/ui` 通过；布局为纯 CSS，jsdom 无布局能力，不做 RTL 断言。
