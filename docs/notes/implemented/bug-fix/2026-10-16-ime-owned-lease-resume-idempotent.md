# Note：IME 已持有 lease 时的焦点确认与 release 清理

状态：已实施

## 问题

解耦 blur / acquire / confirmFocus 后，中文模式下第一个按键有时可用（Rime 返回 preedit 与候选），随后 lease 被释放，后续按键既不进入 Rime，也不被原生输入接受，表现为“打不了字”。同时窗口重新获得焦点后再确认焦点，会让渲染进程认为自己不再持有 lease。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/ime/imeIpc.ts`（SessionCommand `resume` 分支）、`packages/ui/src/hooks/useEmbeddedIme.ts`（`release` 与卸载清理）、`packages/shared/src/channels.ts`（诊断事件）。
- UI/进程/协议/持久化表面：main 持有的 Rime owner lease 状态机、renderer 与 main 之间的 `ImeSessionCommand` 契约；不改变持久化。
- 相关 Note：`docs/notes/implemented/bug-fix/2026-10-16-ime-lease-blur-focus-handoff.md`、`docs/notes/rejected/architecture/2026-10-16-ime-editor-editability-policy.md`。

## 根因

1. 候选窗是 `focusable:false` 的非激活窗口，main 的 `onBlur` 守卫在进程仍在前台时不 suspend（见 `imeIpc.ts` 的 `attachLeaseListeners.onBlur`）。因此候选窗出现时 owner window 常常仍处于 `owned`。
2. 渲染进程在窗口恢复焦点时统一发送 `resume`（`confirmFocus`）。main 的 `resume` 分支此前只在 `status === "suspended"` 时才接受，`owned` 时返回 `invalid-transition`。
3. `confirmFocus` 收到拒绝后只把 `targetEngaged` 置为 false，但 `generationRef` 与 `focusedRef` 仍保留。此后 `targetOwned === false` 使 text policy 走原生输入，而按键仍按旧 generation 路由，导致两边都不接管，React 回滚 DOM 字符。
4. `useEmbeddedIme` 的卸载清理写成了 `useEffect(() => () => void release(), [release])`。只要 `release` 的依赖引用发生变化，这段 cleanup 就会在重渲染时触发一次 `release()`，把合成中的 lease 丢掉。

补充：本次“第一个按键可用、之后打不了字”的真实运行时根因后来被定位在别处 —— 移除中文模式下的 HTML `readOnly` 让文本目标成为真实系统 IME 目标，触发全局 composition fail-closed guard 并 `blur` 掉焦点。该决定已否决，见 [Note：输入法输入路由与编辑权限分离](../../rejected/architecture/2026-10-16-ime-editor-editability-policy.md)。上面的第 4 条在实机日志复核中被证伪为本次触发点（整段日志没有 `release-called`，也没有 `lease-suspended`），仅保留为防御性加固。

## 决定

- `resume` 语义改为幂等：当 lease 已由同一 owner 持有（generation、windowId、webContentsId、targetId 一致）时，焦点确认是 no-op，直接返回当前状态；只有 `suspended` 才走 `isolateNativeIme` 并恢复为 `owned`。
- renderer 侧 `release` 的卸载清理绑定到真实卸载（latest-ref 模式），不再对 `release` 标识变化敏感。
- 为定位后续 release 触发点，`release` 增加 `reason` 并发出 `release-called` 诊断；main 日志以 `renderer-release-called` 输出。

## 修复

- `imeIpc.ts`：SessionCommand `case "resume"` 在 `managed.lease.status === "owned"` 时执行 no-op `confirm-focus` 并返回 `{ enabled }`，不调用 `isolateNativeIme`。
- `useEmbeddedIme.ts`：`release(reason)` 记录诊断后清 generation/coordinator 并向下发送 `releaseTarget`（仅在持有 generation 时）；调用点标注 `target-switched` / `effect-inactive` / `unmount`；卸载清理改用 `releaseRef`。
- `channels.ts`：`ImeRendererDiagnosticEvent` 增加 `release-called`，`ImeRendererDiagnostic` 增加 `reason?`。
- 回归测试：main 新增“已持有 lease 时重复焦点确认保持 owned 且不重复隔离”；UI 现有卸载释放、DOM blur 不释放、窗口焦点确认等用例保持通过。

## 曾考虑的替代方案

- **renderer 侧在 `owned` 时不发 `resume`（读快照判断 phase）：** 舍弃。renderer 读到的 snapshot 可能滞后，且会让“窗口焦点即确认”这一单一协议分裂成 snapshot 推断，回归用例也以“窗口焦点发送确认”为准。
- **每次 DOM blur 都释放 lease：** 舍弃。见 `2026-10-16-ime-lease-blur-focus-handoff.md`：DOM blur 与原生窗口失焦顺序不可靠，会误判窗口级焦点交接。
- **保留 `[release]` 依赖的卸载清理，改为稳定 `bridge` 标识：** 舍弃。渲染进程无法保证 `window.answra` 代理对象跨访问引用稳定，且清理依赖回调标识本身是易踩坑的写法。

## 后果与防回退

- `resume` 是幂等确认：同 owner 重复确认不得改变 generation，也不得重复执行原生 IME 隔离。
- lease 释放只由明确来源触发：控件卸载、IME 禁用、renderer 明确切换目标；卸载清理禁止重新绑定到 `release` 标识。
- `release-called` 诊断保留 `reason`，用于继续追踪任何非预期 release；不得用它替代真实根因判断。

## 验证

- 定向验证：`pnpm --filter @answra/ui test -- useEmbeddedIme.test.tsx ImeCandidateAnchorReporter.test.tsx`；`pnpm --filter @answra/desktop test -- imeIpc.test.ts`。
- 全量验证：`pnpm --filter @answra/ui test`（158 项通过）、`pnpm --filter @answra/desktop test`（132 项通过）、`@answra/ui`、`@answra/desktop`、`@answra/shared` typecheck 通过、Biome 通过。
- 实机验证：Windows/macOS 上“连续输入拼音、候选窗跟随光标、窗口切换后继续输入”尚待用户确认；自动化测试不覆盖原生窗口焦点与候选窗激活的真实时序。
- 若仍出现非预期释放，主进程日志中的 `renderer-release-called` 会给出 `reason`，据此定位剩余触发点。
