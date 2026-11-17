# Note：安装包审计误拒 keychain 原生依赖，阻断答题版打包

状态：已实施

## 问题

`pnpm dist:win` 在 electron-builder `afterPack` 阶段失败，安装包无法产出：

```text
最终安装目录审计失败：
app.asar 包含已由 bundle 覆盖的运行时依赖：@napi-rs/keyring
app.asar 包含已由 bundle 覆盖的运行时依赖：@napi-rs/keyring-win32-x64-msvc
```

`answer` 与 `full` 共用同一审计脚本，因此 Windows 与 macOS 打包都被阻断。桌面 0.1.1 安装包构建于 keychain 改造之前，问题一直潜伏到下一次真实打包才暴露。

## 涉及范围

- `apps/desktop/scripts/audit-packaged-app.cjs`：`afterPack` 审计规则与 unpacked 原生依赖断言。
- `apps/desktop/package.json`、`apps/desktop/scripts/build-electron.mjs`、`apps/desktop/scripts/write-electron-builder-config.mjs`：keyring 的 `dependencies`、esbuild `external` 与 `asarUnpack` 声明（本次不改）。
- 相关 Note：[本地模型 API Key 共享 OS keychain](../architecture/2026-11-13-shared-model-api-key-keychain.md)。

## 根因

审计脚本把 `@napi-rs/` 整个 scope 记为 bundled-only，用于拦截“已被 bundle 吸收、却又被复制进 asar”的包。keychain 改造把 `@napi-rs/keyring` 声明为桌面运行时依赖，并在 esbuild 中保持 external、由 `asarUnpack` 解包到 `app.asar.unpacked`。`app.asar` 的条目清单仍会列出 unpacked 文件，审计据条目名命中 `@napi-rs/` 规则，误判为重复打包。

## 决定

- 审计对 `@napi-rs/keyring` 与平台二进制包（`@napi-rs/keyring-*`）豁免 bundled-only 判定；其它 `@napi-rs/` 包仍按原规则拒绝。
- 新增断言：`resources/app.asar.unpacked/node_modules/@napi-rs/keyring` 必须存在。缺少解包原生模块时仍失败，避免把“审计通过但运行时崩溃”的安装包放出去。
- 不修改 keyring 的打包方式：原生 `.node` 不能进 asar，external + `asarUnpack` 是该依赖的正确形态。

## 修复

- `audit-packaged-app.cjs` 的 bundled-only 规则对 `@napi-rs/keyring` 与 `@napi-rs/keyring-*` 豁免，其余 `@napi-rs/` 包仍拒绝。
- `afterPack` 增加 `app.asar.unpacked/node_modules/@napi-rs/keyring` 存在性断言，避免只放宽规则而漏掉真正缺包。
- 不改变 keyring 的 external / `asarUnpack` 声明，保持原生模块可加载。

## 曾考虑的替代方案

- **删除 `@napi-rs/` 通配规则**：会同时放过其它 `@napi-rs/` 包的重复打包，削弱审计。舍弃。
- **把 `@napi-rs/keyring` 打进 bundle**：原生模块无法从 asar 内加载，且与既有 external 决策冲突。舍弃。
- **把审计降级为警告**：坏包会直接进入分发链路，违背 profile 审计初衷。舍弃。

## 后果与防回退

- 新增原生 external 依赖时，必须同时更新：desktop `dependencies`、esbuild `external`、electron-builder `asarUnpack`、本审计的 native 白名单与 unpacked 断言；缺一项都会在打包或首启时暴露。
- `answer` profile 不得为了裁剪而移除 keychain 依赖，`full` 仍需 sherpa/unpacked 断言。

## 验收标准

- `pnpm dist:win` 完成 `answer` 打包并产出 NSIS 安装包。
- `release/win-unpacked/resources/app.asar.unpacked/node_modules/@napi-rs/keyring` 与平台二进制包存在。
- 其它 bundled-only 包仍无重复打包。

## 风险

- 白名单按名称前缀匹配，若未来新增 `@napi-rs/keyring` 之外的 keychain 实现，需要按同流程登记，不能放宽成整个 scope。
- 审计只断言基础包目录存在，平台二进制包缺失仍依赖 electron-builder 的 optional dependency 解析。

## 验证

- 2026-11-15：修复前 `pnpm dist:win` 在 `afterPack` 失败；修复后构建通过并产出安装包。
- 2026-11-15：`pnpm lint` 通过；`release/win-unpacked/resources/app.asar.unpacked/node_modules/@napi-rs/keyring` 与 `@napi-rs/keyring-win32-x64-msvc` 均存在。
