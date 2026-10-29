# Note：对话区纳入统一设计令牌

状态：已实施

## 问题

外壳（悬浮导航、面板、设置、回复条）早就只消费 `packages/ui/src/styles/tokens.css` 的感知令牌，深浅色、变色龙、颜色分组和透明度滑杆由 `:root` 上的 `data-theme` 与 `--fade` 单点驱动。但对话内容部件是例外：

- `ThinkingReasoning.module.css` 自带 `--tre-*`（写死 `#a1a1a1` 系列）；
- `TextResponse.module.css` 自带 `--tr-*`，并在组件内复制了一整套「浅色 / `[data-theme=dark]` / `prefers-color-scheme`」三分支迷你主题；
- `MessageActions.module.css` 自带 `--ma-*` 与另一套明暗分支；
- `ToolResponse.module.css` 的错误色写死 `#c0392b`。

结果：对话区被冻结在浅色取值上，不随变色龙/深色/透明度变化；同一句话在外壳里和在对话里的墨色不一致。更实际的后果是——每次往对话流里加新部件（模型报错、工具调用卡片），都要再发明一套私有色板，视觉语言越叠越多。上一次尝试用「新卡片语言」重做思考/正文输出反而更乱，根因就在此。

## 涉及范围

- 代码/模块：`packages/ui/src/components/chat/{ThinkingReasoning,TextResponse,MessageActions,ToolResponse,MessageStream}.module.css`、`MessageActions.tsx`、`packages/ui/src/styles/tokens.css`、`packages/ui/test/themeCss.test.ts`。
- UI 表面：对话面板与回复条浮层里的思考块、Markdown 正文、工具调用卡、消息操作条及其悬停提示片。
- 相关 Note：[悬浮表面视觉契约](2026-10-11-floating-surface-visual-contract.md)（同一思路，作用范围是悬浮条）。

## 决定

对话区不再拥有自己的调色板，改为与外壳共用同一套令牌：

- 在 `tokens.css` 增补对话内容原语：`--chat-card-bg`（= `--field`）、`--chat-card-line`（= `--glass-line-soft`）、`--chat-card-radius`、`--chat-card-pad`，以及 `--chat-meta`（`color-mix(in srgb, var(--ink) 72%, transparent)`，给思考这类次要文字降一档存在感）。原语是感知令牌的显式派生，因此自动带上主题、变色龙与 `--fade`。
- 四个部件改为消费令牌：思考/正文墨色走 `--ink`/`--muted`/`--chat-meta`，正文代码块与表格走 `--glass-line-soft`/`--field`，工具卡走 `--chat-card-*` 且错误色改 `--danger`，操作条把 `--ma-*` 重定义为令牌别名（`--ink`/`--icon`/`--hover`/`--field-strong`/`--paper`/`--glass-line`/`--shadow-pop`/`--mint-text`/`--danger`）。
- 删除对话区内的全部 `[data-theme]` / `prefers-color-scheme` 分支和 `--tre-*`/`--tr-*` 私有色板；操作条悬停提示片改为 `color-mix(in srgb, var(--ink) 62%, transparent)` + `--paper`，由令牌自动反色，顺带删除 `tipTheme` 状态与气泡上的 `data-theme`。
- `MessageStream.module.css` 清掉失效的浅色兜底色（`#c9c9cf`/`#8a8a90`）。
- `themeCss.test.ts` 增加闸门：`components/chat/*.module.css` 不得出现 `#hex` 或字面 `rgb()/hsl()`。

## 模块边界

- `tokens.css` 是对话内容表面与状态色的唯一定义处；`chat/` 组件只消费令牌，不定义颜色。
- 主题的唯一写入点仍是 `documentElement` 上的 `data-theme`（`useAppTheme`）；组件内不得再出现 `[data-theme]` 或 `prefers-color-scheme` 分支。
- `packages/ui/src/components/panels/message-actions/` 是一份更完整但当前未被任何地方引用的操作条变体（含表情选择器），仍自带一套 `--ma-*` 色板；本 Note 不删它，但它接入时必须一并收编。

## 曾考虑的替代方案

- **保留各部件自己的迷你主题，只把色值调一致：** 舍弃。两处维护深浅方案，变色龙与 `--fade` 仍然作用不到，且下次加部件还会分叉。
- **给对话区再抽一套独立 design system：** 舍弃。等于在外壳之上再叠第三套语言，正是问题本身。
- **用 CSS Modules `composes` 复用 `shared.css` 里的共享类：** 舍弃。目标是全局 CSS 而非 module，`composes … from` 不适用；改为把表面契约下沉为 `tokens.css` 的原语令牌，组件消费令牌，效果等价且无打包耦合。
- **直接删除未接入的 `panels/message-actions/` 重复实现：** 舍弃。它带有表情选择器等额外能力，更像在研变体，删除风险高于收益。
- **在组件内继续给提示片挂 `data-theme` 做反色：** 舍弃。反色片用 `--ink` 底 + `--paper` 字即可自动反转，少一处状态与一处 DOM 属性。

## 后果与防回退

- 对话区新增部件（模型报错、工具调用等）必须消费 `--chat-card-*` / `--chat-meta` 及既有感知令牌；不得自带调色板或写死色值。
- 不得在任意组件 CSS 里重新引入 `[data-theme]` / `prefers-color-scheme` 分支或 `--tre-*`/`--tr-*`/`--ma-*` 私有色板（`--ma-*` 仅允许作为 `.root` 内的令牌别名存在）。
- 观感变化是刻意的：正文与思考改用外壳墨色（石板灰）而非原近黑/浅灰；深色主题、变色龙、透明度滑杆现在会作用到对话区。
- `web` 与 `reply` 窗口共用 `tokens.css`，本改动不新增运行时代码，无需给独立窗口补主题来源。
- `panels/message-actions/` 接入时必须一并收编其 `--ma-*` 色板，否则会重新制造孤岛。

## 验证

- 自动化：`pnpm verify` 通过（lint + `notes:hint` + typecheck + ui 238 / desktop 249 / agent 20 + 架构守护）；新增的 chat 闸门用例在 `themeCss.test.ts` 通过。
- 构建：`pnpm --filter @answra/desktop exec vite build` 通过，产物 CSS 正常生成，确认 `color-mix` 与令牌编译无问题。
- 需要用户实机验证：浅色、深色、变色龙、颜色分组、透明度各状态下，思考块、正文、工具卡与操作条与面板保持同一墨色与表面语言。
