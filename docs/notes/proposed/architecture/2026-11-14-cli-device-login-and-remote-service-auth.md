# Note：CLI 设备登录与远程服务准入

状态：提案

## 问题

CLI 已具备远程信令适配、WebRTC 传输和 host/controller 会话状态机，但真实连接前缺少服务准入：CLI 没有账号设备登录，拿不到 `signaling-ticket` 所需的 access token。桌面端登录 token 存在 Electron `safeStorage`，CLI 不能解密，也不能复用桌面端深链回调；直接读取桌面凭据会破坏进程安全边界。

同时仓库禁止非测试代码在 `src` 中开启本地监听，因此不能照搬桌面端 PKCE + loopback 回调。需要一条能在无窗口终端、SSH 和公司电脑上使用的登录路径，并且仍然使用 AnswraSite 的账号体系与授权页。

## 涉及范围

- CLI 身份与凭据：新增 `apps/cli/src/remote/auth/`，包含 PKCE、设备标识、keychain 凭据存储、登录/刷新/登出应用服务。
- CLI 命令：`apps/cli/src/config/cliOptions.ts`、`apps/cli/src/cli/authCommand.ts`、`apps/cli/src/cli/help.ts`、`apps/cli/src/cli/runCli.ts`、`apps/cli/src/cli/dependencies.ts`、`apps/cli/src/main.ts`。
- 远程服务准入：`apps/cli/src/remote/signaling/remoteSignalingService.ts` 改为通过访问令牌端口取 token，不再接受手工 token；`apps/cli/src/remote/runtimeDependencies.ts` 组合认证服务。
- 浏览器打开：`apps/cli/src/transport/openBrowser.ts`。
- 站点/网关前置：AnswraSite 需要提供 CLI 授权页与手动回调展示页，并把回调地址加入授权 allowlist；网关复用现有 `POST /api/v1/auth/desktop/exchange`、`POST /api/v1/auth/refresh`、`POST /api/v1/auth/logout`。
- 相关 Note：[远程控制 P2P 信令](./2026-11-13-remote-control-p2p-signaling.md)、[桌面端账号登录与凭据](../../implemented/feature/2026-10-17-desktop-account-login-and-credentials.md)。

## 模块边界

- `apps/cli/src/config/cloudEndpoints.ts`：只解析开发态 API/站点地址与生产回退，不发起网络请求。
- `apps/cli/src/remote/auth/`：PKCE、设备描述、token 交换/刷新、keychain 存储和登录态；不携带模型 API key，不读取桌面 `safeStorage`。
- `apps/cli/src/remote/signaling/remoteSignalingService.ts`：只把 access token 换成一次性 ticket；不解释账号权限或远程访问密钥。
- `apps/cli/src/main.ts`：组合根，把解析后的 `apiBaseUrl` / `siteBaseUrl` 注入 auth 与 signaling；业务模块不读环境变量。
- AnswraSite：只做授权页、回调页、exchange/refresh/logout 与 ticket 签发；不保存 CLI token、不接触远程访问密钥 secret。

## 提案

### 登录流程

采用 Authorization Code + PKCE S256 + 手动授权码回填，不用本地监听：

1. `answra auth login` 生成一次性 `state` 与 `code_verifier`，打印并尝试打开 AnswraSite CLI 授权页。
2. 用户在浏览器登录/同意后，站点跳转到 CLI 手动回调页。
3. 回调页把授权结果展示为 `code#state`（或完整 URL），用户在终端粘贴。
4. CLI 校验 `state`，调用现有 `/api/v1/auth/desktop/exchange`，携带 `code`、`code_verifier` 和稳定设备描述。
5. 成功后把 access token、refresh token、过期时间写入 OS keychain；失败不覆盖已有登录态。

不使用 OAuth Device Authorization Grant 作为首版：它需要新增设备码申请与轮询端点，站点还要新增用户码确认页；手动回调复用现有 authorize/exchange 契约，改动面更小。若后续要彻底免粘贴，再以独立 Note 增加 device code。

### 端点与站点契约

- 官方站点/网关固定为 `https://colorect.cloud`。打包版或 `ANSWRA_ENV=production` 时忽略所有地址覆盖。
- 开发态允许 `ANSWRA_CLOUD_API_BASE_URL` / `ANSWRA_CLOUD_SITE_BASE_URL` 覆盖，但只接受 `http:` 且 host 为 `127.0.0.1` 或 `localhost`；其他值静默回退官方地址，不能借此连接任意第三方域名。
- 授权页：`{siteBaseUrl}/{locale}/cli/authorize`；授权回调：`{siteBaseUrl}/{locale}/cli/authorize/callback`。生产为 `https://colorect.cloud/{locale}/cli/authorize/callback`。
- 授权页参数沿用桌面端：`state`、`code_challenge`、`code_challenge_method=S256`、`redirect_uri`、`device_id`、`device_name`、`os`。
- 站点在用户同意后，将 `code` 与 `state` 交给手动回调页；回调页只展示一次性授权码，不写日志、不持久化。
- 网关沿用现有 token 契约：`device_access_token` / `device_refresh_token` / `expires_in`，兼容 `access_token` / `refresh_token`；成功信封为 `{ code: 0, data }`。
- 本地联调时 `ANSWRA_CLOUD_SITE_BASE_URL` 与网关 `SERVER_FRONTEND_URL` 必须使用完全相同的 origin（`localhost` 与 `127.0.0.1` 不可混用），否则回调精确 allowlist 会拒绝。

