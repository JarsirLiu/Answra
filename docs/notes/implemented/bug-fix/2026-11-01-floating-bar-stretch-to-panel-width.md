# Note：面板打开时悬浮条与固定宽度面板同宽

状态：已实施

## 问题

answer 安装包内打开「设置」后，固定宽度面板（480px CSS，150% 缩放下约 714 物理像素）与悬浮导航栏（约 307px CSS）宽度不一致，上下两块浮层左右错位，看起来是两个互不相关的悬浮块。恢复笔记本入口后悬浮条变宽了约一步，但依旧比面板窄 170px 左右，用户截图裁定这是必须修掉的观感缺陷。

## 涉及范围

- 代码/模块：`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/components/floating-bar/FloatingBar.css`。
- UI 表面：notes（笔记本/资料）/ settings / interview / account 四个固定宽度面板打开期间的悬浮胶囊形态。
- 相关 Note：[浮窗启动收起与面板宽度跟随导航栏](../feature/2026-10-18-collapsed-startup-and-panel-width.md)、[answer Profile 设置面板宽度被视口钳制](2026-11-01-answer-panel-width-fit-content-clamp.md)、[answer Profile 恢复笔记本工作区](2026-11-01-answer-profile-restore-notebook.md)。

## 根因

面板宽度体系有两个来源：对话面板跟随 `--surface-w`（悬浮条实测宽度），固定宽度面板写死 `480px`（为断开 fit-content 视口自引用回路，见 2026-11-01 bug-fix Note）。answer Profile 的悬浮条没有更宽的常驻内容，天然只有约 307px，固定面板打开时窗口虽被撑到 496px，但胶囊仍是窄条、留在左侧，面板右对齐铺满窗口——宽度差与左右对齐叠加成明显的错位。

## 修复

- `FloatingBarApp.tsx` 外壳挂 `data-panel-open={panel === "closed" ? undefined : "true"}`，开合状态唯一来源于 `surfaces.panel`，不另设推导态。
- `FloatingBar.css`：`.overlay-root[data-panel-open="true"]` 下悬浮条栈 `align-self: stretch; width: auto`、胶囊 `width: auto` 并 `justify-content: space-between`。

## 决定

- 面板打开期间（`panel !== "closed"`），外壳挂 `data-panel-open="true"`，悬浮条栈 `align-self: stretch; width: auto`、胶囊 `width: auto` 拉伸到面板宽度，段间分隔线随 `justify-content: space-between` 均匀分布；悬浮条与面板构成同一块浮层。
- 面板关闭后胶囊回到 `max-content` 紧凑态；模式菜单等无面板状态不触发拉伸。
- 固定面板 `480px` 不变：笔记本侧栏 `clamp(170px, 38%, 232px)` 在 307px 宽度下会把正文挤到约 130px，跟随导航栏会复活旧的挤压问题；让宽的那一侧（胶囊）向面板对齐，不反过来。

## 曾考虑的替代方案

- **所有面板改为跟随 `--surface-w`：** 舍弃。窄导航栏下笔记本/设置内容在 307px 宽度会挤压破损，文字折行问题不会消失（2026-11-01 bug-fix Note 已裁定过一次）。
- **悬浮条常驻加宽到 480px：** 舍弃。紧凑胶囊是产品形态，无面板时也要为对齐付出屏幕空间；此前方案已被否。
- **面板加 `min-width: var(--surface-w)` 再右对齐：** 舍弃。宽度仍然不同，只改变错位方向，不满足"同宽"诉求。
- **把面板缩到导航栏宽度：** 舍弃。同方案一，内容不可用。

## 后果与防回退

- 固定面板打开时窗口宽度为面板宽度加外壳余量（496px），胶囊同步变宽；关闭面板即回收。宽度反馈全部来自固定 px，无 `vw` 参与，不会重新引入 fit-content 宽度自引用。
- `--surface-w` 在面板打开时会读到面板宽度（480px）：当前只有 chat 面板消费它，且 chat 本就跟随导航栏，answer 不含 chat，从而无行为分叉。
- 新增固定宽度面板时沿用同一机制：面板定 px 宽度即可，胶囊在打开期间自动对齐。
- 守卫：`themeCss.test.ts` 断言拉伸规则挂在 `[data-panel-open="true"]` 且不写死其他宽度来源；`FloatingBarApp.test.tsx` 断言面板开合与外壳属性同步。

## 验证

- `pnpm --filter @answra/ui test`：新增两条测试通过。
- `pnpm verify`、`pnpm notes:check` 通过。
- 实机（待办）：answer 安装包内打开设置/笔记本/账户，确认胶囊与面板同宽、分隔线均匀分布；关闭面板后胶囊回到紧凑态。
