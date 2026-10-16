# Note：深色主题下 AI 正文与候选词不可见

状态：已实施

## 问题

用户实机反馈：开启「跟随背景色」（变色龙）且背景为深色时，对话面板里 AI 回复的正文、以及输入法候选词都看不见；浅色下正常。

## 涉及范围

- 代码/模块：`packages/ui/src/components/chat/TextResponse.module.css`、`packages/ui/src/styles/tokens.css`、`packages/ui/src/components/panels/ImeCandidatePopup.css`、`packages/ui/src/app/ImeCandidateWindowApp.tsx`、`packages/ui/src/theme.ts`、`apps/desktop/src/main/ambient.ts`、`apps/desktop/src/main/window.ts`、`apps/desktop/src/main/ime/imeCandidateWindowController.ts`。
- UI/进程/协议/持久化表面：renderer 组件 CSS、候选窗独立窗口的令牌与深浅方案来源、主进程变色龙采样推送目标；不改 IPC 频道与 Rime 行为。
- 相关 Note：[悬浮表面视觉契约](../architecture/2026-10-11-floating-surface-visual-contract.md)、[内置 Rime 输入法](../architecture/2026-10-14-embedded-rime-ime.md)、[独立候选原生窗口](../../implemented/feature/2026-10-14-ime-candidate-native-window.md)、[IME 权威会话与文本路由提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)。

## 根因

两个独立缺陷都以「声明静默失效」的形式出现，都不报错，只是回落到浅色主题值：

1. **AI 正文**：`TextResponse.module.css` 用双冒号 `::global(...)` 声明 `--tr-*`。lightningcss（Vite 的 CSS modules 处理器）把 `::global` 当成未知伪元素，只给出 "not recognized as a valid pseudo-element" 警告，并把整条规则原样输出：

   ```css
   ::global(:root){--tr-fg:#1a1a1a;…}
   ::global([data-theme="dark"]){--tr-fg:#f5f5f5;…}
   ```

   浏览器丢弃这两条无效规则，`--tr-fg` 从未定义，`.prose` 一直使用回退值 `#1a1a1a`。浅色主题下回退值恰好正确，`data-theme="dark"`（变色龙深色或系统深色）时就是深色面板上的深色正文。回复条浮层看不出来，是因为 `ReplyConversationPopover.css` 自己写了 `--tr-fg: var(--ink)`。

2. **候选词**：候选窗是独立 `BrowserWindow`，没有任何外观控制器，于是：
   - 没人往它的 `:root` 写 `--fade`，而 `tokens.css` 的感知令牌（`--ink`/`--panel`/`--glass-line`…）声明为 `--fade` 的显式函数 ⇒ 整层令牌无效，文字回落到 UA 默认色（浅色主题方案下是黑）；
   - `ImeCandidatePopup.css` 还在引用 `--surface`、`--line`、`--accent` 这三个早已不存在的令牌名（`tokens.css` 里是 `--panel`/`--glass-line`/`--mint`）⇒ 背景、描边、选中高亮的声明全部无效。

   两者叠加：候选条背景透明、无描边，只剩黑字浮在透明窗上。浅色桌面上看起来「只是没样式」，深色桌面（或变色龙采样到深色）即不可见。

同一类陈旧令牌引用还有 `ConversationComposer.css` 的 `--accent`、`SettingsPanel.css` 的 `--glass-fill`、`MessageStream.module.css` 的 `--glass-surface`/`--foreground`/`--glass-hover`/`--accent`（带浅色回退，深色下变成白色药丸或浅底），以及停止按钮写死的 `color: white`（`background: var(--ink)` 在深色主题里变浅，白字消失）。

## 决定

- CSS modules 里的主题变量只允许单冒号 `:global(...)`；组件 CSS 只允许引用 `tokens.css` 感知令牌（或运行时写入、已在测试白名单登记的令牌）。
- 令牌层必须自洽：`tokens.css` 给 `--fade` 一个样式表默认值，任何没有外观控制器的表面也能让整层令牌成立。
- 候选窗不自己发明主题状态：读同一份本地偏好（变色龙开关、颜色分组、透明度）并调用 `useAppTheme`，深浅方案与感知令牌由同一套推导产生。
- 候选窗的变色龙输入来自主进程已有的一次采样：`ambient` 采样把同一份 payload 广播给主窗口和候选窗，不新增 IPC 频道，也不在 renderer 之间搬运令牌。

