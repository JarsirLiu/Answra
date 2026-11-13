# Note：桌面端与 CLI 共享本地模型配置

状态：已实施

## 问题

桌面端与 CLI 已共享 Agent 运行时，但模型配置仍有两套来源：

- 桌面端把 `source/baseUrl/model/answerModel/apiKey` 一起写入 `userData/conversation-model.json`，密钥由 Electron `safeStorage` 加密，依赖 app ready 与平台密钥环。
- CLI 只读 `ANSWRA_AI_BASE_URL`、`ANSWRA_MODEL`、`ANSWRA_API_KEY` 或命令行参数，无法复用用户在桌面端已经填好的本地模型。
- CLI 因此每次换机器或换终端都要重复配置，两个客户端不像同一产品的不同入口。

本次目标是把**用户自己配置的本地模型**统一到一份共享配置；CLI 未来可以支持云端登录，但本次不实现。

## 涉及范围

- 新增 `packages/config`（`@answra/config`）：Node-only 共享配置库，负责路径、校验、原子读写。
- `apps/desktop/src/main/conversation/modelSettings.ts`：改为共享配置 + 桌面密钥存储 + 旧文件迁移。
- `apps/desktop/src/main/conversation/modelSecret.ts`：`safeStorage` 密文密钥存储。
- `apps/desktop/src/main/index.ts`：组合根注入共享配置路径与旧路径。
- `apps/cli/src/config/modelConfig.ts`、`sharedConfig.ts`、`cli/codeCommand.ts`、`cli/dependencies.ts`、`main.ts`：参数/环境变量优先，其次共享本地模型。
- `apps/cli/src/cli/help.ts`：说明共享配置与密钥边界。
- `AGENTS.md`、`scripts/architecture/architecture-check.mjs`：登记新包与 Node-only 边界。
- 测试：`packages/config/test/config.test.ts`、`apps/desktop/test/modelSettings.test.ts`、`apps/cli/test/modelConfig.test.ts`、`apps/cli/test/runCli.test.ts`。

## 决定

### 共享文件只放非 secret 字段

共享路径统一为：

- Windows：`%APPDATA%\Answra\config.json`
- macOS：`~/Library/Application Support/Answra/config.json`
- Linux：`$XDG_CONFIG_HOME/Answra/config.json` 或 `~/.config/Answra/config.json`

文件形状：

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
- `local` 始终保留用户配置的本地端点；桌面端切到云端不会清掉它，CLI 目前只消费这一块。
- 文件不包含 API Key、登录令牌或任何可解密 secret。写入使用临时文件 + rename，权限 0600。

### 密钥仍按客户端保存

- 桌面端继续用 `safeStorage`，密钥移到 `userData/conversation-model-key.json`，共享文件只有非 secret 字段。
- CLI 继续使用 `ANSWRA_API_KEY` 或 `--api-key`，不读取、不解密桌面密文。
- 如果本地端点需要鉴权，桌面与 CLI 需要各自提供 Key；这是安全边界，不是实现遗漏。

### CLI 优先级与兼容性

```text
--base-url / --model / --api-key
  > ANSWRA_AI_BASE_URL / ANSWRA_MODEL / ANSWRA_API_KEY
  > 共享 config.json 的 model.local
  > 报错
```

- CLI 本次只把共享配置解析为 `auth: "local"`；`source: "cloud"` 不触发云端调用，也不会被误当成可用本地端点。
- 未来 CLI 云端登录实现后，再读取 `source` 与账号 token；本次不预埋 token 或云端分支。
- CLI 的 `answer` 路由在共享配置下使用 `answerModel`，命令行覆盖模型时两路都用覆盖值，避免 chat/answer 不一致。

### 桌面迁移与产品门禁

- 首次 `init` 读取旧 `conversation-model.json`：非 secret 字段迁移到共享文件，`encryptedKey` 迁移到新密文文件；两者成功后删除旧文件。
- 迁移失败保留旧文件，下次启动重试，不静默丢配置。
- 打包版 `localAvailable = !app.isPackaged` 保持不变。本次只共享配置，不改变“打包版本地来源折叠为云端”的产品门禁；是否正式开放桌面本地模型是独立决策。

