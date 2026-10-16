# Note：Shift 切换英文后输入被锁死

状态：已实施

## 问题

用户在 Windows 上输入中文后按 Shift 切换到英文，继续输入时完全没有反应：文本框仍在屏幕上，点回去也打不了字，只有重新加载 renderer 才能恢复。故障期间 Rime 侧没有收到按键、主进程 lease 状态也正常，属于 renderer 侧的输入锁死。

## 涉及范围

- 代码/模块：`packages/ui/src/hooks/useStealthInputGuard.ts`、`packages/ui/src/ime/imeTextPolicy.ts`、`packages/ui/src/hooks/useEmbeddedIme.ts`、`packages/ui/test/useStealthInputGuard.test.ts`、`packages/ui/test/imeTextPolicy.test.ts`、`packages/ui/test/ConversationComposer.test.tsx`。
- UI/进程/协议/持久化表面：renderer DOM 焦点、系统 IME（Windows TSF/IMM32）与文本目标的绑定关系、`ImeTextPolicy` 契约；不改 IPC 协议、持久化、候选窗和 main 侧 `isolateNativeIme`。
- 相关 Note：[输入法输入路由与编辑权限分离](../../rejected/architecture/2026-10-16-ime-editor-editability-policy.md)、[内置 Rime 输入法桥接](../../implemented/architecture/2026-10-14-embedded-rime-ime.md)、[统一 IME 输入目标与窗口生命周期](../../implemented/architecture/2026-10-15-unified-ime-target-lifecycle.md)、[IME 输入目标 blur 与窗口失焦顺序](../../implemented/bug-fix/2026-10-16-ime-lease-blur-focus-handoff.md)、[Shift 中英文切换](../../implemented/feature/2026-10-15-ime-shift-language-toggle.md)。

## 根因

`ANSWRA_IME_DEBUG=1` 实机日志给出两条相互叠加的根因：

1. **ASCII 模式让文本框重新变成真实系统 IME 目标。** `resolveImeTextPolicy` 曾对 `inputMode === "ascii"` 返回 `useNativeTextInput: true, blockNativeEditing: false`，文本框因此没有 HTML `readOnly`。按下 Shift 后 Windows 输入法切到英文并在文本框上激活，后续按键以 `event.key === "Process"` 送到 renderer（诊断里表现为 `keyKind:"process"`），日志同时出现 `key unhandled Shift` 与紧随其后的 `renderer-input-blur`。
2. **隐身旁路 guard 无条件注册 fail-closed 监听。** `useStealthInputGuard` 的 `if (!enabled) return` 位于监听注册之后，`compositionstart`/`beforeinput` 即使隐身关闭也会生效：`onCompositionStart` 执行 `preventDefault + stopImmediatePropagation + target.blur()` 并写入 `data-native-ime-isolation-failed`，随后 `lockTextAfterCompositionFailure` 对该属性生效期间的每个 `keydown`/`focusin`/`pointerdown` 都 `preventDefault + blur()`。日志中所有后续 `renderer-document-keydown` 的 `activeElementTarget` 与 `focusedRef` 都是 `false`，只有一次按键进入 Rime，且全程没有 `release-called`/`lease-suspended`，说明故障完全在 renderer DOM 焦点层，且一旦触发就不可恢复。

载荷很轻：只要文本目标可原生编辑，Chromium 就会把它交给平台 IME；一旦平台 composition 出现，fail-closed guard 就把"路由不可写"升级成"整个输入不可用"。

## 决定

持有 Rime lease 的输入目标在任何输入模式下都不再由浏览器承担原生文本写入：`ImeTextPolicy` 只用 lease 所有权决定策略，ASCII 与中文的差异只保留在按键路由（`imeKeyRouter`）里。`useStealthInputGuard` 恢复为纯隐身开关，并且永不 blur 应用自己的 IME 输入目标。

## 修复

