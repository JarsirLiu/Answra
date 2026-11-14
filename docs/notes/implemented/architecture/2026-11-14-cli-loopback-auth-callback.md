# Note：CLI 一次性 OAuth 环回回调例外

状态：已实施

## 问题

CLI 需要在用户完成 AnswraSite 登录后自动收到授权结果。手动复制 `code#state` 会打断正常登录流程，也无法满足已确认的 CLI 交互契约。

## 根因

OAuth 授权结果必须回到发起授权的 CLI 进程；CLI 没有桌面深链注册能力，且浏览器不能直接把结果写入终端 stdin。

## 涉及范围

- 代码/模块：`apps/cli/src/remote/auth/localAuthCallback.ts`、`apps/cli/src/remote/auth/remoteAuthService.ts`、`scripts/architecture/architecture-check.mjs`
- UI/进程/协议/持久化表面：CLI 登录期间的一次性 loopback HTTP 回调；浏览器仍在远程 AnswraSite 完成登录。
- 相关 Note：[CLI 欢迎页与账号登录交互](../feature/2026-11-14-cli-welcome-and-auth-flow.md)

## 决定

允许 CLI 登录模块使用受控 loopback 回调：只绑定字面量 `127.0.0.1`，端口由系统随机分配，路径固定为 `/auth/callback`，收到有效 `code/state` 后立即完成结果并由登录服务关闭监听。回调页面只确认结果已发送给 CLI，不承载账号逻辑或凭据。

## 修复

架构守护为 CLI 回调文件增加精确白名单，并断言绑定地址、动态端口、固定路径和关闭监听均存在。其他 `src` 文件仍禁止自建监听。

## 模块边界

`localAuthCallback.ts` 只负责接收一次浏览器回调；PKCE、state 校验和 token 交换仍由 `RemoteAuthService` 负责，网站不把凭据交给回调页面，架构守护只维护监听例外规则。

## 曾考虑的替代方案

- **要求用户复制 `code#state`：** 可以绕过监听，但破坏自动登录体验，已舍弃。
- **复用桌面端深链回调：** CLI 不拥有 Electron 协议注册和窗口生命周期，无法可靠接收，已舍弃。
- **开放通用本地 HTTP 服务：** 监听面过大且与 CLI 需求无关，已舍弃，只保留一次性随机端口回调。

## 后果与防回退

生产登录仍通过远程网站完成，CLI 只短时接收回调；回调结束或取消后监听关闭。新增本地监听必须新增独立 Note、白名单和代码断言，不得把此例外扩展成常驻服务。

## 验证

- `pnpm architecture:check` 通过，白名单断言覆盖 CLI 回调约束。
- CLI 测试、Agent 测试、类型检查和全量测试通过。
- 生产网站回调页已验证显示“CLI 登录完成”，不要求复制授权码。
