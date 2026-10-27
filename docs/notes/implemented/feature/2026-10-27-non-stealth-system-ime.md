# Note：非隐身模式交还系统输入法

状态：已实施

## 问题

Answra 在 Windows 上把所有窗口的文字输入都固定在应用内 Rime：主浮窗和回复条始终以 `focusable: false` 创建或重设为不可激活，主进程同时用 `ImmDisableIME(0)` 禁用 Electron UI 线程的系统输入法。结果是用户关闭会议隐身、只想正常聊天或编辑笔记时，也无法使用微软拼音、搜狗等系统输入法，只能依赖内置 Rime。

在本次变更前，内置 Rime 的非激活键盘通道还依赖尚未发布的新版 `answra-rime-host`；开发版资源不声明 `keyboardCaptureAvailable` 时，非隐身模式同样没有可用的打字通道。对非隐身场景来说，这属于不必要的降级。

## 涉及范围

- 代码/模块：
  - `apps/desktop/src/main/windowSurfaceRegistry.ts`：主浮窗/回复条的可激活策略改为只在隐身时生效。
  - `apps/desktop/src/main/windowStealthController.ts`：IME 隔离改为可逆；移除线程级 `ImmDisableIME`。
  - `apps/desktop/src/main/window.ts`、`replyBarWindowController.ts`：按隐身状态应用/恢复窗口 IME 上下文。
  - `packages/ui/src/components/panels/ChatPanel.tsx`、`ReplyConversationPopover.tsx`、`workspace/MarkdownEditorPane.tsx`、`workspace/DirectoryTree.tsx`、`workspace/WorkspacePanel.tsx`、`components/controls/EmbeddedImeInput.tsx`：内置 Rime 只在隐身模式接管输入。
- UI/进程/协议/持久化表面：窗口可激活性、Windows IME 上下文、renderer 文本控件是否使用内置 Rime；不改 IPC 协议、候选窗契约、持久化或截图流程。

## 决定

- 会议隐身是“内置 Rime 接管文字输入”的唯一模式。隐身开启时，主浮窗和回复条继续使用非激活窗口、内置 Rime 会话、候选窗和输入保护。
- 隐身关闭时，主浮窗和回复条恢复普通可聚焦窗口；不再对窗口执行 IME 上下文 detach，并把此前 detach 过的窗口恢复默认 IME 上下文。文本控件不再挂载内置 Rime 会话，`keydown` 事件、`readOnly` 和 composition 拦截全部交还浏览器/系统输入法。
- renderer 的 `useEmbeddedIme` 仍以 `stealth` 作为 `enabled` 入参；`enabled=false` 时 hook 立即释放租约、拒绝 acquire/processKey，并让文本控件保持原生可编辑。`useStealthInputGuard` 原本就只在隐身时注册，因此非隐身不再有 composition 拦截。
- 不保留 `ImmDisableIME`：该 API 禁用当前线程的 IME 后无法重新启用，会与“关闭隐身后恢复系统输入法”直接冲突。隐身模式下的隔离改为 `ImmAssociateContext` + `ImmAssociateContextEx(..., IACE_CHILDREN)` detach，并用 `ImmAssociateContextEx(..., IACE_DEFAULT)` 恢复；非激活窗口本身不能成为系统 IME 的目标，renderer 的 composition guard 仍作为 fail-closed 兜底。
- 回复条以自身的 `ReplyBarState.stealth` 为准同步 IME 上下文，避免主进程和回复条各自维护第二份隐身状态。
- 主进程是隐身状态的唯一权威：renderer 的 IME lease 只在隐身开启时成立；acquire、resume 和焦点重新隔离前都校验隐身，关闭隐身后残留 lease 不得再次 detach 系统 IME。
- renderer 的持久化隐身设置异步到达。收到首个设置前，主浮窗和回复条保持非激活（沿用旧行为）；设置到达后再按值切换，避免持久化隐身会话在启动期短暂变成可聚焦窗口。

## 影响表面

- 非隐身：点击主浮窗或回复条会正常激活窗口；聊天、回复和笔记编辑器使用当前系统输入法，候选窗由系统提供。
- 隐身：行为保持原样，主浮窗/回复条不可激活，文字仍由内置 Rime 与自有候选窗处理。
- 隐身与非隐身之间切换：窗口可激活性、IME 上下文和 renderer 的 Rime 接管随状态切换；不再需要重启应用才能恢复系统输入法。

## 曾考虑的替代方案

