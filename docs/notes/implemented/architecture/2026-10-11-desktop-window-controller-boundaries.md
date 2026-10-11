# Note：桌面窗口控制器边界

状态：已实施

## 问题

`apps/desktop/src/main/window.ts` 同时管理主导航窗口、独立回复条窗口、窗口尺寸、回复条 IPC 状态和捕获保护。多人修改其中一个窗口时，容易误触另一个窗口的生命周期，尤其是回复条的隐藏、恢复和尺寸变化。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/window.ts`、`apps/desktop/src/main/replyBarWindowController.ts`、`apps/desktop/src/main/windowLayout.ts`
- 相关流程：窗口 IPC、区域截图后的回复条、捕获保护、窗口落位
- 相关 Note：Electron 捕获保护兼容性、功能边界与本地运行时分层

## 决定

新增 `replyBarWindowController`，由它独占回复条 BrowserWindow 的状态、创建、显示、隐藏、尺寸、捕获保护和 renderer 同步。`window.ts` 只保留主窗口所有权，并通过稳定的兼容函数转发现有 IPC 调用。

新增 `windowLayout` 保存纯窗口几何计算。它不导入 Electron，也不持有窗口句柄，方便单测和未来其他表面复用。

## 模块边界

- `window.ts`：主导航窗口、主窗口尺寸、主窗口隐身状态和公共 IPC 转发。
- `replyBarWindowController.ts`：回复条独立 HWND 的完整生命周期；不能读取主窗口内部变量，只通过 `ReplyBarWindowHost` 回调协作。
- `windowLayout.ts`：选区落位和尺寸限制等纯函数。
- `windowCaptureProtection.ts`：只负责系统捕获保护 API，不负责窗口业务状态。

## 曾考虑的替代方案

- **只把回复条函数拆到另一个文件并直接导入 `window.ts` 内部状态：** 会形成循环依赖和隐式共享状态，仍然无法保证窗口边界，因此改用显式 `ReplyBarWindowHost`。
- **为每一种窗口建立全局事件总线：** 会隐藏谁负责显示、恢复和销毁，调试窗口生命周期更困难，因此暂不引入事件总线。

## 后果与防回退

- 新增独立悬浮表面时，应新增对应 controller，不得把第二种窗口的状态继续堆进 `window.ts`。
- controller 只能通过 host 回调访问主窗口；不要导出内部 BrowserWindow 或可变状态。
- 捕获保护的系统行为仍需在目标 Electron 版本和 Windows 环境实测；纯单元测试不能替代实机验证。

## 验证

- `apps/desktop` 类型检查通过。
- Desktop 49 项测试通过，包含窗口落位、窗口 IPC 和捕获流程。
- 提交前运行 `pnpm notes:check`、`pnpm verify` 和 `pnpm architecture:check`。
