# Note：本地模型 API Key 共享 OS keychain

状态：已实施

## 问题

桌面端与 CLI 已经共享 `config.json` 中的非 secret 模型字段，但 API Key 仍按客户端分裂：

- 桌面端把 Key 用 Electron `safeStorage` 加密后放在 `userData`，CLI 无法读取。
- CLI 只接受 `ANSWRA_API_KEY` / `--api-key`，或在 TUI 中输入一次；重启后需要重新输入。
- 用户在桌面端配置过的本地模型，切换 CLI 时仍要重新准备 Key，两个入口不像同一产品。

同时，用户明确否决明文 `0600` JSON 与主密码/环境变量方案，要求“简单好用、无需主密码”的跨端持久化。仓库既有安全边界也不允许把 API Key 写进共享 `config.json`。

## 涉及范围

- 新增 `packages/credentials`（`@answra/credentials`）：OS keychain 端口、`@napi-rs/keyring` 适配器、不可用错误与测试。
- `apps/desktop/src/main/conversation/modelSettings.ts`：改用共享 keychain，读取/写入/清除本地模型 Key。
- `apps/desktop/src/main/conversation/modelSecret.ts`：只保留旧 `safeStorage` 密文读取，用于一次性迁移。
- `apps/desktop/src/main/index.ts`：组合根注入共享配置路径、旧密钥路径与凭据库。
- `apps/cli/src/main.ts`、`cli/dependencies.ts`、`cli/codeCommand.ts`、`cli/configCommand.ts`、`tui/runTui.tsx`：CLI 读取、保存、清除 keychain Key。
- `apps/cli/src/config/cliOptions.ts`、`apps/cli/src/cli/help.ts`：新增 `config set --api-key` 与凭据边界说明。
- `apps/cli/scripts/build.mjs`、`apps/desktop/scripts/build-electron.mjs`、`apps/desktop/package.json`：原生模块 externalize、复制与 `asarUnpack`。
- `AGENTS.md`：登记新包、依赖方向与 secret 边界。
- 测试：`packages/credentials/test/credentials.test.ts`、`apps/desktop/test/modelSettings.test.ts`、`apps/desktop/test/modelRouter.test.ts`、`apps/cli/test/runCli.test.ts`、`runTui.test.ts`、`cliOptions.test.ts`、`remoteCommand.test.ts`。
- 相关 Note：
  - [桌面端与 CLI 共享本地模型配置](2026-11-13-shared-client-model-config.md)
  - [CLI 本地模型设置域与目录边界](2026-11-13-cli-model-settings-domain.md)
  - [CLI 启动时的模型配置引导](../feature/2026-11-13-cli-model-onboarding.md)
  - [CLI 启动引导中的 API Key 输入](../feature/2026-11-13-cli-onboarding-api-key-input.md)

## 决定

### 用 OS keychain 作为共享 secret 存储

- 新增 Node-only 包 `@answra/credentials`，唯一职责是本地模型 API Key 的 keychain 读写。
- 使用 `@napi-rs/keyring@2.1.2`，覆盖 Windows Credential Manager、macOS Keychain 与 Linux Secret Service。
- 固定条目：service `Answra`，account `local-model-api-key`。桌面端与 CLI 使用同一 service/account，因此同一个 OS 用户天然共享 Key。
- `config.json` 仍只保存 `baseUrl` / `chatModel` / `answerModel` / `source`，不保存 API Key。
- 登录令牌仍由桌面 `safeStorage` 负责，不进入本地模型 keychain 条目。

### 凭据优先级与 TUI 行为

```text
--api-key / ANSWRA_API_KEY
  > OS keychain
  > 无显式 Key
```

- 显式参数/环境变量仍最高优先，方便 CI、临时覆盖与故障排查。
- TUI 三步引导中输入非空 API Key 时写入 keychain；留空时读取 keychain 已有 Key。
- `answra config set --api-key <key>` 写入 keychain；`answra config unset` 同时清空本地模型配置与 keychain Key。
- 桌面端保存 `source=cloud` 时清除本地模型 Key；保存 `source=local` 且未提供新 Key 时保留已有 Key。
- Key 不进入 TUI store、输入历史、日志、测试快照或 `config.json`。

### 旧密钥迁移

- 桌面启动时读取旧 `conversation-model.json` 的 `encryptedKey`，或旧 `conversation-model-key.json` 的 `safeStorage` 密文。
- 迁移成功后写入 keychain，并清理旧字段/旧文件。
- keychain 写入失败时保留旧文件，下次启动重试；不静默丢弃 Key，也不回退明文。
- 旧 `modelSecret.ts` 只服务迁移，不再作为新密钥的写入路径。

### 不可用时 fail-closed

- keychain 不可用（原生模块缺失、Secret Service 未运行、权限拒绝等）时，读写抛 `CredentialStoreUnavailableError`。
- 不回退到明文文件、共享配置或自定义加密文件。
- 用户仍可用 `ANSWRA_API_KEY` / `--api-key` 或 TUI 内存输入完成当前会话。

### 打包与分发

