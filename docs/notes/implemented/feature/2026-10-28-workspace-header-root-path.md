# Note：工作区面板回归标准头部，目录树侧栏只留纯树

状态：已实施

## 问题

工作区面板（笔记本 / 资料）此前的 headerless 布局把筛选框、根路径行、根节点行全堆在侧栏，面板头部消失，视觉杂乱；且目录树把扁平先序数据整表渲染，嵌套文件在顶层重复出现（同一文件显示两次）；树行还引用了未定义的 `--font-lg` 令牌，字号回落失效。用户要求：只需要一个规整的目录树、可以收起，整体清爽协调。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/workspace/WorkspacePanel.tsx|.css`、`DirectoryTree.tsx|.css`、`packages/ui/src/components/panels/PanelShell.tsx`（删除 `headerless` 分支）、`packages/ui/src/styles/tokens.css`（清理 `--font-lg` 注释残留）、`apps/desktop/src/main/ime/imeRendererDiagnostics.ts`（诊断白名单移除失效 targetId）。
- UI 表面：已选目录态的面板头部（路径标题 + 收起目录/更换目录图标钮）、目录树侧栏（纯树）、未选目录态（标准头部 + 空态）。
- 相关 Note：[目录树缩进与收起窄条](../bug-fix/2026-10-28-workspace-tree-indent-and-rail.md) 的收起竖条约束随本次作废（收起改为整块侧栏不渲染）。

## 决定

- **回归 `PanelShell` 标准头部**：标题 = 根目录路径（单行省略 + `title` 全量提示），未选目录时标题为「笔记本 / 资料」、context 显示「未选择目录」；`headerless` 分支从 `PanelShell` 删除。
- **头部动作组**（`panel-header-action` 位，贴关闭钮左侧）：收起/展开目录图标钮（`PanelLeftClose`/`PanelLeftOpen` 随状态切换）+ 更换目录文件夹图标钮（`workspace-panel__pick-root`，走既有 `pickRoot()` → 主进程原生目录对话框）；关闭钮由 `PanelShell` 承担。
- **收起 = 侧栏整体不渲染**：不再保留收起竖条；正文占满内容区，`ZoomablePreview` 的 `ResizeObserver` 自动重适应宽度。
- **目录树只渲染树**：删除筛选框（`EmbeddedImeInput` 及 `bridge`/`stealth` prop 随之移除）、根路径 h2 行、根节点行；顶层节点 = 路径不含「/」的节点，嵌套节点只在展开的父目录内渲染，杜绝整表重放。
- **树行观感**：行高 `--row-h`（22px）、行圆角 `--ctl-radius-sm`、无行间分隔线；hover `--field`、选中 `--hover`（既有梯度）；文件行补 chevron 空槽，全树图标与文件名同列对齐；子级缩进每级 16px + 竖向引导线；树行字号 `--font-md`。
- 主进程 IME 诊断白名单移除 `workspace-directory-filter`（输入面已不存在）。

## 影响表面

- 工作区面板头部、目录树渲染、目录选择与预览区域的布局行为发生变化；工作区文件读写协议和目录树数据来源不变。

## 曾考虑的替代方案

- **保留筛选框**：用户明确「只需要一个规整的目录树」；筛选作为独立需求出现时再立项。
- **保留收起竖条（14px）**：多一个常驻元素；收起入口放头部后竖条无存在必要。
- **纸面卡片包内容区**：实机已否决（大面积近白底显脏），内容区保持与面板同底。

## 后果与防回退

- 约束一：目录树组件不持有筛选与收起状态——收起/更换目录入口只允许在面板头部，树组件保持纯展示。
- 约束二：顶层列表必须只渲染路径不含「/」的节点；`workspace.test.tsx` 的单次出现断言（`getAllByText("错题.md")).toHaveLength(1)`）是守卫。
- 约束三：树行字号走 `--font-md`；`--font-lg` 令牌不存在，禁止引用未声明的字号令牌。
- 约束四：工作区内容区保持与面板同底；预览边界只由 `.zoomable-preview__viewport` 框线承担（既有约束）。

## 验证

- `packages/ui`：`vitest run test/workspace.test.tsx test/themeCss.test.ts test/zoomablePreview.test.tsx test/markdownEditorPane.test.tsx` 31 例、`FloatingBarApp.test.tsx` 44 例全过；`tsc --noEmit` 无错误；biome 对全部改动文件无告警。
- `apps/desktop`：`imeRendererDiagnostics.test.ts` 3 例全过。
- 待实机验证：头部显示根目录路径（长路径省略）；收起目录后正文占满且预览自动重适应；目录树无重复节点、图标文件名对齐。
