# Note：UI 令牌契约第一批收口

状态：已实施

## 问题

`packages/ui` 的 CSS 变量体系本身没有失效，问题出在令牌之外的例外：

- `--paper` 在 `tokens.css` 中乘了 `--fade`，但 `--glass` / `--panel` 不乘，和“表面不透明”的注释冲突；同一令牌又被提示片文字、开关拇指和滑杆描边当作反色前景使用。
- `AnnouncementList.css` 的未读/重要角标和 `SettingsPanel.css` 的错误文字是硬编码颜色，绕开 `[data-theme]`、变色龙和 `--fade`。
- 隐身光标只挂在 `.overlay-root` / `.reply-window-root` 后代；Portal 到 `document.body` 的提示片会逃逸约束。
- 后续若直接使用 Tailwind 的 `bg-panel/80` 或 shadcn 默认色板，会重新引入第二套表面/状态色来源。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/styles/tokens.css`
  - `packages/ui/src/styles/base.css`
  - `packages/ui/src/hooks/useAmbientTheme.ts`
  - `packages/ui/src/hooks/useStealthDocumentFlag.ts`
  - `packages/ui/src/app/FloatingBarApp.tsx`
  - `packages/ui/src/app/ReplyBarWindowApp.tsx`
  - `packages/ui/src/components/controls/Switch.css`
  - `packages/ui/src/components/controls/RangeSlider.css`
  - `packages/ui/src/components/chat/MessageActions.module.css`
  - `packages/ui/src/components/panels/AnnouncementList.css`
  - `packages/ui/src/components/panels/SettingsPanel.css`
  - `packages/ui/test/themeCss.test.ts`
  - `packages/ui/test/theme.test.tsx`
  - `packages/ui/test/FloatingBarApp.test.tsx`
  - `packages/ui/test/ReplyBarWindowApp.test.tsx`
  - `packages/ui/test/useStealthDocumentFlag.test.ts`
  - `scripts/design/check-tokens.mjs`
  - `package.json`
- UI 表面：悬浮栏、回复条、对话消息操作提示片、公告列表、设置页、开关与滑杆。
- 不涉及：Electron 捕获保护、非激活窗口、IME、IPC 和持久化。
- 相关 Note：
  - [对话区纳入统一设计令牌](2026-10-19-chat-parts-token-unification.md)
  - [隐身模式光标覆盖被同特异性规则压过](../bug-fix/2026-10-16-stealth-cursor-override-specificity.md)
  - [设计令牌治理提案](../../proposed/architecture/2026-10-28-design-token-governance.md)

## 决定

### 1. `--paper` 只做表面，新增 `--on-ink` 做反色前景

```css
--paper-base: 1;
--paper: rgb(var(--paper-tint) / var(--paper-base));
--on-ink: rgb(var(--paper-tint) / var(--fade));
```

- `--paper` 继续作为消息操作弹层等纸面背景，但不再随 `--fade` 变透明。
- 提示片文字、开关开启态拇指、滑杆拇指描边改用 `--on-ink`，继续受透明度控制。
- `--paper-base` 纳入 `FALLBACK_TOKEN_KEYS`，关闭变色龙时能清除可能的行内覆盖并回落到样式表默认。

### 2. 状态色进入语义层

- 浅色主题新增 `--warning-tint` / `--warning-wash-tint` / `--success-tint` / `--success-wash-tint`，深色主题各覆盖一次。
- 派生 `--warning`、`--warning-wash`、`--success`、`--success-wash`，状态文字继续乘 `--fade`。
- `AnnouncementList.css` 未读角标改用 `--danger` / `--danger-wash`，重要角标改用 `--warning` / `--warning-wash`。
- `SettingsPanel.css` 错误文字改用 `--danger`，保存成功改用 `--success`。
- 变色龙不写状态色；状态色也不进入用户颜色分组。

### 3. 隐身标记提升到 `<html>`

- 新增 `useStealthDocumentFlag(enabled)`，在悬浮栏和回复条根组件中把 `data-stealth` 同步到 `document.documentElement`，关闭或卸载时删除。
- `base.css` 的 `cursor: default !important` 同时匹配 `html[data-stealth="true"] *`，保留原有根节点选择器作为过渡兼容。
- 这样 Portal 到 `document.body` 的提示片、未来 Radix Popover/Dialog 都在隐身光标作用域内。
- 该属性只控制光标，不改变主进程的 `setContentProtection` 或窗口交互策略。

### 4. 新增 `pnpm tokens:check`

`scripts/design/check-tokens.mjs` 扫描 `packages/ui/src`：

- 除 `styles/tokens.css` 外，组件 CSS 禁止 `#hex`、`rgb()`、`hsl()`。
- 组件 CSS 禁止直接引用 `var(--*-tint)` / `var(--*-base)`。
- TS/TSX 禁止 `bg-panel/80` 这类表面令牌二次 alpha。
- `components/panels/message-actions/MessageActions.module.css` 当前显式白名单；它仍未被引用，接入前必须收编私有色板。
- 该脚本暂不并入 `pnpm verify`，先观察误报与遗漏。

