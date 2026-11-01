# Note：设置页手动检查更新与立即安装

状态：已实施

## 问题

桌面端的更新此前只有后台静默路径：启动 5 秒后首查、每 4 小时轮询，发现新版本自动下载，Windows 则把安装推迟到下次启动。用户看不到当前版本，也无法主动确认是否有新版本；下载完成后只能等下次启动，遇到问题也没有可见的重试入口。

## 涉及范围

- `packages/shared/src/channels/update.ts`、`channels.ts`、`index.ts`：新增 `UpdateChannels`、`UpdateStatus` 与 `UpdateChannelMap` 契约。
- `packages/shared/src/bridge.ts`、`apps/desktop/src/preload/index.ts`：渲染层更新 API 面。
- `apps/desktop/src/main/updater/updateState.ts`：纯状态归约。
- `apps/desktop/src/main/updater/updateController.ts`：状态持有、手动检查、下载重试、立即安装。
- `apps/desktop/src/main/updater/updateIpc.ts`、`apps/desktop/src/main/index.ts`：IPC 注册与组合根接线。
- `apps/desktop/src/main/updater/applyPendingUpdate.ts`：抽出 `installPendingUpdate`，启动安装与立即安装共用。
- `packages/ui/src/components/panels/UpdateSettingsGroup.tsx`、`SettingsPanel.tsx`：设置页「关于」分组。
- 相关 Note：[Windows 更新改为下次启动时安装](../architecture/2026-11-01-deferred-update-install-on-launch.md)。

## 决定

- 保留后台自动检查与 `autoDownload = true`：启动 5 秒首查、每 4 小时轮询不变；设置页的「检查更新」是手动触发同一轮检查，发现新版本后由 electron-updater 继续自动下载，用户不需要二次点击下载。
- 更新状态只由 main 进程的 `updateController` 持有，渲染层通过 `GetStatus` / `Check` / `Download` / `InstallNow` / `Status` 五个频道镜像；`UpdateStatus` 同时携带当前版本，设置页不再另设版本频道。
- 状态机为 `unsupported | idle | checking | up-to-date | available | downloading | downloaded | error`。自动检查失败只记日志并回到 `idle`；手动检查失败显示「无法连接更新服务器，请稍后重试」；下载失败保留候选版本并显示「重试下载」。
- 下载进度先更新 main 内存状态，再按「变化 ≥1% 或距上次推送 ≥250ms」节流推送 IPC；`GetStatus` 始终返回最新进度。
- Windows 的「立即重启安装」优先复用 `pending-update.json`：校验版本与安装包存在后拉起 NSIS、清除记录并退出；记录不可用时回退 `autoUpdater.quitAndInstall(false, true)`。macOS 直接走 `quitAndInstall`；Linux 与开发态显示 `unsupported`，但仍返回版本号。
- 设置页「关于」分组展示 `Answra vX.Y.Z`、当前阶段、进度与错误；`downloaded` 时提供「立即重启安装」，第一次点击只进入行内确认，第二次才执行，避免原生弹窗破坏隐身场景。
- 不新增更新源输入、频道切换、跳过此版本或独立「关于」Tab。

## 影响表面

- 「设置」Tab 底部新增「关于」分组：版本号、检查更新、下载进度、失败重试与立即重启安装。
- 手动检查发现新版本后立即进入自动下载，进度实时展示；下载完成后提示「下次启动应用时自动安装」。
- 开发态与 Linux 显示「更新不可用」及原因，不显示可执行按钮。
- 更新失败不再完全静默：手动检查与下载失败会在设置页可见并给出重试入口；后台检查失败仍只记日志。

## 曾考虑的替代方案

- **`autoDownload = false`，仅手动下载：** 舍弃。用户明确选择保留静默自动下载；改为手动后还需要在悬浮条或设置入口增加更新红点，否则多数用户会长期停留在旧版本。
- **完全手动，去掉 4 小时轮询：** 舍弃。最省流量，但失去自动更新能力，用户不打开设置就永远不更新。
- **新增独立「关于」Tab：** 舍弃。设置页已经承载账户/设置/公告三个入口，再多一个 Tab 会稀释入口层级；「关于」分组放在设置页底部即可，面板本身支持滚动。
- **立即安装统一走 `autoUpdater.quitAndInstall`：** 部分采用。macOS 使用该路径；Windows 仍以 pending 记录为主，保持与下次启动安装同一套校验与安装参数，减少两条路径的行为差异。

## 后果与防回退

- 「立即重启安装」会关闭应用，未落盘的草稿会丢失；行内确认文案必须保留。Windows 装机若紧接着关机，NSIS 覆盖写仍可能被打断，这与「下次启动安装」是同一类已知代价。
- `UpdateStatus` 是唯一状态来源；不要让渲染层根据 `availableVersion` 自行推算“可下载/可安装”，也不要新增第二个写更新状态的模块。
- 手动检查与定时检查共享 in-flight 保护，避免 electron-updater 报“检查正在进行”；恢复并发直调前先补测试。
- 后台检查失败的静默分流不能删：每 4 小时弹出一次离线错误会干扰使用。
- 若未来改为手动下载，必须先更新本 Note，并在设置入口增加更新提示，避免用户长期不更新。
- 开发态仍需返回版本号；把 `unsupported` 直接变成“无状态”会让设置页无法展示当前版本。

## 验证

- `apps/desktop/test/updateState.test.ts`：检查/下载/失败归约、下载失败保留候选版本、自动失败回到 idle。
- `apps/desktop/test/updateController.test.ts`：Windows 落 marker、非 Windows 退出安装、手动检查成功/失败、自动失败静默、下载重试、并发检查去重、立即安装三条路径与状态订阅。
- `packages/ui/test/UpdateSettingsGroup.test.tsx`：版本展示、手动检查、下载进度、失败重试、unsupported、订阅清理与无桥降级。
- `packages/ui/test/SettingsPanelTabs.test.tsx`：设置页出现「关于」分组与当前版本。
- `pnpm notes:check`、`pnpm verify` 通过。
- 打包版实机检查（COS `latest.yml`、下载进度、立即安装、下次启动安装）需在发版前执行；本环境未运行打包安装流程。
