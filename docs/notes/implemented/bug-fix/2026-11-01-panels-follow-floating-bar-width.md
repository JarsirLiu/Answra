# Note：所有面板宽度跟随悬浮导航栏

状态：已实施

## 问题

answer 安装包内固定宽度面板（480px CSS，150% 缩放下约 714 物理像素）与悬浮导航栏（约 307px CSS）宽度不一致，两块浮层左右与宽度双重错位。第一次修复把悬浮条拉伸到面板宽度，被用户裁定否决——悬浮条必须保持原有紧凑宽度；正确方向是面板向悬浮条对齐。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/PanelShell.css`、`packages/ui/src/components/panels/workspace/WorkspacePanel.css`、`packages/ui/test/themeCss.test.ts`。
- UI 表面：notes（笔记本/资料）/ settings / interview / account 面板宽度；悬浮条形态不变。
- 相关 Note：[浮窗启动收起与面板宽度跟随导航栏](../feature/2026-10-18-collapsed-startup-and-panel-width.md)、[answer Profile 设置面板宽度被视口钳制](2026-11-01-answer-panel-width-fit-content-clamp.md)、[answer Profile 恢复笔记本工作区](2026-11-01-answer-profile-restore-notebook.md)、[悬浮条拉伸到面板宽度方案（已拒绝）](../../rejected/feature/2026-11-01-floating-bar-stretch-to-panel-width.md)。

## 根因

面板宽度体系有两个来源：基类与对话面板跟随 `--surface-w`（悬浮条实测宽度），固定宽度变体写死 `480px`（为断开 fit-content 视口自引用而引入）。answer Profile 的悬浮条天然只有约 307px，固定面板打开时窗口被撑到 496px，但胶囊仍是窄条留在左侧，形成肉眼可见的错位。宽度不一致不是渲染 bug，而是"同一浮层两块区域"各自有宽度来源的结构问题。

## 修复

- `PanelShell.css`：删除 `.content-panel--notes`、`--settings`、`--interview`、`--account` 的 `width: 480px`，变体只保留高度规则；所有面板继承基类 `width: min(var(--surface-w, 620px), calc(100vw - 16px))`。
- `WorkspacePanel.css`：笔记本侧栏 `clamp` 下限 170px → 132px，允许窄面板下侧栏占 38% 而不是硬撑 170px 挤压正文。
- `themeCss.test.ts`：守卫改为断言四个变体不得自带 `width` 声明、基类宽度必须挂在 `--surface-w` 上。

## 决定

- 所有面板宽度统一等于悬浮条实测宽度：胶囊与面板恒为同宽浮层，悬浮条形态在任何状态下不变。
- 自引用不回归的依据：面板宽度地板是导航栏自身（`window = fit-content 根 = max(导航栏, 面板) + 16px 余量 ≥ 导航栏 + 16px`），因此基类 `100vw - 16px` 上限永不生效；`100vw` 仍然禁止出现在变体宽度里，也禁止任何元素用视口单位定义自己参与上报的宽度。
- 笔记本、设置、账户内容按约 340px 全宽档位的行宽重新自查：设置行所需最小宽（标签 + 滑块 + 数值 ≈ 264px）可整行放下；侧栏降至 132px 下限后笔记本正文保有余宽。
- 曾考虑的方案记录：拉伸悬浮条（已拒绝，见否决 Note）、保留 480px 固定宽（即原错位缺陷）、用 `min-width: var(--surface-w)` 只改对齐边（宽度仍不同）。

## 曾考虑的替代方案

- **拉伸悬浮条到面板宽度（已实施的上一版）：** 舍弃。用户裁定悬浮条必须保持原有紧凑宽度，方案整体已迁入 rejected 记录，见 [悬浮条拉伸到面板宽度方案（已拒绝）](../../rejected/feature/2026-11-01-floating-bar-stretch-to-panel-width.md)。
- **保留固定 480px 面板宽度：** 舍弃。这正是本次缺陷来源；只要面板存在独立宽度来源，与悬浮条错位就无法消除。
- **面板加 `min-width: var(--surface-w)`、保持 480px 上限：** 舍弃。bar 窄时仍是 480 与 307 两个宽度，只改变对齐边不改变宽度差。
- **用 `100vw` 封顶面板宽度：** 舍弃。fit-content 窗口里 `100vw` 由面板自己上报的宽度决定，`min(480px, 100vw - 16px)` 已真实造成过自引用锁窄（见 2026-11-01 面板宽度 bug-fix Note）。跟随 `--surface-w` 后基类保留的 `100vw - 16px` 上限只在导航栏地板之下才可能生效，等价于不生效。

## 后果与防回退

- 面板宽度只有一个来源：`--surface-w`。新增面板不得自带 px 宽度，由守卫测试拦截。
- 在 620px 回退值生效的首帧（面板在 `useSurfaceWidth` 测量前打开）窗口会先宽后收，属一次性过渡，不作为布局事实依赖。
- 笔记本侧栏/设置行在窄宽度下的排版是接受态的一部分；若未来行内控件最小宽总和超过导航栏实测宽，应先改控件自适应，而不是重启第二套宽度来源。
- 全量 Profile 中导航栏因回复条等功能槽变宽时，面板宽度同步跟随（与对话面板原行为一致）。

## 验证

- `pnpm --filter @answra/ui test`：重写后的 `themeCss.test.ts` 守卫通过，`FloatingBarApp.test.tsx` 面板行为测试通过。
- `pnpm verify`、`pnpm notes:check` 通过。
- 实机（待办）：answer 安装包内打开设置/笔记本/账户，确认面板与悬浮条同宽、悬浮条不因面板开合改变宽度；在大于/等于 150% 缩放下复核设置行与笔记本两栏排版。