### 凭据与设备

- access token、refresh token、过期时间只存 OS keychain，service `Answra`，account `remote-service-auth`；keychain 不可用时 fail-closed，不回退明文。
- 设备 ID 为非 secret，持久化到 `Answra/cli-device.json`；设备名默认主机名，`os` 取 `process.platform`。
- access token 提前 60 秒视为过期；`remote host/attach` 每次取 token 时按需刷新，refresh token 轮换后立即写回 keychain。
- 只有服务端明确拒绝（401/403 等，408/429 除外）才清除本地登录态；网络错误、超时与 5xx 保留凭据并向上报可重试错误。
- `auth logout` 先清本地凭据，再尽力调用 revoke；revoke 失败不阻止本地登出。

### 命令表面

```text
answra auth login
answra auth status
answra auth logout
```

`remote host` / `remote attach` 未登录时明确提示运行 `answra auth login`，不读取 `ANSWRA_REMOTE_SERVICE_TOKEN`，也不静默降级到匿名信令。

## 曾考虑的替代方案

- **复用桌面端 `safeStorage`：** 免登录，但 CLI 需要 Electron/DPAPI 解密，破坏“CLI 不读桌面凭据”的边界。舍弃。
- **CLI 开 localhost 回调：** 体验最好，但仓库架构禁止 `src` 本地监听；为登录单独开例外会扩大攻击面。舍弃。
- **OAuth Device Code：** 最适合无浏览器环境，但需要新网关端点与站点用户码页；首版成本高于手动回调。暂缓。
- **手工环境变量 token：** 只适合开发，无法刷新、容易泄漏，且用户已明确要正式登录。移除。
- **把 refresh token 写普通文件：** 实现简单但秘密落明文盘；keychain 不可用时必须失败。舍弃。

## 后果与防回退

- CLI 登录态与桌面登录态相互独立；同一账号可以在两个设备上分别授权、分别撤销。
- `ANSWRA_REMOTE_SERVICE_TOKEN` 不再是正式路径；若保留只允许作为测试注入，不进入用户文档。
- 站点必须实现 CLI 授权页/手动回调页并 allowlist `https://colorect.cloud/{locale}/cli/authorize/callback` 与本地开发 origin 的同一路径；未部署前只能做 fake 测试，不能声称真实登录可用。
- 登录只解决服务准入；控制某台 host 仍必须持有该 host 的远程访问密钥。

## 验收标准

- 可观察结果：`answra auth login` 打开授权页，粘贴 `code#state` 后登录成功；`remote host` / `remote attach` 未登录时提示先登录，登录后能用同一账号换取 `signaling-ticket`。
- 本地开发：设置 `ANSWRA_CLOUD_SITE_BASE_URL=http://localhost:3100`、`ANSWRA_CLOUD_API_BASE_URL=http://localhost:8080` 后，授权页、回调页和 exchange 都指向本地；打包版或生产环境忽略覆盖。
- 自动化验证：PKCE 向量与 `state` 一次性校验；fake store/fetch 下登录成功写 keychain、缺失或错误 `state` 拒绝、exchange 失败不覆盖旧凭据、过期自动刷新、401 清凭据、5xx 保留凭据、logout 清本地并尽力 revoke。
- 自动化验证：`cloudEndpoints` 覆盖本地 loopback、非法 host、打包版与生产回退；`remoteAuthService` 断言本地站点授权 URL、回调 URL 和 API 请求都使用注入地址。
- 自动化验证：`answra auth login/status/logout` 命令测试；未登录运行远程命令时提示登录；`pnpm --filter @answra/cli typecheck`、`test`、`build`、`pnpm architecture:check`。
- 需要的实机验证：站点部署后验证 Windows/macOS 浏览器授权、终端粘贴、刷新、撤销和多设备登录。
- 本地联调（2026-11-14）：本地 compose 下 `POST /api/v1/remote/signaling-ticket` 换取成功；host/controller 各用一张 ticket 完成真实 WebSocket `join` 和 WebRTC DataChannel 建立，controller 收到 host 的 `workspaceRoot` 与模型设置。网关原回调 allowlist 只接受无 locale 的 `/cli/authorize/callback`，已扩展为同时接受 `/{locale}/cli/authorize/callback`（单个 2–5 位小写 locale），并补正向/反向 Go 测试；重建网关后 `/health` 正常。

## 风险

- 本地覆盖若把 `localhost` 与 `127.0.0.1` 混用，会因网关精确回调 allowlist 失败；联调环境必须统一 origin。
- 开发态覆盖只保护官方构建不连第三方地址，不能防止本机用户主动把 loopback 服务换成恶意实现；这是开发便利与安全边界之间的有意取舍。
- 登录只证明服务准入，不替代 host 访问密钥；keychain 不可用时必须失败，不能回退明文或共享配置。
