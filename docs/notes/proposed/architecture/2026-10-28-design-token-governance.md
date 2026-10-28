# Note：UI 设计令牌治理与组件库映射边界

状态：提案

## 问题

`packages/ui` 已经有一套比普通项目更完整的设计令牌体系：`tokens.css` 定义原始参数与感知令牌，`theme.ts` / `useAmbientTheme.ts` 负责深浅主题、变色龙和用户颜色分组，`--fade` 由外观控制器单点写入。当前问题不在令牌数量，而在令牌之外的例外没有被约束：

- 组件层仍有硬编码颜色：`AnnouncementList.css` 的未读/重要角标、`SettingsPanel.css` 的错误文字，绕开了 `[data-theme]`、变色龙和 `--fade`。
- `components/panels/message-actions/MessageActions.module.css` 仍是一套独立的 `--ma-*` 硬编码色板，只是当前未被引用；一旦接入就会制造第二个调色板。
- `--paper` 同时承担“纸面背景”和“反色前景”两个语义，并且在 `tokens.css` 中乘了 `--fade`，与 `--glass` / `--panel` 的“表面不透明”约束冲突。
- 隐身模式的光标覆盖只作用于 `.overlay-root` / `.reply-window-root` 的后代；现有 `MessageActions` 已经把提示片 Portal 到 `document.body`，未来接入 Radix/shadcn 会扩大这个逃逸面。
- 如果直接引入 Tailwind/shadcn，默认主题、`bg-*/80`、`shadow-md`、`dark:`、Portal 和 CSS layer 都可能绕过现有的变色龙与隐身约束。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/styles/tokens.css`
  - `packages/ui/src/styles/base.css`
  - `packages/ui/src/theme.ts`
  - `packages/ui/src/hooks/useAmbientTheme.ts`
  - `packages/ui/src/app/useAppearanceController.ts`
  - `packages/ui/src/hooks/useMeetingStealth.ts`
  - `packages/ui/src/components/panels/AnnouncementList.css`
  - `packages/ui/src/components/panels/SettingsPanel.css`
  - `packages/ui/src/components/controls/Switch.css`
  - `packages/ui/src/components/controls/RangeSlider.css`
  - `packages/ui/src/components/chat/MessageActions.module.css`
  - `packages/ui/src/components/panels/message-actions/`
  - `packages/ui/test/themeCss.test.ts`
- UI/进程/协议/持久化表面：`@answra/ui` 内所有渲染表面；不改变 Electron 主进程、IPC、窗口捕获保护、IME 协议和持久化键。
- 相关 Note：
  - [悬浮表面视觉契约](../../implemented/architecture/2026-10-11-floating-surface-visual-contract.md)
  - [对话区纳入统一设计令牌](../../implemented/architecture/2026-10-19-chat-parts-token-unification.md)
  - [变色龙只接管表面固有色与浅色调色板](../../implemented/feature/2026-10-17-ambient-surface-only-and-light-palette.md)
  - [隐身模式光标覆盖被同特异性规则压过](../../implemented/bug-fix/2026-10-16-stealth-cursor-override-specificity.md)
  - [字号令牌补齐并清零组件 CSS 里的 px 字面量](../../implemented/bug-fix/2026-10-20-font-size-token-hardcode.md)
  - [综合隐身模式提案](2026-10-13-comprehensive-stealth-mode.md)

## 提案

### 1. 固定三层令牌契约

保留现有 CSS 变量 + CSS Modules，不重做主题系统，明确三层职责：

| 层级 | 示例 | 允许写入方 | 允许读取方 |
| --- | --- | --- | --- |
| 原始参数 | `--ink-tint`、`--glass-tint`、`--line-base`、`--shadow-base` | `tokens.css`、`theme.ts`、`useAmbientTheme.ts` | 仅 `tokens.css` 的感知令牌公式 |
| 感知令牌 | `--ink`、`--glass`、`--panel`、`--edge-line`、`--hover`、`--shadow-pop` | `tokens.css` | 所有组件 CSS |
| 组件别名 | `--ma-*`、`--chat-card-*` | 组件自身 | 该组件及其子部件 |

硬约束：

- 组件 CSS 不得直接引用 `--*-tint` / `--*-base`，也不得出现 `#hex`、`rgb()`、`hsl()`。
- 表面令牌 `--glass`、`--panel`、`--paper` 使用 `*-base` 且基数为 `1`，不乘 `--fade`；透明度只作用于文字、图标、描边、控件和投影。
- `useAppTheme` 仍是 `data-theme` 与主题变量的唯一写入方；`--fade` 仍只由外观控制器写入。
- 变色龙只允许写表面 tint 与结构轮廓/投影归零，不得写任何前景令牌。

### 2. 解决 `--paper` 的双重语义

把“纸面背景”和“反色前景”拆开：

```css
--paper-base: 1;
--paper: rgb(var(--paper-tint) / var(--paper-base));
--on-ink: rgb(var(--paper-tint) / var(--fade));
```

