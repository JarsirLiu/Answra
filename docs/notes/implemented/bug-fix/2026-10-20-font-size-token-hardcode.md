# Note：字号令牌补齐 --font-md 并清零组件 CSS 里的 px 字面量

状态：已实施

## 问题

用户反馈设置面板「好像没按主题规范做字体，图中这些字体变大了」。核查事实：设置面板文案在代码里用的都是字号令牌（`--font-xs` 10px / `--font-sm` 11px），渲染层也没有任何 zoom/scale/dpi 逻辑；用仓库内 Electron 29 实测，Chromium 严格按 CSS 输出 10/11/12px。用户机器显示缩放为 150%（`AppliedDPI=144`），10/11/12px 被等比放大成 15/16.5/18 物理像素——三档只差 1~2px 的层级在 150% 下几乎不可分辨，观感就是「一团偏大、没有层级的字」。审查字号令牌体系时进一步确认：`tokens.css` 只定义了三档字号，而面板标题（`.panel-title`，`PanelShell.css`）与设置分组名（`.settings-panel h2`，`SettingsPanel.css`）是两处硬编码 `12px` 字面量，公告「未读/重要」角标还有一处 `font-size: 10px` 字面量——这正是「没按主题规范做字体」成立的部分：字号一旦不走令牌，后续既无法统一调整，也说不清层级从哪来。

## 涉及范围

- 代码/模块：`packages/ui/src/styles/tokens.css`（新增 `--font-md: 12px` 并写明四档层级语义）、`packages/ui/src/components/panels/PanelShell.css`、`SettingsPanel.css`、`AnnouncementList.css`（字面量改引令牌）、`packages/ui/test/themeCss.test.ts`（新增字号守卫）。
- UI/进程/协议/持久化表面：纯视觉与令牌体系；渲染像素与改动前一致（12px→12px、10px→10px），不变的是机制。
- 相关 Note：[对话内容部件令牌统一](../architecture/2026-10-19-chat-parts-token-unification.md)（聊天正文有自己的内容字号尺度、不受界面标签令牌约束的先例）、[模式菜单浮层与统一标签字重](../feature/2026-10-17-mode-menu-overlay-and-label-weight.md)（界面标签统一 `--label-weight` 的来源）、[受保护的桌面公告中心](../feature/2026-10-17-desktop-announcement-center.md)（公告角标样式的出处）。

## 根因

- 字号令牌体系当初只设了三档（sm/xs/2xs），面板标题与设置分组名的 12px 没有对应令牌，两处实现直接写了字面量；lightningcss 不会拦截 `font-size` 字面量，主题 CSS 守卫也只查颜色不查字号，于是硬编码静默存活。
- 观感「变大」的共因是 150% 显示缩放 + 档位间差距太小（10/11/12px），不属于渲染层被放大或令牌失效——用 Electron 实测排除了 Chromium 最小字号钳制的假设。

## 决定

- 字号体系定为四档并全部令牌化：`--font-md` 12px（面板标题、设置分组名）、`--font-sm` 11px（正文标签）、`--font-xs` 10px（次要说明）、`--font-2xs` 9.5px（角标）。
- 组件 CSS 的 `font-size` 只允许引用这四档；面板骨架（`PanelShell.css`/`SettingsPanel.css`/`AnnouncementList.css`）由 themeCss 守卫测试禁止 px 字面量。
- 「字大」的观感问题不通过局部改字号解决：属 150% 显示缩放的等比结果，统一调整只走令牌值。

## 修复

- `tokens.css` 新增 `--font-md: 12px`，注释写明四档语义：md=面板标题与设置分组名、sm=正文标签、xs=次要说明、2xs=角标；字号只允许走令牌。
- `.panel-title`、`.settings-panel h2` 改引 `var(--font-md)`；公告角标 `10px` 改引 `var(--font-xs)`。
- 防回退守卫进入 `themeCss.test.ts`：`PanelShell.css`/`SettingsPanel.css`/`AnnouncementList.css`（面板骨架）禁止 `font-size: <数字>px` 字面量；对话内容文件保留自己的内容字号尺度，不入守卫名单。

## 曾考虑的替代方案

- **把面板标题压到 `--font-sm`（11px）凑齐现有三档：** 标题与正文标签同字号同字重，层级彻底消失；150% 缩放下观感更糊。为此补第四档令牌，代价是令牌表多一行。
- **给标题加字重（600/bold）拉开层级：** 与「界面标签统一 500 字重」的既有决定冲突（小字号加粗会发糊），该决定在模式菜单 Note 里有明确理由，不回退。
- **全局守卫：所有面板 CSS 禁止 px 字面量：** 工作区面板、输入区、消息操作条等大量内容型文字合理使用自己的尺度，一刀切会产生海量误报；守卫收窄到本次修复的面板骨架文件。

## 后果与防回退

- 面板骨架字号只允许引用 `--font-md/--font-sm/--font-xs/--font-2xs` 四档；若未来觉得字号层级不够用，调整点是令牌值，不是组件里的字面量。
- `themeCss.test.ts` 的 px 字面量守卫失败即说明骨架又写了死字号，直接回退修复。
- 用户端「字大」的感受源于 150% 显示缩放与档位差距，修复保持渲染像素不变；后续若要整体调整观感，属产品决定，应通过令牌值统一调整，而不是局部改动。

## 验证

- 仓库内 Electron 29 实测脚本：computedStyle 输出 10px/11px/12px 精确值（`scaleFactor: 1.5` 显示下 CSS px 不受钳制）。
- `packages/ui` `themeCss.test.ts` 7 项通过（含新增字号守卫）；`pnpm verify` 全绿（biome、typecheck、ui 247 项 / desktop 276 项测试、架构守护）。
- 事实核查记录：显示缩放取自 `HKCU\Control Panel\Desktop\WindowMetrics\AppliedDPI = 144`（150%）。
