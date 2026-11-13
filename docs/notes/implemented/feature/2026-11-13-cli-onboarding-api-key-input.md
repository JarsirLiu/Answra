# Note：CLI 启动引导中的 API Key 输入

状态：已实施

## 问题

模型配置引导只有 base URL 和模型 ID 两步，需要鉴权的 OpenAI 兼容端点仍要求用户先退出 TUI、设置 `ANSWRA_API_KEY`、再重启。Claude Code 式首次启动应在同一欢迎流程里完成凭据输入，否则用户会看到模型已配置但首条请求失败。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/runTui.tsx`：设置步骤为 `base-url → api-key → model-id`；非空 Key 写入 `@answra/credentials`，空提交读取已有 Key。
  - `apps/cli/src/tui/app/viewStore.ts`、`App.tsx`：新增 `setupStep`，让输入框知道当前步骤并切换遮罩与提示。
  - `apps/cli/src/tui/composer/PromptInput.tsx`、`TextInput.tsx`：secret 输入遮罩、secret 不进历史、API Key 步骤允许空提交。
  - `apps/cli/src/cli/codeCommand.ts`：`createSession(model, accessToken?)` 允许引导流程覆盖启动时的 token。
  - `apps/cli/src/cli/help.ts`、`AGENTS.md`：同步 API Key 的 keychain 边界。
  - `apps/cli/test/runCli.test.ts`、`runTui.test.ts`、`tui.test.tsx`：覆盖三步流程、空 Key、遮罩、token 注入与 keychain 写入。
- UI/进程/协议/持久化表面：
  - 不改 Agent 事件、transcript schema、IPC 或桌面端 UI。
  - API Key 不进入 `@answra/config`、TUI store、历史、日志或测试快照；持久化只走 `@answra/credentials` 的 OS keychain。
  - 共享配置仍只保存 `baseUrl` / `chatModel` / `answerModel`。
- 相关 Note：
  - [CLI 启动时的模型配置引导](2026-11-13-cli-model-onboarding.md)
  - [本地模型 API Key 共享 OS keychain](../architecture/2026-11-13-shared-model-api-key-keychain.md)
  - [CLI 模型设置域](../architecture/2026-11-13-cli-model-settings-domain.md)

## 影响表面

- 首次无模型启动：欢迎页模型配置面板同屏显示三项，已完成项标 `✓`、当前项标 `❯`、待填写项标 `○`；输入 base URL 后进入隐藏输入的 API Key 步骤，再进入模型 ID。
- API Key 步骤按 Enter 空提交表示“使用系统凭据库中已有的 Key”；如果 keychain 中没有 Key，则当前会话没有显式 token，本地端点仍可直接使用。
- 输入非空 Key 后，Key 写入 OS keychain；配置成功提示说明已保存到系统凭据库，重启 CLI 后仍可使用。
- keychain 不可用时，TUI 保存失败并回到 base URL 步骤；不写明文、不假装保存成功。用户仍可用 `ANSWRA_API_KEY` / `--api-key` 启动。
- `/model add` 仍复用同一路径；无会话时创建的会话使用启动时 token 或 keychain 中已有 Key。

## 决定

1. **三步引导。** Base URL、API Key、模型 ID 是同一欢迎流程的三个连续步骤；欢迎页面板按 `setupStep` 同屏显示三项状态，不显示输入值；每一步只写自己的局部输入，最后才持久化非 secret 字段并创建会话。
2. **Key 持久化到 OS keychain。** 非空 API Key 通过 `@answra/credentials` 写入系统凭据库；不写共享配置，也不新增 CLI 私有 secret 文件。
3. **遮罩与历史隔离。** API Key 步骤用 `•` 遮罩显示；secret 输入不进入输入历史，避免后续按 Up 泄露；提示文案不包含 Key。
4. **空 Key 是显式选择。** API Key 步骤允许空提交，表示读取 keychain 已有 Key；这兼容本地端点和已保存凭据的用户。keychain 不可用时按失败处理，不回退明文。
5. **会话工厂接受 token 覆盖。** `createSession(model, accessToken?)` 由 `codeCommand` 注入；TUI 不直接构造 `CodingSession`，也不持有宿主装配细节。
6. **非交互模式不变。** `answra code "..."` 与 stdin 管道仍 fail-fast，不进入三步引导。

## 曾考虑的替代方案

- **把 API Key 写进 `@answra/config`：** 舍弃。共享配置只存非 secret 字段，且桌面端与 CLI 共用该文件。
- **新增 CLI 明文 secret 文件：** 舍弃。用户明确否决明文 `0600` 方案；文件权限不能替代系统凭据保护。
- **继续只保存在 TUI 内存：** 舍弃。重启后仍需重新输入，无法达到桌面与 CLI 共享凭据的目标。
- **API Key 步骤不允许空提交：** 舍弃。本地端点不需要 Key，强制输入会制造无意义步骤；空提交改为读取 keychain。
- **把 Key 放进 TUI store 以便重渲染：** 舍弃。遮罩只需输入框本地状态；store 不保存 secret，减少泄露面。

## 后果与防回退

- 重启后会自动恢复 keychain 中的 Key；这是与早期“仅内存”实现的明确差异。
- API Key 不得出现在 `TuiState`、`notice`、`localError`、输入历史、日志或测试快照中；只允许在 `runTui` 局部变量、`CodingSession` 内存与 OS keychain 中存在。
- API Key 步骤必须保持遮罩；新增输入框分支时不得把 secret 原样交给 `TextInput`。
- 空 Key 必须继续读取 keychain；读取失败必须 fail-closed，不能退化为“无 Key 成功”。
- 非交互路径不得因本改动进入三步引导。

## 验收标准

- 可观察结果：
  - 无配置 TTY 启动时欢迎页同屏显示 Base URL、API Key、模型 ID；当前项标 `❯` 高亮，输入框 placeholder 提示当前步骤。
  - API Key 输入时屏幕只显示遮罩字符；提交后输入历史不包含该 Key。
  - 输入 Key 后创建的新会话在发送时使用该 Key；重启 CLI 后空提交可读取同一 Key。
  - keychain 不可用时保存失败并明确报错，不生成明文 Key 文件。
- 自动化验证：
  - `apps/cli/test/runTui.test.ts`：三步流程、空 Key、keychain 写入/读取、session token。
  - `apps/cli/test/runCli.test.ts`：TUI 输入 Key 进入新会话。
  - `apps/cli/test/tui.test.tsx`：欢迎页三项面板与当前项高亮、API Key 遮罩与空提交。
  - `pnpm --filter @answra/cli test`、`typecheck`、`lint`、`architecture:check`、`notes:check`、`tokens:check`、`build`。

## 验证

- 2026-11-13：`pnpm --filter @answra/cli test` 通过 25 个测试文件、167 个测试；覆盖三步设置、空 Key、`/model add` 无会话创建、API Key 遮罩与空提交。
- 2026-11-13：`pnpm --filter @answra/cli typecheck`、`pnpm --filter @answra/cli build` 通过；构建产物已复制 keyring 平台包。
- 2026-11-13：Windows Credential Manager 写入、读取、删除 smoke test 通过。
- 待完成：Windows Terminal / VS Code 集成终端实机走查；未完成前不能把本 Note 当作“首次启动体验已验收”的依据。

## 风险

- 用户以为 Key 只存在内存时，实际会写入系统凭据库；配置成功提示已明确说明。
- Linux 未启动 Secret Service 时，TUI 保存会失败；当前选择明确报错，而不是退回文件。
- 云端端点留空 Key 时不会在配置阶段报错，首条请求仍可能 401；这是为了避免对本地端点强制输入 Key。
- 如果用户把 Key 粘贴到其他非 secret 输入框，遮罩不会生效；secret 遮罩只绑定 API Key 步骤。