- `--paper` 只作为表面：popover、消息操作弹层等背景继续使用它，保持不透明。
- `--on-ink` 作为反色前景：消息操作提示片文字、开关开启态拇指、滑杆拇指描边等改用它，继续受 `--fade` 影响。
- 这是有意的行为变化：透明度滑杆不再让纸面表面变透明，只淡化前景。需要手工确认开关、滑杆和提示片在 `--fade: 0.5` 下仍可读。

### 3. 补齐状态色，清掉现有硬编码

- 新增 `--warning` / `--warning-wash` 及其原始参数，在浅色和深色主题各定义一次；变色龙不覆盖状态色。
- `AnnouncementList.css` 的未读角标优先复用现有 `--danger` / `--danger-wash`；重要角标使用 `--warning` / `--warning-wash`。
- `SettingsPanel.css` 的错误文字改用 `--danger`。
- 若现有 `--danger` 在浅色或深色下对比不足，再补 `--danger-strong`，不在组件里写死色值。
- 不新增没有实际使用方的 `success` 等令牌，避免令牌表膨胀。

### 4. 组件别名与未接入实现

- `--ma-*` 只允许作为 `.root` 内的感知令牌别名存在，例如 `--ma-pop: var(--paper)`，不得重新定义颜色值。
- `components/panels/message-actions/` 当前未被引用，且带有表情选择器等额外能力。按既有决定不删除，但继续隔离：
  - 不得被其他组件直接引用；
  - 接入前必须先把 `--ma-*` 硬编码色板收编为感知令牌别名；
  - 接入时同步补 `themeCss.test.ts` 守卫。
- 新增共享组件时优先复用 `SurfaceButton`、`PanelShell`、`floating-surface`、`input-surface`，不重新发明按钮、表面和输入框基础样式。

### 5. 把隐身作用域提升到文档根

- 在隐身状态变化时，把 `data-stealth` 同步到 `<html>`；现有根节点上的 `data-stealth` 保留一个过渡周期以兼容测试和旧选择器。
- `base.css` 的隐身光标覆盖改为同时匹配 `html[data-stealth="true"] *`，保留 `cursor: default !important`。
- 这样 Portal 到 `document.body` 的提示片、Radix Popover/Dialog、未来任何浮层都不会逃逸隐身光标约束。
- 该规则只影响光标形状，不改变 `window.setContentProtection`、窗口非激活策略、IME 隔离或输入守卫。

### 6. 固定未来 Tailwind/Radix 接入边界

本提案不实施 Tailwind/Radix 迁移，只固定接入条件；真正引入时另开 Note。

- **不引入 shadcn 主题。** 不创建第二套 `--background` / `--foreground` / `--border` / `--primary` 色板；如确需兼容，必须映射到现有感知令牌。
- **Tailwind 只做布局。** 颜色、阴影、表面仍由现有组件 CSS 和令牌控制。
- 如果引入 Tailwind，必须：
  - 使用 `@theme inline` 把 `--color-*` 指向 `var(--ink)`、`var(--panel)`、`var(--edge-line)` 等感知令牌；
  - 配置 `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))`，不依赖默认 `prefers-color-scheme`；
  - 禁止对表面令牌使用 `/xx` 透明度修饰符，例如 `bg-panel/80`；
  - 禁止 `shadow-md` 等固定阴影，改用 `shadow-[var(--shadow-pop)]`；
  - Radix Portal 挂到 `.overlay-root` 内，或依赖 `html[data-stealth]` 覆盖；
  - 现有 CSS 放入 `@layer components`，确保 `@layer utilities` 按预期覆盖布局，不出现未分层样式压过工具类。
- **Radix 只做行为。** Dialog、Popover、Tooltip 等只复用可访问性与交互逻辑，外观必须由 token 化的包装组件提供；不使用 shadcn 默认的 `bg-black/80` 遮罩、`backdrop-blur` 大面板和默认阴影。

### 7. 把约束变成测试与静态检查

- 扩展 `packages/ui/test/themeCss.test.ts`，断言 `--glass`、`--panel`、`--paper` 使用 `*-base`，`--paper` 不含 `--fade`，`--on-ink` 仍由 `--fade` 合成，以及 `html[data-stealth="true"] *` 带 `cursor: default !important`。
- 新增 `pnpm tokens:check`：扫描 `packages/ui/src` 的 CSS 与 TSX，除 `tokens.css` 外禁止 `#hex`、`rgb()`、`hsl()`、`var(--*-tint)` / `var(--*-base)` 和表面令牌 `/xx` 二次 alpha；误报通过显式白名单和 Note 处理。
- 保留现有 chat、reply bar、面板字号守卫；不把对话内容字号强行并入界面标签字号体系。
- `tokens:check` 先独立运行，稳定后再并入 `pnpm verify`。

## 当前实施进度

第一批已实施：`--paper` 拆为不透明表面 + `--on-ink` 反色前景；新增 `--warning` / `--success` 状态色并清掉公告与设置页硬编码；隐身标记同步到 `<html>`；新增 `pnpm tokens:check`，当前不并入 `pnpm verify`。详见[第一批令牌契约收口](../../implemented/architecture/2026-10-28-ui-token-contract-first-pass.md)。

