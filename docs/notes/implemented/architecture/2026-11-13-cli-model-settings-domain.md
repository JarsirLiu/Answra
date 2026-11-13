# Note：CLI 本地模型设置域与目录边界

状态：已实施

## 问题

CLI 已经能读取桌面端写入的共享 `config.json`（`@answra/config`），但还不能自己添加或切换本地模型。补这个能力时，原目录会暴露三个问题：

- `apps/cli/src/config/` 同时放 argv 语法、优先级解析、文件 I/O 和 cwd 校验；再加入写入和 `/model` 后，这个目录会变成命令解析、持久化和 UI 的混合层。
- `apps/cli/src/tui/runTui.tsx` 直接在命令 switch 里处理 `/help`、`/clear`、`/exit`；如果 `/model` 也写在这里，TUI 会同时依赖文件路径、合并规则和会话重配，无法独立测试。
- `apps/cli/src/session/codingSession.ts` 的 `model` 是构造时只读，`host.configure()` 只在 `open()` 调一次；会话内切换模型需要显式的会话端口，而不是让 TUI 重建整个会话。

桌面端 `apps/desktop/src/main/conversation/modelSettings.ts` 已经有一套本地字段合并逻辑。CLI 如果自己再写一套，两个写者会逐渐产生不同的 `answerModel` 保留、尾部斜杠和 source 行为。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/model/`：`ports.ts`、`selection.ts`、`precedence.ts`、`settingsService.ts`；只放值对象、校验、优先级和应用服务，不碰 fs、Ink、argv。
  - `apps/cli/src/adapters/sharedModelStore.ts`：`@answra/config` 的唯一文件实现。
  - `apps/cli/src/cli/configCommand.ts`：`answra config show|set|unset` 用例。
  - `apps/cli/src/config/cliOptions.ts`：新增 `config` 的 argv 语法；不读写文件。
  - `apps/cli/src/session/codingSession.ts`：新增 `setModel()` 窄端口。
  - `apps/cli/src/tui/commands/catalog.ts`、`commands/parse.ts`、`commands/dispatch.ts`、`commands/modelCommand.ts`、`app/viewStore.ts`：`/model` 元数据、解析、分派、执行与状态行标签。
  - `apps/cli/src/presentation/modelSummary.ts`：模型摘要纯文本投影。
  - `packages/config/src/localModel.ts`：桌面与 CLI 共用的 normalize/merge 纯函数；桌面 `resolveLocal` 已改为复用。
  - `packages/credentials`：CLI 与桌面共享的本地模型 API Key keychain 读写。
  - 测试：`apps/cli/test/modelSettings.test.ts`、`runCli.test.ts`、`codingSession.test.ts`、`commands.test.ts`、`runTui.test.ts`、`packages/config/test/localModel.test.ts`、`packages/credentials/test/credentials.test.ts`。
  - `AGENTS.md` 与 `README.md`：登记 `apps/cli/src/model` 的职责和禁止项。
- 持久化表面：非 secret 模型字段仍只有 `%APPDATA%\Answra\config.json`（Windows）等共享文件；API Key 只写 `@answra/credentials` 的 OS keychain，没有新增 CLI 私有 secret 文件。
- 相关 Note：
  - [桌面端与 CLI 共享本地模型配置](2026-11-13-shared-client-model-config.md)
  - [本地模型 API Key 共享 OS keychain](2026-11-13-shared-model-api-key-keychain.md)
  - [CLI Coding 模式与终端 UI 提案](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)

## 决定

### 目标目录

```text
apps/cli/src/
  main.ts                     # 组合根：构造 adapter/service 并注入 runCli
  cli/
    runCli.ts                 # 只做命令分派
    dependencies.ts           # 端口集合
    configCommand.ts          # config show/set/unset
    codeCommand.ts
  config/                     # 只做 argv 与 cwd 校验
    cliOptions.ts
    workspace.ts
  model/                      # CLI 模型设置域
    ports.ts                  # Store/ModelSettings 端口与 DTO
    selection.ts              # 输入校验与 LocalModelConfig 组装
    precedence.ts             # flag > env > shared
    settingsService.ts        # resolve/switch/add/clear
  adapters/
    sharedModelStore.ts       # @answra/config 文件实现
    agentCodingHost.ts
  session/
    codingSession.ts          # setModel()
  presentation/
    modelSummary.ts           # config show 文本
  tui/
    commands/catalog.ts       # /model 语法元数据
    commands/parse.ts         # 通用 slash 解析
    commands/dispatch.ts      # /model 分派
    commands/modelCommand.ts  # /model 执行
    runTui.tsx                # 只编排
    app/viewStore.ts          # modelLabel
