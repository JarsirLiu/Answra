# Note：目录树整棵右移（缩进选择器误伤顶层）与收起窄条极细化

状态：已实施

## 问题

用户反馈两点：一是鼠标悬浮目录/文件行时，高亮行距面板左缘有一大截空隙，整棵树"一点都没有目录组织"，要求对齐 macOS/VS Code 式的成熟层级；二是侧栏收起后的窄条（26px）太粗，要求极细。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/workspace/DirectoryTree.css`（缩进修复）、`WorkspacePanel.css` 与 `WorkspacePanel.tsx`（收起窄条宽度与图标尺寸）。
- UI 表面：工作区面板目录树的缩进层级与收起态竖条宽度。

## 决定

- 顶层列表贴左、子级缩进只由 `.workspace-tree__children` 承担（每级 16px），层级观感对齐 VS Code / macOS Finder。
- 收起态竖条固定为 14px 极细条：窄条只承担"展开目录"一个动作，图标 11px，tooltip 保留。

## 根因

`DirectoryTree.css` 用 `.workspace-tree ul { padding-left: 16px }` 做逐级缩进，但该选择器（特异度 0,1,1）同样命中顶层的 `.workspace-tree__list`，且压过前一条规则里 `.workspace-tree__list` 的 `padding: 0`（特异度 0,1,0）。结果顶层列表凭空右移 16px，"nothing" 的子级再叠到 32px，悬浮高亮整行跟着右移，左侧留出一大块无主空隙。

## 修复

- 逐级缩进只挂在标记里已有的子级列表类 `.workspace-tree__children`（`padding-left: 16px`），顶层列表回到贴左（侧栏 padding 8px + 行内 2px），每级 16px 的 VS Code/Finder 式层级保持不变。
- 收起态竖条从 26px 收窄到 14px：`flex-basis: 14px`、按钮同宽、图标从 15px 降到 11px，tooltip（"展开目录"）保留可发现性。

## 曾考虑的替代方案

- **顶层列表加 `padding-left: 0 !important` 或提高 `.workspace-tree__list` 特异度硬顶回来：** 治标，下一个想缩进子级的人还会踩同一个宽选择器，弃用；改为从选择器语义上杜绝（缩进只属于 children）。
- **收起态彻底取消竖条、展开入口挪到根目录条：** 少一个常驻元素，但要动根目录条结构且展开入口更隐蔽；用户只要求"极细"，保留极细竖条是更小步的改法。

## 后果与防回退

- 约束一：目录树缩进只允许挂在 `.workspace-tree__children` 上，禁止再引入 `.workspace-tree ul` / `li ul` 一类会命中顶层列表的后代选择器。
- 约束二：收起态竖条保持 ≤14px；新增收起态内容前先确认它真的需要常驻竖条，否则放进展开态。
- 顶层行与悬浮高亮必须贴齐侧栏左缘（8px 内边距），不允许出现"整块右移"的层级观感。

## 验证

- `pnpm exec biome check packages/ui/src/components/panels/workspace/` 无告警；`vitest run test/workspace.test.tsx` 12 例全过（收起/展开按钮行为断言不受纯样式改动影响）。
- 待实机验证：悬浮文件行高亮应从侧栏左缘开始；"nothing" 子级相对父级只缩进一级 16px；收起后竖条为发丝级窄条。
