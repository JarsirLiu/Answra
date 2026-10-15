# Note：IME 焦点恢复中文模式与候选窗预热

状态：已实施

## 问题

用户反馈输入编辑器失焦后重新输入，拼音可能只得到按音节拆分的拉丁文本（例如 `nishishui` 变成 `ni shi shui`），不再出现中文候选。候选窗口还在首次出现时才创建并加载 renderer，增加首次候选显示延迟。后续实机测试又确认候选会被 renderer 上报的空状态隐藏。直接以隔离用户目录调用同一 native helper 输入 `nishishui` 时，每键均返回 `handled=true`，`ni shi shui` 返回 `你是谁` 等候选，证明当前词库和 native Rime 转换链路可用；UI 的异步 key IPC 没有串行队列，响应直接写状态，存在旧快照覆盖新组合状态的竞争。

## 涉及范围

- 代码/模块：`packages/ui/src/hooks/useEmbeddedIme.ts`、`apps/desktop/native/rime-host/main.cpp`、`apps/desktop/src/main/ime/imeCandidateWindowController.ts`、`apps/desktop/src/main/window.ts`、对应 UI 和 main 测试。
- UI/进程/协议/持久化表面：窗口重新聚焦后的 Rime 模式恢复；候选 BrowserWindow 的启动和首次显示；逐键日志负载。
- 相关 Note：[输入法焦点生命周期与 Shift 切换](../../proposed/bug-fix/2026-10-14-ime-shift-and-screenshot-lifecycle.md)、[统一 IME 输入目标与窗口生命周期](../architecture/2026-10-15-unified-ime-target-lifecycle.md)、[内置 Rime 输入法桥接](../architecture/2026-10-14-embedded-rime-ime.md)。

## 根因

- Rime session 初始化时显式设置 `ascii_mode=false`，但后续 `enable(true)` 只标记 session enabled，没有重置输入模式。
- Renderer 在窗口 `focus` 时会刷新候选锚点，但没有重新向 main 确认 Rime session 的中文模式。
- Renderer 逐键 IPC 同时并发发送并直接应用每个响应，缺少类似 `fydeRhythm` session mutex/key sequence 的顺序保护。
- 候选 BrowserWindow 原先只在收到第一份组合状态时创建，首次输入需要同时承担窗口创建和页面加载开销。
- reporter 在 DOM `focusout` 且 `document.hasFocus()` 为 true 时会立即丢弃输入锚点；候选 child window 显示期间出现的短暂 blur 因此被上报为 `owner-suspended`。
- Windows 实机再次显示 owner blur 后 `GetForegroundWindow` 进程检测暂时返回 false，Electron focused window 同时为空；此前在下一轮事件立即判定，未给候选窗口 show/owner 激活状态收敛留时间。
- renderer 与 main 都有逐键日志；这些日志会放大热路径工作量，但目前没有耗时测量证据表明它们是主要延迟来源。
- reporter 将 composition 活跃但暂时没有 textarea 锚点的过渡状态上报为 `suspend`；main 收到后隐藏候选窗并清除锚点，焦点恢复前候选不会自动重现。
- main 为两个 renderer 共用一个 Rime session，但没有绑定当前操作窗口；无效或非 owner 的 IPC 请求还会调用全局 `enable(false)`，放大局部生命周期错误的影响。

## 决定

继续保留 main 持有 Rime session、renderer 持有编辑器和候选状态的既有边界。窗口重新聚焦时通过现有 `imeEnable(true)` typed IPC 恢复 session，并由 native helper 在每次 enable 时显式设置 `ascii_mode=false`。候选窗口由主窗口初始化流程预热，页面 ready 后保持隐藏，直到真实候选状态到达。按键路径移除逐键日志；生命周期和启动错误仍保留诊断日志。

main IPC 以最近显式启用 session 的 BrowserWindow 作为当前 owner。按键、选词、reset 和 disable 仅接受当前 owner；新窗口显式启用后取得 owner。这是操作路由隔离，不承诺跨 renderer 保留彼此独立的拼音 composition。

## 修复

