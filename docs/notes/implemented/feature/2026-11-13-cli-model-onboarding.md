# Note：CLI 启动时的模型配置引导

状态：已实施

## 问题

`pnpm dev:cli` 在共享配置和环境变量都没有本地模型地址时，会在启动阶段直接抛出 `缺少 ANSWRA_AI_BASE_URL`，用户看不到 TUI，也不知道如何配置。Claude Code 的启动体验是先进入欢迎页，再引导用户完成模型设置；当前 CLI 把“未配置”当成启动失败，阻断了首次使用。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/model/errors.ts`（新增）：`MissingModelConfigError`，区分“未配置”和真正的配置损坏。
  - `apps/cli/src/model/precedence.ts`：缺少 base URL / model ID 时抛出该类型错误。
  - `apps/cli/src/cli/codeCommand.ts`：交互模式捕获该错误，启动无会话 TUI；非交互模式仍返回原错误。
  - `apps/cli/src/tui/runTui.tsx`：无会话时进入三步设置（base URL、API Key、model ID），配置成功后创建并打开 `CodingSession`；`/model add` 在无会话时同样可用。
  - `apps/cli/src/tui/commands/modelCommand.ts`：`session` 改为可选，新增 `configureSession` 回调。
  - `apps/cli/src/tui/app/viewStore.ts`、`App.tsx`、`transcript/VirtualTranscript.tsx`、`transcript/Transcript.tsx`：新增 `modelConfigured` 与 `setupStep` 状态，欢迎页显示配置引导并切换输入遮罩。
  - `apps/cli/test/runCli.test.ts`、`runTui.test.ts`、`tui.test.tsx`：覆盖交互式启动、三步设置、`/model add` 无会话配置与欢迎页文案。
- UI/进程/协议/持久化表面：
  - 只改 CLI 启动与 TUI；不改 Agent 事件、transcript schema、IPC、桌面或持久化。
  - 仍只持久化 `@answra/config` 的非 secret 字段 `baseUrl` / `chatModel` / `answerModel`。
  - API Key 可从 `ANSWRA_API_KEY` / `--api-key` 或 TUI 内存输入获得，不进入共享配置；欢迎页说明 Key 仅在本次会话内存中使用。
- 相关 Note：
  - [CLI 启动引导中的 API Key 输入](2026-11-13-cli-onboarding-api-key-input.md)
  - [CLI 模型设置域](../architecture/2026-11-13-cli-model-settings-domain.md)
  - [CLI Coding 模式与终端 UI 移植](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [CLI TUI 对话交互重建](../architecture/2026-11-13-cli-tui-conversation-interaction-rebuild.md)

## 影响表面

- 交互式 `answra code`：没有可用模型时不再退出，而是显示欢迎页和三步设置提示。
- 非交互式 `answra code "..."` / stdin 管道：仍保持 fail-fast，缺少模型直接返回 1，避免脚本静默进入交互。
- 已配置模型：启动路径不变，仍先打开会话再进入 TUI。
- 欢迎页：未配置时显示 Base URL → API Key → 模型 ID 三步清单，已完成项标 `✓ 已完成`、当前项标 `○ 待填写`；配置成功后恢复正常任务提示。

## 决定

1. **未配置不是配置损坏。** 在模型解析层引入 `MissingModelConfigError`；命令层只对这种错误降级到 TUI 引导，非法 URL、写文件失败等仍然向上抛出。
2. **只对交互式启动降级。** `interactive = prompt === undefined && input.isTTY`；脚本和管道不进入 TUI，避免改变现有非交互语义。
3. **会话延迟创建。** 无模型时 TUI 不创建 `CodingSession`，只保存设置输入；`addLocal` 成功后再通过 `createSession` 工厂创建并 `open()` 会话。这样不伪造空模型会话，也不让 TUI 直接持有宿主装配细节。
4. **三步设置。** 依次输入 OpenAI 兼容 base URL、API Key、模型 ID；`addLocal` 负责 URL 校验、归一化和持久化。API Key 允许留空，留空时沿用启动 token；任何一步失败都回到 base URL 提示并显示错误。欢迎页清单只显示步骤完成状态，不显示输入值，API Key 永不回显。
5. **`/model add` 复用同一路径。** 无会话时 `/model add <url> <id>` 通过 `configureSession` 创建会话；有会话时仍调用 `session.setModel()`，不复制模型切换逻辑。
6. **API Key 内存输入、不落盘。** 三步引导中的 API Key 只保存在当前进程内存，输入时遮罩且不进入历史；不写共享配置、不新增明文 secret 文件。详细生命周期与取舍见[API Key 输入 Note](2026-11-13-cli-onboarding-api-key-input.md)。

## 曾考虑的替代方案

- **在启动时直接打印 `/model add` 提示并退出。** 舍弃。用户仍看不到 TUI，也仍然要先理解命令语法；与 Claude Code 的欢迎页引导目标不符。
- **允许 `CodingSession` 接受空模型并在发送时再报错。** 舍弃。会制造“会话已打开但没有可用模型”的假状态，违反状态显式来源约束。
- **在 TUI 中直接调用 `createSessionHost` / `CodingSession`。** 舍弃。TUI 只应消费会话端口；宿主装配留在 `codeCommand` 的 `createSession` 工厂。
- **把 API Key 一并写入 `@answra/config`。** 舍弃。共享配置只存非 secret 字段；secret 持久化需要独立的凭据存储与安全评审。
- **在非交互模式也进入设置向导。** 舍弃。脚本、CI 和管道没有输入交互能力，必须保持 fail-fast。

## 后果与防回退

- `ModelSettings.resolve` 的“缺少字段”错误类型固定为 `MissingModelConfigError`；新增其他配置错误时不得复用该类型，否则会被误判为可引导状态。
- 非交互路径必须继续直接调用 `resolve` 并返回 1；不能把 `runCodeCommand` 的交互降级逻辑扩散到 `runOnce`。
- `CodingSession` 仍要求完整 `ConversationModelConfig`；不得为了启动引导放宽构造函数契约。
- API Key 不得出现在 `@answra/config`、TUI 状态、输入历史、日志或测试快照中；只允许在 `runTui` 局部变量与 `CodingSession` 内存中存在，输入时必须遮罩。
- `modelConfigured` 只由 `runTui` 在会话创建/打开成功后写入；不能从 `modelLabel` 或输入内容推演。

## 验收标准

- 可观察结果：
  - 无配置时在 TTY 运行 `answra code`，进入欢迎页并显示 Base URL / API Key / 模型 ID 三步引导，不打印 `缺少 ANSWRA_AI_BASE_URL`。
  - 输入合法 base URL、可选 API Key 与模型 ID 后，配置写入共享文件，状态行显示模型名，输入任务可正常发送。
  - 无配置时执行 `answra code "hello"`（非 TTY）仍返回 1 并报告缺少模型。
  - 无会话时执行 `/model add <url> <id>` 能完成配置并创建会话。
- 自动化验证：
  - `pnpm --filter @answra/cli test`：覆盖交互式启动降级、三步设置、欢迎页清单完成状态、API Key 遮罩/空提交、`/model add` 无会话配置、欢迎页文案。
  - `pnpm --filter @answra/cli typecheck`、`pnpm lint`、`pnpm architecture:check`。
- 需要的实机验证：
  - Windows Terminal / VS Code 集成终端：无配置启动、三步输入、配置成功后发送首条任务、`/model add`、`Ctrl+C` 退出。

## 验证

- 2026-11-13：`pnpm --filter @answra/cli test` 通过，20 个测试文件、151 个测试；新增覆盖：
  - `test/runCli.test.ts`：交互式缺配置启动 TUI、TUI 输入的 API Key 进入新会话，非交互式仍返回 1。
  - `test/runTui.test.ts`：三步设置创建会话、空 Key、`/model add` 无会话配置。
  - `test/tui.test.tsx`：未配置欢迎页显示三步清单、已完成项标 `✓`、当前项标 `○`、API Key 遮罩与空提交。
- 2026-11-13：`pnpm --filter @answra/cli typecheck`、`pnpm lint`、`pnpm notes:check`、`pnpm architecture:check`、`pnpm tokens:check`、`pnpm --filter @answra/cli build` 通过。
- 待完成：TTY 实机走查；未完成前不能把本 Note 当作“首次启动体验已验收”的依据。

## 风险

- 用户输入错误 base URL 时，`addLocal` 失败后回到 base URL 步骤；错误信息与重新输入提示可能让用户误以为已保存。当前通过 `localError` 显示原始校验错误来降低误解。
- TUI 输入的 API Key 只在当前进程内存中，重启后需要重新输入或改用 `ANSWRA_API_KEY` / `--api-key`；这是避免明文 secret 持久化的取舍。
- 如果共享配置文件写入失败，配置不会生效，TUI 停留在设置流程；这是 fail-closed 行为，不自动回退到内存配置。
