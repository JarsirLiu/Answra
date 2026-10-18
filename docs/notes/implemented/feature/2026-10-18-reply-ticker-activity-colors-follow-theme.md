# Note：回复条活动色与思考指示改走主题令牌

状态：已实施

## 问题

回复条（发送条的截图提交后进入的流式态）有两处和主题体系脱节：

1. 思考态在左侧指示图标和跑马灯文字上单独染成紫色（`#7652a3`），与条内其它中性图标（相机、收起、导航条图标）不是一套语言，同一根条上出现第二种强调色。
2. 活动色 `#7652a3`（思考）、`#176b68`（工具）、`#34618f`（回答）以及展开详情里的工具色 `#176b68` 全是写死色值，绕过 `[data-theme]` 与变色龙主题：主题切换或跟随背景时这些文字/图标不跟着变，容易出现浅色主题下配深底、深色主题下近黑的低对比。用户要求发送条与回复条都遵守主题（变色龙）管理。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/ReplyBar.css`、`packages/ui/src/components/panels/ReplyConversationPopover.css`、`packages/ui/src/components/panels/ReplyActivityTicker.tsx`、`packages/ui/test/themeCss.test.ts`。
- UI/进程/协议/持久化表面：发送条/回复条跑马灯与展开详情中活动项的文字/图标颜色、指示图标尺寸（仅 UI 表现层，不涉及 IPC、协议与持久化）。
- 相关 Note：[回复条发送键与缩略图删除键改回中性图标语言](2026-10-18-reply-bar-neutral-icon-actions.md)、[悬浮导航功能槽就地回复与 FeatureSlot 架构](../architecture/2026-10-18-in-place-reply-slot-and-feature-slot.md)、[变色龙只换表面固有色与浅色调色板](2026-10-17-ambient-surface-only-and-light-palette.md)。

## 决定

- 思考态不再换色：跑马灯文字只用斜体区分，左侧指示图标回到条内其它图标同一中性色（`--muted`）。
- 活动色全部改走调色板令牌：回答 `--ink`、工具 `--mint-text`、来源/状态 `--muted`、错误 `--danger`；详情面板的工具块同样收敛到 `--mint-line` / `--mint-text`。
- 指示图标从 16px 收到 `ICON`（14px），与条内图标键同尺寸。
- 新增守卫：`ReplyBar.css` 与 `ReplyConversationPopover.css` 里不允许出现十六进制 / `rgb()` / `hsl()` 硬编码色值。

## 影响表面

- 思考态：紫色指示图标 + 紫色文字 → 中性指示图标 + 中性斜体文字，区分靠字形（斜体）而不是颜色。
- 工具活动在深浅主题下取薄荷文字色（浅色 `#1f7a53`、深色 `#7ae6b8`），不再是固定青色；回答与状态文字取主题中性色。
- 详情面板里工具块与来源块都成薄荷系文字 + 薄荷描边，靠图标与标签区分。
- 跟随背景（变色龙）与用户选色现在能同时作用到这些颜色。

## 曾考虑的替代方案

- **思考保持独立色相（换成主题蓝）：** 调色板里没有第二种强调色，只能写死色值或借用薄荷；前者正是本次要清掉的硬编码，后者会与「工具/来源」撞色，故不采用。
- **思考态改用 `--muted` 弱化：** 流式期间思考常常是跑马灯里唯一在滚的内容，压到最弱会看不清；思考内容本身有价值，斜体 + 正文色更合适。
- **只改思考、保留工具与回答的写死色值：** 用户要求发送条与回复条统一遵守主题管理，留两处硬编码等于把同类缺陷留在原地，故一并收敛。
- **指示图标保持 16px：** 与条内 12px/14px 图标键并列时偏大、偏抢眼，且没有第二个 16px 图标与之呼应，故统一到 `ICON`。

## 后果与防回退

- 跑马灯/详情的活动色只允许引用调色板令牌；新增语义色先确认令牌里是否已有对应项，没有则先决定它属于哪个令牌组，不要写死色值。
- 思考态的区分手段是斜体，不要再给它单独颜色；确要换色必须先回到「令牌组」层面讨论。
- `themeCss.test.ts` 的硬编码色值守卫覆盖这两个文件；新增回复条样式文件时同步加入该列表。

## 验证

- `packages/ui/test/themeCss.test.ts` 新增用例「keeps the reply bar and its details panel on palette tokens, without hardcoded colors」；`FloatingBarApp.test.tsx` 既有用例继续断言思考项带 `reply-activity-item--thinking` 且思考指示不带 spinner。
- `pnpm verify` 通过（biome、notes:check、typecheck、agent 13、ui 233、desktop 219、架构守护）。
- 需要的实机验证（待办）：Windows 实机确认思考态只呈现中性图标 + 斜体文字，工具/回答/错误在浅色、深色、跟随背景三种主题下颜色都跟着主题变化。
