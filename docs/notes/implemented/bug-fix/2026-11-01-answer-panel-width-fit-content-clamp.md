# Note：answer Profile 设置面板宽度被视口钳制

状态：已实施

## 问题

answer 安装包打开「设置」后，面板明显比开发态窄，设置项文字折行、「前景透明度」被挤成竖排；`pnpm dev`（full Profile）和 full 构建都没有此问题。截图显示打包版窗口宽度停在约 300px，而开发态面板保持 480px 宽。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/PanelShell.css`、`packages/ui/test/themeCss.test.ts`。
- UI 表面：notes / settings / interview / account 四个固定宽度面板；chat 面板仍跟随悬浮导航栏。
- 相关 Note：[浮窗启动收起与面板宽度跟随导航栏](../feature/2026-10-18-collapsed-startup-and-panel-width.md)、[账户面板 vh 上限在 fit-content 窗口里引发塌缩](2026-10-24-account-panel-vh-max-height-collapse.md)、[安装包功能裁切与发布 Profile](../../implemented/architecture/2026-11-01-answer-only-release-profile.md)、[answer Profile 恢复笔记本工作区](2026-11-01-answer-profile-restore-notebook.md)、[所有面板宽度跟随悬浮导航栏](2026-11-01-panels-follow-floating-bar-width.md)。

## 根因

fit-content 窗口的宽度自引用：`useFitContent` 测量 `.overlay-root` 的 `offsetWidth` 上报，主进程据此设置窗口宽度；而固定宽度面板又写了 `width: min(480px, calc(100vw - 16px))`，`100vw` 正是由面板上报后决定的窗口宽度。

- full/开发态的悬浮条带有对话、工作区等入口，自身宽度足以把窗口先撑到 480px 以上，因此 `100vw` 不再限制面板，循环被导航栏打破。
- answer Profile 排除 chat 与 workspace，悬浮条只剩答题、截图、设置、关闭，宽度约 300px；没有更宽的元素提供地板，首帧面板被 `100vw - 16px` 夹到约 300px，窗口随后按 300px 稳定，形成和 [vh 上限塌缩](2026-10-24-account-panel-vh-max-height-collapse.md) 同类的自引用回路。

## 修复

- `.content-panel--notes`、`.content-panel--settings`、`.content-panel--interview`、`.content-panel--account` 的宽度改为固定 `480px`，删除 `calc(100vw - 16px)` 上限。
- 面板宽度不再参与“用视口约束自己”；窗口会先按 496px（480 + 外壳左右 16px）上报并放大，随后面板与悬浮条同处一个稳定布局。
- 越界与超窄屏继续由主进程 `clampToWorkArea` 处理，渲染层不复制视口约束。
- `themeCss.test.ts` 增加守卫：固定宽度变体必须使用 `width: 480px` 且不得出现 `100vw`。

## 决定

固定宽度面板只由 px 尺寸和主进程工作区钳制决定；fit-content 窗口内，任何参与宽度上报的元素都不得写 `vw` 基准的 `width` / `max-width` / `min-width`。chat 面板继续使用 `--surface-w`（悬浮条宽度）作为宽度来源，它天然以导航栏为地板，不会自引用。

## 曾考虑的替代方案

- **给 `.overlay-root` 在固定面板打开时加 `min-width`：** 舍弃。能让首帧越过 `100vw` 限制，但仍保留视口单位参与布局，只是把自引用藏到另一层；小屏下还要再决定 min-width 与工作区谁优先。
- **把 answer 悬浮条加宽到 480px 以上：** 舍弃。用视觉占位掩盖布局缺陷，窄条产品形态与节省屏幕空间的目标都会被破坏。
- **让设置面板也跟随 `--surface-w`：** 舍弃。answer 下会永久跟随即约 300px 的导航栏，文字折行问题不会消失。
- **只在 answer Profile 覆盖宽度：** 舍弃。缺陷属于 fit-content 窗口的通用尺寸纪律，full 下只是被更宽的导航栏掩盖；按 Profile 打补丁会让 full 的窄条变体再次踩坑。

## 后果与防回退

- 固定宽度面板在窄导航栏 Profile 下会主动把窗口撑到 496px；这是与 full 一致的预期尺寸。answer 后来恢复工作区入口，窄导航栏不再是常态。
- 固定面板的 480px 宽度随后被整体取代：所有面板统一跟随 `--surface-w`，见 [所有面板宽度跟随悬浮导航栏](2026-11-01-panels-follow-floating-bar-width.md)。中间一版"悬浮条拉伸到面板宽度"被用户否决，见 [悬浮条拉伸到面板宽度方案（已拒绝）](../../rejected/feature/2026-11-01-floating-bar-stretch-to-panel-width.md)。
- 本 Note 的核心约束继续有效：任何参与 fit-content 宽度上报的元素都不得用 `vw` 基准定义自身宽度；面板以导航栏宽度为地板后，基类 `100vw - 16px` 上限在正常布局下永不生效，自引用无回归路径。
- 渲染层不再用 `vw` 封顶固定面板宽度；新增固定尺寸面板必须沿用 px 宽度，并自查是否参与 fit-content 宽度上报。
- 极窄显示器下窗口被 `clampToWorkArea` 钳制后面板可能横向裁切，这与既有高度钳制语义一致，不在渲染层另做响应式压缩。

## 验证

- `pnpm --filter @answra/ui test`：`themeCss.test.ts` 新增守卫通过。
- `pnpm verify`、`pnpm notes:check` 通过。
- 重新执行 `pnpm --filter @answra/desktop dist:win` 生成 answer 安装包；需在安装包内复查设置面板宽度、常规/模型/公告排版与文字不再折行。