### 5. 暂不删除未接入的消息操作变体

`components/panels/message-actions/` 仍保留。既有[对话区令牌 Note](2026-10-19-chat-parts-token-unification.md)确认它含表情选择器等额外能力，删除风险高于收益。本次只把它隔离在 `tokens:check` 白名单外，等接入时再合并。

## 模块边界

- `tokens.css`：原始参数、感知令牌和对话原语的唯一定义处；组件选择器不进入此文件。
- `useAmbientTheme.ts` / `theme.ts`：只写原始参数；不写状态色，不写感知令牌。
- `useStealthDocumentFlag.ts`：只同步 `<html data-stealth>`，不判断能力、不调用主进程。
- `base.css`：只负责 reset、外壳布局和隐身光标覆盖；不定义组件颜色。
- 组件 CSS：只消费感知令牌或组件别名；不定义全局主题和颜色字面量。
- `scripts/design/check-tokens.mjs`：只做静态扫描，不修改源码；白名单必须写明原因。
- `components/panels/message-actions/`：继续隔离；接入时必须先收编色板。

## 曾考虑的替代方案

- **删除未接入的 `panels/message-actions/`：** 舍弃。它包含表情选择器和更完整的操作条交互，既有 Note 已明确不删；直接删除会丢能力。
- **把 `--paper` 保持为 `--fade` 函数，再给每个表面补 `opacity: 1`：** 舍弃。会把表面不透明约束散落到组件，新增表面仍会漏。
- **用根节点整体 `opacity` 实现透明度：** 舍弃。会同时淡化文字和表面，破坏相对对比，也让变色龙的表面融底失效。
- **只把 `data-stealth` 继续挂在应用根节点：** 舍弃。Portal 到 body 的提示片无法被根节点选择器覆盖。
- **只扩展 `themeCss.test.ts`，不新增 `tokens:check`：** 舍弃。测试已经覆盖 chat/panel 的部分目录，但无法覆盖未来新增的全局 CSS 和 TSX 里的表面 alpha；独立脚本可以先观察全量误报。
- **允许 `--paper` 同时做表面和前景，由组件自行决定：** 舍弃。语义冲突会持续，低透明度下不同组件表现不一致。

## 后果与防回退

- 透明度滑杆不再改变 `--glass` / `--panel` / `--paper` 的表面不透明度，只淡化前景；这是有意的行为变化。
- 公告未读色从 `#a33a30` 变为 `--danger`，重要角标沿用原黄色语义；设置错误色和保存成功色随主题切换。
- 隐身开启时，Portal 到 body 的内容也会显示默认箭头；关闭或组件卸载后必须移除 `<html data-stealth>`。
- 新增状态色不得在组件里重复定义，也不得由变色龙覆盖。
- `tokens:check` 的白名单只允许当前未接入变体；新增白名单必须同时写 Note。
- 未来接入 Tailwind 时，不得使用 `bg-panel/80`、固定 `shadow-md` 或 shadcn 默认色板。

## 验证

- 自动化已通过：
  - `pnpm tokens:check`
  - `pnpm --filter @answra/ui test -- themeCss.test.ts theme.test.tsx FloatingBarApp.test.tsx ReplyBarWindowApp.test.tsx useStealthDocumentFlag.test.ts`
  - `pnpm typecheck`
  - `pnpm test`（shared / agent / ui / desktop 全部通过）
  - `pnpm architecture:check`
  - `pnpm notes:check`
- `pnpm verify` 未通过：`pnpm lint` 在未提交的 IME 改动里报错（`EmbeddedImeInput.tsx` 的 exhaustive-deps、`ConversationComposer.tsx` / `MarkdownEditorPane.tsx` 的格式），与本次令牌改动无关；本次未触碰这些文件。
- 需要用户实机验证：
  - 浅色/深色 × 变色龙开/关 × 透明度 `1`/`0.7`/`0.5`，检查提示片、开关、滑杆、公告角标、设置错误与成功文字。
  - 隐身开/关，检查 `document.body` 下 Portal 提示片的光标形状；关闭后恢复。
