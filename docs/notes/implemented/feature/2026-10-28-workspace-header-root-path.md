# Note：工作区目录路径上移面板头部，更换目录收为图标钮

状态：已实施

## 问题

工作区面板（笔记本 / 资料）在面板头部（当前文件名）与目录树之间横着一条「根目录路径 + 更换目录」的工具行：既占一整行高度，又把同一块上下文切成三层。用户要求：目录路径放到头部显示文件名的位置，更换目录只留一个文件夹图标按钮（点击弹系统目录选择器），中间那一行整行删除。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/workspace/WorkspacePanel.tsx`、`WorkspacePanel.css`、`packages/ui/src/components/panels/PanelShell.tsx|.css`；`packages/ui/test/workspace.test.tsx`。
- UI 表面：已选目录态的面板头部（标题 = 根目录路径 + 更换目录图标钮）与主体布局；未选目录态不变。
- 相关 Note：`archived/feature/2026-10-28-workspace-rootbar-layout.md` 描述的路径条随本次移除，已归档。

## 决定

- 面板标题（原文件名位）改为**根目录路径**：单行省略、完整路径放 `title` 提示；`PanelShell` 的 `panel-title` 补 `min-width: 0` + ellipsis（标题可能很长）。
- 「更换目录」收为头部动作位的**文件夹图标按钮**（`workspace-panel__pick-root`，25px，与关闭钮同语言），点击走既有 `workspace.pickRoot()` → 主进程 `dialog.showOpenDialog({ properties: ["openDirectory"] })`，即系统原生目录选择器（不自绘选择器）。
- 删除 `.workspace-panel__rootbar` 整行及其样式；选择目录失败的错误信息改在内容区顶部呈现（`.workspace-panel__content > .workspace-panel__error` 自带内缩）。

## 影响表面

- 已选目录态：面板头部标题变为根目录路径（长路径省略），右侧新增文件夹图标钮；头部与目录树之间不再有路径行，内容区整体上移一行。
- 未选目录态：头部标题仍为「笔记本 / 资料」，选择目录主按钮与错误提示不变。

## 曾考虑的替代方案

- **保留路径条、只把它做矮一点：** 仍然是三层信息（文件名 / 路径 / 树），用户明确要求删掉整行。
- **自绘目录选择器弹层：** 需要目录遍历、权限、键盘导航等一整套交互，系统原生对话框已覆盖且零维护成本，弃用。
- **头部同时显示「文件名 — 路径」：** 480px 宽的面板放不下，两段都会被截断，信息密度反而下降；文件身份由目录树选中态承担。

## 后果与防回退

- 约束一：面板标题承载路径，必须保持单行省略 + `title` 全量提示；`PanelShell` 内标题不再假设短文本。
- 约束二：更换目录入口只允许「头部图标钮 + 空态主按钮」两处，均调用 `workspace.pickRoot()`；禁止再引入第二条路径显示行。
- 约束三：目录选择必须是主进程原生对话框，不在渲染进程自绘。
- 约束四：已选目录态的树/预览区顶部不再有路径条，错误信息统一走内容区顶部（自带内缩）。

## 验证

- `packages/ui/test/workspace.test.tsx`：恢复缓存目录时断言 `heading` 名称为路径且带 `panel-title`、头部「更换目录」图标钮带 `workspace-panel__pick-root` 且点击调用 `pickWorkspaceRoot`；其余用例（选择目录空态、树展开/收起、md 打开、旧笔记迁移、docx/pdf 预览）保持通过。
- `vitest run test/workspace.test.tsx test/zoomablePreview.test.tsx test/FloatingBarApp.test.tsx` 全过；相关文件 biome 无告警。
- 待实机验证：面板头部显示根目录路径（长路径省略、悬停见全量），右侧文件夹图标点击弹出系统目录选择器；头部与目录树之间不再有中间行。