## 修复

- `TextResponse.module.css`：`::global(...)` 全部改为 `:global(...)`，并注明双冒号会被 lightningcss 丢弃。
- `tokens.css`：`:root` 增补 `--fade: 1`（外观控制器仍按用户透明度内联覆盖）。
- `ImeCandidatePopup.css`：`--surface` → `--panel`、`--line` → `--glass-line`、`--accent` → `--mint`/`--mint-text`/`--mint-wash`/`--mint-wash-strong`、hover 底色 → `--hover`、阴影 → `--shadow-pop`。
- `ImeCandidateWindowApp`：用 `useAppTheme`（`ambientFollow`/`colorGroups` 从 localStorage 读一次）落 `data-theme` 与令牌，另把 `--fade` 写成同一份用户透明度。
- `theme.ts`：导出 `loadAmbientFollow`/`loadAppOpacity`/`saveAppOpacity`；`useAmbientFollow`、`useAppearanceController`、候选窗共用这几个读写点。
- 主进程：`createAmbientThemeController` 接受 `additionalTargets`，`sampleAndPush` 把 payload 发给主窗口 + 候选窗；`imeCandidateWindowController.getWindow()` 与 `window.getImeCandidateWindow()` 暴露存活候选窗。
- 顺带修复同类陈旧令牌：`ConversationComposer.css`（IME 按钮激活底）、`SettingsPanel.css`（输入框底色）、`MessageStream.module.css`（回到最新按钮）、停止按钮改用 `--ink`/`--panel` 反色对。
- 新增 `packages/ui/test/themeCss.test.ts`：扫描 `packages/ui/src/**/*.css`，断言（a）生效 CSS 里没有 `::global(`，（b）`var(--x)` 引用的令牌都在 CSS 里声明过、或由 TS 运行时写入、或在白名单内（`--cue-*`、`--slider-fill`、`--ime-input-text-color`）。

## 曾考虑的替代方案

- **候选窗按 `prefers-color-scheme` 取深浅，不接变色龙：** 舍弃。用户报告的场景正是变色龙；深色桌面上出现浅色候选条会变成新的不一致。
- **在 `TextResponse.module.css` 里给回退值做成深色安全的中间色：** 舍弃。两条规则失效的原因与回退值无关，改回退值只是遮盖症状。
- **让候选窗自己再写一套令牌推导：** 舍弃。会与主窗口形成第二套主题逻辑；`useAppTheme` 已经是唯一的写入入口。
- **按回复条的方式由主 renderer 投影最终变量给候选窗：** 本阶段舍弃（需要新频道 + 主进程保存 + renderer 每次主题变化都推送），改用主进程已有的采样 payload；残留差异记入提案未完成项。
- **把 `--fade` 也纳入采样广播：** 舍弃。透明度是 renderer 偏好而非采样结果，候选窗直接读同一份 localStorage 更直接。

## 后果与防回退

- 主题 CSS 的两条约束由 `themeCss.test.ts` 锁定：不要放宽成白名单扩大，遇到未声明令牌应改成 `tokens.css` 里的真实令牌。
- 新的独立窗口若要跟随主题，必须在 `:root` 上同时拿到 `data-theme` 与 `--fade`；只在子元素上写令牌不会让 `:root` 的感知令牌重算。
- 实底按钮的「反色文字」必须用 `--panel`（与 `--ink` 恒反色），不要写字面量白色或 `--ink-deep`。
- 候选窗仍有两处已知差异（挂载时读一次偏好、不走主 renderer 变量投影），属提案未完成项，不要当作回归。

## 验证

- 自动化：`pnpm --filter @answra/ui test` 25 文件 / 165 项通过（新增 3 项）；`pnpm --filter @answra/desktop test` 通过，`ambient.test.ts` 新增 1 项断言候选窗与主窗口收到同一次采样；`pnpm verify` 通过。
- 构建：`pnpm --filter @answra/desktop exec vite build` 不再出现 lightningcss 的 `'global' is not recognized as a valid pseudo-element` 警告，产物中 `--tr-fg` 已落在有效选择器上。
- 需要用户实机验证：变色龙 + 深色桌面下对话面板正文、候选词、停止按钮可见且与主窗口同色；浅色与系统深色不受影响。
