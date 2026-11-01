# Note：双平台自动更新与未签名 mac 自动换装

状态：已实施

## 问题

当前两平台更新行为不完整且不对称：

- Windows：electron-updater 下载后写待安装记录，`installNow()` / 下次启动由 `applyPendingUpdate` 拉 NSIS 安装器，链路完整不需要改动。
- macOS（未签名构建）：`installMode === "manual"` 只检查不下载，mac 用户无法在应用内完成更新；手动装要自己面对 zip/dmg 拖拽，用户已明确否决（“不要出用户拖拽压缩包这种鬼点子”）。
- 曾有的半成品：mac 跳浏览器下载（`OpenDownload` 频道 + `downloadUrl`），绕开官方下载链路且没有应用内进度条，也没有真实消费方，随本方案作废。
- Windows 与 mac 的下载交互分叉，后续任何更新相关功能都要平台 fork UI。

硬约束：**应用不做 Apple 代码签名**（用户明确否决）。electron-updater 在 mac 上把安装交给 Squirrel.Mac，后者校验 Apple 签名/Team ID，未签名必然失败且无开关——这是 Apple 侧机制，不是实现选择。

## 涉及范围

- 代码/模块：`packages/shared/src/channels/update.ts`、`packages/shared/src/bridge.ts`、`packages/shared/src/distribution.ts`（删除）、`apps/desktop/src/main/updater/updateController.ts`、`apps/desktop/src/main/updater/macUpdateSwap.ts`（新增）、`apps/desktop/src/main/updater/updateIpc.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/preload/answer.ts`、`packages/ui/src/components/panels/UpdateSettingsGroup.tsx`、`apps/desktop/scripts/upload-to-cos.mjs`、`apps/desktop/package.json`
- UI/进程/协议/持久化表面：设置页「关于」分组、`Update*` IPC 频道、`UpdateStatus` 合同；COS 发布产物集合
- 相关 Note：[GitHub Release 流水线](../process/2026-11-01-github-release-pipeline.md)

## 决定

1. **下载不静默（双平台一致）**：`autoUpdater.autoDownload = false`；检查发现新版本停在 `available`，设置页「下载更新」按钮触发 `Download` 频道，进度复用现有 `download-progress` 推送与节流。与 opencode desktop（`electron-updater` + `autoDownload=false`）同构。
2. **macOS `auto-swap` 换装**（唯一自研面）：
   - 下载走 electron-updater 官方链路：`latest-mac.yml` 指向 `Answra-{arch}.zip`，享受 blockmap 差异更新；zip 是 electron-updater 在 mac 的更新介质硬契约，dmg 只供人工安装，不进更新链路。
   - `update-downloaded` 事件给出缓存 zip 路径，`MacSwapInstaller.extract`（`macUpdateSwap.ts`）用 macOS 自带 `ditto -x -k` 解出 `Answra.app` 到 `userData/mac-update/`；落盘不经浏览器，无 quarantine 属性。
   - `installNow()` 调 `startInstall`：写换装脚本（内容为纯函数 `macSwapScript`，spawn detached + unref）后 `app.quit()`。脚本逻辑：清 `.old` 残留 → `pgrep -f` 等旧进程退出（≤30s）→ 旧 app 挪 `.old` → 新版挪进原位（同卷 mv 原子）→ 失败从 `.old` 还原 → `open` 重启应用。目标目录由 `process.execPath` 反推，兼容 `~/Applications` 与 `/Applications`。
   - `autoUpdater.autoInstallOnAppQuit = false`（darwin），Squirrel 全程不被触碰。开发态维持 `unsupported`。
3. **合同收敛**：`UpdateStatus` 增加 `downloadedPath: string | null`（下载就绪后的本地安装载体路径：Windows 安装包 / 换出的 `.app`）；删除 `downloadUrl`、`UpdateChannels.OpenDownload`、`UpdateOpenDownloadResult`、`openUpdateDownload` 桥方法与 `packages/shared/src/distribution.ts`（其 `macInstallerDownloadUrl` 只服务浏览器方案）；`UpdateInstallMode` 改为 `"next-launch" | "auto-swap" | "on-quit"`。
4. **UI 收敛**：`downloaded` 阶段双平台同一形态（「立即重启安装」+确认文案），详情按 `installMode` 分别提示「下次启动应用时自动安装 / 将自动换装并重启 / 退出应用后自动安装」；`manual` 分支与「打开下载页」从 UI 删除。
5. **发布约束**：`upload-to-cos.mjs` 清单引用的更新链路安装包（exe/zip/appimage）缺 `.blockmap` 时硬失败退出；dmg 走旧的人工安装收集路径，无需 blockmap。mac `build.mac.extendInfo` 补 `NSMicrophoneUsageDescription`、`NSScreenCaptureUsageDescription`。

