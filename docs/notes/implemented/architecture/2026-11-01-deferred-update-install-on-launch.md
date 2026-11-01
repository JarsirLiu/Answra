# Note：Windows 更新改为下次启动时安装

状态：已实施

## 问题

Windows 打包版此前使用 `autoInstallOnAppQuit`：更新在后台下载完成后，于 App 正常退出时由 electron-updater 静默拉起 NSIS 安装器。NSIS 是逐文件覆盖 `$INSTDIR`，没有事务与回滚；如果用户关闭 App 后几秒内就关机，安装器会被系统终止，可能留下“新 exe + 旧资源”的半更新状态。签名与 MSIX 打包当前都没有预算，不能靠更换安装格式解决。

## 涉及范围

- `apps/desktop/src/main/updater/updateController.ts`：Windows 不再在退出时安装，改为持久化待安装记录。
- `apps/desktop/src/main/updater/pendingUpdate.ts`：待安装记录的文件格式、读写与版本比较。
- `apps/desktop/src/main/updater/applyPendingUpdate.ts`：下次启动时静默拉起 NSIS 安装器。
- `apps/desktop/src/main/index.ts`：启动流程在创建窗口前消费待安装记录。
- 非 Windows 平台保持原有行为，不受影响。

## 决定

- Windows 打包版设置 `autoInstallOnAppQuit = false`；收到 `update-downloaded` 后只把 `{ version, installerPath }` 写入 userData 下的 `pending-update.json`，本次退出不做任何安装。
- 下次启动、创建窗口之前读取该记录：仅当记录版本严格新于当前 `app.getVersion()` 且安装包文件仍存在时，才以 `["--updated", "/S", "--force-run"]` 拉起安装器，清除记录并立即退出；安装器结束后重新拉起新版本。
- 版本不新、安装包丢失或记录损坏时清除记录并正常启动；安装器无法拉起时保留记录，下次启动重试。无法写入记录时回退为退出时安装，避免更新永久卡住。
- 安装完成后由版本号相等清掉陈旧记录，不会每次启动都重复安装。

## 模块边界

- `updateController` 只负责检查、下载和落记录，不决定何时安装。
- `applyPendingUpdate` 只负责启动时消费记录并拉起安装器，不感知更新源与下载逻辑。
- `index.ts` 作为组合根在启动最早阶段调用，命中后停止后续初始化；具体文件路径与进程细节留在 updater 目录。

## 曾考虑的替代方案

- **保持退出时安装，接受关机窗口风险：** 舍弃。这正是本次要消除的风险；NSIS 非原子，无法通过配置保证中断安全。
- **改为代码签名 + MSIX：** 暂缓。MSIX 由系统级事务部署，能从根本上避免半更新，但要求代码签名证书或微软商店分发，当前没有预算。
- **下载完成后立即 `quitAndInstall`：** 舍弃。会在用户使用过程中突然重启，打断正在进行的操作，体验代价高于启动时安装。
- **只提示用户手动重装：** 舍弃。失去静默更新，且多数用户不会主动执行。

## 后果与防回退

- 更新只在用户主动打开 App、系统稳定时安装，不再与关机流程重叠；但那次启动会短暂退出并由安装器重开，属于有意接受的代价。
- 若安装再次被中断（含启动后立刻关机），本次换机窗口仍可能留下半更新；恢复路径是重新运行官网安装包，覆盖安装即可修复。
- 不要恢复 Windows 的 `autoInstallOnAppQuit = true`；若未来引入签名或 MSIX，需先更新本 Note 并补实机验证。
- 记录只保存安装包路径引用的 electron-updater 缓存文件，不复制安装包；缓存被清理时按“无待安装更新”处理，由后台重新下载。

## 验证

- 新增 `pendingUpdate`、`applyPendingUpdate`、`updateController` 单测：记录往返、版本比较、陈旧记录清理、安装器拉起失败保留记录、非 Windows 不生效、Windows 下载后落记录。
- `pnpm --filter @answra/desktop test` 通过。
- `pnpm verify`：lint、全包 typecheck、测试与架构检查通过。
- 本 Note 满足 `notes:check` 的目录、状态与章节要求；仓库内另有历史 Note 的既有格式问题，与本次变更无关。
