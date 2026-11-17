# Note：CLI `/remote` 未登录提示指向了错误的登录入口

状态：已实施

## 问题

在 coding TUI 内执行 `/remote` 时，如果尚未登录，界面提示“请先运行 `answra auth login` 登录”。TUI 本身已经提供 `/login`，用户不需要退出当前会话再走顶层命令；这条提示把 TUI 宿主和 shell 宿主的登录入口混在了一起。登录过期时也会出现同样的顶层命令提示。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/commands/dispatch.ts`：`/remote` 在启动 host 前读取登录状态；未登录时提示 `/login`，并捕获启动阶段的 `RemoteAuthRequiredError`。
  - `apps/cli/src/cli/remoteSessionCommands.ts`：TUI 专用 host 启动入口在缺少登录能力时给出明确文案，不再建议 shell 命令。
  - `apps/cli/test/tui/commands/remoteAuthHint.test.ts`：覆盖未登录、登录过期和缺少登录能力三种状态。
  - `apps/cli/test/tui/runTui.test.ts`：`/remote` 成功路径注入已登录状态，避免测试把未登录当成默认。
- UI 表面：只改 TUI 的 `/remote` 错误提示；顶层 `answra auth login`、`answra remote host/attach` 的 shell 流程不变。
- 相关 Note：
  - [CLI 欢迎页与账号登录交互](../feature/2026-11-14-cli-welcome-and-auth-flow.md)
  - [CLI 斜杠命令统一管理远程连接](../../proposed/feature/2026-11-15-cli-slash-remote-management.md)

## 决定

TUI 内的 `/remote` 必须使用 TUI 的登录入口文案：未登录时提示“请先运行 /login 登录，成功后再运行 /remote”；登录过期时提示重新运行 `/login`。`RemoteAuthRequiredError` 继续作为领域错误，由 TUI 命令层翻译成宿主相关提示，不在认证服务里硬编码某个宿主的命令。

不在 `/remote` 中自动打开浏览器登录：用户显式执行 `/login` 的流程保持不变，`/remote` 只负责说明前置条件，避免一次命令同时触发浏览器授权和远程 host 启动。

## 根因

1. `startRemoteHostWithConnectionCode` 在 TUI 组合根里调用 `remoteAuth.getAccessToken()`；未登录时 `RemoteAuthService` 抛出默认文案“请先运行 `answra auth login` 登录”。
2. `dispatchTuiCommand` 的通用错误处理直接把错误消息写入 notice，没有按 TUI 宿主翻译。
3. `/remote` 没有在启动 host 前读取 `remoteAuth.status()`，因此无法在正常控制流里给出 `/login` 提示。

## 修复

- `/remote` 启动 host 前先检查 `deps.remoteAuth` 与 `status().signedIn`；未登录时写入 TUI 提示并返回，不调用 host 启动。
- 启动阶段捕获 `RemoteAuthRequiredError`（覆盖 token 过期/刷新被拒绝），转换为“登录已过期，请先运行 /login”的 TUI 提示；其他错误继续交给统一错误处理。
- 缺少登录能力时明确提示“当前环境未配置账号登录，无法开启远程连接”，不再让用户去找顶层命令。
- 成功路径保持原有 host 启动和连接码展示逻辑。

## 曾考虑的替代方案

- **把 `RemoteAuthRequiredError` 的默认文案改成 `/login`：** 舍弃。顶层 `answra remote host/attach` 仍需要 `answra auth login`，认证服务不应假设调用方一定是 TUI。
- **`/remote` 自动调用 `deps.login()` 后继续启动：** 本次不采用。会改变 `/remote` 的一次命令语义，并在用户只想查看远程状态时自动拉起浏览器；先保留显式 `/login`。
- **只在 UI 里替换错误字符串：** 舍弃。需要依赖字符串匹配，登录过期和未登录无法稳定区分；使用现有错误类型和 `status()` 事实更可靠。

## 后果与防回退

- TUI 的 `/remote` 前置登录文案只走 `/login`；顶层 shell 命令的文案仍走 `answra auth login`。
- `RemoteAuthRequiredError` 的默认文案继续服务于非 TUI 调用方，不得为了 TUI 文案把它改成单一宿主。
- 新增 TUI 远程入口时必须复用同一登录状态检查，不要复制一份“先 auth login”的文案。
- `/remote` 不会自动登录；若未来要支持自动登录，需单独设计取消、失败和 host 启动顺序，并更新本 Note。

## 验收标准

- 未登录执行 `/remote`：不启动 host，提示“请先运行 /login 登录，成功后再运行 /remote”。
- 登录过期执行 `/remote`：不把 `answra auth login` 文案显示在 TUI，提示重新运行 `/login`。
- 已登录执行 `/remote`：仍能启动 host 并显示连接码/Key ID。
- 缺少登录能力时：提示当前环境未配置账号登录，不启动 host。

## 验证

- 2026-11-17：`apps/cli/test/tui/commands/remoteAuthHint.test.ts` 3 项、`apps/cli/test/tui/runTui.test.ts` 24 项通过；完整 `@answra/cli` 测试 51 个文件、319 项通过。
- 2026-11-17：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check` 与 `pnpm notes:check` 通过。
