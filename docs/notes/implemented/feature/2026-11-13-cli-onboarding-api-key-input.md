# Note：CLI 启动引导中的 API Key 输入

状态：已实施

## 问题

模型配置引导只有 base URL 和模型 ID 两步，需要鉴权的 OpenAI 兼容端点仍要求用户先退出 TUI、设置 `ANSWRA_API_KEY`、再重启。Claude Code 式首次启动应在同一欢迎流程里完成凭据输入，否则用户会看到模型已配置但首条请求失败。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/runTui.tsx`：设置步骤改为 `base-url → api-key → model-id`，把输入的 API Key 传给 `createSession`。
  - `apps/cli/src/tui/app/viewStore.ts`、`App.tsx`：新增 `setupStep`，让输入框知道当前步骤并切换遮罩与提示。
  - `apps/cli/src/tui/composer/PromptInput.tsx`、`TextInput.tsx`：secret 输入遮罩、secret 不进历史、API Key 步骤允许空提交。
  - `apps/cli/src/cli/codeCommand.ts`：`createSession(model, accessToken?)` 允许引导流程覆盖启动时的 token。
  - `apps/cli/src/cli/help.ts`、`AGENTS.md`：同步“API Key 可走 TUI 内存输入”的边界。
  - `apps/cli/test/runCli.test.ts`、`runTui.test.ts`、`tui.test.tsx`：覆盖三步流程、空 Key、遮罩、token 注入。
- UI/进程/协议/持久化表面：
  - 不改 Agent 事件、transcript schema、IPC 或桌面端。
  - API Key 只存在于 `runTui` 的局部变量和 `CodingSession` 内存中；不写入 `@answra/config`，不进入 TUI store、历史、日志或测试快照。
  - 共享配置仍只保存 `baseUrl` / `chatModel` / `answerModel`。
- 相关 Note：
  - [CLI 启动时的模型配置引导](2026-11-13-cli-model-onboarding.md)
  - [CLI 模型设置域](../architecture/2026-11-13-cli-model-settings-domain.md)

## 影响表面

- 首次无模型启动：欢迎页明确显示三步清单，已完成项标 `✓`、当前项标 `○`；输入 base URL 后进入隐藏输入的 API Key 步骤，再进入模型 ID。
- API Key 步骤按 Enter 空提交表示“不使用显式 Key”，回退到启动时解析到的 `ANSWRA_API_KEY` / `--api-key`；本地端点可直接留空。
- 配置成功后新会话使用本次输入的 Key；配置提示说明 Key 只在本次进程内存中，重启后需重新输入或改用环境变量。
- `/model add` 仍复用同一路径；无会话时创建的会话使用启动时 token，不额外询问 Key。

## 决定

1. **三步引导。** Base URL、API Key、模型 ID 是同一欢迎流程的三个连续步骤；欢迎页清单按 `setupStep` 显示完成状态，不显示输入值；每一步只写自己的局部输入，最后才持久化非 secret 字段并创建会话。
2. **API Key 内存生命周期。** 不把 secret 写入共享配置，也不新增 CLI 私有 secret 文件；Key 只保存在当前 TUI 进程的局部变量和会话对象中。
3. **遮罩与历史隔离。** API Key 步骤用 `•` 遮罩显示；secret 输入不进入输入历史，避免后续按 Up 泄露；提示文案不包含 Key。
4. **空 Key 是显式选择。** API Key 步骤允许空提交，表示沿用启动时 token；这兼容本地端点和已设置环境变量的用户。
5. **会话工厂接受 token 覆盖。** `createSession(model, accessToken?)` 由 `codeCommand` 注入；TUI 不直接构造 `CodingSession`，也不持有宿主装配细节。
6. **非交互模式不变。** `answra code "..."` 和 stdin 管道仍 fail-fast，不进入三步引导。

## 曾考虑的替代方案

- **把 API Key 写进 `@answra/config`。** 舍弃。共享配置只存非 secret 字段，且桌面端与 CLI 共用该文件。
- **新增 CLI 明文 secret 文件。** 舍弃。明文凭据不符合仓库秘密处理边界；文件权限也不能替代加密存储。
- **引入 OS keychain 依赖。** 本次舍弃。需要新增原生依赖、打包分发和跨平台验收，超出启动引导范围；后续若做持久化，应单独评审。
- **API Key 步骤不允许空提交。** 舍弃。本地端点不需要 Key，强制输入会制造无意义步骤。
- **把 Key 放进 TUI store 以便重渲染。** 舍弃。遮罩只需输入框本地状态；store 不保存 secret，减少泄露面。

## 后果与防回退

- 重启后不会自动恢复 TUI 输入的 API Key；这是当前明确取舍。需要长期使用时设置 `ANSWRA_API_KEY` 或 `--api-key`。
- API Key 不得出现在 `TuiState`、`notice`、`localError`、输入历史、日志或测试快照中；只允许在 `runTui` 局部变量与 `CodingSession` 内存中存在。
- API Key 步骤必须保持遮罩；新增输入框分支时不得把 secret 原样交给 `TextInput`。
- 空 Key 必须继续映射为 `undefined` 传给 `createSession`，让 `codeCommand` 回退到启动 token。
- 非交互路径不得因本改动进入三步引导。

## 验收标准

- 可观察结果：
  - 无配置 TTY 启动依次显示 `1/3 Base URL`、`2/3 API Key`、`3/3 模型 ID`。
  - API Key 输入时屏幕只显示遮罩字符；提交后输入历史不包含该 Key。
  - 输入 Key 后创建的新会话在发送时使用该 Key；空提交时使用启动时 token。
  - 配置成功提示明确说明 Key 只在本次会话内存中。
- 自动化验证：
  - `apps/cli/test/runTui.test.ts`：三步流程、空 Key、session token。
  - `apps/cli/test/runCli.test.ts`：TUI 输入的 Key 进入新会话。
  - `apps/cli/test/tui.test.tsx`：欢迎页三步文案、API Key 遮罩与空提交。
  - `pnpm --filter @answra/cli test`、`typecheck`、`lint`、`architecture:check`、`notes:check`、`tokens:check`、`build`。

## 验证

- 2026-11-13：`pnpm --filter @answra/cli test` 通过，20 个测试文件、151 个测试；新增覆盖：
  - `test/runCli.test.ts`：TUI 输入的 API Key 被新会话使用。
  - `test/runTui.test.ts`：三步设置、空 Key、`/model add` 无会话创建。
  - `test/tui.test.tsx`：欢迎页三步清单与完成状态、API Key 输入遮罩与空提交。
- 2026-11-13：`pnpm --filter @answra/cli typecheck`、`pnpm lint`、`pnpm notes:check`、`pnpm architecture:check`、`pnpm tokens:check`、`pnpm --filter @answra/cli build` 通过。
- 待完成：Windows Terminal / VS Code 集成终端实机走查；未完成前不能把本 Note 当作“首次启动体验已验收”的依据。

## 风险

- 用户以为 API Key 会被持久化，重启后仍需重新输入；当前通过配置成功提示明确说明内存生命周期。
- 云端端点留空 Key 时不会在配置阶段报错，首条请求仍可能 401；这是为了避免对本地端点强制输入 Key。
- 如果用户把 Key 粘贴到其他非 secret 输入框，遮罩不会生效；secret 遮罩只绑定 API Key 步骤。
