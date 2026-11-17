# Note：桌面端与 CLI 共享本地模型配置

状态：已实施

## 问题

桌面端与 CLI 已共享 Agent 运行时，但模型配置仍有两套来源：

- 桌面端把 `source/baseUrl/model/answerModel/apiKey` 一起写入 `userData/conversation-model.json`，密钥由 Electron `safeStorage` 加密，依赖 app ready 与平台密钥环。
- CLI 只读 `ANSWRA_AI_BASE_URL`、`ANSWRA_MODEL`、`ANSWRA_API_KEY` 或命令行参数，无法复用用户在桌面端已经填好的本地模型。
- CLI 因此每次换机器或换终端都要重复配置，两个客户端不像同一产品的不同入口。

本次目标是把用户自己配置的本地模型统一到一份共享配置，并让 API Key 通过共享 OS keychain 在桌面端与 CLI 之间复用；CLI 云端登录仍不在本次范围。

## 涉及范围

- `packages/config`（`@answra/config`）：Node-only 共享配置库，负责路径、校验、原子读写。
- `packages/credentials`（`@answra/credentials`）：Node-only OS keychain 凭据库，只负责本地模型 API Key。
- `apps/desktop/src/main/conversation/modelSettings.ts`：共享配置 + keychain + 旧文件迁移。
- `apps/desktop/src/main/conversation/modelSecret.ts`：只保留旧 `safeStorage` 密文读取，用于迁移。
- `apps/desktop/src/main/index.ts`：组合根注入共享配置路径、旧密钥路径与凭据库。
- `apps/cli/src/model/`、`adapters/sharedModelStore.ts`、`cli/configCommand.ts`、`cli/codeCommand.ts`、`cli/dependencies.ts`、`main.ts`：参数/环境变量优先，其次共享本地模型与 keychain。
- `apps/cli/src/cli/help.ts`：说明共享配置与密钥边界。
- `AGENTS.md`、`README.md`、`scripts/architecture/architecture-check.mjs`：登记新包与 Node-only 边界。
- 测试：`packages/config/test/config.test.ts`、`localModel.test.ts`、`packages/credentials/test/credentials.test.ts`、`apps/desktop/test/modelSettings.test.ts`、`apps/cli/test/modelSettings.test.ts`、`runCli.test.ts`。
- 相关 Note：
  - [本地模型 API Key 共享 OS keychain](2026-11-13-shared-model-api-key-keychain.md)
  - [CLI 本地模型设置域与目录边界](2026-11-13-cli-model-settings-domain.md)
  - [CLI 启动时的模型配置引导](../feature/2026-11-13-cli-model-onboarding.md)

## 决定

### 共享文件只放非 secret 字段

共享路径统一为：

- Windows：`%APPDATA%\Answra\config.json`
- macOS：`~/Library/Application Support/Answra/config.json`
- Linux：`$XDG_CONFIG_HOME/Answra/config.json` 或 `~/.config/Answra/config.json`

文件形状为：

```json
{
  "version": 1,
  "model": {
    "source": "local",
    "local": {
      "baseUrl": "http://127.0.0.1:1234/v1",
      "chatModel": "qwen",
      "answerModel": "qwen-vl"
    }
  }
}
```

- `source` 是桌面端当前来源，保留给未来 CLI 云端登录使用。
- `local` 始终保留用户配置的本地端点；桌面端切到云端不会清掉它。
- 文件不包含 API Key、登录令牌或任何可解密 secret。写入使用临时文件 + rename，权限 `0600`。

### API Key 共享 OS keychain

- 桌面端与 CLI 通过 `@answra/credentials` 使用同一 service/account：`Answra` / `local-model-api-key`。
- 底层使用 `@napi-rs/keyring`，对应 Windows Credential Manager、macOS Keychain、Linux Secret Service。
- keychain 不可用时 fail-closed；不回退明文文件，也不把 Key 写进 `config.json`。
- 登录令牌仍由桌面 `safeStorage` 负责，不进入本地模型 keychain 条目。

### 凭据优先级与兼容性

```text
模型字段：--base-url / --model > ANSWRA_AI_BASE_URL / ANSWRA_MODEL > 共享 config.json 的 model.local > 报错
API Key：--api-key > ANSWRA_API_KEY > OS keychain > 无显式 Key
```

- 参数与环境变量逐字段覆盖共享配置；Key 与模型字段分开解析。
- CLI 只把共享配置解析为 `auth: "local"`；`source: "cloud"` 不触发云端调用，也不会被误当成可用本地端点。
- CLI 写入时把 `source` 置为 `local`；`config unset` 清空本地模型并把 `source` 置回 `cloud`，同时删除 keychain 条目。
- CLI 的 `answer` 路由在共享配置下使用 `answerModel`；命令行覆盖模型时两路都用覆盖值。

