# Note：GitHub Actions 双平台发布流水线（Windows + macOS）

状态：已实施

## 问题

仓库原有发版方式只有本地 Windows 脚本（`pnpm release:win`）。macOS 安装包必须在 macOS 上构建，且用户要求 Windows 与 macOS 都由 GitHub Actions 产出，不依赖开发者本机，也不再维护两套独立的平台流水线。

## 涉及范围

- 代码/模块：`.github/workflows/release.yml`、`apps/desktop/package.json`（`dist:mac`、`build.mac`）、`apps/desktop/scripts/adhoc-sign.cjs`、`apps/desktop/scripts/after-pack.cjs`、`apps/desktop/scripts/upload-to-cos.mjs`、`apps/desktop/build/entitlements.mac.plist`、根 `package.json`（`dist:mac`/`release:mac`）。
- UI/进程/协议/持久化表面：无运行时行为变化；只影响构建与分发。
- 相关 Note：[afterPack 产物审计写死 Windows 资源路径](../bug-fix/2026-11-01-afterpack-audit-macos-resources-path.md)、[answer-only 发布 Profile](../../implemented/architecture/2026-11-01-answer-only-release-profile.md)。

## 决定

- 单一 release 流水线，矩阵构建：`windows-latest` 跑 `dist:win`，`macos-14` 跑 `dist:mac`，两平台都产出 answer Profile 的安装包；`fail-fast: false` 保证一个平台失败不影响另一个平台的产物。
- 单一 publish 作业：`needs: build`，用 `actions/download-artifact`（`pattern: answra-*`、`merge-multiple: true`）把两平台产物合并到 `apps/desktop/release/`，再执行一次 `upload-to-cos.mjs`，统一写入 `download/latest/` 与 `download/v{version}/`。更新清单 `latest.yml` 与 `latest-mac.yml` 同目录共存，客户端按平台各取各的。
- COS 文件集合只取 latest 清单引用的更新安装包及其 blockmap，另加官网人工安装使用的 DMG；不上传 release 目录里的旧构建残留。每个前缀都先上传包与 blockmap，最后上传 `latest*.yml`。
- 发布前置校验：tag 推送时校验 `v{version}` 与 `apps/desktop/package.json` 的 `version` 一致；COS 凭证缺失时在 publish 阶段显式失败并给出提示，而不是静默跳上传。
- 手动触发默认只构建不上传（`workflow_dispatch` 的 `upload` 输入默认 `false`），只有打 tag 或手动勾选才执行 publish，避免验证性运行覆盖线上更新源。
- 分发双写：COS 是 electron-updater 与官网下载源；tag 构建同时用 `gh release upload` 把安装包与清单附到 GitHub Release（`gh release create --generate-notes --verify-tag` 不存在时创建）。
- macOS 不签名：`build.mac` 显式 `identity: null` + `hardenedRuntime: false`，`afterPack` 组合钩子先审计再 ad-hoc 签名（`codesign --force --deep --entitlements ... --sign -`），保证 Apple Silicon 可启动；检测到 `CSC_LINK`/`CSC_NAME` 时自动让位给真实签名。
- 版本号仍为 0.1.1（首次公开发布尚未发生，用户决定不跳版本）。

## 流程变化

- 发版入口：`git tag v{version}` + `git push origin v{version}`，或 Actions 里手动运行 `Release`。
- 构建产物：Windows `Answra-Setup-x64.exe` + blockmap + `latest.yml`；macOS `Answra-arm64.dmg/zip`、`Answra-x64.dmg/zip` + blockmap + `latest-mac.yml`。
- 仓库 Secrets 必需：`COS_SECRET_ID`、`COS_SECRET_KEY`。
- 发布 job 在 ubuntu-latest 上运行，需要 `pnpm install` 以获取 `cos-nodejs-sdk-v5`。

## 曾考虑的替代方案

- **每个平台一个独立 workflow（先做的 `release-mac.yml`）：** 舍弃。版本、Secret、上传逻辑会各写一份，tag 触发时无法保证两个平台同版本同时上线，属于不标准做法。
- **在各平台 job 内各自上传 COS：** 舍弃。上传逻辑重复、凭证在两处使用，且 `download/latest/` 的覆盖顺序不可控；集中到 publish 作业后只有一个写入点。
- **只上传到 GitHub Release，由用户手动同步到 COS：** 舍弃。electron-updater 指向 COS 的 generic feed，Release 无法替代更新源，手动同步必然产生遗漏。

## 验收标准

- 可观察结果：`Release` 运行中 `Build windows`、`Build macos`、`Publish to COS and GitHub Release` 三个作业；COS `download/latest/` 同时出现 `latest.yml` 与 `latest-mac.yml`。
- 自动化验证：`pnpm lint`、`pnpm notes:check` 通过；workflow 首次真实运行需在 GitHub 上完成（本地 Windows 无法验证 mac 打包）。
- 需要的实机验证：Windows 与 macOS 各自安装产物，确认可启动。

## 风险

- macOS 未签名：Gatekeeper 会拦截首次启动（需右键打开），且 Squirrel.Mac 无法应用未签名更新——mac 自动更新安装不可用，只能手动下载覆盖。这是不签名阶段的既定价。
- `macos-14` 上 electron-builder 的 dmg 生成与 `codesign --deep` 顺序未经实跑，可能需按日志调整。
- 私有仓库的 macOS runner 按 10 倍分钟计费。

## 验证

- `pnpm verify`（lint + typecheck + 42 个测试文件 / 268 用例 + 架构检查）与 `pnpm notes:check` 通过。
- `node apps/desktop/scripts/upload-to-cos.mjs --dry-run` 在本地 Windows 正确列出 `latest.yml` + exe + blockmap，证明上传文件集合逻辑未被 dmg 补丁破坏。
- 未执行：两平台打包与 COS 上传的真实运行；首次 `Release` 运行日志是唯一有效证据，需在运行后补记。

## 后果与防回退

- 新增平台（如 Linux）时只能加矩阵项 + 对应 `dist:*` 脚本，禁止另建 workflow，否则又回到多套发布入口。
- 任何安装包产物都必须能被 `upload-to-cos.mjs` 的文件集合覆盖（清单引用或 `.dmg`）；新增产物类型要同时改脚本，否则会出现"artifact 有、COS 没有"。
- 清单引用的更新链路安装包（exe/zip/appimage）缺 `.blockmap` 时上传脚本硬失败，禁止回退为只提示；相关更新行为见 [双平台自动更新与未签名 mac 自动换装](../feature/2026-11-01-cross-platform-auto-update.md)。
- 更新清单必须最后发布，不能让客户端先读到尚未就绪的新版本元数据；上传集合不得扩展为整个 `release/` 目录，以免引入无用文件与额外分发流量。
- tag 与版本号一致性校验不得移除，否则会出现 tag v0.1.2 但包内容为 0.1.1 的错版发布。
