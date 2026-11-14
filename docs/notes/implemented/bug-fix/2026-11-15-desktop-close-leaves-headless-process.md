# Note：关闭悬浮条后进程残留导致应用再也打不开

状态：已实施

## 问题

用户点击悬浮条右上角「关闭应用」后，界面消失，但 Answra 主进程、渲染进程和隐藏窗口继续存活。用户再次双击桌面图标时新实例被单实例锁立即退出，已运行实例又没有主窗口可聚焦，表现为「点图标毫无反应」，只能结束进程才能恢复。

本机复现证据（安装版 0.1.1，Windows 11）：残留主进程 `Responding=True`，可枚举到隐藏的「请选择截图区域」overlay 窗口，但主悬浮条窗口已不存在；此后每次启动都会立刻退出。2026-11-15 通过结束残留进程并重启恢复。

## 涉及范围

- 代码/模块：
  - `apps/desktop/src/main/ipc/windowIpc.ts`：`WindowChannels.Close` 从关闭主窗口改为退出应用。
  - `apps/desktop/src/main/index.ts`：主窗口 `closed` 时在 Windows/Linux 退出应用；单实例回调与 `activate` 统一走主窗口激活入口。
  - `apps/desktop/src/main/mainWindowActivation.ts`：新增主窗口激活逻辑，主窗口不存在时重建。
  - `packages/shared/src/channels/window.ts`：更新 `Close` 频道语义注释。
  - `apps/desktop/test/windowIpc.test.ts`、`apps/desktop/test/mainWindowActivation.test.ts`：回归测试。
- UI/进程/协议/持久化表面：改变桌面主窗口关闭语义与单实例复用路径；不改 IPC 频道名、载荷、持久化格式。
- 相关 Note：
  - [窗口表面生命周期](../architecture/2026-10-14-window-surface-lifecycle.md)
  - [桌面账号登录与凭据](../feature/2026-10-17-desktop-account-login-and-credentials.md)
  - [面试独立窗口（生命周期风险）](../../proposed/architecture/2026-11-12-interview-window.md)

## 决定

「关闭应用」必须是真正退出应用，而不是只关闭主窗口；同时单实例复用路径必须在主窗口缺失时重建窗口，不能静默聚焦一个不存在的窗口。

## 根因

1. `WorkspaceControls` 的「关闭应用」只发送 `WindowChannels.Close`，主进程随后执行 `window.close()`，仅销毁主悬浮条窗口，没有退出应用。
2. 截图 overlay 是跨截图复用的池化窗口：`hideSelectionWindows()` 只 `hide()`，只有 `before-quit` 时才 `disposeSelectionWindow()`；surface 浮窗的 `dismiss()` 同样只隐藏不销毁。因此主窗口关闭后仍有 `BrowserWindow` 存活，`app.on("window-all-closed")` 永远不会触发。
3. 进程带着单实例锁继续运行，但 `second-instance` 回调只执行 `getWindow()?.focus()`。主窗口已销毁，`getWindow()` 返回 `undefined`，回调变成空操作。应用没有托盘或全局热键可以重建主窗口，于是形成不可恢复的无界面状态。

## 修复

- `WindowChannels.Close` 在确认 sender 是主窗口后调用 `app.quit()`；退出流程经过已有的 `before-quit`，会停止面试、Agent 并销毁池化 overlay。
- 主窗口 `closed` 时，非 macOS 平台直接 `app.quit()`，覆盖 Alt+F4、任务栏关闭等不经过 IPC 的关闭路径，不再依赖 `window-all-closed`。
- 新增 `activateMainWindow(host)`：主窗口缺失或已销毁时调用 `createWindow()` 重建；存在但隐藏时先经过窗口表面策略再 `showInactive()`，最后 `focus()`。
- `second-instance` 与 `app.on("activate")` 统一调用 `activateOrCreateMainWindow()`；`app` 尚未 ready 时直接返回，避免与启动期创建窗口并发。
- `createManagedMainWindow()` 仍是唯一创建入口，重建时继续绑定面试窗口与变色龙主题控制器。

## 曾考虑的替代方案

- **只把 `WindowChannels.Close` 改成 `app.quit()`：** 舍弃。Alt+F4、任务栏关闭等原生关闭路径不经过该 IPC，隐藏复用窗口仍会留下后台进程。
- **在 `window-all-closed` 里补销毁池化窗口：** 舍弃。该事件只在所有窗口关闭后触发，池化窗口存在时根本不会触发，属于因果倒置。
- **主窗口关闭时逐个销毁截图 overlay / surface 窗口再依赖 `window-all-closed`：** 舍弃。需要主进程记住所有复用窗口的销毁顺序，仍然无法覆盖「窗口被平台销毁但进程未退出」的其它路径；直接 `app.quit()` 让 `before-quit` 统一收口更简单。
- **保留 `second-instance` 只 `focus()` 的旧行为：** 舍弃。单实例锁意味着这是用户唯一的重新打开路径，必须能在主窗口缺失时自愈。

## 后果与防回退

- Windows/Linux 上主窗口关闭即退出是产品语义：桌面端没有托盘驻留，悬浮条就是唯一入口；不要为了「后台常驻」重新引入只关窗不退出的路径。
- `second-instance` / `activate` 只能走 `activateMainWindow`，不得再写只 `focus()` 的短路径；主窗口重建必须经过 `createManagedMainWindow()`，否则会丢失面试窗口绑定和主题控制器。
- 池化截图 overlay 与 surface 窗口可以继续隐藏复用，但任何「主窗口关闭」路径都必须能结束进程。
- 新增其它常驻窗口（如面试窗口）时必须验证主窗口关闭后应用确实退出，不能依赖 `window-all-closed`。

## 验收标准

- 可观察结果：Windows 上点击「关闭应用」后任务管理器无残留 `Answra.exe`；关闭主窗口后再次双击图标能正常出现悬浮条。
- 自动化验证：`windowIpc.test.ts` 断言 Close 会退出应用且拒绝非主窗口；`mainWindowActivation.test.ts` 覆盖缺失/已销毁窗口重建、隐藏窗口显示、策略拒绝时不强显。
- 需要的实机验证：安装版走一遍「截图答题 → 点关闭应用 → 任务管理器确认退出 → 重新启动」，再覆盖 Alt+F4 关闭路径。

## 风险

- `app.quit()` 会中断进行中的截图、答题或登录流程；这是「关闭应用」的预期语义，但仍在后台收尾的异步任务不会等待完成。
- `prepareWindowToShow` 在隐身策略初始化完成前可能拒绝显示；此时激活只记录日志，不上抛，避免影响单实例回调。
- macOS 保持「关闭主窗口不退出」，依赖 `activate` 重建窗口；本次未改动 macOS 的 dock 驻留语义。

## 验证

- 2026-11-15：`apps/desktop` 全量 vitest 53 个文件、337 项测试通过；新增 `mainWindowActivation.test.ts` 5 项、`windowIpc.test.ts` 5 项。
- 2026-11-15：`@answra/desktop` typecheck（main/preload/renderer）通过；改动文件 Biome 检查通过；`build:electron --profile=answer` 构建通过；`pnpm notes:check`、`architecture:check`、`tokens:check` 通过。
- 2026-11-15：Windows 11 实机结束残留进程后重启，悬浮条恢复显示；关闭应用行为与重新启动留待新构建安装版走查。
