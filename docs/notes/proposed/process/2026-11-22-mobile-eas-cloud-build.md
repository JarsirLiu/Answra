# Note：移动端 EAS 云构建配置

状态：提案

## 问题

Phase 0 只验证了 `expo export` 与自动化骨架，没有配置可重复的云构建路径。本机没有 JDK/Android SDK，无法本地 `expo prebuild` + Gradle 出 APK；后续 Phase 4 又必须真机安装。需要在用户注册 Expo/EAS 账号前，把 `apps/mobile` 调到“只差账号、项目 ID 和签名确认”的状态，同时不把任何账号或凭据写进仓库。

## 涉及范围

- 代码/模块：`apps/mobile/eas.json`、`apps/mobile/.gitignore`、根 `.gitignore`、`README.md`、`AGENTS.md`
- UI/进程/协议/持久化表面：不涉及
- 相关 Note：`docs/notes/proposed/architecture/2026-11-21-mobile-remote-controller-p2p.md`

## 提案

- Android-first 使用 EAS Build 云构建；`development` 用于开发构建并跳过 Android 凭据，`preview` 产出内部 APK，`production` 保留正式 APK profile。
- 不提交生成的 `android/`、`ios/`、`.expo/`、`web-build/` 与 `credentials.json`、`google-services.json`、keystore。
- EAS 项目 ID 由用户后续执行 `eas init` 写入 `app.json`，仓库不预置 UUID；签名凭据默认由 EAS 远程管理。
- CI 自动构建留到 Phase 4；届时再用 `EXPO_TOKEN` 与 GitHub Secrets，不在本变更中预置。

## 流程变化

- 本地开发仍用 `pnpm --filter @answra/mobile start` 与 Expo Go；涉及原生模块时改用 EAS development build。
- 出 APK：在 `apps/mobile` 执行 `eas build --platform android --profile preview`。
- 免费档每月 15 次 Android 构建；超出后按量或订阅。正式签名 keystore 由 EAS 生成/托管，丢失会导致无法覆盖升级。

## 曾考虑的替代方案

- **本地 Gradle 构建：** 需要 JDK 17 + Android SDK，当前环境缺失；作为备选保留 `prebuild:android`，不作为首版默认。
- **GitHub Actions 自建 Android runner：** 需要自行维护 JDK/Android SDK、缓存、签名与产物校验，首版范围过大；舍弃。
- **激进 `.easignore` 裁剪 monorepo：** EAS 默认从 Git 根上传，裁剪其他 workspace 包可能让 `pnpm install` 解析工作区失败；暂缓，先用根 `.gitignore` 排除 mobile 生成物与凭据。
- **EAS Submit / 商店分发：** 首版只发 Android APK，不提交 Play；不引入 Submit。

## 验收标准

- 可观察结果：
  - `eas build --platform android --profile preview` 在用户完成 `eas login` / `eas init` 后能产出 APK。
  - development profile 不要求 Android 签名凭据。
  - 仓库内不出现 EAS 项目 UUID、keystore、`credentials.json`。
- 自动化验证：
  - `pnpm --filter @answra/mobile typecheck` 通过。
  - `pnpm notes:check` 通过。
  - `pnpm lint` 通过。
- 需要的实机验证：
  - 用户账号下首次 EAS Android 构建与 APK 安装（Phase 4）。

## 风险

- EAS 免费档为低优先级队列，高峰期可能等待；构建额度每月重置。
- Android keystore 由 EAS 托管后，升级必须持续使用同一签名身份；后续 Phase 4 需记录凭据来源。
- monorepo 默认上传整个 Git 根，体积较大；后续如需优化，应先验证 `pnpm install` 对裁剪后工作区的解析。
- `eas build` 未配置项目 ID 时会提示初始化；这是预期状态，不是构建失败。
