# Note：IME 租约释放原因与默认焦点链日志

状态：已实施

## 问题

三轮实机故障（Shift 后输入锁死、FFI 硬崩溃、候选窗宽度棘轮）都只能靠手写临时日志定位。复盘时发现默认输出根本无法回答最基本的问题：**这条租约为什么消失**。同一份日志里 `lease-acquired` 有、`key-processed` 有，但 `lease-released` 没有任何原因字段；owner 窗口关闭、renderer 进程崩溃、主框架导航导致的租约转移完全没有日志；renderer 主动释放时带的原因在跨进程白名单里被丢弃。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`、`packages/shared/src/index.ts`、`apps/desktop/src/main/ime/imeIpc.ts`、`apps/desktop/src/main/ime/imeDiagnostics.ts`、`apps/desktop/src/main/ime/imeCandidateWindowController.ts`、`packages/ui/src/hooks/useEmbeddedIme.ts`。
- UI/进程/协议/持久化表面：`ImeSessionCommand` 的 `releaseTarget|suspend|resume` 变体增加可选 `reason?: string`；`ImeChannels.Release` 请求增加可选 `reason`；新增 shared 运行时事件名列表 `IME_RENDERER_DIAGNOSTIC_EVENTS`；改变 main 终端默认日志的事件集合。不改变租约状态机、候选窗行为和持久化。
- 相关 Note：[IME 控制台诊断日志](../feature/2026-10-15-ime-diagnostic-log.md)、[Shift 切换英文后输入被锁死](./2026-10-16-ime-shift-ascii-input-lockout.md)、[原生 FFI 字符串解码崩溃](./2026-10-16-native-ffi-string-decode-crash.md)、[候选窗宽度棘轮](./2026-10-16-ime-candidate-window-width-ratchet.md)、[内置 Rime 输入法桥接](../architecture/2026-10-14-embedded-rime-ime.md)。

## 根因

1. **diagnostics 白名单与 renderer 实际事件漂移，且漂移方向恰好丢掉原因。** `isImeRendererDiagnostic` 维护了一份手写事件名数组，里面还留着永不发出的 `confirm-focus-start`/`confirm-focus-result`，却没有 renderer 真实发出的 `release-called`。`useEmbeddedIme.release()` 一直发送 `release-called` 诊断，main 侧在校验阶段直接 `return`，所以"谁释放了租约"从头到尾没有进入日志。
2. **main 侧租约消失路径大多没有日志。** `lease-released` 只有 renderer 显式释放这一条来源，且无原因字段；`owner-window-closed`、`renderer-process-gone`、`window-navigation` 三个来源共用静默转移；acquire 时替换旧 owner、`isolateNativeIme` 失败让旧租约作废也都没有记录；session 命令层的 `resume`/`suspend` 分支完全静默，而 `focus-confirmed` 只覆盖旧的 ConfirmFocus handler。
3. **默认只打印"好消息"的候选窗日志。** `candidate-native-positioned` 默认被 `details.visible !== true` 抑制，而 `reportNativeWindow` 在 `showInactive()` 之前采样，首次定位必然 `visible:false`；同时 payload 不含 renderer 上报尺寸，观测者无法在一行里对比"上报尺寸 vs 实际窗口尺寸"——这正是宽度棘轮需要的信息。

## 决定

把"租约为什么变化"变成默认可见的事实，而不是需要重启并设置 `ANSWRA_IME_DEBUG` 才能拿到的调试信息。判定标准：每一行 `lease-released` 都必须带 `reason`，每个能让租约消失的路径都必须写出该行；渲染进程与主进程的事件名只能有一份来源。

## 修复

- `packages/shared/src/channels.ts`：新增运行时常量 `IME_RENDERER_DIAGNOSTIC_EVENTS`，`ImeRendererDiagnosticEvent` 由它派生，删除僵尸成员 `confirm-focus-start`/`confirm-focus-result`；`ImeSessionCommand` 的 `releaseTarget|suspend|resume` 与 `ImeChannels.Release` 请求增加 `reason?: string`（additive，兼容旧 renderer）。
- `packages/shared/src/index.ts`：导出 `IME_RENDERER_DIAGNOSTIC_EVENTS`，供 main 白名单与测试共用。
- `apps/desktop/src/main/ime/imeIpc.ts`：
  - `isImeRendererDiagnostic` 改为"事件名必须存在于 `IME_RENDERER_DIAGNOSTIC_EVENTS`（`candidate-rendered` 走候选窗口专用校验）"，不再维护手写数组。
  - renderer 诊断转发新增 `reason` 字段，取值必须匹配 `^[a-z-]{1,40}$`，否则整体丢弃（不把任意 renderer 文本写进日志）。
  - `lease-released` 增加 `reason` 与 `composing`：renderer 释放取命令里的 `reason`（非法值记 `renderer-unspecified`）；`owner-window-closed`/`renderer-process-gone`/`window-navigation` 三个来源各自命名；acquire 替换旧 owner 记 `owner-replaced` 并附 `nextTargetId`；`isolateNativeIme` 失败记 `native-ime-isolation-failed` 并追加 `lease-unavailable` 行说明会话阶段变化；owner 监听器过期时附 `staleListener: true`。
  - session 命令层补 `lease-resumed`（带 `previousStatus`）与 `lease-suspended`（带 `reason`），覆盖此前静默的 `resume`/`suspend`。
- `apps/desktop/src/main/ime/imeDiagnostics.ts`：`SUPPRESSED_IME_DIAGNOSTIC_EVENTS` 改为导出的常量数组（供测试断言），取消 `renderer-input-focus`/`renderer-input-blur`/`renderer-window-focus`/`renderer-window-blur` 的抑制——它们按焦点变化计数，不是逐键噪音，且是唯一记录"谁开始改租约"的地方；取消 `candidate-native-positioned` 的 `visible !== true` 抑制（该方法本身已按签名去重）；候选原生窗口单行日志补 `requestedSize`/`candidateBounds`/`contentBounds`。
- `apps/desktop/src/main/ime/imeCandidateWindowController.ts`：`candidate-native-positioned` 携带 `requestedSize`，并把它并入去重签名，使"上报尺寸变了但窗口尺寸没变"也能被观测到。
- `packages/ui/src/hooks/useEmbeddedIme.ts`：`release(reason)` 的 `releaseTarget` 命令透传 `reason`；acquire 失败路径回写 `focus-lost-during-acquire`/`acquire-rejected`。
- 测试：`imeDiagnostics.test.ts` 新增焦点链默认可见、抑制名单不变量（每个 `renderer-<X>` 必须存在于 shared 列表，且 4 个焦点事件不在其中）、不可见时仍打印 requestedSize；`imeIpc.test.ts` 新增释放原因、非法原因回退、owner 关闭、owner 被替换、隔离失败、resume 来源共 6 项；`imeCandidateWindowController.test.ts` 新增 requestedSize 与夹紧后 bounds 的对照断言。

## 曾考虑的替代方案

- **让用户复现时开 `ANSWRA_IME_DEBUG=1`：** 舍弃。三次故障都发生在"用户正常使用"过程中，要求改环境变量并重启才能拿到原因，等于放弃现场；已复现两次的教训是不设门控的事件必须在默认输出里。
- **新增独立的 `lease-release-reason` 事件，而不是给 `lease-released` 加字段：** 舍弃。日志行数翻倍，而且原因与释放动作分成两行后更容易在粘贴时被截断。字段与动作放在同一行是这次复盘的直接需求。
- **让 renderer 直接发送任意事件名，main 只校验 sender：** 舍弃。renderer 是可能被注入内容的一侧（输入文本经过这里），事件名与字段白名单是限制日志注入面的唯一手段；改为共享一份常量列表即可解决漂移，不需要放开校验。
- **继续手写事件名数组，只补上 `release-called`：** 舍弃。漂移是这次故障的根因，补一次就还会漂第二次；共享常量加不变量测试能在编译期和测试期同时挡住。
- **保留 `candidate-native-positioned` 的可见性抑制：** 舍弃。被抑制的恰恰是"窗口还没显示时的第一次定位"，而这正是尺寸异常需要的一帧。

## 后果与防回退

- `reason` 只接受 `^[a-z-]{1,40}$` 的小写短标识，非法值一律记 `renderer-unspecified`。禁止把编辑器内容、候选文本或任何用户输入放进 `reason`；新增原因字符串必须同时出现在 renderer 调用点和 main 的分支命名里。
- `IME_RENDERER_DIAGNOSTIC_EVENTS` 是 renderer 诊断事件名的唯一来源；main 白名单与候选窗口校验不得再各写一份数组。
- 焦点链与 `candidate-native-positioned` 现在属于默认输出，新增同类事件时优先考虑合并到已有事件而非新增噪音。
- `lease-released` 的 `reason` 是排障的第一入口：任何让租约消失的新路径都必须带 reason 记录，否则视为可判定性回退。
- renderer unmount 由 `useEmbeddedIme` 的卸载 cleanup（`unmount`）与 CodeMirror 面板重建时的 `editor-unmount` 两条来源覆盖；两者都会先清掉本 renderer 的注册再发 `releaseTarget`，因此重复释放同一 generation 只会被 main 拒绝，不会误伤新租约。

## 验证

- 自动化：`pnpm --filter @answra/desktop test` 26 个文件 / 145 项通过（新增 10 项），`pnpm --filter @answra/ui test` 24 个文件 / 159 项通过；`pnpm lint`、`pnpm typecheck`、`pnpm architecture:check` 通过。
- 不变量测试覆盖：每个被抑制的 `renderer-<X>` 事件都存在于 shared 列表，4 个焦点事件不在抑制名单内；非法 `reason` 不会进入日志。
- 需要用户实机验证：Windows 上 `pnpm dev`（无需 `ANSWRA_IME_DEBUG`）执行"输入中文 → 切窗口 → 切回 → 换目标输入框 → 关闭面板"，确认默认输出里能看到 `lease-released` 带 reason、`lease-resumed`/`lease-suspended`、焦点链事件，以及 `candidate-native-positioned` 的 `requestedSize` 与 `candidateBounds`。macOS 尚未验证。
