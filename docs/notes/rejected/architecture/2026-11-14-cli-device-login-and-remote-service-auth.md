# Note：CLI 设备登录与远程服务准入旧提案

状态：已拒绝：手动复制授权码的登录路径与自动回调产品流程冲突。

## 问题

CLI 远程服务需要账号登录准入，但旧提案把“仓库禁止本地监听”解释为 CLI 必须手动复制授权码，和用户要求的自动登录流程冲突。

## 涉及范围

- 代码/模块：`apps/cli/src/remote/auth/`、`apps/cli/src/cli/`、`apps/cli/src/tui/`
- UI/进程/协议/持久化表面：AnswraSite 授权、CLI OAuth 回调、OS keychain 登录态。
- 替代决策：[CLI 欢迎页与账号登录交互](../../implemented/feature/2026-11-14-cli-welcome-and-auth-flow.md)、[CLI 一次性 OAuth 环回回调例外](../../implemented/architecture/2026-11-14-cli-loopback-auth-callback.md)

## 模块边界

旧提案把 CLI 登录、网站授权和本地回调限制在手动回填路径；该边界已由实施 Note 替换为 `RemoteAuthService` 与一次性 CLI 回调接收器的分工。

## 提案

旧提案原计划使用 Authorization Code + PKCE，并要求用户在网站授权后把 `code#state` 粘贴回 CLI。

## 否决理由

“手动复制 `code#state`”不是产品要求，而是由过宽的本地监听禁令推导出的实现限制。产品要求浏览器在远程 AnswraSite 完成登录，并由 CLI 自动接收授权结果。新架构决策只允许短时、随机端口、绑定 `127.0.0.1` 的一次性 OAuth 回调，不开放通用本地服务。

## 曾考虑的替代方案

- **维持手动复制授权码：** 实现简单，但增加不必要的用户操作，已否决。
- **为 CLI 开放通用 localhost 服务：** 不符合最小监听面，已否决。
- **沿用 OAuth Device Code：** 需要新增网站确认页与服务端轮询接口；当前一次性回调已有可验证实现，暂不采用。

## 后果与防回退

CLI 登录仍使用网站账号体系和既有 token/keychain 边界；监听例外不得扩展成常驻或通用 HTTP 服务。后续若改用 Device Code，必须单独补齐网站、服务端协议和回归验证。