- **继续让两种模式都使用内置 Rime：** 与“非隐身要能正常用系统输入法”的产品要求冲突；而且开发版 helper 缺少键盘捕获能力时，非隐身会完全无法输入。
- **保留 `ImmDisableIME`，只在隐身时调用：** 该 API 对线程是单向的；用户一旦开启过隐身，关闭后系统输入法无法在同一进程内恢复，只能重启，不能接受。
- **非隐身只恢复 `focusable`，不改 IME 隔离：** 窗口虽然能聚焦，但线程级 IME 已被禁用，系统输入法仍然不会出现，不能解决问题。
- **非隐身模式允许用户在内置 Rime 和系统输入法之间任选：** 需要新增设置项、第二套状态来源和候选窗切换规则，超出本次“先让非隐身能正常打字”的范围。

## 后果与防回退

- 隐身模式的系统 IME 隔离由线程级降为窗口级。不再禁用整个 UI 线程的 IME，因此不得把“隐身时系统候选窗绝不出现”写成已证明事实；必须以 Windows 实机候选窗和 composition 结果为准。
- `isolateNativeIme`/`restoreNativeIme` 必须成对使用：开启隐身 detach，关闭隐身恢复。不要在任何非隐身路径调用 `isolateNativeIme`。
- `windowSurfaceRegistry` 的 `stealthConfigured` 是启动期 fail-closed 的依据：首个隐身设置到达前不得把 stealth 表面改为可聚焦；不要用 `stealthEnabled` 的默认值替代它。
- `imeIpc` 必须在 acquire、resume 和焦点隔离前校验 `isStealthEnabled()`；删除该门禁会让关闭隐身后的迟到 lease 重新禁用系统输入法。
- 主浮窗和回复条的 `SURFACE_POLICIES` 使用 `nonActivating: "stealth"`；不要改回无条件 `always`，也不要在窗口控制器里重放 `setFocusable`。
- renderer 所有文本输入面都必须显式接收 `stealth` 并传给 `useEmbeddedIme` 的 `enabled`；新增输入面时漏传会把系统输入法重新挡掉。
- 隐身限制仍然 fail-closed：内置 Rime 不可用时保持输入阻断，不得回退系统 IME；非隐身不存在这个限制。

## 验证

- 自动化：`pnpm --filter @answra/desktop test` 46 个文件、305 项通过；`pnpm --filter @answra/ui test` 37 个文件、273 项通过。覆盖主浮窗/回复条只在隐身时不可激活、启动期设置未到达时保持非激活、隐身切换时窗口策略往返、关闭隐身后 acquire/焦点不再隔离、回复条 IME 同步、`EmbeddedImeInput` 在 `enabled=false` 时保持原生可编辑、ChatPanel 非隐身时不 acquire，以及隐身时仍走 Rime 提交。
- 待 Windows 实机验证：非隐身点击主浮窗不丢焦点且能用系统输入法打字；开启隐身后候选窗/组合文本不由系统输入法接管；关闭隐身无需重启即可恢复系统输入法；回复条在两种模式下的输入路径一致。
- 未实机验证前，不得在发布说明中宣称隐身模式的系统候选窗隔离行为已有提升或回退。

## 风险

- 窗口级 IME detach 不能像线程级禁用那样覆盖所有 TSF 路径；若 Windows 实机在隐身时仍出现系统候选窗，需要重新评估隔离方案，不能简单恢复 `ImmDisableIME` 而牺牲非隐身输入。
- `setFocusable(true)` 在 Electron/Windows 版本间行为需实测；本变更保留窗口构造时的 `focusable: false`，由注册器在非隐身时恢复可聚焦。
- 系统输入法候选窗在透明无边框窗口中的定位由操作系统决定，可能与本应用内置候选窗位置不同。
- 启动期主进程可能先收到 renderer 的 acquire、后收到持久化隐身设置；此时 acquire 会按非隐身拒绝，用户重新聚焦即可。该窗口保持在毫秒级，且不会把非隐身窗口错误地隔离。

## 相关 Note

- [跨平台内置 Rime 输入法桥接](../architecture/2026-10-14-embedded-rime-ime.md)
- [Windows 非激活窗口的 Rime 键盘输入](../architecture/2026-10-27-nonactivating-rime-keyboard-input.md)
- [会议场景隐身模式的窗口与捕获边界](../../proposed/architecture/2026-10-13-comprehensive-stealth-mode.md)
- [会议场景下的窗口焦点与输入体验](../../proposed/architecture/2026-10-26-focus-and-screen-switch-detection.md)
