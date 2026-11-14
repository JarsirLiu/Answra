# Note：CLI 欢迎页与账号登录交互

状态：提案

## 问题

CLI 已有 `answra auth login|status|logout` 和 PKCE 登录实现，但首次进入 TUI 只展示模型配置，欢迎页没有账号状态、安全提示，也不能像 Claude Code 一样在会话内完成登录。用户在浏览器授权后还必须离开 TUI，交互链路不完整。

## 涉及范围

- 代码/模块：`apps/cli/src/tui`、`apps/cli/src/remote/auth/remoteAuthService.ts`、`apps/cli/src/cli/codeCommand.ts`
- UI/进程/协议/持久化表面：TUI 欢迎页、slash 命令、浏览器授权码回填、OS keychain 登录态
- 相关 Note：[CLI 设备登录与远程服务准入](../architecture/2026-11-14-cli-device-login-and-remote-service-auth.md)

## 影响表面

- 首次 TUI 进入时可见登录状态和可信工作区提醒。
- 登录时不会有第二个 stdin 读取者；授权码只从 TUI 提交事件进入认证服务。
- token 仍只由 `RemoteAuthService` 写入 OS keychain，欢迎页和 notice 不显示 token。

## 提案

在不复制认证协议的前提下，把已有 `RemoteAuthPort` 接入 TUI：欢迎页显示工作区、账号状态和安全提示；新增 `/login`、`/status`、`/logout`；`/status` 打开 Claude Code 风格的 Status 面板，把账户作为完整状态的一部分展示，而不是另造 `/account` 命令。`/login` 在 CLI 中生成 PKCE 参数并启动一次性的 `127.0.0.1` OAuth 回调接收器，浏览器始终在 AnswraSite 完成登录、账号校验和授权确认；授权完成后网站将 `code/state` 自动重定向到 CLI，CLI 校验 state 并完成 exchange，成功后由 `TuiViewStore` 更新账号状态。localhost 只承担 OAuth redirect 接收，不提供登录页面、不读取网站 Cookie、不保存账号逻辑。顶层 `answra auth` 命令继续保留，作为非 TTY/脚本入口。

## 曾考虑的替代方案

- **在 TUI 内直接调用现有 `promptCode`：** 会与 Ink 同时读取 stdin，输入归属不确定，舍弃。
- **复制一套 TUI OAuth 实现：** 会产生第二套 PKCE/token 语义，破坏认证协议唯一来源，舍弃。
- **把网站 Cookie 交给 CLI：** Cookie 绑定浏览器会话，扩大凭据暴露面，舍弃。
- **默认要求复制 `code#state`：** 容易中断正常登录体验，舍弃；生产组合根使用自动 localhost 回调，无法回调时明确失败并重新发起授权。

## 验收标准

- 可观察结果：TUI 空会话显示账号状态、安全提示；`/login` 打开授权页并自动接收网站回调；`/status` 打开 Status 面板；`/logout` 更新欢迎页和 Status 面板的账号状态；已有对话执行命令后，反馈显示在当前 transcript 底部。
- 自动化验证：命令目录包含三个命令；既有认证服务测试继续覆盖 state 校验、exchange 与 keychain；CLI 类型检查和测试通过（现有仓库基线类型错误需单独治理）。
- 需要的实机验证：Windows 终端中运行 `answra code`，浏览器在生产站点登录并授权后自动返回 CLI，随后 `answra auth status` 与 `answra remote host/attach` 使用同一登录态取 ticket。

## 风险

- TUI 登录等待网站回调期间，回调监听器五分钟超时并在退出时关闭，不会覆盖已有 keychain 登录态。
- 账号状态读取失败会按认证服务错误显示，不伪造为已登录或匿名成功。