- `useEmbeddedIme` 在 renderer 窗口重新获得焦点时调用 `imeEnable(true)` 并同步返回的 Rime 状态；清理时移除 focus listener。
- 候选锚点 reporter 保留最近聚焦的 IME 编辑器；renderer 窗口恢复焦点且 DOM 焦点落在 `body` 时恢复该编辑器焦点并重新发布当前候选锚点，避免只恢复 Rime 模式却没有可接收按键的 DOM 输入目标。
- owner `blur` 延迟 120ms 检查 Electron focused window 与 OS foreground；只有失焦状态持续到检查时才隐藏候选窗。DOM `focusout` 在活跃 composition 期间保留输入锚点；窗口重新聚焦后 reporter 会重新发布锚点。
- reporter 在 composition 活跃时若暂时没有可测量锚点，不发送 `suspend` 或 `clear`，保留 main 已有候选状态；textarea 重新聚焦后再发布新锚点。失焦时隐藏候选由 main 的 owner 生命周期处理，避免 renderer 的瞬时 DOM 状态关闭 native surface。
- 候选窗显示时必须由 `windowSurfaceRegistry.attachAbove` 绑定当前 IME owner，包括从预热状态第一次显示和 owner 在主窗口/回复窗口间切换；owner 重新获得焦点时 registry 重申该关系。IME lease manager 通过 registry 的原生焦点事件检查 OS foreground 与 Electron focused window，不能仅凭 blur 事件清除输入锚点。
- `useEmbeddedIme` 必须将物理按键、候选翻页和候选选择放入同一个 Promise 队列，按输入顺序调用 native bridge 并依序应用响应；不可让较早的空候选快照覆盖后续仍在组合的状态。这里借鉴 `fydeRhythm` 的 session mutex 与 key sequence 思路，不移植其 Chrome `input.ime` API。
- IME IPC 校验失败或请求来自非 owner 时只能返回空状态，不能调用全局 `enable(false)`；共享 session 的 enable/disable、按键、选词和 reset 必须受同一个 owner 约束。
- `RimeHost` 在每次 enable 时设置 `ascii_mode=false`，避免恢复后继承英文模式；disable 时仍按原行为清除未提交 composition。
- candidate window controller 增加 `warmup()`，桌面窗口 controller 初始化后立即创建并加载候选 renderer；预热不显示窗口，也不需要候选 owner。
- 移除 renderer 和 main 中逐按键日志，保留其他低频生命周期日志。
- 测试覆盖窗口 focus 后再次调用 `imeEnable(true)`，以及候选 renderer 可预加载但保持隐藏。
- 输入 hook 测试覆盖快速连续按键会串行调用 bridge，且最终 UI 状态保留最新 preedit。
- main 测试覆盖 app 仍在前台时忽略 owner 的瞬时 blur、app 失焦时隐藏候选窗。
- main 测试覆盖 OS foreground 短暂掉落后恢复时保留候选窗，以及持续失焦达到 120ms 后隐藏。
- IME IPC 测试覆盖最近启用窗口 owner 隔离，以及无效/非 owner 请求不会关闭全局 session。
- reporter 测试覆盖 document 仍有焦点时的 composer DOM blur 不会中断活跃 composition。
- reporter 测试覆盖 composition 活跃但初始尚无锚点时不发送 suspend，焦点到达后正常发布候选。

## 曾考虑的替代方案

- **焦点恢复时清空 composition 并重建 session：** 舍弃。现有失焦策略旨在保留用户未提交的拼音；本次只重置输入模式，不主动丢弃组合内容。
- **把 Rime 直接放进 renderer：** 舍弃。会破坏 renderer 不加载 Node/native 模块的进程边界，且需要重新处理原生库安全和跨平台打包。
- **首次输入时继续创建候选窗口：** 舍弃。页面创建与加载不依赖候选内容，预先加载可将该开销移出首次输入路径；窗口保持隐藏以避免空浮层。

## 后果与防回退

- 每次应用窗口重新聚焦都会将 Rime 模式设回中文。当前产品尚未实现可用的 Shift 英文切换；若以后增加 ASCII 模式开关，焦点恢复策略需要改为恢复用户明确选择的模式，而不能无条件切中文。
- 启动时多创建一个隐藏 BrowserWindow 和 renderer，增加少量常驻资源占用；候选 UI 首次显示不再等待窗口页面加载。
- `useEmbeddedIme` 目前只挂在主对话和回复对话的 composer；其他设置/工作区文本控件没有内置 Rime 接入。Windows UI 线程的系统 IME 按隐私策略禁用，因此不得宣称其他字段已获得中文 IME 支持。扩展前需设计可复用的 text target、selection/commit、候选锚点和隐身捕获策略，并覆盖跨窗口 owner 测试。
- 当前 owner 检查只约束共享 session 的操作归属，不保存每个 BrowserWindow 独立的 preedit；两个输入窗口交替使用时，产品若要求各自保留未提交组合，仍需实现独立 session 或明确的 owner lease 生命周期。

## 验证

- 自动化：UI hook 测试确认窗口 focus 触发 `imeEnable(true)`；candidate reporter 测试确认 renderer 恢复焦点后会恢复此前的 IME 编辑器焦点和候选锚点；candidate controller 测试确认预热后 renderer 可加载且窗口保持隐藏。
- 门禁：`pnpm notes:check`、`pnpm --filter @answra/ui test`、`pnpm --filter @answra/desktop test`、相关 typecheck 和 `git diff --check`。
- 实机：Windows 11 x64 首轮测试确认 Rime preedit 可见，但候选窗出现后 owner blur 被误判为应用切出，候选窗随即隐藏且 textarea caret 消失。第二轮日志显示 `owner-reported-no-candidates`，隔离用户目录的 native helper 命令行测试则确认 `nishishui` 有中文候选。已增加候选窗原生 parent 绑定、composition 中焦点恢复和 hook 输入串行队列；必须再次在 Windows 实机验证候选持续显示、数字选词、焦点离开时关闭，以及 `nishishui` 中文候选。自动化测试不能验证 Electron/Windows 原生 focus 顺序，也不能测量键盘到候选显示的真实延迟。
