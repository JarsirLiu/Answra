# Note：悬浮层大投影裁剪成"贴边灰环"——整体移除表面投影

状态：已实施

## 问题

用户反馈：人眼能看到应用外面"有一层应用"，贴着悬浮导航条与内容面板外扩一圈的半透明灰色镶边（亮色网页背景下最明显，设置面板打开时整圈可见，胶囊条与面板之间的 8px 缝也被填灰）。随后用户明确裁定：悬浮条不需要用阴影假装"悬浮感"，表面投影整个不要。

## 涉及范围

- 代码/模块：`packages/ui/src/styles/tokens.css` 的 `--shadow-bar` 与 `--shadow-pop` 两个感知令牌（`--shadow-ctl` 不动：控件阴影画在不透明表面内部，无窗口裁剪问题）。
- UI 表面：悬浮导航条（`.floating-surface` / `.floating-bar`）、内容面板（`PanelShell.css`）、浮层（`FloatingLayerHost.css`、`ModePicker.css`、`ReplyConversationPopover.css`、`MessageActions` 的 `--ma-elevated`）共有跟随归零。无行为变化、无 IPC/协议/持久化变化。
- 相关 Note：[变色龙融底](../feature/2026-10-17-ambient-surface-only-and-light-palette.md)（变色龙早已把 `--shadow-base` 归零，本变更是把同一裁定推广到默认主题）、[悬浮表面视觉契约](../architecture/2026-10-11-floating-surface-visual-contract.md)（颜色/阴影只能来自令牌）、`apps/desktop/src/main/ambient.ts` 的 `SHADOW_PAD = 12` 注释（前提"阴影只渲染进窗口内约 8px"更成立）。

## 根因

1. 三类悬浮窗全部 `transparent: true` + `hasShadow: false`（`mainWindowController.ts:62-71`、`selectionWindow.ts`、`replyBarWindowController.ts`）——没有系统投影兜底，CSS 阴影无法越出窗口矩形。
2. `.overlay-root` 的窗口四周只有 4/8px 透明余量；旧令牌 `--shadow-bar: 0 8px 24px`、`--shadow-pop: 0 14px 34px`（黑 alpha ≈ 0.20）的模糊半径与偏移远超余量，**越界部分直接被窗口裁掉**，只留下紧贴表面的到窗口边为止的一条最高 alpha 灰环。150% DPI 下这条环按物理像素放大到约 12px，亮背景上读作"一层应用的影子"。
3. 叠加项：胶囊条阴影向下偏移 8px + 模糊 24px，正好把胶囊条与面板之间 8px 的整个缝隙填灰，视觉上连成"一片"。
4. 自检对照：变色龙 Note 已裁定"投影是最先暴露悬浮层矩形的东西，近距离可读性完全不依赖它"（`tokens.css:137-139` 旧注释同源）。本缺陷是同一病灶在默认主题下的近距离版本，说明大模糊投影在整个悬浮层设计里本来就不成立。

## 决定

- `--shadow-bar: none`、`--shadow-pop: none`：悬浮条、内容面板、浮层不再有投影。消费方声明（`box-shadow: var(--shadow-*)`）不删——阴影只允许从令牌层进出（悬浮表面视觉契约），将来要任何形式的投影都在一处改。
- 变色龙链路零改动：`--shadow-base: 0` 归零与 `FALLBACK_TOKEN_KEYS` 回退对 `none` 值是无操作，`useAmbientTheme` / `theme` 测试语义不变。
- 表面辨形唯一负责者是 1px 结构描边（`--glass-line`）与不透明表面色差。
- `--shadow-ctl`（`0 1px 3px`）保留：开关拇指/滑杆/发送键等控件在不透明表面内部画接触影，不吃窗口裁剪，不属于本次裁定对象。

## 修复

仅 `tokens.css` 两个声明替换旧值，并同步调整【投影】注释块的理由（不再宣称"轻投影抬起来一格"）。

## 曾考虑的替代方案

- **收敛为 2px 贴边接触影：** 首轮提案，实机讨论中被用户明确否决（"不需要悬浮感，不需要打阴影"）。接触影在亮背景上仍有可见足迹，与裁定冲突。
- **把窗口透明余量加大到能容纳完整模糊（底部需 ≥ 31px）：** 舍弃。fit-content 窗口矩形会与可见内容严重脱节（遮挡判定、ambient 采样环、`SHADOW_PAD` 前提全被破坏），换来的悬浮感在裁剪边界上依然是灰环。
- **逐组件删 box-shadow 声明：** 舍弃。六个消费方引用同一令牌，逐处删除会把"无投影"散布成六份局部事实；令牌层 `none` 让"阴影从令牌进出"的契约继续成立。

## 后果与防回退

- 约束一：悬浮条/面板/浮层不得自带 box-shadow（无投影是常态默认值）；将来要恢复任何投影必须先过本 Note 与用户确认，且 blur/offset 必须满足窗口余量裁剪上限（fit-content 窗口四周只有 4/8px，大模糊必然裁成灰环）。
- 约束二：`themeCss.test.ts` 的令牌守卫新增断言——`--shadow-bar` / `--shadow-pop` 声明必须为 `none`，压住被"顺手感"加回。
- 约束三：`--shadow-ctl` 是控件级接触影的唯一例外；给不透明表面内部之外的任何元素加投影前，先回本 Note 对照窗口余量约束。

## 验证

自动化：`packages/ui/test/themeCss.test.ts` 新增断言 `--shadow-bar: none` 与 `--shadow-pop: none`；ui 包既有测试全绿（`theme.test.tsx` / `useAmbientTheme.test.tsx` 的 `--shadow-base` 归零语义不受影响）；biome 与 ui typecheck 通过。

实机验证（用户目测）：亮色网页背景下打开设置面板，胶囊条/面板四周无"一层"灰环，条-面板 8px 缝不再被填灰；深色背景无异常；拖动窗口无残影。若归零后仍有可见层，转查 DWM 合成路径（与本次改动无关）。
