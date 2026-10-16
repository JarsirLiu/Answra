# Note：输入法输入路由与编辑权限分离

状态：已拒绝：在 Windows 上移除中文模式 `readOnly` 会让文本目标成为真实系统 IME 目标，触发全局隐身 composition guard 并锁死输入

## 问题

IME policy 曾以 `blockNativeEditing` 表示“当前文本由 Rime 处理”，控件再把该值映射为 HTML `readOnly`。输入路由因此同时改变编辑权限、原生控件语义和无障碍状态；业务 `disabled/readOnly`、Rime 路由和平台系统 IME 隔离无法独立判断。

本提案希望把两个维度拆开：删除由中文模式派生的 `readOnly`/`aria-readonly`，改由同步 `beforeinput` 边界拦截原生文本写入，让控件业务权限只由控件自身属性表达。

## 涉及范围

- 代码/模块：`packages/ui/src/ime/imeTextPolicy.ts`、`ConversationComposer`、`EmbeddedImeInput`、`RichTextComposer`、`ImeCandidateAnchorReporter`、`useStealthInputGuard`。
- UI/进程/协议/隐私表面：Rime owner 输入、ASCII 输入、业务编辑权限、隐身下的文本目标焦点、HTML 原生变更与系统 composition 保护。
- 相关 Note：[内置 Rime 输入法桥接](../../implemented/architecture/2026-10-14-embedded-rime-ime.md)、[统一 IME 输入目标与窗口生命周期](../../implemented/architecture/2026-10-15-unified-ime-target-lifecycle.md)、[IME 权威会话与文本路由](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)、[IME lease 与窗口焦点交接](../../implemented/bug-fix/2026-10-16-ime-lease-blur-focus-handoff.md)。

## 提案

- 删除由中文 IME policy 派生的 HTML `readOnly`/`aria-readonly`；`ImeTextPolicy` 只用 `useNativeTextInput` 表达原生文本路径是否有效，并在同步 `beforeinput` 边界阻止中文 Rime 路由的原生写入。
- 业务 `disabled`/显式 `readOnly` 由控件属性独立表达，不由输入模式、lease 或平台隔离状态推导。
- 保留未接入 IME 的隐身焦点限制、main 的 native IME isolation，以及意外系统 `compositionstart` 后的 fail-closed 保护；Rime commit 和 typed editor adapter 命令仍可写入 draft。

## 曾考虑的替代方案

- **保留中文模式下的 `readOnly`（最终采纳）：** 承认输入路由与编辑权限在当前架构下仍然耦合，但保住 Windows 上可用的连续中文输入。
- **同时移除 `useStealthInputGuard` 的 composition fail-closed：** 舍弃。这让系统 IME 在敏感控件上也可能提交，等于放弃隔离防线，且不是本次问题的必要条件。
- **在 guard 内识别并跳过可编辑 IME target 的 composition：** 当时舍弃。guard 无法区分“这是 Rime target 的正常原生 composition”与“平台隔离失败”，跳过只会把 fail-closed 边界继续放宽，且无法在未验证的平台上通用。后续在保留 `readOnly` 恒真（本 Note 的结论）的前提下，以收窄形式采用了这一方向：embedded target 只取消 composition，不 blur、不写失败标记，见 [Shift 切换英文后输入被锁死](../../implemented/bug-fix/2026-10-16-ime-shift-ascii-input-lockout.md)。
- **只在 renderer 侧重新聚焦并继续输入：** 舍弃。故障链是 guard 主动 `blur` 并写 `data-native-ime-isolation-failed`，重新聚焦只是掩盖症状，下一个按键会再次锁死。

## 否决理由

Windows 实机（`ANSWRA_IME_DEBUG=1`）日志给出完整证据链：

1. 移除 `readOnly` 后文本框成为真实系统文本目标；Windows 11 的 TSF 路径下 `ImmDisableIME` 不能阻止系统 IME 开始 composition。
2. 系统 composition 触发全局 `useStealthInputGuard.onCompositionStart`（隐身关闭时仍然注册），执行 `preventDefault + stopImmediatePropagation + target.blur()` 并写入 `data-native-ime-isolation-failed`。
3. 文本目标在 `renderer-acquire-result` 之后立刻出现 `renderer-input-blur`；此后所有 `renderer-document-keydown` 的 `activeElementTarget` 都是 `false`。
4. 只有一个按键进入 Rime（一条 `key` 日志，`handled: true`，候选 `N / 你 / 能 / 那 / 呢`），后续按键被 `lockTextAfterCompositionFailure` 一并 `preventDefault + blur`。
5. 整段日志没有 `release-called`，也没有 `lease-suspended`，main 侧 lease 始终正常 —— 故障完全在 renderer DOM 焦点层。

即：这次编辑权限改动在 Windows 上把“文本路由是否可写”的问题升级成了“输入完全不可用”。fail-closed guard 无法区分正常 Rime 路由的原生 composition 与平台隔离失败，因此在可编辑目标上必然走向锁死，这不是可以靠测试补齐的实现细节。

## 后果与防回退

- 中文模式继续保留 HTML `readOnly`/`aria-readonly`（由 `textPolicy.blockNativeEditing` 派生），`ImeCandidateAnchorReporter` 仍以 `anchor.readOnly` 判定是否显示虚拟光标。
- 输入路由与编辑权限在本架构下继续耦合；在 Windows 与 macOS 分别验证出可替代的系统 IME 隔离机制之前，不得再次移除此 `readOnly`。
- 禁止仅凭单元测试把该提案重新标记为已实施。重新提出必须先给出两个平台“可编辑目标 + 系统 composition”实机证据，并说明 guard 如何区分正常路由与隔离失败。
- 评审时不得把 `resolveImeTextPolicy` 返回的 `useNativeTextInput`/`blockNativeEditing` 视为可任选其一的冗余字段：`blockNativeEditing` 是当前 Windows 输入可用性的前提。

## 验证

- 回退后自动化验证：`pnpm --filter @answra/ui test` 24 个文件 / 158 项通过；`@answra/shared`、`@answra/desktop` typecheck 通过。
- 需要用户实机验证：Windows 上 `set ANSWRA_IME_DEBUG=1` 后 `pnpm dev`，确认中文模式可连续输入多字，且不再出现 `renderer-input-blur` 紧跟 `renderer-acquire-result`。
- 本 Note 不含平台隔离已验收的证据；移除 `readOnly` 从来不是系统 IME 隔离证明。

## 模块边界

- `imeTextPolicy.ts`：同时表达原生文本路由（`useNativeTextInput`）与 `blockNativeEditing`；两者不得被拆开单独删除。
- 编辑器组件与 adapter：继续把 `blockNativeEditing` 映射为 `readOnly`/`aria-readonly`，并执行 Rime commit 与 typed editor command。
- `useStealthInputGuard` 与 main native isolation：保持 fail-closed，负责平台/隐身输入边界，不因本次提案调整；guard 后续只在[Shift 切换英文后输入被锁死](../../implemented/bug-fix/2026-10-16-ime-shift-ascii-input-lockout.md)中收窄为不锁应用自己的 IME 目标，并不改变本 Note 的结论。