## 影响表面

- 设置页「关于」：两平台统一为「发现新版本 → 下载更新（进度条）→ 立即重启安装/自动换装重启」；mac 不再出现浏览器跳转或手动拖拽。
- `UpdateStatus`：新增 `downloadedPath`，移除 `downloadUrl`；`installMode` 取值变化影响设置页文案分支。
- 发布：COS 产物必须含 `latest-mac.yml`、`*.zip`、`*.zip.blockmap`，否则 publish 作业直接失败。

## 曾考虑的替代方案

- **Apple Developer ID 签名 + 公证**（opencode desktop 路线，官方唯一全自动）：签名年费与开发者账号要求被用户明确否决。
- **Tauri + tauri-plugin-updater / 自签名 latest.json**（cc-switch 路线）：Tauri 换装器不校验 Apple 签名，但换框架比例失衡，舍弃。
- **跳浏览器下载 dmg**（此前半成品）：绕开官方下载与差异更新、打断应用内体验，整体作废。
- **自研 HTTPS dmg 下载器**：重复造下载轮子且丢 blockmap 差异更新，舍弃。
- **electron-updater 下载 zip 后在 Finder 手动装**（natively 未签名 fallback）：用户仍要解压拖拽，被明确否决；本方案用 ditto 保官方链路并消掉 zip 手感。
- **`downloadedPath` 指向 dmg、用户重装**：引入第二分发介质且回到手动流程，舍弃。

## 后果与防回退

- mac 换装依赖 `MacSwapInstaller` 端口注入：darwin 打包态不注入或换装就绪信息缺失时，`installNow()` 返回 `{started:false}` 并保留日志，不静默吞掉。
- 更新完整性由 HTTPS + `latest.yml` sha512 保证，不及 Apple 签名级校验——无签名模式的固有代价，接受。
- 未来 Electron 升级若改变 Squirrel/更新缓存布局或 `ditto` 行为，必须重测 mac 换装（见风险）。
- 浏览器跳转与 `downloadUrl` 合同不得复活；更新相关新能力先落本 Note 对应模式，禁止在 UI 层分发平台逻辑。

## 验收标准

- Windows：下载改为点击触发；下载完成 → 「立即重启安装」/下次启动安装，均安装成功。
- macOS 打包态：点击「下载更新」出进度条；「立即重启安装」后应用自动关闭换装并以新版本弹开；全程不出现 zip/dmg 或 Finder 拖拽。
- 设置页文案按 `installMode` 区分且无 `manual` 残留；shared 契约中无 `downloadUrl`/`OpenDownload`。
- COS 发布产物含 `latest-mac.yml`、`*.zip`、`*.zip.blockmap`。

## 验证

- `apps/desktop/test/updateController.test.ts`：点击下载才触发（两平台）、mac 换装注入（下载 → extract → installNow spawn 先于 quit）、换装失败回 error 且可重试成功、`autoInstallOnAppQuit=false` 断言。
- `apps/desktop/test/macUpdateSwap.test.ts`：`extractAppPath` 反推与换装脚本内容（等待退出、原子替换、失败还原、重启命令）。
- `packages/ui/test/UpdateSettingsGroup.test.tsx`：available 停留与点击下载、`auto-swap` 的换装文案与确认安装；`SettingsPanelTabs.test.tsx` fixture 同步。
- 已通过：`pnpm verify`（biome lint、全包 typecheck、desktop 273 项 / UI 24 项测试、架构检查）。
- 平台实测（未完成，为 mac 发布验收点）：mac 真机换装一轮（arm64），记录系统版本与 Gatekeeper 行为；本机是 Windows 无法验证，装完 0.1.1 的用户不应期待同版本号内升级行为（见 Release 流水线 Note）。

## 风险

- 换装脚本在极端情况下（强制关机落在替换环节）依赖 `.old` 还原；mv 原子性保证不会出现半份 app，最坏是 `.old` 残留（脚本开头已清理）。
- 未签名更新不具备 Apple 级真实性校验，若 COS 账号被攻破则可能推送恶意包；缓解靠云账号安全（密钥轮换、子账号最小权限）。
- 换装脚本等待退出依赖 `pgrep -f` 匹配旧 app 路径；如未来二进制名/目录结构调整需同步脚本模式。
