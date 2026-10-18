# Note：桌面端账号登录与凭据（Phase 0）

状态：已实施

## 问题

桌面端此前是**零账号**：模型能力只有本地 BYO 三元组 `{baseUrl, model, apiKey}`，服务端无法下发会员能力，也无法把上游模型选择留在服务端。产品模式是「免费能用 + 账号解锁会员」，因此需要一条让用户登录、由服务端下发能力清单的路径，且客户端**不接触也不保存**上游 API Key 与模型名。

同时存在两个不能靠"以后再说"绕过的硬约束：

1. 登录必须复用站点已有的账号体系（2FA/OAuth），桌面端不能自己收密码；
2. 云能力将来由 agent 在 `utilityProcess` 里执行，而 agent 是 Electron/凭据无关的运行时——token 不能进 agent，也不能进渲染层（渲染层会被截图、可能被注入）。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/auth/`（`pkce.ts`、`authorizeUrl.ts`、`callback.ts`、`pendingAuth.ts`、`pendingAuthStore.ts`、`credentialStore.ts`、`secureFile.ts`、`deviceInfo.ts`、`config.ts`、`authService.ts`、`authIpc.ts`、`callbackChannel.ts`、`loopbackCallback.ts`、`lifecycle.ts`）、`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/window.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/package.json`、`packages/shared/src/{channels,bridge,env,index}.ts`、`.env.example`、`packages/ui/src/components/panels/SettingsPanel.tsx` / `.css`。
- UI/进程/协议/持久化表面：设置面板新增「账户」区块；新增 4 个 IPC 频道（`answra:auth:*`）；新增 `userData/desktop-auth.bin`（凭据，safeStorage 加密）、`desktop-auth-pending.bin`（待处理登录，一次性 `code_verifier`）、`desktop-device.json`（设备稳定 ID）；首次启动申请单实例锁，第二个实例立即退出；打包清单新增 `protocols: answra`。
- 相关 Note：[禁止在 src 中自建本地监听](../architecture/2026-10-17-local-listener-forbidden.md)、[开发态环回回调例外](../architecture/2026-10-17-dev-loopback-callback-exception.md)、[Agent 组装点收归自身并抽象宿主传输](../architecture/2026-10-17-agent-host-composition-and-transport.md)。

## 决定

- **流程**：OAuth 2.0 for Native Apps（RFC 8252）Authorization Code + **PKCE S256** + 一次性 `state`。`login()` 在系统浏览器打开站点授权页，回调 `answra://auth/callback?code=…&state=…`；客户端只做 `code` → token 交换，不做任何密码/用户名输入。
- **回调通道抽象成端口**（`AuthCallbackChannel`）：打包版 = 深链（`open-url` / `second-instance` 路由），开发态 = 环回 HTTP（单例白名单，见环回例外 Note）。`AuthService` 不感知通道形态。
- **main 是唯一持有 token 的层**：access/refresh token 与账号画像（`plan`、`capabilities`）一起经 `safeStorage` 加密落盘；`safeStorage` 不可用时**拒绝写入**（宁可不持久化，也不明文落盘）。渲染层只能拿到 `AuthStatus { signedIn, plan, capabilities, cloudBaseUrl }`。
- **待处理登录必须落盘**：深链回跳经常由系统拉起一个新进程（应用未运行或 macOS 冷启动），只放内存会在最关键的路径上拒绝回调。落盘后由 `restore()` 载入，`state` 单次消费、2 分钟 TTL、`redirect_uri` 必须与发起时一致。
- **单实例 + 平台路由**：`requestSingleInstanceLock()`；macOS `open-url` 在 app ready 前注册，Win/Linux 从 `second-instance` 的 argv 里捞 URL；开发态协议注册带 `process.execPath` + 入口脚本路径（`process.defaultApp` 判定）。
- **登录成功与能力目录解耦**：交换成功即视为登录成功；能力目录拉取失败只让 `capabilities` 为空（下次刷新补回），不把已成功的登录丢掉。刷新失败必须分类：只有服务端明确拒绝（4xx，408/429 除外）才清凭据，网络/超时/5xx 保留登录态并冷却补刷，见[刷新失败不再等同登出](../bug-fix/2026-10-18-refresh-failure-keeps-session.md)。
- **云端地址防篡改**：打包版忽略环境变量、只用内置默认地址；开发态允许覆盖但必须是环回 http（`127.0.0.1` / `localhost`）。
- **网关契约集中在两处**：`AUTH_PATHS`（`exchange`/`refresh`/`revoke`/用户资料路径）与 `readTokens`/`readProfile`（响应解析）。主进程统一解包网关 `{ code, data }` envelope。
- **真实网页登录已接通**：网站登录后由授权确认页调用网关 authorize，桌面端用 PKCE verifier 兑换一次性 code；开发回调限 `127.0.0.1`，打包版限 `answra://auth/callback`。网关沿用现有 pending auth 完成码和 refresh token 轮换机制。
- **本轮不做**：云端跑任务（agent 带 Bearer 调网关）、BYO/云端模式切换与老用户迁移、门禁抬升到能力入口、撤销/多设备管理 UI。这些属于 Phase 1，触发点是网关能收请求。

## 影响表面

