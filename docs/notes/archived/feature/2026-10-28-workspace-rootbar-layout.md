# Note：工作区根目录条改为带内边距的工具行

状态：已实施
归档日期：2026-10-28

> 后续：该路径条已在同日被移除——目录路径上移到面板头部，更换目录收为头部图标钮，
> 见 [工作区目录路径上移面板头部](../../implemented/feature/2026-10-28-workspace-header-root-path.md)。本 Note 仅留作历史记录。

## 问题

用户反馈工作区面板（笔记本 / 资料）里「更换目录」一行难看：整行顶到面板头部和左右边缘。根因是 `.workspace-panel` 自身没有内边距，`workspace-panel__rootbar` 直接贴住 `PanelShell` 头部下沿与面板边框；同时 `workspace-panel__body` 的 `border-top` 与面板容器 `gap: 10px` 叠加，分隔线悬空浮在目录树上方 10px 处，不成一条完整的行。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/workspace/WorkspacePanel.css`（仅样式，`WorkspacePanel.tsx` 零改动）。
- UI 表面：已选目录态下根目录条（文件夹图标 + 路径 + 「更换目录」+ 错误信息）与下方左右分栏的间距、分隔线。

## 决定

- 根目录条自带 `padding: 10px 12px`（左右与面板头部、内容区 12px 内边距对齐）和 `border-bottom: 1px solid var(--glass-line-soft)`，成为一条完整的工具行。
- `.workspace-panel` 移除 `gap: 10px`，`workspace-panel__body` 移除 `border-top`：分隔线归属根目录条，消除悬空线。
- 根目录条 `flex-wrap: wrap`，错误信息（`workspace-panel__error`）`flex-basis: 100%`：出错时整行折行到路径下方，不再挤压路径文本。
- 「更换目录」按钮加 hover 反馈（`color: var(--ink); background: var(--hover)`）并把 padding 从 `2px 8px` 放宽到 `3px 10px`，与其它小号控件的手感一致。

## 影响表面

- 已选目录态：路径行不再贴边，面板头部与目录树之间出现完整分隔线；错误信息从同行挤压变折行。
- 未选目录态（空态）与各预览 pane 布局不变。

## 曾考虑的替代方案

- **给 `.workspace-panel` 整体加内边距（对齐 `.notes-panel` 的 14px）：** 会让左右分栏和分隔线一起内缩，破坏当前「目录树贴边 + 右侧内容自带 padding」的 VS Code 式满幅结构，弃用。
- **只给根目录条加 `margin: 10px 12px 0`：** 路径行与分隔线仍然分离（`border-top` 依旧悬空），没有解决根因，弃用。

## 后果与防回退

- 约束一：工作区面板的分隔线由 `workspace-panel__rootbar` 的 `border-bottom` 承担，禁止在 `workspace-panel__body` 上再叠 `border-top`（会出现双线或悬空线）。
- 约束二：`.workspace-panel` 不设纵向 `gap`，根目录条与 body 的间距由根目录条 padding 提供；新增行级元素应挂进根目录条（折行）或 body 内部，不要靠容器 gap 撑开。
- 根目录条是全宽工具行：新增其内元素时保持左右 12px 内边距与面板头部对齐。

## 验证

- `pnpm --filter @answra/ui exec vitest run test/workspace.test.tsx`：12 例全过（选择目录、打开文件、收起侧栏等行为断言不受纯样式改动影响）。
- 待实机验证：打开「笔记本」选择目录后查看路径行与头部/左右边缘的间距、hover「更换目录」反馈；`pnpm verify` 由提交前门禁执行。