```

`packages/config` 只增加纯函数模块 `localModel.ts`，不新增第二个持久化实现。

### 依赖方向

```text
main -> cli -> model -> @answra/shared（纯类型）
main -> adapters -> @answra/config（唯一 fs 入口）
tui -> model（端口）+ session（端口）+ ui
model -X-> tui / cli / adapters / node:fs
session -X-> 配置持久化
```

`model/` 只认识端口和 `@answra/config` 的类型/纯函数，不认识文件路径；真实路径和读写由 `main.ts` 注入 `adapters/sharedModelStore.ts`。TUI 不 import `@answra/config` 或 `node:fs`，只调用 `ModelSettings` 端口。

### 端口与语义

- `ModelOverrides`：一层覆盖，字段缺省表示继续向下查找；不含 API Key。
- `LocalModelInput`：`baseUrl`、`chatModel`、可选 `answerModel`；不含 secret。
- `ModelSettingsSnapshot`：`source`、`local`、`configured`，供 `config show` 与 `/model` 展示。
- `ModelSettingsStore`：`read()` / `write()`，只做共享文件 I/O，不解释优先级或 source。
- `ModelSettings`：`resolve()` / `snapshot()` / `addLocal()` / `switchChatModel()` / `clearLocal()`。
- `resolve()` 返回 `ConversationModelConfig`，不返回 access token；凭据由命令层从 `ANSWRA_API_KEY` / `--api-key` 或 `@answra/credentials` 的 OS keychain 读取后注入会话。
- `addLocal` 校验后写入共享本地模型并把 `source` 置为 `local`；`switchChatModel` 只替换 chat 模型并保留端点与 answer 模型；`clearLocal` 清空 `model.local` 并把 `source` 置回 `cloud`，不删除文件。
- 模型字段优先级保持：flag > env > 共享 `model.local`，逐字段回退；凭据优先级为 `--api-key` / `ANSWRA_API_KEY` > keychain，TUI 非空输入写入 keychain。

### 命令表面

- `answra config show`：打印 `source/baseUrl/chatModel/answerModel/configured`，不打印密钥。
- `answra config set --base-url <URL> --model <ID> [--answer-model <ID>]`：写入共享配置并切到 local。
- `answra config unset`：清空共享 `model.local`，把 `source` 置回 cloud。
- TUI `/model`：显示摘要；`/model <ID>` 切换并持久化；`/model add <base-url> <model-id> [answer-model]` 添加并切换。运行中拒绝修改，但不重建会话或活动 run。

### 明确不做

- 不新增 `apps/cli/src/utils/`、`services/`、`core/` 或通用 DI/命令框架。
- 不做 `profiles[]`、`--profile`、`/v1/models` 自动发现和云端登录。
- 不把 API Key、OAuth token 或任何可解密 secret 写进共享配置；本地模型 API Key 只写 OS keychain，keychain 不可用时 fail-closed。
- 不让 `tui/` 直接写文件，不让 `session/` 知道配置路径，不让 `config/` 承载持久化。
- 不做会话内 cloud/local 来源切换；`/model` 只操作本地模型。

## 模块边界

| 目录 | 只放 | 禁止 |
| --- | --- | --- |
| `cli/` | 命令用例、退出码、依赖端口 | fs、Ink 组件、模型 URL 校验细节 |
| `config/` | argv 语法、cwd 校验 | 读写配置、会话、事件 |
| `model/` | 选择值对象、优先级、持久化端口、应用服务 | Ink、fs、终端输出 |
| `adapters/` | `@answra/config` 文件实现、Agent host 映射 | 业务规则、命令分派 |
| `session/` | 单活动 run 与会话生命周期 | 配置持久化、TUI |
| `presentation/` | 事件/设置到文本的纯投影 | 读写状态、打开文件 |
| `tui/` | 交互、视图状态、slash 解析 | 直接 import `@answra/config` 或 `node:fs` |

## 曾考虑的替代方案

- **继续把新能力放在 `apps/cli/src/config/`：** 舍弃。argv、优先级、文件 I/O 和 UI 会继续堆在同一目录，新增 `/model` 时无法独立测试，也无法按职责并行。
- **CLI 使用自己的私有配置文件：** 舍弃。会破坏“桌面与 CLI 共享一套本地模型”的目标，用户需要在两个客户端重复配置；共享文件已经是既成契约。
- **让 TUI 直接调用 `@answra/config` 写文件：** 舍弃。TUI 会依赖 fs、路径和合并规则，测试要触碰真实用户目录；写操作也无法被命令层复用。
- **CLI 复制桌面端的本地字段合并逻辑：** 舍弃。桌面 `resolveLocal` 已处理 `answerModel` 保留和尾部斜杠；两个实现会在后续字段扩展时分叉。改为在 `@answra/config` 提供纯合并函数，并让桌面复用。
- **引入通用 DI 容器或命令框架：** 舍弃。CLI 只有少量命令和端口，`main.ts` 手工接线更可读；通用框架会扩大启动路径和测试成本。
- **v1 直接做多模型 profiles 和 Ink 选择器：** 暂缓。当前需求是“能添加并切换一个本地模型”；profiles 和交互式 picker 需要新的持久化形状和 TUI 状态机，等真实复用出现再做。

## 后果与防回退

- 桌面与 CLI 同时写共享文件仍是“最后一次原子替换生效”，没有跨进程锁；配置可能被覆盖，v1 接受。
- 共享文件没有文件监听；桌面修改后需要重启 CLI，`config show` 只反映启动时或本次命令读取的值。
- `addLocal` 把 `source` 置为 local 会改变开发态桌面的当前来源；打包版仍按既有门禁把 local 折叠为 cloud。两个客户端对 source 的解释由 `packages/config` 的共享形状约束。
- `CodingSession.setModel()` 在运行中直接拒绝，不改变当前 run 的端点；`/model` 也先检查 TUI 忙碌状态。
- `/model add` 采用空格分隔参数，v1 只接受标准 URL 和模型 ID；包含空格的路径式参数需要后续参数语法。
- `config` 子命令与 `/model` 必须同步 `apps/cli/src/cli/help.ts` 和 `apps/cli/src/tui/commands/catalog.ts` 的稳定文案，避免文档与行为漂移。
- `answerModel` 在共享保存时由 `mergeLocalModel` 保留；`addLocal` 未提供 answer 模型时不写该字段，解析时回退到 chat 模型，避免沿用另一个端点上的旧值。

## 验证

- `pnpm --filter @answra/config test`：覆盖 normalize/merge，包括尾部斜杠、空 answer、切回 cloud 时保留本地端点。
- `pnpm --filter @answra/cli test`：覆盖逐字段优先级、缺失配置报错、`config show/set/unset`、`/model` 查询/切换/添加/运行中拒绝，以及 `CodingSession.setModel` 的关闭与运行中拒绝。
- `pnpm --filter @answra/desktop test -- modelSettings`：证明桌面本地字段行为在改用共享纯函数后未改变。
- `pnpm typecheck`、`pnpm architecture:check`、`pnpm lint`、`pnpm notes:check` 必须通过。
- 2026-11-13：`pnpm --filter @answra/cli test` 通过 25 个文件/167 个测试；`pnpm --filter @answra/credentials test` 通过 5 个测试；`pnpm --filter @answra/desktop test -- modelSettings modelRouter` 通过 22 个测试。
- 2026-11-13：`pnpm --filter @answra/cli build` 通过；keyring 平台包已复制到 `dist/node_modules/@napi-rs/`；在临时 `APPDATA` 下用构建产物依次执行 `config set/show/unset`，写入的 `Answra/config.json` 只含 `version/model.source/model.local`，`config unset` 后 `source` 回到 cloud、本地字段清空。
- 待完成：全量 `pnpm verify` 与打包后 Electron/CLI 实机验证。
- 实机验证：Windows 上桌面 dev 写入配置后启动 `pnpm dev:cli`，确认共享文件路径一致；打包版桌面仍按既有门禁把 local 折叠为 cloud。
