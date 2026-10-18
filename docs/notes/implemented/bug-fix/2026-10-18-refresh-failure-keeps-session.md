# Note：刷新失败不再等同登出

状态：已实施

## 问题

用户反馈"登录几十分钟就失效，要频繁重新登录"。网关侧的寿命其实足够：access token 默认 24h，refresh token 默认 30 天且每次刷新都会轮换并**重新计满 TTL**（网关 `auth_service.go` 的 `RefreshTokenPair` / `GenerateRefreshToken`），只要 30 天内启动过一次应用就不该重登。

真正的来源在客户端：`AuthService.doRefresh` 捕获**任何**异常都调用 `dropSession()`，把 `refresh_token` 从本地删掉。于是断网启动、网关重启、代理超时、5xx 甚至一个 JSON 解析抖动，都会让一次临时故障退化成"凭据已失效、必须重走浏览器登录"。第二个放大因素是 `readTokens` 的兜底寿命只有 1800 秒（30 分钟）：网关响应一旦缺 `expires_in`，用户就变成半小时刷一次，抖动概率被放大 48 倍。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/auth/authService.ts`（`doRefresh`、`dropSession`、`getStatus`、`request`、`readTokens`）、`apps/desktop/src/main/auth/authIpc.ts`（消费者）。
- UI/进程/协议/持久化表面：`userData/desktop-auth.bin` 的**存留语义**变化（临时失败时不再被删除）；`answra:auth:status` 推送给渲染层的 `signedIn` 在离线时保持为真；`answra:auth:get-status` 在冷却期内不再产生网络等待。
- 相关 Note：[桌面端账号登录与凭据（Phase 0）](../feature/2026-10-17-desktop-account-login-and-credentials.md)。

## 根因

`doRefresh` 用同一个 `catch` 处理两类完全不同的失败：

1. **服务端明确拒绝**（401 `REFRESH_TOKEN_INVALID`/`REFRESH_TOKEN_EXPIRED`/`TOKEN_REVOKED`/`REUSE`、403 `USER_NOT_ACTIVE`）——refresh token 确实死了，只能重登；
2. **临时失败**（`fetch` 抛错、15s 超时、5xx/503、408/429）——凭据完全有效，只是这次没拿到新 token。

而 `request()` 只抛出 `new Error(\`${path} 返回 ${status}\`)`，状态码在抛出点就丢了，调用方无法分类，只能"一律当死"。此外 `FALLBACK_EXPIRES_IN = 1800` 远低于网关默认 24h，缺字段时会把刷新频率抬到半小时一次。

## 修复

- 新增 `CloudRequestError(status, path, message)`，`request()` 的所有失败路径（HTTP 非 2xx、envelope `code !== 0`）都携带状态码抛出。
- 新增 `isRejectedByServer(error)`：只有 `CloudRequestError` 且 `4xx` 且**不是** 408/429 才算"服务端明确拒绝"。非 `CloudRequestError`（网络错误、超时、解析失败）一律按临时失败处理。
- `doRefresh` 分叉：拒绝 → `dropSession()`（清凭据并按未登录推送）；临时失败 → 保留凭据、保留内存会话、**不发登出推送**，返回缓存 `statusFrom(session)`，并记录 `refreshRetryAt = now + 60s`。
- `getStatus()` 在 `now < refreshRetryAt` 时直接返回缓存登录态，不再发起刷新：离线时每次查询都不会各等一次 15s 超时。
- 冷却在登录成功、刷新成功与 `dropSession` 时清零；`restored` 标记在 `restore()` 的 `finally` 中置位（见配套 Note 的门禁用法）。
- `FALLBACK_EXPIRES_IN` 从 1800 改为 3600，与网关真实档位同一量级：兜底值只影响刷新频率，不决定登录态寿命。

## 决定

登录态是否有效**只由服务端是否明确拒绝 refresh 决定**，网络可达性不参与判定。临时失败一律保留凭据并退避重试；只有拿到 4xx（408/429 除外）才清凭据并要求重新登录。

## 曾考虑的替代方案

- **所有失败都保留凭据（不做分类）：** 已失效的 refresh token 会被永久保留，用户既不重登也刷不出新 token，表现为"一直显示已登录但什么都调不动"；必须有终态分支，因此按状态码分类。
- **网络失败时立即重试（指数退避循环）：** 会在离线/网关故障期间持续占用请求并放大失败面，用户仍看到不可用的界面；改为冷却 + 下次查询触发，代价是故障恢复后最多延迟 60s 自动补刷。
- **只把 `FALLBACK_EXPIRES_IN` 改大：** 只能降低刷新频率，无法解决"一次网络抖动就登出"，主因仍在分类缺失。
- **在渲染层判断"是否离线"再决定清不清凭据：** 渲染层拿不到 token 也无法区分 401 与超时，且会让安全敏感的凭据生命周期依赖不可信的 UI 状态。

## 后果与防回退

- `dropSession()` 的调用点必须保持"仅服务端拒绝"这一前提；任何"为了干净起见清一下凭据"的写法都按缺陷处理。
- 临时失败必须保持**无 `auth/status` 推送**：渲染层不应看到 `signedIn: false` 闪现，否则界面会在离线时反复切到未登录态。
- 冷却常量（60s）与超时（15s）是"离线不卡界面"的唯一保障，调大超时前必须同时评估冷却与 `getStatus()` 的调用频率。
- `FALLBACK_EXPIRES_IN` 不得再低于网关默认档位；网关调整 `access_token_expire_minutes` 时应同步本值。
- 部署侧约束（不在本仓库代码内，但会直接触发本次缺陷）：网关的 refresh token cache（Redis）不可用时 `RefreshTokenPair` 直接返回 401，客户端会正确地判为"需重登"，因此**部署必须保证 Redis 可用**；`session_binding_enabled` 必须保持关闭（默认关闭），否则换网/VPN/多网卡都会被判定为会话异常。

## 验收标准

- 离线启动：已登录用户仍显示已登录，本地凭据保留，界面不出现"未登录"。
- 网关 5xx/503/408/429 或超时：保留登录态，60s 内不再发起刷新请求，之后自动补刷成功即回到正常刷新节奏。
- 401/403/400：清除本地凭据并推送未登录。
- `expires_in` 缺失时兜底为 1 小时。

## 验证

- `apps/desktop/test/authService.test.ts`：`AuthService.refresh failure classification` 4 项 + `AuthService.hasSession` 2 项 + `readTokens` 兜底断言（30 项全绿）。
  - `fetch` 抛错（离线）→ `restore()` 返回 `signedIn: true`、`refresh_token` 仍在、`statuses` 为空（无登出推送）。
  - 500/502/503/408/429 逐个断言保留凭据且无推送。
  - 400/401/403 逐个断言清凭据并推送未登录。
  - 冷却：失败后 30s 内 `getStatus()` 不再产生刷新请求，90s 后补刷成功并落库新 token。
- `pnpm verify`（lint + notes:check + typecheck + test + architecture:check）通过。
- 待实机验证：断网启动 / 网关重启期间的登录态保持与恢复后自动补刷，需在部署了网关的环境确认。

## 风险

- 冷却是进程内状态，重启应用会立即重试一次（可接受：一次超时代价）。
- 服务端若把权限类错误也用 4xx 表达（例如 403 表示"本次请求无权限"而非"账号不可用"），会误清凭据；当前网关 403 只有 `USER_NOT_ACTIVE`，因此可接受，新增 403 语义时必须同步 `isRejectedByServer`。
- 客户端兜底寿命与网关真实寿命不一致时只影响刷新频率，不会缩短登录有效期。
