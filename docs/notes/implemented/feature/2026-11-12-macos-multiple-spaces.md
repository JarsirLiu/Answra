# Note：macOS 多桌面适配

状态：已实施

## 问题

主窗口使用普通 BrowserWindow，置顶策略没有表达 macOS Spaces 归属。用户在同一块屏幕切换普通桌面或进入第三方原生全屏桌面后，需要继续使用悬浮条。截图选区原本已使用 macOS panel，但未获得焦点时按 Escape 无法取消。

## 涉及范围

- `apps/desktop/src/main/mainWindowController.ts`：主窗口构造。
- `apps/desktop/src/main/capture/captureIpc.ts`：捕获期 Escape 注册与释放。
- `apps/desktop/test/mainWindowController.test.ts`、`captureIpc.test.ts`、`selectionWindow.test.ts`：平台与生命周期回归。
- 相关约束：[窗口策略生命周期](../architecture/2026-10-14-window-surface-lifecycle.md)、[主窗口与隐身边界](../architecture/2026-10-11-main-window-and-stealth-boundaries.md)、[Electron 捕获兼容基线](../bug-fix/2026-10-11-electron-capture-protection-compatibility.md)。

## 决定

仅在 darwin 创建主窗口时采用 Electron 29.4.6 的 `type: "panel"`，复用选区窗口已有模式。该版本的原生 panel 具有 `CanJoinAllSpaces` 和 `FullScreenAuxiliary` 行为，不新增 Space ID、轮询或窗口副本。

窗口的置顶、捕获保护及焦点策略仍由 windowSurfaceRegistry 持有；Dock 显隐继续由 windowStealthController 持有。主窗口仍使用 showInactive 自动显示，Windows/Linux 的窗口类型和策略不变。当前回复继续内联在主窗口中，未启用独立回复入口。

macOS 选区沿用 Windows 已有的捕获期全局 Escape 注册，并在 finally 中释放。未点击选区时也能取消；注册失败时保留选区自身的取消路径，不注销未取得的快捷键。

## 影响表面

变化限于 desktop main 的原生窗口与截图会话。没有新增 IPC、共享 schema、Agent 状态或依赖；没有升级 Electron。单屏多桌面是本次范围，外接多屏、面试音频和捕获隐私保证不在本次交付中。

## 曾考虑的替代方案

- **普通窗口配合 setVisibleOnAllWorkspaces：** 当前版本默认会触发 DockHide，可能与隐身控制竞争；panel 已提供所需原生行为，舍弃。
- **切换桌面时重建、移动或复制窗口：** 会扩大窗口及回复状态的生命周期，并引入额外状态同步；系统 panel 可直接满足需求，舍弃。

## 后果与防回退

保留一个主窗口承载所有 Spaces 上的入口和内联内容。以后调整窗口类型或 Electron 版本时，必须重新验证普通 Space、全屏 Space、输入法候选及捕获期取消，mock 测试不能代替系统实测。不得在 show、resize 或 restore 路径增加第二个 Dock writer。

## 验证

- 平台：macOS 15.6、Apple Silicon、Electron 29.4.6，使用 Answer 打包版和独立临时 userData。
- 用户实机：2026-11-12 反馈“两个桌面都可见”；2026-11-13 明确确认“全屏桌面悬浮条可见，中文候选和选字也正常”。
- 用户补充验收：2026-11-13 使用 Mac 测试版验证全屏截图、框选期间切换桌面后反馈“都可以”。这两项已取得实机通过反馈。
- 原生自动化：设置面板、工作区目录选择对话框、临时文档英文编辑及中文粘贴保存可用。旧版本复现未点击选区时 Escape 无效；修复后连续两轮未点击先按 Escape 均取消并恢复主窗口。
- 构建：Answer renderer/main/preload 编译、打包输入和最终 app.asar 审计、Apple Silicon app 临时签名校验通过。
- 自动化回归：六个相关 desktop 测试文件 41 项通过、1 项 Windows 专用测试跳过；FloatingBarApp 54 项通过。覆盖主窗口平台类型、选区复用与 bounds 更新、成功/取消/失败清理、快捷键注册失败及失败后重试。
- 完整门禁：`pnpm verify` 通过，shared 11、Agent 409、UI 298、desktop 290 项通过，desktop 3 项按已有条件跳过；Biome、全包类型检查及架构检查通过。测试平台修正见 [Mac 验证门禁的测试平台假设](../testing/2026-11-12-macos-validation-portability.md)。
- 验证边界：未完整实测回复流式输出及隐身模式的全部交叉组合；未实测 Windows/Linux 或其他 Mac 机型。上述结果不代表这些矩阵已全部通过。

## 依据

- [Electron 29.4.6 panel 选项](https://github.com/electron/electron/blob/v29.4.6/docs/api/structures/browser-window-options.md#L143-L153)
- [panel collection behavior](https://github.com/electron/electron/blob/v29.4.6/shell/browser/ui/cocoa/electron_ns_panel.mm#L17-L32)
- [key/main window 判定](https://github.com/electron/electron/blob/v29.4.6/shell/browser/ui/cocoa/electron_ns_window.mm#L244-L249)
- [workspace setter 的 Dock 转换](https://github.com/electron/electron/blob/v29.4.6/shell/browser/native_window_mac.mm#L1329-L1345)