### 桌面迁移与产品门禁

- 首次读取旧 `conversation-model.json`：非 secret 字段迁移到共享文件，旧 `encryptedKey` 或旧 `conversation-model-key.json` 的 `safeStorage` 密文迁移到 keychain。
- 迁移成功后清理旧字段/旧文件；keychain 写入失败时保留旧文件，下次启动重试。
- 打包版 `localAvailable = !app.isPackaged` 在本 Note 落地时保持不变。2026-11-17 起 answer 打包版开放本地来源，full 仍折叠为云端，见[答题安装包支持本地模型](../feature/2026-11-17-answer-package-local-model.md)。

## 模块边界

- `@answra/config` 只负责非 secret 契约、路径、校验与原子 I/O；不依赖 Electron、Ink、UI 或 Agent 运行时。
- `@answra/credentials` 只负责 keychain 读写；不读写 `config.json`，不解释模型来源或优先级。
- 只允许 desktop main 与 CLI 导入这两个 Node-only 包；renderer/preload 禁止导入。
- 桌面 `safeStorage` 只保留旧密钥迁移读取；CLI 不读取、不解密桌面 `safeStorage` 文件。
- 模型路由、Agent 事件与会话状态不进入 `packages/config` 或 `packages/credentials`。

## 曾考虑的替代方案

- **把 API Key 明文放进共享文件：** 舍弃。任何读文件的进程都能拿到 Key，违反既有 secret 边界；用户也明确否决。
- **CLI 解密桌面 `safeStorage` 文件：** 舍弃。需要平台专属实现，扩大密钥暴露面，且与 CLI 独立宿主边界冲突。
- **桌面常驻并通过本地 IPC 提供配置：** 舍弃。CLI 会依赖桌面运行，失去独立终端/CI/SSH 场景。
- **桌面与 CLI 各写一套配置 I/O：** 舍弃。路径、校验、迁移和原子写会分叉，最终又回到两套行为。
- **本次一并开放打包版本地模型：** 暂缓。会改变订阅与登录门禁，需要单独产品决策与权限评估；该决策已由[答题安装包支持本地模型](../feature/2026-11-17-answer-package-local-model.md)落地到 answer profile。
- **本次一并实现 CLI 云端登录：** 暂缓。需要 device code/OAuth 与后端支持，不能只靠本地配置。

## 后果与防回退

- 桌面配置本地模型后，CLI 不带参数即可使用同一 `baseUrl/model/answerModel` 与 keychain Key；需要鉴权的端点不再要求每次启动重新输入。
- 桌面切到云端会清除 keychain Key，但不会破坏共享本地端点；CLI 仍可读取本地端点，只是没有 Key。
- 共享文件读取发生在 CLI 启动时，没有文件监听；桌面修改后需重新启动 CLI。
- 两端同时写配置时按最后一次原子替换生效，不提供跨进程锁；keychain 同样以最后一次写入为准。
- 共享文件损坏时桌面按默认云端继续启动，CLI 明确报配置读取错误，不静默使用猜测端点。
- 新包均为 Node-only，禁止 renderer/preload 导入；架构脚本已显式允许 `packages/config/src` 使用 Node 内置模块。
- 后续新增共享字段前必须先判断是否 secret；API Key、OAuth token、登录态不得进入 `config.json`，也不得让 CLI 解密桌面密文。

## 验证

- 2026-11-13：`pnpm --filter @answra/config test` 通过，覆盖路径解析、原子读写、缺失文件、版本、端点校验与共享 local 字段合并。
- 2026-11-13：`pnpm --filter @answra/credentials test` 通过 5 个测试；`typecheck` 通过。
- 2026-11-13：`pnpm --filter @answra/desktop test -- modelSettings modelRouter` 通过 22 个测试；`pnpm --filter @answra/desktop typecheck` 通过。
- 2026-11-13：`pnpm --filter @answra/cli test` 通过 25 个测试文件、167 个测试；`pnpm --filter @answra/cli typecheck` 通过。
- 2026-11-13：`pnpm --filter @answra/cli build` 通过，keyring 平台包已复制到 `dist/node_modules/@napi-rs/`；Windows Credential Manager smoke test 通过。
- 待完成：打包后的 Electron 实机启动验证、TTY 实机走查与全量 `pnpm verify`。

## 风险

- Linux 未启动 Secret Service 时 keychain 不可用；当前选择明确报错，而不是退回文件。
- 原生模块与 Electron/Node ABI 必须匹配；升级 Electron 或 Node 下限时要重新验证 keyring 平台包。
- 用户可能在系统凭据管理器中手动删除条目，CLI/桌面下次读取会表现为“没有 Key”。
- keychain 条目按 OS 用户共享，不区分桌面端与 CLI；这是共享目标，但也意味着同一用户的所有客户端会看到同一 Key。
