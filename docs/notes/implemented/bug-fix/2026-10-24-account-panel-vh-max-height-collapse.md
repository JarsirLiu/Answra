# Note：账户面板 vh 上限在 fit-content 窗口里引发塌缩

状态：已实施

## 问题

[账户页卡片化](../feature/2026-10-24-account-panel-card-layout.md) 首版给 `.content-panel--account` 写了 `height: auto` + `min-height: 0` + `max-height: calc(100vh - var(--bar-h) - 24px)`（意图：视口过矮时封顶）。实机验证发现：从设置 tab 切到账户 tab，面板不呈现内容高度，而是越缩越矮，最后只剩面板头 + 资料卡 + 「额度/93 积分」，明细行与退出按钮被 `overflow: hidden` 齐齐裁掉。

## 根因

自引用反馈回路：

1. 本窗口是 fit-content 透明窗——`useFitContent` 用 ResizeObserver 量 `.overlay-root` 的 `offsetHeight` 上报，主进程 `resizeWindowToContent` 把窗口高度设为上报值（`minHeight: 40`，无有效地板）。
2. 因此渲染层 `100vh` = 窗口高度 = 由本页内容高度决定的高度。账户页内容比设置页矮，切过去后窗口先缩到贴合内容。
3. 窗口一缩，`100vh` 变小 → `max-height` 上限随之低于内容高 → 面板被夹矮 → 上报更小 → 窗口再缩……每轮缩一小截，直至只剩面板头。

其它变体（chat/notes/settings/interview）同样写了 `min(固定值, calc(100vh - …))` 却不塌，是因为 `.content-panel` 基类的 `min-height: 400px` 给循环提供了触底地板；账户变体恰恰把 `min-height` 设成了 0，回路无底。

## 修复

- 删除 `.content-panel--account` 的 vh 基准 `max-height`，只保留 `height: auto` + `min-height: 0`，面板高度完全由内容决定；并在 `PanelShell.css` 原地留注释，写明「fit-content 窗口内禁止 vh 基准高度约束」及原因，防止后续在同一位置再犯。
- 超高保护交给主进程既有职责：`resizeWindowToContent` 里的 `clampToWorkArea` 已把窗口钳制在工作区内；极矮屏幕下窗口被钳制、面板底部被裁，属于主进程钳制的既有语义，不再用 CSS 复制一份（复制必然重新自引用）。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/PanelShell.css`（删除 `.content-panel--account` 的 vh 基准 `max-height`）。
- UI 表面：仅账户 tab 的面板高度行为；其余变体与主进程窗口逻辑零改动。
- 相关 Note：[账户页卡片化](../feature/2026-10-24-account-panel-card-layout.md)、[账户页分组卡版式](../feature/2026-10-24-account-panel-grouped-cards.md)。

## 决定

- 渲染层不对 fit-content 窗口内参与上报高度的元素写任何 `vh`/`vw` 基准的 `height`/`max-height`/`min-height`：视口尺寸正是被这些元素决定的，约束必然自引用。
- 窗口越界/超矮屏的处理职责在主进程 `clampToWorkArea`，渲染层不重复实现。

## 曾考虑的替代方案

- **保留 max-height、给账户变体加一个 px 地板（如 `min-height: 340px`）让循环触底：** 能停但不解决问题——地板若低于内容高仍会裁掉内容，等于用一个魔法值换另一个魔法值；弃用。
- **上限改用固定 px（如 `max-height: 480px`）：** 不自引用、稳定，但固定上限与「高度随内容收紧」目标矛盾（内容不足上限时无影响、超过时又被硬裁），且矮屏下仍可能与主进程钳制打架；弃用。
- **回退账户变体、固定 560px：** 回到用户抱怨的半屏空白；弃用。

## 后果与防回退

- 约束一：fit-content 窗口（`useFitContent` + `resizeWindowToContent`）内，渲染层禁止对参与上报高度的元素写 `vh`/`vw` 基准的 `height`/`max-height`/`min-height`——视口尺寸就是被这些元素决定的。需要上限时用固定 px 或交给主进程工作区钳制。
- 约束二：新增面板变体若用 `height: auto`，必须自查整条高度链（面板、内容区、卡片）没有任何视口单位参与；基类 `min-height: 400px` 的「循环地板」作用是隐式的，依赖它兜底等于埋雷。
- 约束三：窗口越界/超矮屏的处理职责在主进程 `clampToWorkArea`，渲染层不重复实现。

## 验证

- `pnpm verify` 全绿（biome + 全包 typecheck + vitest + 架构守护）。
- 实机：用户实机截图中账户页完整呈现资料卡 + 额度卡 + 动作行，面板高度随内容收紧，未再塌缩；设置/账户 tab 间切换窗口高度平滑伸缩。
- 回归点：设置/公告/对话面板行为不受影响（本次只动 `.content-panel--account` 一个选择器）。
