# Note：悬浮条单一笔记本入口与导航图标统一尺寸

状态：已实施

## 问题

悬浮导航条第三段并列了「笔记本」（`FolderOpen` + 文案 + 下箭头，打开 `notes`）与右侧无文案的书本图标（`BookOpen`，打开 `sources`）两个入口，但两者渲染的是同一块 `WorkspacePanel`（笔记 + 资料合并表面），功能完全重复，多出来的入口只增加视觉噪声。

同时导航条内图标尺寸不一致：模式入口与模式功能按钮使用 `ICON`（14），而工作区的书本/设置/关闭三个图标使用 `ICON_SM`（12），同一排出现两种字号，观感不统一。

## 涉及范围

- 代码/模块：`packages/ui/src/components/floating-bar/WorkspaceControls.tsx`、`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/components/panels/PanelShell.tsx`、`packages/ui/src/components/panels/workspace/WorkspacePanel.tsx`、`packages/shared/src/bridge.ts`、`packages/ui/test/FloatingBarApp.test.tsx`。
- UI/进程/协议/持久化表面：悬浮导航条的入口数量与图标尺寸、`OverlayMode` 面板值集合。
- 相关 Note：[笔记本与资料合并为本地工作区](../feature/2026-10-12-workspace-merge.md)（本次是其「后续可再合并入口」的落地）、[悬浮表面视觉契约](../architecture/2026-10-11-floating-surface-visual-contract.md)。

## 决定

- 删除书本入口：第三段只保留「笔记本」一个工作区入口（`notes`），并连带从 `OverlayMode`、`PanelShell` variant、`FloatingBarApp` 分支中移除已不可达的 `sources` 值。面板状态只存在于 `useSurfaceCoordinator` 的内存 reducer（无持久化），因此没有迁移包袱。
- 统一导航条图标尺寸：导航条内所有功能图标一律使用 `ICON`（14）；`ICON_SM`（12）只保留给 `icons.tsx` 定义的符号类图形（模式选择器与笔记本入口的下拉箭头、菜单选中勾），与该文件既有约定一致。工作区的设置、关闭图标由 12 提升到 14。

## 移除内容

- `WorkspaceControls.tsx`：`BookOpen` 图标与「打开参考资料」按钮、`ICON_SM` 导入，以及已无任何 CSS 定义的 `utility-action--icon` 标记类。
- `packages/shared/src/bridge.ts`：`OverlayMode` 的 `sources` 值；连带 `PanelShell` 的 `sources` variant 与 `FloatingBarApp` 的 `panel === "sources"` 分支。
- 混用的 12px 功能图标（设置、关闭）。

## 影响表面

- 悬浮导航条第三段从 4 个控件降为 3 个（笔记本、设置、关闭）；用户仍经「笔记本」进入同一工作区面板。
- 导航条内功能图标统一 14px，下拉箭头与选中勾仍为 12px 符号尺寸。
- `OverlayMode` 面板值集合不再包含 `sources`；工作区面板的渲染条件从 `notes || sources` 收敛为 `notes`。
- 无用户可见功能损失：`sources` 与 `notes` 此前渲染的是同一个 `WorkspacePanel`。

## 曾考虑的替代方案

- **保留书本入口、只统一图标尺寸：** 两个入口打开同一面板，重复入口本身就是噪声源，因此一并删除。
- **为 `sources` 新建独立资料面板：** 目前不存在"只有资料、没有笔记"的独立内容需求，凭空新增面板属于过度设计，因此不引入。
- **只从 UI 移除入口、保留 `OverlayMode.sources`：** 会留下无法到达的类型分支与死条件，且面板状态无持久化、没有兼容包袱，因此一并收敛。
- **把导航条图标统一到 `ICON_SM`（12）：** 会连带缩小模式入口与模式功能图标，让主操作显得更弱，因此统一到 14。
- **把下拉箭头也提升到 14：** 箭头属于符号图形，与文字/图标同级放大会显得笨重，且与 `icons.tsx` 的既有约定冲突，因此保持 12。

## 后果与防回退

- 第三段只允许存在一个工作区入口；新增「资料」类能力应作为 `WorkspacePanel` 内部能力（目录/预览）扩展，而不是再挂一个并列入口。
- 导航条功能图标一律走 `ICON`，`ICON_SM` 只用于符号类图形；不要再为单个按钮单独调小图标尺寸。
- `OverlayMode` 现有值：`closed` / `chat` / `interview` / `notes` / `settings`。

## 重新引入条件

- 当「资料」需要独立语义（不同的数据源、独立的打开/关闭行为，或独立窗口）而不只是共用同一面板时，再为它恢复独立入口与对应的 `OverlayMode` 值。

## 验证

- 新增 `packages/ui/test/FloatingBarApp.test.tsx` 用例：悬浮条内「打开笔记本」只有 1 个、不存在「打开参考资料」，且排除下拉箭头后 6 个功能图标宽高均为 `ICON`。
- `pnpm typecheck` 通过（确认 `sources` 再无任何引用）；`packages/ui` 全部 204 个测试通过；`pnpm notes:check` 通过。