- 设置面板：桥提供 auth API 时显示「账户」区块（未登录 → 主按钮"登录"；已登录 → 会员档 / "已解锁 N 项云能力" + "退出登录"）；浏览器预览与旧桥无此 API 时整块隐藏。
- 授权页打开后提示"已在浏览器中打开授权页，完成后会自动同步"，登录结果由主进程推送（`answra:auth:status`）刷新界面。
- 首次启动行为变化：应用改为单实例；第二个实例不再创建窗口，只把深链 argv 转发给已运行实例。
- 未登录时 `cloudBaseUrl` 为 null；登录后为网关地址——客户端**不保存**模型名与上游地址。

## 曾考虑的替代方案

- **桌面端直接 `POST /auth/login` 换 JWT：** 实现最简，但无法复用站点 2FA/OAuth、要让用户在本应用里输密码、且需开放网络/CORS，安全性最差；舍弃。
- **把 token 放在渲染层（或让它自己刷新）：** 渲染层是截图/注入与 XSS 的唯一暴露面；token 一旦进渲染层，隐身定位与"客户端不接触 key"的承诺同时破产；舍弃。
- **打包版也支持环境变量覆盖云端地址：** 便于测试，但等于把"指向哪个网关"交给运行环境，篡改与钓鱼面太大；只在开发态放开且限制为环回 http。
- **待处理登录只放内存：** 省一个文件，但冷启动深链必然失败（新进程无待处理状态）；这类失败只出现在真实用户路径上，代价最高；舍弃。
- **先做深链、开发态也走深链：** 开发态协议注册依赖 `execPath` + 相对脚本路径，热重载与多实例下回跳常丢；采用受控的环回例外（另见环回例外 Note）。
- **登录与能力目录串行且强绑定：** 能力目录是服务端配置项，抖动会连带把已成功的登录判失败；改为解耦，只影响门禁展示。

## 后果与防回退

- token **永不**进渲染层、永不进日志、永不进 agent；后续云任务需要凭据时，由 main 经 worker 端口下发短时 access token（内存期、不落盘）。
- 客户端的云能力请求只能带**能力 ID**；上游模型与端点必须由网关官方配置，客户端不可见、不可伪造。新增云能力时先加能力 ID，不要在客户端加模型名参数。
- 单一登录尝试、`state` 单次消费、2 分钟 TTL、`redirect_uri` 与发起时一致 —— 这四条是安全线，任何"为了容错放宽校验"的改动都按缺陷处理。
- 本地只有一份常驻登录态；并发回调、重放回调、过期回调都必须被拒绝且不影响既有登录。
- **登录态是否有效只由服务端是否拒绝 refresh 决定**：网络错误、超时、5xx、网关重启都不得清凭据，也不得向渲染层推送"已登出"（见 `2026-10-18-refresh-failure-keeps-session.md`）。
- 新增/变更网关路径或响应字段时，只改 `AUTH_PATHS` 与 `readTokens`/`readProfile`，并在同一个变更里更新本 Note 的验证记录。
- `capabilities` 只用于展示与提前提示，**不构成授权**：真正的门禁与计费在服务端强制。

## 验证

- `apps/desktop/test/authPkce.test.ts`（7 项）：S256 与 RFC 7636 附录 B 官方向量一致；verifier/state 为无填充 base64url 且每次不同。
- `apps/desktop/test/authCallback.test.ts`（12 项）：接受深链与 `127.0.0.1` 环回回调；拒绝其他 scheme/host/path、`localhost`、缺参、`error=access_denied`（带描述）、非 URL；`findAuthCallbackUrl` 能从 argv 里捞出回跳。
- `apps/desktop/test/authPendingAuth.test.ts`（7 项）：命中后即消费（重放变 `no-pending`）、未知 state 拒绝、超 2 分钟 TTL 拒绝、`redirect_uri` 不一致拒绝、新登录作废旧登录、`restore()` 支持冷启动、登出清空。
- `apps/desktop/test/authConfig.test.ts`（4 项）：打包版忽略环境变量；开发态接受 `127.0.0.1`/`localhost` 覆盖并去掉尾斜杠；远端/非法/host 非环回一律回落默认。
- `apps/desktop/test/authService.test.ts`（30 项）：授权 URL 含 S256 challenge 且**不含** verifier；exchange 携带 `code`/`code_verifier`/`device`；网关 envelope 解包；用户资料请求带 `Bearer`；未知 state/超 TTL/交换失败均不落库且不推送；token 过期触发刷新并轮换 refresh token；被 4xx 拒绝的刷新才清凭据，网络/5xx/408/429 保留登录态并进入 60s 冷却；并发状态查询只刷新一次；登出调用 `revoke` 并清空凭据（revoke 失败也保持本地登出）；`hasSession()` 在 `restore()` 完成前按已登录处理。
- `apps/desktop/test/authLifecycle.test.ts`（5 项）：开发态协议注册带 `execPath` + 入口脚本，打包版只注册 scheme；设备 ID 稳定且损坏时重新生成。
- `packages/ui/test/FloatingBarApp.test.tsx`：无 auth API 时隐藏账户区块；点"登录"调用桥并提示浏览器授权；登录失败显示错误；推送 `plan: "pro"` + 两项能力时显示"会员 / 已解锁 2 项云能力"，推送登出后回到未登录；退出登录采用返回状态；面板关闭时取消订阅。
- `pnpm verify`（lint + notes + typecheck + test + architecture:check）与 `pnpm build` 通过。
- 待实机验证：登录握手和回调需在部署了 AnswraSite 授权页及网关路由的环境验证；另需验证冷启动深链（应用未运行时点链接）和打包版协议注册。会员能力目录已由独立 Note 记录；桌面云端模型调用与额度门禁仍未实现。
