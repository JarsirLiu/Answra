# Note：Electron 捕获保护兼容性回归

状态：已实施

## 问题

Windows 11 上启用隐身后，主导航及普通面板在外部截图中出现黑块。独立回复条正常，但关闭回复条后主窗口表面又出现黑块。Electron 返回的捕获保护状态为成功，不能解释实际捕获结果。后续 CLI 需要 Node 22，而 Electron 29.4.6 内嵌 Node 20.9，因此必须在保持捕获保护可用的前提下升级 Electron。

## 根因

在同一 Windows 环境和相同捕获流程中，Answra 使用 Electron `44.7.0` 时出现黑块，改为与已验证正常的 mycluely 相同的 Electron `29.4.6` 后恢复正常。这个对照表明 Electron 版本是已验证的关键差异；仅凭 `setContentProtection(true)` 成功或 HWND affinity 查询值不能判断录屏/截图一定正确。

Electron 35.0.0 不再暴露 `BrowserWindow.isContentProtected()`。原实现只依赖该 getter 判断当前保护状态；getter 缺失时，应用保护仍会成功，但变色龙背景采样会误判窗口未受保护。

## 涉及范围

- `apps/desktop/package.json` 的 Electron 版本和构建运行时。
- `apps/desktop/scripts/build-electron.mjs`、`apps/cli/scripts/build.mjs` 的 bundle target。
- 主窗口、回复窗口、截图流程及其捕获保护生命周期。
- `apps/desktop/src/main/windowCaptureProtection.ts` 的保护状态记录与诊断。
- 变色龙背景采样对窗口是否受捕获保护的判断。

## 决定

采用 Electron `35.0.0`（Node `22.14`）作为当前基线，并保持回复条为独立 `BrowserWindow`。desktop worker 与 CLI bundle target 统一为 `node22.14`。

当 Electron 不提供 `isContentProtected()` getter 时，以 `setWindowCaptureProtection` 最后一次成功应用的标志作为显式状态来源；不通过版本号、日志或截图结果推断保护状态。

## 修复

- Electron 固定为 `35.0.0`；CLI 安装包复用其内置 Node `22.14`（`ELECTRON_RUN_AS_NODE=1`），不新增 Node sidecar。
- `setWindowCaptureProtection` 记录每个窗口最后一次成功应用的保护标志；getter 可用时仍以 getter 为准，不可用时回落到该记录。
- `isWindowCaptureProtected` 使用同一记录判断变色龙背景应取窗口内还是窗口外像素，避免 Electron 35 下误取悬浮条自身像素。
- 增加 getter 缺失场景的回归测试，锁定“设置成功后仍被视为受保护、关闭后失效”的行为。
- 按 Electron 35 的权限请求联合类型收窄 `MediaAccessPermissionRequest`，只在 `details` 含 `mediaTypes` 时读取麦克风类型，避免把其他权限请求当成媒体请求。
- 持久截图回复条使用独立 `BrowserWindow`；主 renderer 保持附件/草稿状态所有权，回复窗口只呈现状态并回传动作。
- 主窗口在回复工作流期间保持原尺寸；主窗口与回复窗口分别应用捕获保护。
- 隐身日志区分 API 报告状态与 OS 捕获实测结论；getter 缺失时 `reportedProtected` 为 `undefined` 属于预期。

## 影响范围

- `apps/desktop/package.json` 锁定 Electron 版本。
- `apps/desktop/src/main/window.ts` 管理主窗和回复窗口生命周期。
- `apps/desktop/src/main/windowCaptureProtection.ts` 封装捕获保护调用与诊断。
- `apps/desktop/src/main/ambient.ts` 消费保护状态决定背景采样区域。
- `packages/ui/src/app/FloatingBarApp.tsx` 将回复工作流状态同步到独立窗口。
- `packages/shared/src/channels.ts` 定义回复窗口 IPC 状态和动作契约。

## 曾考虑的替代方案

- **继续使用 Electron 29.4.6：** 舍弃；它仍能通过捕获保护验证，但只带 Node 20.9，无法满足 CLI 运行时与仓库 Node 22.13 下限。
- **使用 Electron 39.0.0：** 拒绝；用户实测回复条关闭后悬浮导航栏会成为黑块，Node 版本优势不足以抵消捕获回归。
- **继续使用 Electron 44 并重复调用捕获保护 API：** 排除；已多次看到 API 报告成功而实际输出仍为黑块，重复调用没有建立系统级证据。
- **只把回复条改成独立窗口：** 不充分；回复条变正常后，关闭它时主导航和面板仍会黑块。
- **改透明度、缩略图或主窗口背景：** 排除；用户已验证透明/内容显示实验未解决问题，不能解释同机 Electron 版本 A/B 的差异。
- **只依赖 getter，getter 缺失时按未保护处理：** 舍弃；Electron 35 下会让变色龙采样取错区域，且没有真实状态来源。
- **按 Electron 版本号推断 getter 是否存在：** 舍弃；版本判断会与未来 Electron 行为耦合，改用 setter 的应用记录作为唯一状态来源。

## 后果与防回退

- 不得仅凭 `setContentProtection` 返回值、日志 `reportedProtected: true` 或窗口 affinity 值宣称系统截图、会议共享和录屏结果正确。
- 升级 Electron 前必须先查本 Note，并在目标 Windows 版本对主导航、面板、回复条开合前后及应用内截图之后执行系统截图/录屏 A/B；确认通过后更新本 Note 的版本与证据。
- 新增原生窗口时必须明确其内容是否应受捕获保护，并单独测试该窗口显示/隐藏/resize/关闭生命周期。
- getter 缺失是合法运行时状态；不得把 `undefined` 当作失败，也不得用 `undefined` 推断窗口未受保护。
- OS 实测范围之外的捕获软件和平台行为不得外推为保证。

## 验证

- 2026-11-12 在 Windows 11 build `26200` 使用 Electron `35.0.0`（Node `22.14.0`，Chromium `134.0.6998.44`）实测：开启保护后不透明与透明窗口的 `GetWindowDisplayAffinity` 均为 `17`（`WDA_EXCLUDEFROMCAPTURE`），关闭后为 `0`。
- 同一环境 GDI 截图：隐身开启时悬浮条不在截图中，显示其身后页面，无黑块；隐身关闭时悬浮条可见。
- 实际 `answer` profile 通过 Vite + Electron 35 启动，经 CDP 调用 `window.answra.setStealth(true/false)` 后 affinity 在 `17/0` 间切换，GDI 截图无黑块。
- `ELECTRON_RUN_AS_NODE=1` 使用 Electron 35 二进制运行得到 Node `22.14.0`。
- 用户用 `ELECTRON_OVERRIDE_DIST_PATH` 指向 Electron 35 启动 dev 实例，确认界面启动与隐身表现正常。
- 自动化验证：`apps/desktop/test/windowCaptureProtection.test.ts` 覆盖 getter 存在/缺失、状态不匹配和异常路径；`pnpm --filter @answra/desktop typecheck` 覆盖 Electron 35 权限请求类型收窄。
- `pnpm --filter @answra/cli smoke:electron` 通过，确认 Electron 35 的 `ELECTRON_RUN_AS_NODE=1` 能运行 CLI bundle。