- CLI esbuild 将 `@napi-rs/keyring` 保持 external，并把 keyring 包与当前平台 optional package 复制到 `dist/node_modules/@napi-rs/`。
- Electron main 将 `@napi-rs/keyring` 保持 external，并通过 electron-builder `asarUnpack` 解包原生模块。
- `answer` 发布 profile 也必须保留 keychain 的 `asarUnpack`，不能因裁剪资源而移除。

## 模块边界

- `@answra/credentials` 只依赖 `@napi-rs/keyring`，不依赖 Electron、Node 内置模块、React、Ink、Agent、CLI 或 desktop。
- desktop main 与 CLI 只通过 `@answra/credentials` 的公开入口消费；renderer/preload 禁止导入。
- `@answra/credentials` 不解释模型来源、不读写 `config.json`、不决定优先级；这些仍属于各客户端的模型设置域。
- keychain 原生模块只在适配器内部懒加载，避免非 keychain 测试路径加载平台二进制。

## 曾考虑的替代方案

- **明文 `0600` JSON：** 舍弃。用户明确否决；任何读文件的进程都能拿到 Key，文件权限不能替代系统凭据保护。
- **主密码 + 自定义加密文件：** 舍弃。需要额外解锁流程、密码遗忘恢复和跨端格式维护，违背“无需主密码”的目标。
- **环境变量作为唯一共享方式：** 舍弃。环境变量不是持久化配置，CLI/桌面各自启动时仍需用户设置，且容易进入 shell 历史。
- **桌面常驻并通过本地 IPC 提供 Key：** 舍弃。CLI 会依赖桌面运行，失去独立终端、CI 与 SSH 场景。
- **CLI 解密桌面 `safeStorage` 文件：** 舍弃。需要平台专属实现，扩大密钥暴露面，且与既有 CLI 边界冲突。
- **继续只保存在 TUI 内存：** 舍弃。重启后仍需重新输入，无法达到桌面与 CLI 共享凭据的目标。

## 后果与防回退

- 同一个 OS 用户下，桌面端与 CLI 共享同一份本地模型 Key；换机器仍需要重新配置，这是系统凭据库的边界。
- Windows Credential Manager 通常无感；macOS 可能弹出 Keychain 授权；Linux 依赖 Secret Service，未运行时必须 fail-closed。
- keychain 写入失败时桌面保存/迁移失败，CLI 的 `config set` 也会失败；不得为了让保存“成功”而写明文。
- `config.json` 仍可手动编辑；手动删除 Key 不在文件里，必须通过 `config unset` 或系统凭据管理器清除。
- 桌面与 CLI 仍没有跨进程锁；keychain 的最后一次写入生效。
- 原生模块必须随 CLI/Electron 分发；缺少平台包时应在启动/首次读写时明确报 keychain 不可用，而不是静默丢 Key。
- 新增 secret 字段前必须先判断是否属于本地模型 Key；登录令牌、OAuth token 不得复用这个 keychain 条目。

## 验收标准

- 可观察结果：
  - 桌面端保存本地模型 Key 后，CLI 不带 `ANSWRA_API_KEY` 启动仍能使用同一 Key。
  - `answra config set --api-key` 后重启 CLI 仍可读取；`config unset` 后 keychain 条目被删除。
  - keychain 不可用时 CLI/桌面明确报错，不生成明文 Key 文件。
  - 旧 `safeStorage` 密钥迁移成功后旧文件被清理；迁移失败时旧文件保留。
- 自动化验证：
  - `pnpm --filter @answra/credentials test`、`typecheck`。
  - `pnpm --filter @answra/desktop test -- modelSettings modelRouter`、`typecheck`。
  - `pnpm --filter @answra/cli test`、`typecheck`、`build`。
  - `pnpm architecture:check`、`pnpm notes:check`、`pnpm verify`。
- 需要的实机验证：
  - Windows Credential Manager 写入/读取/删除。
  - 打包后的 CLI 与 Electron 应用能加载 keyring 原生模块。
  - TTY 下三步引导写入 Key 后重启仍能读取。

## 验证

- 2026-11-13：`pnpm --filter @answra/credentials test` 通过 5 个测试；`typecheck` 通过。
- 2026-11-13：`pnpm --filter @answra/desktop test -- modelSettings modelRouter` 通过 22 个测试；`pnpm --filter @answra/desktop typecheck` 通过。
- 2026-11-13：`pnpm --filter @answra/cli test` 通过 25 个测试文件、167 个测试；`pnpm --filter @answra/cli typecheck` 通过。
- 2026-11-13：`pnpm --filter @answra/cli build` 通过；`dist/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node` 已复制。
- 2026-11-13：使用构建产物中的 keyring 包执行 Windows Credential Manager 写入、读取、删除 smoke test，结果通过。
- 待完成：打包后的 Electron/CLI 实机启动验证；TTY 下三步引导实机走查。

## 风险

- Linux 桌面环境未启动 Secret Service 时，keychain 会不可用；当前选择明确报错，而不是退回文件。
- 原生模块与 Electron/Node ABI 必须匹配；升级 Electron 或 Node 下限时要重新验证 keyring 平台包。
- 用户可能在系统凭据管理器中手动删除条目，CLI/桌面下次读取会表现为“没有 Key”，需要重新输入。
- keychain 条目按 OS 用户共享，不区分 Answra 桌面端与 CLI；这是共享目标，但也意味着同一用户的所有客户端会看到同一 Key。
