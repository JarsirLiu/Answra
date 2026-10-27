# Note：Windows 非激活窗口的 Rime 键盘输入

状态：已实施

## 问题

Windows 隐身模式的主窗口使用 `BrowserWindow.setFocusable(false)` 保持鼠标操作不激活 Answra，但现有内置 Rime 只从获焦 renderer 的 DOM 键盘事件读取按键。结果是隐身时编辑器无法开始 Rime 会话，窗口保持非激活时不能打字。非隐身模式已改为可聚焦窗口并使用系统输入法，见[非隐身模式交还系统输入法](../feature/2026-10-27-non-stealth-system-ime.md)；本 Note 只描述隐藏身输入路径。

## 涉及范围

- `apps/desktop/native/rime-host/`：Windows helper 的短生命周期键盘捕获与协议事件。
- `apps/desktop/src/main/ime/`：helper 事件解析、会话 lease 校验、按键定向发送与捕获生命周期。
- `packages/shared/src/channels.ts`、`bridge.ts`、`apps/desktop/src/preload/`：typed keyboard event bridge。
- `packages/ui/src/hooks/useEmbeddedIme.ts` 与编辑器适配器：点击后维持 DOM 输入目标和 selection，分发受验证的合成键事件到原有 Rime 路由。
- `apps/desktop/src/main/windowSurfaceRegistry.ts`：隐身窗口（含启动期隐身设置未知时）保持非激活；helper 能力缺失时由 IME lease 拒绝输入，捕获失败不得吞键。

## 模块边界

- helper 只负责 Windows 低级键盘 hook、事件编号和有界交付确认，不访问 Electron 或 renderer 状态。
- main 持有唯一 IME lease；它是 helper 与 owner renderer 之间的路由和校验边界。
- renderer 只在 target 与 generation 匹配且 active element 正确时派发 DOM 键盘事件，并回执是否由编辑器处理。
- `shared` 只定义 IPC DTO 与频道；preload 只转发。

## 决定

Windows 使用 Answra 自带 librime，而不是依赖系统 CJK IME。隐身模式下原生主窗口和回复窗口保持 `focusable: false`；非隐身模式恢复可聚焦窗口并把文字输入交还系统输入法。点击编辑器只设置 renderer 的逻辑输入目标和 DOM selection，不调用 BrowserWindow/native focus。helper 在有效输入租约期间安装低级键盘 hook，按键事件带 lease generation；main 校验 generation 后只发送给当前 owner renderer，renderer 校验 active element 后把 DOM 键盘事件交给现有 Rime/editor 路由。

捕获只在有效输入目标与 owned lease 存在时运行。Esc、应用外鼠标点击、原生前台窗口切换、目标释放/销毁、helper 错误和有界空闲超时都必须停止捕获。Esc 即使没有正在组词也会结束捕获；renderer 未处理时仍把 Esc 交给 Windows。鼠标命中窗口通过 `WindowFromPhysicalPoint` + `GA_ROOT` 检查 Electron 顶层 HWND 所属 PID，不能比较 helper 自身 PID，因为 Chromium 内容 HWND 可能属于 renderer 子进程；helper 必须声明 per-monitor DPI awareness，低级鼠标 hook 提供的是物理像素，DPI-unaware 进程做命中测试会在缩放屏幕上把应用内点击误判为应用外。hook 安装失败或捕获能力缺失时拒绝输入租约，不能假装可用。

本次先限定 Windows。macOS `CGEventTap`、辅助功能授权、系统键盘布局差异和打包发布另行验证，不把 Windows 结果外推。焦点探针继续如实记录第三方页面事件；页面事件是否变化不是本功能的成功条件。

## 曾考虑的替代方案

- **重新激活 BrowserWindow 后输入：** 可直接复用 DOM 与 Rime，但违反 Windows 隐身输入期间窗口不获取原生焦点的约束，因此不采用。
- **复用系统 IME 或 `ToUnicodeEx` 直接插入字符：** 系统 IME 不会把组合事件送入应用自带 Rime；直接翻译字符也绕过现有 composition、候选、selection 和撤销语义，因此不采用。
- **继续禁用隐身输入：** 实现最少，但主窗口无法完成用户要求的编辑，因此不采用。

## 后果与防回退

- 全局 hook 是系统级按键入口，敏感范围必须严格限于输入 lease 生命周期；不得广播按键、在目标缺失时缓存按键或在 renderer 回执前吞键。回执最多等待 700 ms，超时会停止捕获并让按键继续传给操作系统。协议解析拒绝命名键（如 `Backspace`、`ArrowLeft`）等同于未回执，同样会超时停止捕获，因此按键名校验不能用过短的长度上限。
- 每个 lease generation 只允许其 owner renderer 收到按键。迟到事件按 window、webContents、target 和 generation 校验后丢弃。
- helper 协议能力必须显式报告；旧 helper 或资源缺失时不能假装支持非激活输入。原生 helper 版本、release tag、SHA-256 manifest 与资源准备文档必须同步。
- 编辑器的 DOM active element 和 selection 是 renderer 的逻辑状态，不代表 Electron BrowserWindow 获得原生焦点。测试必须分别断言两者。
- 保护 Esc、系统快捷键、modifier、外部点击、Alt+Tab、hook 安装失败、pipe 关闭、renderer 销毁与 timeout；不得留下仍吞键的孤儿 hook。
- IME lease 只在隐身开启时成立：主进程在 acquire、resume 和焦点重新隔离前校验隐身状态，避免关闭隐身后残留 lease 再次 detach 系统 IME。

## 验证

- 自动化：覆盖主进程 lease 定向与 generation 拒绝、renderer active element 校验与 DOM 事件路由、隐身回复窗口非激活策略。
- 本机 Windows：`answra-rime-host` 使用 MSVC 19.44 / Windows SDK 10.0.26100 Release 编译成功；独立协议冒烟确认 helper 报告 `keyboardCaptureAvailable: true`，捕获 hook 成功启动并按 `released` 正常停止。完整键盘输入和应用原生焦点状态仍需在加载新 helper 的开发版实测。
- 发布边界：已准备资源中的 helper 是旧版且不声明 `keyboardCaptureAvailable`，因此 `ime:prepare` 下载的发布 helper 不会启用该功能。发布前必须构建并发布新 helper release，随后同步 `native/rime-resources.json` 的固定 tag 与 SHA-256；开发测试可把本地编译 helper 放入被忽略的 `resources/rime/win32/`。

## 2026-10-27 范围修正

非隐身模式不再使用非激活窗口，也不启用内置 Rime；主窗口和回复条恢复可聚焦，文字输入交还系统输入法。helper 键盘捕获、非激活窗口和本 Note 的失败恢复约束只在隐身模式生效。见[非隐身模式交还系统输入法](../feature/2026-10-27-non-stealth-system-ime.md)。