## 模块边界

- `@answra/config` 只负责契约、路径、校验与原子 I/O；不依赖 Electron、Ink、UI 或 Agent 运行时。
- 只允许 desktop main 与 CLI 导入；renderer/preload 禁止导入这个 Node-only 包。
- 桌面 `safeStorage` 密钥存储留在 `apps/desktop/src/main`；CLI 只读非 secret 共享文件，不反向依赖桌面。
- 模型路由、Agent 事件与会话状态不进入 `packages/config`。

## 曾考虑的替代方案

- **把 API Key 明文放进共享文件：** 舍弃。任何读文件的进程都能拿到 Key，违反既有 `safeStorage`/secret 边界。
- **CLI 解密桌面 `safeStorage` 文件：** 舍弃。需要平台专属实现，扩大密钥暴露面，且与 `2026-11-13-cli-dev-script.md` 的既有拒绝理由冲突。
- **桌面常驻并通过本地 IPC 提供配置：** 舍弃。CLI 会依赖桌面运行，失去独立终端/CI/SSH 场景。
- **桌面与 CLI 各写一套配置 I/O：** 舍弃。路径、校验、迁移和原子写会分叉，最终又回到两套行为。
- **本次一并开放打包版本地模型：** 暂缓。会改变订阅与登录门禁，需要单独产品决策与权限评估。
- **本次一并实现 CLI 云端登录：** 暂缓。需要 device code/OAuth 与后端支持，不能只靠本地配置。

## 后果与防回退

- 桌面配置本地模型后，CLI 不带参数即可使用同一 `baseUrl/model/answerModel`；需要鉴权的端点仍需设置 `ANSWRA_API_KEY`。
- 桌面切到云端不会破坏 CLI 的本地模型配置；但桌面“清除配置”会同时清空共享本地配置。
- 共享文件读取发生在 CLI 启动时，没有文件监听；桌面修改后需重新启动 CLI。
- 两端同时写配置时按最后一次原子替换生效，不提供跨进程锁。
- CLI 仍不支持云端登录；配置里的 `source: "cloud"` 不会让 CLI 获得云端能力。
- 共享文件损坏时桌面按默认云端继续启动，CLI 明确报配置读取错误，不静默使用猜测端点。
- 新包是 Node-only，禁止 renderer/preload 导入；架构脚本已显式允许 `packages/config/src` 使用 Node 内置模块。
- 后续新增共享字段前必须先判断是否 secret；API Key、OAuth token、登录态不得进入 `config.json`，也不得让 CLI 解密桌面密文。

## 验证

- 2026-11-13：`pnpm --filter @answra/config test` 通过，5 个测试覆盖路径解析、原子读写、缺失文件、版本/端点校验。
- 2026-11-13：`pnpm --filter @answra/desktop test` 通过，52 个测试文件、325 个测试；其中 4 个 `ModelSettingsStore` 测试覆盖共享写入、密钥密文、云端切换保留本地端点、旧文件迁移与清理，`modelRouter` 15 个测试保持通过。
- 2026-11-13：`pnpm --filter @answra/cli test` 通过，15 个测试文件、88 个测试；8 个模型配置测试覆盖共享回退、逐字段覆盖与空环境变量占位回退，9 个 `runCli` 测试覆盖共享配置实际进入会话配置。
- 2026-11-13：`@answra/config`、`@answra/desktop`、`@answra/cli` typecheck 通过；`pnpm architecture:check` 通过（6 个 workspace 包）。
- 2026-11-13：`pnpm lint` 通过（632 files）、`pnpm notes:check` 通过、`pnpm tokens:check` 通过；`pnpm --filter @answra/cli build` 通过。
- 2026-11-13：`pnpm --filter @answra/ui test` 单独执行通过（43 个文件、300 个测试）。全仓并行 `pnpm verify` 仍在既有 `@answra/ui` 用例上出现 4 个 5s 超时；失败文件单独重跑 13/13 通过，本轮未改 UI 运行代码。
