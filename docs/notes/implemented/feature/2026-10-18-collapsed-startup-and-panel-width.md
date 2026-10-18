# Note：浮窗启动收起与面板宽度跟随导航栏

状态：已实施

## 问题

启动浮窗后对话面板立即展开，遮挡桌面内容，与“轻量悬浮、按需展开”的定位不符；且对话面板固定 620px 宽，与紧凑的悬浮导航栏宽度不一致，视觉上像两个互不相关的悬浮块。

## 涉及范围

- 代码/模块：`packages/ui/src/app/surfaceState.ts`、新增 `packages/ui/src/hooks/useSurfaceWidth.ts`、`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/components/panels/PanelShell.css`、`packages/ui/test/surfaceState.test.ts`、`packages/ui/test/FloatingBarApp.test.tsx`。
- UI 表面：浮窗初始面板状态、对话面板默认宽度。
- 相关 Note：[对话模式与答题模式分离](2026-10-17-separate-chat-and-exam-modes.md)。

## 决定

- `initialSurfaceState.panel` 恢复为 `"closed"`：启动只显示悬浮导航栏，用户点击“对话”才展开面板。
- 新增 `useSurfaceWidth(rootRef)`：用 `ResizeObserver` 测量外壳内 `.floating-bar` 的 `offsetWidth`，写入根节点 CSS 变量 `--surface-w`。
- `PanelShell.css` 的 `.content-panel` 基础宽度改为 `min(var(--surface-w, 620px), calc(100vw - 16px))`；以导航栏为准，面板默认与其同宽；其它面板用 variant 覆盖各自宽度（notes / sources / settings / announcements 不变）。

## 影响表面

- 启动后不再自动展开对话面板。
- 对话面板宽度跟随悬浮导航栏；导航栏因模式切换变宽变窄时，对话面板同步。

## 曾考虑的替代方案

- **给对话面板写死一个更小的固定宽度：** 舍弃。导航栏宽度随模式切换变化，写死仍会对不齐。
- **在 JS 里按内容计算宽度并写面板内联样式：** 舍弃。会绕过 CSS 变量与 variant 覆写，且 `ResizeObserver` 写入 CSS 变量更简单、不触发 React 重渲染。
- **让面板 `width: 100%` 撑满窗口：** 舍弃。面板会与紧凑导航栏差异更大，不符合“跟随导航栏”的诉求。

## 后果与防回退

- `--surface-w` 只在 `.overlay-root` 上由 `useSurfaceWidth` 维护；不要在组件里各自实现宽度逻辑。
- 其它面板靠 `.content-panel--<variant>` 覆盖宽度，新增面板若不覆盖会继承“跟随导航栏”的默认宽度。
- “启动默认收起”与 [对话模式与答题模式分离](2026-10-17-separate-chat-and-exam-modes.md) 原“启动直接进入通用对话”相冲突，已同步更新该 Note。

## 验证

- `surfaceState.test.ts` 断言初始 `panel` 为 `closed`；`FloatingBarApp.test.tsx` 断言启动无“AI 对话”标题、有“打开对话”按钮，且展开面板的用例先点击“打开对话”。
- `pnpm --filter @answra/ui test` 通过。
- 门禁：`pnpm notes:check`、`pnpm verify` 通过。
- 实机确认（待办）：对话/答题模式切换时，对话面板宽度随之变化且不与导航栏错位。
