# Note：CLI 欢迎页与账号登录交互

状态：已实施

## 问题

CLI 已有 PKCE 登录实现，但 TUI 欢迎页没有账号状态，也不能在会话内发起登录；浏览器授权后若要求用户复制授权码，会中断正常登录流程。

## 涉及范围

- 代码/模块：`apps/cli/src/tui`、`apps/cli/src/remote/auth/`、`apps/cli/src/cli/codeCommand.ts`
- UI/进程/协议/持久化表面：TUI 欢迎页、`/login`/`/status`/`/logout`、远程网站 OAuth 授权、一次性 loopback 回调、OS keychain 登录态。
- 相关 Note：[CLI 设备登录旧提案（已否决）](../../rejected/architecture/2026-11-14-cli-device-login-and-remote-service-auth.md)、[CLI 一次性 OAuth 环回回调例外](../architecture/2026-11-14-cli-loopback-auth-callback.md)

## 影响表面

- 首次 TUI 进入时可见登录状态和可信工作区提醒。
- `/login` 打开 AnswraSite 授权页；网站授权完成后通过一次性 loopback 回调自动把结果交给 CLI，不要求用户复制授权码。
- `/status` 展示账户与 CLI 状态；`/logout` 同步更新欢迎区和状态面板。
- token 只由 `RemoteAuthService` 写入 OS keychain，欢迎页和 notice 不显示 token。

## 决定

把已有 `RemoteAuthPort` 接入 TUI，欢迎页显示工作区、账号状态和安全提示；提供 `/login`、`/status`、`/logout`。`/status` 打开包含账户信息的 Status 面板，不另造 `/account` 命令。CLI 在授权期间绑定 `127.0.0.1` 的随机端口和固定回调路径；浏览器始终在 AnswraSite 完成登录、账号校验和授权确认。回调接收器只接收 `code/state`，不提供登录页面、不读取网站 Cookie、不保存账号逻辑；`RemoteAuthService` 校验 state 并完成 exchange。顶层 `answra auth` 命令保留为非 TTY/脚本入口。

## 曾考虑的替代方案

- **在 TUI 内直接调用现有 `promptCode`：** 会与 Ink 同时读取 stdin，输入归属不确定，舍弃。
- **复制一套 TUI OAuth 实现：** 会产生第二套 PKCE/token 语义，破坏认证协议唯一来源，舍弃。
- **把网站 Cookie 交给 CLI：** Cookie 绑定浏览器会话，扩大凭据暴露面，舍弃。
- **默认要求复制 `code#state`：** 人工复制中断正常登录体验，舍弃；自动回调不可用时明确失败并重新发起授权。

## 后果与防回退

- TUI 登录结果通过 `TuiViewStore` 更新欢迎区账户状态；成功 notice 不会永久留在对话区。
- 本地 listener 只用于短时 OAuth 回调，细节与架构守护见 loopback 例外 Note；不得扩展成常驻服务。
- 账号 token 仍只进入 OS keychain；工作区安全提醒不替代用户对当前目录的判断。
- `pnpm dev:cli` 无参数时默认启动 `code`；传入 `remote`、`auth` 或 `--help` 时原样分发，避免开发入口吞掉顶层命令。

## 验证

- CLI 45 个测试文件、270 个测试通过；登录服务和 TUI 命令测试覆盖登录状态与反馈。
- CLI 类型检查、Biome 检查和构建通过。
- 生产网站回调页返回 200，显示“CLI 登录完成”和“授权结果已发送”，不要求复制授权码。
- Windows 真实 CLI 浏览器授权闭环尚需用户本机运行 `pnpm dev:cli` 验证。
