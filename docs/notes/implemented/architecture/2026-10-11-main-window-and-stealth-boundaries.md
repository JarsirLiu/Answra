# Note：主窗口生命周期与隐身策略拆分

状态：已实施

## 问题

`window.ts` 同时创建主导航窗口、调整尺寸、监听原生窗口事件、保存隐身状态并应用捕获保护。继续增加服务窗口或浮层时，修改主窗口生命周期容易改变隐身行为。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/window.ts`、`mainWindowController.ts`、`windowStealthController.ts`
- 影响：主窗口创建、fit-content、show/resize 生命周期、Windows 捕获保护、任务栏/Dock 隐藏
- 相关 Note：桌面窗口控制器边界、Electron 捕获保护兼容性

## 决定

主窗口由 `mainWindowController` 独占创建、加载、尺寸约束和销毁通知；隐身由 `windowStealthController` 独占状态、捕获保护和任务栏/Dock 策略。两者只通过明确的 host 回调连接。`window.ts` 只负责装配和兼容导出，IPC 不需要知道具体 controller。

## 模块边界

- `mainWindowController.ts`：只管理主导航 BrowserWindow，不读取隐身状态，也不管理回复条。
- `windowStealthController.ts`：只管理隐身状态和每个已注册表面的捕获保护，不改变面板或截图工作流状态。
- `window.ts`：组装 controller，并保留稳定的 IPC 兼容函数。
- `replyBarWindowController.ts`：继续独占回复条 BrowserWindow，不能回退到主窗口复用。

## 曾考虑的替代方案

- **继续向 `window.ts` 添加函数：** 中心文件会重新成为多人协作冲突点，舍弃。
- **用全局事件总线连接窗口和隐身：** 生命周期责任不清，舍弃。
- **让主窗口 controller 自己读隐身状态：** 会把窗口几何和平台策略重新耦合，舍弃。

## 后果与防回退

- 新增 BrowserWindow 必须建立独立 controller，并显式声明捕获保护策略。
- 主窗口 show/resize 只能通过 host 通知隐身 controller 刷新，不能在 controller 内直接调用隐身模块。
- `setContentProtection` 的返回状态不代表所有录屏软件都会遵守；Windows 实机和目标 Electron 版本仍需验证。

## 验证

- 自动化：`pnpm typecheck`、`pnpm test`、`pnpm architecture:check`。
- 实机：Windows 11 22631、Electron 29.4.6 已验证回复条和主导航捕获行为。
- DXGI `IDXGIDuplicateOutput ... format is 10` 属于 10-bit 显示器的 Chromium 桌面复制器诊断，当前应用没有可靠 API 将其转换为 8-bit；它不改变 controller 边界，也不能作为捕获保护成功证据。