- `packages/ui/src/ime/imeTextPolicy.ts`：删除 `inputMode === "ascii"` 分支，`targetOwned` 为真时恒返回 `useNativeTextInput: false, blockNativeEditing: true, blockComposition: true`；`ImeTextPolicyInput` 随之不再需要 `inputMode`，`useEmbeddedIme` 调用点同步收窄。
- `packages/ui/src/hooks/useStealthInputGuard.ts`：`if (!enabled) return` 移到 effect 最前，隐身关闭时零副作用；`onCompositionStart` 与 `lockTextAfterCompositionFailure` 对 `[data-embedded-ime-target]` 只做 `preventDefault + stopImmediatePropagation`，不 blur、不写 `data-native-ime-isolation-failed`。
- 编辑器侧无需改动：`ConversationComposer`/`EmbeddedImeInput` 已经把 `blockNativeEditing` 映射为 `readOnly`，`onChange`/`onBeforeInput` 本来就在 `useNativeTextInput === false` 时拒绝原生写入，Rime commit 与 typed editor command 仍可写 draft。
- 测试：`useStealthInputGuard.test.ts` 新增"隐身关闭零副作用"与"embedded target 只取消 composition 不锁死"，删除旧的"隐身关闭仍锁死 composition"断言；`imeTextPolicy.test.ts` 合并为按所有权判定；`ConversationComposer.test.tsx` 的 ASCII 用例改为断言 `readOnly === true`、原生 `change` 不写 draft、composition 仍被取消。

## 曾考虑的替代方案

- **整体移除 `useStealthInputGuard` 的 composition fail-closed：** 舍弃。非 IME 文本目标上的意外系统 composition 仍会泄露 preedit 到不受捕获保护的系统候选窗；本次只把应用自己的 IME 目标排除出去，其余目标保持 fail-closed。
- **保留 ASCII 原生编辑，只做重聚焦或按键修补：** 舍弃。文本框只要可编辑，Chromium 就会把焦点元素交给 TSF；重聚焦只能掩盖症状，Shift 下一次仍会唤醒系统 IME。
- **用系统级键盘钩子吞键并注入字符（参考 natively-cluely 的 WH_KEYBOARD_LL / CGEventTap + `WS_EX_NOACTIVATE`）：** 舍弃。需要平台特化钩子、建窗时确定焦点策略，且会在输入法组字前吞键；复杂度远高于保留 `readOnly` + 现有 Rime 端到端路径。
- **改用 `chrome.input.ime` 做平台 IME（参考 fydeRhythm）：** 舍弃。该 API 仅 ChromeOS 可用，Electron 任何版本都不实现，也不支持 `input_components`，等于要自己写 Windows TSF/macOS InputMethodKit 文本服务。
- **不改 `readOnly`，改由同步 `beforeinput` 拦截原生写入：** 已单独否决，见[输入法输入路由与编辑权限分离](../../rejected/architecture/2026-10-16-ime-editor-editability-policy.md)。
- **同批接入 Ctrl+V 剪贴板插入：** 本次不做。`readOnly` 目标无法接收原生粘贴，但剪贴板读取需要额外授权与冲突处理，先保持中文模式的既有行为。

## 后果与防回退

- 持有 lease 的输入目标（含英文模式）恒为 `readOnly`/`aria-readonly`：会话期间浏览器原生粘贴、剪切、拖拽和撤销不可用；剪贴板粘贴在 owned 期间是不支持的，除非后续单独接入 Ctrl+V。
- `resolveImeTextPolicy` 不再接受 `inputMode`；任何"按输入模式放开原生编辑"的改动都会重新打开本次缺陷，必须先给出两个平台上可编辑目标 + 系统 composition 的替代隔离证据。
- `[data-embedded-ime-target]` 的防护前提是 `blockNativeEditing` 派生出的 `readOnly`，不是 guard 锁死；脱离 IME 的逃生口（lease 释放、关闭内置输入法、引擎不可用）下该目标可原生编辑，guard 不得因此 blur 它。
- 非 IME 文本目标继续 fail-closed：composition 仍会 `preventDefault + blur` 并写 `data-native-ime-isolation-failed`，该属性存在期间继续锁死其余文本目标。
- `data-native-ime-isolation-failed` 仍是 renderer 局部状态，main 侧隔离失败走 `isolateNativeIme` 的 `suspendCurrent("native-ime-isolation-failed-on-focus")`，两者不是同一信号。

## 验证

- 定向验证：`pnpm --filter @answra/ui test` 24 个文件 / 158 项通过。
- 全量验证：`pnpm verify` 通过，UI 158 项、desktop 132 项、app 7 项测试通过，Biome lint、Note 门禁、各包 typecheck 和 architecture check 均通过。
- 需要用户实机验证：Windows 上 `set ANSWRA_IME_DEBUG=1` 后 `pnpm dev`，执行"输入中文 → Shift 切英文 → 继续输入 → 再 Shift 回中文"，确认不再出现 `keyKind:"process"` 与紧跟 acquire 的 `renderer-input-blur`，英文模式能连续输入，候选窗在两种模式下都可用；macOS 与高 DPI 场景尚未验证。
- 自动化测试只覆盖 DOM 层（`readOnly`、composition 取消、隐身关闭零副作用），不能证明 Windows TSF 不再把该文本框当作系统文本目标。