未实施：

- `components/panels/message-actions/` 未删除，仍按既有决定隔离；`tokens:check` 对该文件显式白名单。删除或合并需先确认表情选择器等能力去向，并同步更新既有 Note。
- Tailwind/shadcn 接入边界仍停留在提案。
- `tokens:check` 尚未并入 `pnpm verify`。

## 模块边界

- `tokens.css`：只定义原始参数、感知令牌和对话内容原语；不写组件选择器。
- `theme.ts` / `useAmbientTheme.ts`：只写原始参数；`deriveAmbientTokens` 的返回键继续限制为表面 tint 与轮廓/投影归零。
- `useAppearanceController.ts`：只负责 `--fade` 和外观偏好，不写其他主题令牌。
- `base.css`：只负责 reset、焦点可见性、外壳布局和隐身光标作用域。
- 组件 CSS：只消费感知令牌或组件别名；不定义全局主题，不写颜色字面量。
- `themeCss.test.ts`：把上述契约变成可失败的门禁；新增例外必须同时更新测试和 Note。
- 未来 `tailwind.css`（若引入）：只做令牌映射和 layer 声明，不成为第二套主题来源。
- `components/panels/message-actions/`：继续隔离；接入时先收编色板，不直接删除。

## 曾考虑的替代方案

- **继续保持现状，只靠人工评审：** 舍弃。硬编码颜色和 Portal 逃逸已经实际出现，且 `themeCss.test.ts` 只覆盖部分目录，无法防止下一次新增组件重新分叉。
- **直接采用 shadcn 默认主题和组件样式：** 舍弃。shadcn 的语义色板、`bg-*/80`、`shadow-md`、默认 Dialog 遮罩和 Portal 会同时破坏变色龙的表面融底、`--fade` 的恒定对比和隐身光标作用域。若未来使用 Radix，只取行为，不取主题。
- **现在全面迁移到 Tailwind + shadcn：** 暂缓。迁移会引入 CSS layer、Portal、opacity 修饰符和组件默认样式四类风险，收益主要是开发速度，不是当前最紧迫的视觉一致性；先用本提案把契约和门禁做稳。
- **删除未接入的 `panels/message-actions/`：** 舍弃。既有 Note 已确认它带有表情选择器等额外能力，删除风险高于收益；改为隔离并在接入时收编。
- **用根节点整体 `opacity` 实现隐身/透明度：** 舍弃。会同时淡化文字与表面，破坏相对对比，也无法满足变色龙“表面不透明、背景零参与混色”的硬约束。
- **把所有表面改成半透明加模糊以贴近桌面：** 舍弃。会推翻已验证的“拖动/滚动不改变应用颜色”约束，并让远距离矩形轮廓更明显，和变色龙的目标相反。

## 验收标准

- 可观察结果：
  - `packages/ui/src` 下除 `tokens.css` 外没有颜色字面量；新增组件只能消费感知令牌。
  - 透明度滑杆只改变前景，不改变 `--glass` / `--panel` / `--paper` 的表面不透明度。
  - 隐身开启时，Portal 到 `document.body` 的提示片和未来 Radix 浮层仍保持默认箭头光标。
  - 未读/重要角标和设置错误文字在浅色、深色、变色龙下都与面板同一套语义色。
- 自动化验证：
  - `pnpm --filter @answra/ui test -- --run test/themeCss.test.ts`
  - `pnpm --filter @answra/ui test`
  - `pnpm verify`
  - `pnpm notes:check`
- 需要手工验证：
  - 浅色/深色 × 变色龙开/关 × 透明度 `1`/`0.7`/`0.5`，检查悬浮栏、面板、回复条、消息操作提示片、开关、滑杆、公告角标。
  - 隐身开/关，检查 Portal 提示片、输入框、按钮的指针形状；确认关闭隐身后光标恢复。
  - Windows 与 macOS 各一次；OS 捕获保护不属于本提案的验证范围。

## 风险

- `--paper` 从“会淡化的表面”改为“稳定不透明表面”会改变低透明度下的观感；如果用户实际更希望纸面随透明度淡化，需要重新定义 `--paper` 的产品语义，而不是在组件里补 `opacity`。
- 全量禁止颜色字面量可能误伤合法的供应商样式或动态画布；白名单必须逐项记录理由，不能静默放宽。
- `html[data-stealth]` 会让整个文档的光标受约束；如果未来同一文档承载非 Answra 内容，需要重新评估作用域。
- 新增 `--warning` 的深浅取值需要实际对比度检查；不能直接复用浅色值到深色主题。
- Tailwind/Radix 接入仍可能在 layer、Portal 和默认组件样式上产生新问题；本提案只固定边界，不承诺“接入即兼容”。
- 本提案只处理 renderer 的 CSS/令牌契约，不改变 Electron 捕获保护、非激活窗口、IME 或持久化行为。
