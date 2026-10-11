# Note：Windows HDR 采集格式诊断

状态：已实施

## 问题

Windows HDR 显示环境下，Chromium 的 DXGI output duplicator 会记录 `IDXGIDuplicateOutput does not use RGBA (8 bit) format, ... format is 10`。这条日志表明 DXGI 返回的格式不是该下游期望的 8-bit RGBA，但单凭它不能断定截图失败或画面损坏。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/chromiumCompatibility.ts`、`apps/desktop/src/main/index.ts`
- 影响表面：应用内区域截图、变色龙背景采样，以及依赖 Chromium 屏幕采集的后续能力
- 相关 Note：截图捕获保护、变色龙采样和 Electron 29.4.6 兼容性

## 根因

日志来自 Chromium 内部的桌面采集器，不是 Answra 明确请求了 10-bit。Answra 的变色龙每 4 秒调用一次 `desktopCapturer.getSources()`，所以连续按约 4 秒间隔出现的日志与变色龙轮询吻合；手动区域截图也使用同一个 Electron 采集 API。

排查还发现，主进程原先无条件启动变色龙采样器，renderer 的“跟随背景色”设置只控制主题订阅和显示效果，没有控制主进程的采集定时器。因此即使用户关闭变色龙，后台仍会每 4 秒采集屏幕；这解释了关闭模式时持续出现的日志。

Electron 暴露的 `force-color-profile=srgb` 用于 Chromium 颜色管理，不是设置 DXGI duplication pixel format 的接口。用户在 Windows HDR 环境仍看到该日志，证明这个开关不能保证消除该 DXGI 诊断，也不能仅凭开关已设置就宣称采集格式已变成 8-bit。当前没有通过项目内代码或自动化测试证明 Electron 29 的公开 API 能控制该 DXGI 格式。

## 修复

在 Electron `app.whenReady()` 之前，Windows 平台设置 `app.commandLine.appendSwitch("force-color-profile", "srgb")`，使应用使用统一的 sRGB 颜色管理配置。此设置不被视为 DXGI 格式修复；非 Windows 平台不改变颜色配置。

变色龙采样器现在默认关闭，通过类型化 `answra:ambient:set-follow` IPC 与 renderer 保存的开关同步。开启时才注册移动/显示器监听并启动 4 秒轮询；关闭时清除定时器、移除监听，并丢弃已在执行中的采样结果。手动区域截图仍独立调用截图 IPC，不会启用变色龙轮询。

## 决定

把颜色兼容开关集中在主进程启动适配模块，由启动入口统一调用；截图服务和变色龙服务继续只负责采集，不感知 Chromium 启动参数。

## 影响表面

- Windows HDR/10-bit 显示器：颜色管理配置为 sRGB；Chromium 仍可能在手动截图采集时记录 DXGI 10-bit 格式诊断，截图是否受影响需依据实际返回图像判断。
- 变色龙关闭时不执行后台屏幕采样；开启后才按移动/显示器变化和 4 秒轮询采样。
- 非 Windows：不追加 Chromium 开关，保留平台默认颜色管理。
- 应用 UI：颜色可能从 HDR 广色域回落到 sRGB，这是为了保证截图采集稳定性而接受的兼容取舍。

## 曾考虑的替代方案

- **只过滤或隐藏 Chromium 的错误日志**：不会改变 DXGI 格式，会掩盖其他 Chromium 诊断，因此舍弃。
- **在 `desktopCapturer.getSources` 中降低缩略图尺寸**：尺寸不决定输出位深，无法解决 10-bit 与 8-bit RGBA 的格式冲突，因此舍弃。
- **禁用 GPU 或关闭系统 HDR**：会影响整个应用的渲染性能，或要求用户修改系统设置；应用不能替用户改变全局显示配置，因此舍弃。

## 后果与防回退

- 颜色配置开关必须保持在 `app.whenReady()` 之前执行，不能移动到截图函数、窗口创建或变色龙采样之后；不要将它描述为强制 DXGI 使用 8-bit 的保证。
- 新增 Chromium 平台开关应集中放入 `chromiumCompatibility.ts`，不要在各采集模块散落 `appendSwitch`。
- 变色龙的 4 秒 `desktopCapturer` 轮询是这类重复日志的常见触发路径；手动截图复用同一采集 API。若将来替换采集后端，应分别验证颜色取样和截图结果，并记录 Windows HDR 实机证据。
- 变色龙的 renderer 偏好与 main 进程采样生命周期必须通过 `AmbientChannels.SetFollow` 同步；不得在应用启动时无条件开始采样。
- 该修复解决的是 DXGI 采集格式兼容，不等价于证明所有系统录屏软件都遵守窗口捕获排除标志。

## 验证

- 自动化：兼容模块覆盖 Windows 设置 sRGB、非 Windows 不追加；此测试不验证 DXGI 的实际像素格式。
- 自动化：主进程生命周期测试验证默认关闭不采样、开启后采样、关闭后停止轮询；UI 测试验证变色龙状态通过 bridge 同步。
- 实机：用户在 Windows `10.0.22631` 环境重启 `pnpm dev` 后仍观察到 `format is 10`；因此本 Note 记录的 sRGB 设置没有消除这条 DXGI 日志。截图/变色龙采样功能是否受该诊断影响，仍需依据图像结果单独确认。
