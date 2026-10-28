# Note：UI 尺寸令牌补齐——间距栅格、行高、小圆角（笔记本面板先行）

状态：已实施

## 问题

用户对照大厂规范审视笔记本面板后确认"没有任何规范"：`tokens.css` 的颜色体系是五层令牌（完善），但尺寸只有控件档（`--ctl-h`/`--ctl-radius`）与四档字号，**没有间距栅格、没有行高令牌**，`WorkspacePanel.css`/`DirectoryTree.css` 里 `10px 12px`、`12.5px`、`13.5px`、`22px` 等字面量散落，每个组件现场发明尺寸，观感失去一致性。

## 涉及范围

- 代码/模块：`packages/ui/src/styles/tokens.css`（新增令牌）；`packages/ui/src/components/panels/workspace/WorkspacePanel.css`、`DirectoryTree.css`（字面量清零）；`packages/ui/test/themeCss.test.ts`（字号守卫纳入 `DirectoryTree.css`）。
- UI 表面：工作区面板的间距/行高/圆角有 ±2px 的栅格归档偏移，无任何行为变化。

## 决定

- **新增尺寸令牌**：`--space-1/2/3/4/6`（4/8/12/16/24，4px 基数栅格）、`--row-h: 22px`（密集列表行高，对齐 VS Code 树行密度）、`--ctl-radius-sm: 4px`（目录行/迷你按钮小圆角，与 `--ctl-radius` 7px 成对）。2px 半步写 `calc(var(--space-1) / 2)`，不单设令牌。
- **书写规则（防回退约束）**：组件 CSS 禁止出现间距/行高字面量；字号继续严格执行既有四档令牌（正文内容按 tokens.css 既有豁免保留内容尺度，如 markdown 预览 13.5px、文本预览 12.5px 等宽、代码块 11.5px）。
- **守卫扩大**：`DirectoryTree.css` 是纯界面样式（无内容文字），纳入 `themeCss.test.ts` 的"面板骨架字号禁 px 字面量"正则守卫；`WorkspacePanel.css` 因混有内容预览尺度暂不入列，内容字号豁免规则见 tokens.css 注释。
- 图标槽位（chevron 12px、文件图标 16px）视为与 TSX 图标尺寸常量同步的图标档，16px 槽位复用 `--space-4`。

## 流程变化

- 后续为 `packages/ui` 写样式：间距取 `--space-*`、列表行高取 `--row-h`、小圆角取 `--ctl-radius-sm`、字号取 `--font-*` 四档；出现新的 px 字面量时先问"这是不是新的一档令牌"，是则进 `tokens.css`，否则归档。
- 工作区侧栏宽度 `clamp(150px, 21%, 230px)` 与收起竖条 14px、预览工具条 30px 属组件一次性尺寸，暂不令牌化（已注释标记）。

## 曾考虑的替代方案

- **把全部字面量一步归档（含 6px→8px、14px→16px 的强制取整）到视觉零偏差：** 部分奇数间距（如根目录条 10px、清空按钮 padding 3px 10px）是刚按用户反馈调过的观感，硬取整会来回抖动；最终按"就近归档、偏差 ≤2px"处理，仅目录树缩进/行高这类结构性尺寸严格对档。
- **同时引入侧栏拖拽调宽（VS Code 式）：** 属交互功能而非规范落地，混入本次会让 Note 与 diff 失焦，弃用；待后续单独立项。
- **连 ChatPanel 等其它面板一起规整：** 范围失控；本次只做笔记本面板 + 令牌，其余面板按同一规则跟进。

## 后果与防回退

- 约束一：`packages/ui` 组件 CSS 出现 `margin/padding/gap/height` 的间距字面量即为违规；新增尺寸先进 `tokens.css` 再引用。
- 约束二：`themeCss.test.ts` 守卫列表只增不减；把含内容文字的 CSS 加入守卫前，须先把内容字号迁出或豁免说明。
- 约束三：目录树缩进只挂在 `.workspace-tree__children`（每级 `--space-4`），禁止 `.workspace-tree ul` 式宽选择器（见 [右移缺陷](../bug-fix/2026-10-28-workspace-tree-indent-and-rail.md)）。

## 验证

- `vitest run test/themeCss.test.ts test/workspace.test.tsx`：21 例全过（含新纳入守卫的 `DirectoryTree.css` 字号检查）。
- `biome check packages/ui/src/components/panels/workspace/ packages/ui/src/styles/tokens.css` 无告警。
- 待实机验证：笔记本面板整体间距观感无回退（根目录条、目录树、编辑器工具条、预览区），字号层级与此前一致。
