# Note：回复条原生窗口边界参数防护

状态：已实施

## 问题

截图后展开回复条时，主进程可能把 renderer 测量值和工作区计算结果直接传给 `BrowserWindow.setBounds`。当尺寸带小数或显示器工作区小于预留边距时，计算结果可能不满足 Electron 原生窗口边界要求，触发未捕获异常并弹出 JavaScript 错误窗口。

## 涉及范围

- 模块：`apps/desktop/src/main/replyBarWindowController.ts`、`apps/desktop/src/main/windowLayout.ts` 及窗口定位测试。
- 用户行为：截图后回复条调整尺寸或展开；模型请求、会话事件、截图内容不变。
- 进程边界：renderer 仍只上报测量尺寸；主进程负责归整、限制和应用原生边界。

## 根因

`ResizeObserver` 回报的尺寸会经过 IPC 送入回复窗口 controller。controller 直接把测量值和工作区边距计算结果用于 `setBounds`，没有统一整数化；工作区小于预留边距时还可能生成非正尺寸。窗口位置来自截图选区，也未在最终 native bounds 边界再次验证。

## 修复

主进程将窗口坐标和尺寸归整为有限整数，并将宽高限制在当前显示器工作区范围内；计算后再次校验原生边界，调用 `setBounds` 时捕获并记录意外 Electron 错误，避免未捕获异常弹窗。纯定位函数覆盖小数输入、窄工作区和负坐标工作区。

## 决定

renderer 继续上报内容测量值；主进程 controller 独占原生边界归整、工作区夹取和 `setBounds` 调用。布局纯函数保持与 Electron 解耦，负责输出有限整数坐标。

## 曾考虑的替代方案

- **只在 `setBounds` 外捕获异常：** 可以阻止系统错误弹窗，但每次尺寸上报仍会重复失败并让窗口保持旧尺寸，因此只作为最后一道保护，不能替代边界修正。
- **在 renderer 的 ResizeObserver 中取整并信任 IPC：** 能覆盖当前 UI 来源，但无法保证未来 bridge 调用方或窗口工作区变化仍合法；原生边界校验必须由主进程负责。

## 后果与防回退

- 窗口尺寸最多比 CSS 测量值相差一个设备无关像素，符合 Electron 原生窗口整数边界并避免小数转换失败。
- 极小工作区下窗口收缩到可用范围，不得把负尺寸、NaN、Infinity 或小数坐标传给 `setBounds`。
- 回复条尺寸 IPC 继续只接受来自回复窗口的有限正数；renderer 不获得原生坐标控制权。

## 验证

- 单元测试覆盖小数尺寸归整、小于边距的工作区、工作区边界夹取，确保布局函数输出整数坐标，controller 校验安全整数边界后才调用 Electron。
- 验证结果：desktop `windowLayout` 5 项测试通过；UI 回复条悬浮交互 3 项测试通过；desktop 类型检查通过；相关变更文件 Biome 检查通过；`pnpm notes:check` 通过。
- 桌面 Electron 版本和截图后实机验证结果：待验证。
