# Note：Electron 捕获保护兼容性回归

状态：已实施

## 问题

Windows 11 上启用隐身后，主导航及普通面板在外部截图中出现黑块。独立回复条正常，但关闭回复条后主窗口表面又出现黑块。Electron 返回的捕获保护状态为成功，不能解释实际捕获结果。

## 根因

在同一 Windows 环境和相同捕获流程中，Answra 使用 Electron `44.7.0` 时出现黑块，改为与已验证正常的 mycluely 相同的 Electron `29.4.6` 后恢复正常。这个对照表明 Electron 版本是已验证的关键差异；仅凭 `setContentProtection(true)` 成功或 HWND affinity 查询值不能判断录屏/截图一定正确。

回复条复用主窗口时，它的显示、尺寸测量和关闭生命周期会触碰主 HWND。独立回复 BrowserWindow 隔离了回复条的尺寸与生命周期，但它本身不能修复 Electron 44 下主窗口的捕获兼容问题；两个措施分别解决窗口生命周期隔离和运行时版本兼容。

## 涉及范围

- `apps/desktop/package.json` 的 Electron 版本和构建运行时。
- 主窗口、回复窗口、截图流程及其捕获保护生命周期。

## 决定

采用 Electron `29.4.6` 作为已验证基线，并保持回复条为独立 BrowserWindow。曾按用户要求测试 Electron `39.0.0`：回复条自身不变黑，但关闭后主导航出现黑块，因此该版本不通过捕获保护验收并已切回 `29.4.6`。

## 修复

- Electron 固定为 `29.4.6`，用户已确认该版本下隐身捕获正常。
- Electron `39.0.0` 的试验已结束：用户验证回复条关闭后悬浮导航栏会成为黑块，因此拒绝该版本，即使它的 Node 版本满足 Pi SDK 要求。
- 持久截图回复条使用独立 BrowserWindow；主 renderer 保持附件/草稿状态所有权，回复窗口只呈现状态并回传动作。
- 主窗口在回复工作流期间保持原尺寸；主窗口与回复窗口分别应用捕获保护。
- 隐身日志区分 API 报告状态与 OS 捕获实测结论。

## 影响范围

- `apps/desktop/package.json` 锁定 Electron 版本。
- `apps/desktop/src/main/window.ts` 管理主窗和回复窗口生命周期。
- `apps/desktop/src/main/windowCaptureProtection.ts` 封装捕获保护调用与诊断。
- `packages/ui/src/app/FloatingBarApp.tsx` 将回复工作流状态同步到独立窗口。
- `packages/shared/src/channels.ts` 定义回复窗口 IPC 状态和动作契约。

## 曾考虑的替代方案

- **继续使用 Electron 44 并重复调用捕获保护 API：** 排除；已多次看到 API 报告成功而实际输出仍为黑块，重复调用没有建立系统级证据。
- **仅把回复条改成独立窗口：** 不充分；回复条变正常后，关闭它时主导航和面板仍会黑块。
- **改透明度、缩略图或主窗口背景：** 排除；用户已验证透明/内容显示实验未解决问题，不能解释同机 Electron 版本 A/B 的差异。
- **保持 Electron 29.4.6：** 采用；用户在 Windows 11 build `22631` 实测隐身捕获正常。
- **使用 Electron 39.0.0：** 拒绝；用户实测回复条关闭后悬浮导航栏会成为黑块，Node 版本优势不足以抵消捕获回归。

## 后果与防回退

- 不得仅凭 `setContentProtection` 返回值、日志 `reportedProtected: true` 或窗口 affinity 值宣称系统截图、会议共享和录屏结果正确。
- 升级 Electron 前必须先查本 Note，并在目标 Windows 版本对主导航、面板、回复条开合前后及应用内截图之后执行系统截图/录屏 A/B；确认通过后更新本 Note 的版本与证据。
- 新增原生窗口时必须明确其内容是否应受捕获保护，并单独测试该窗口显示/隐藏/resize/关闭生命周期。
- OS 实测范围之外的捕获软件和平台行为不得外推为保证。

## 验证

- 用户在 Windows 11 23H2（系统 build `22631`）验证 Electron `29.4.6` 后黑块消失。
- 用户在 Windows 11 build `22631` 实测 Electron `39.0.0`：回复条可见时正常，关闭后悬浮导航栏出现黑块；因此切回 Electron `29.4.6`。Electron `29.4.6` 是当前已验证版本。
