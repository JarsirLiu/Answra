# Note：桌面端云端模型调用对接规格（网关 ↔ 桌面端线协议）

状态：提案

## 问题

两侧需要一份「照着就能实现」的对接规格。此前契约只以决策形式记录在 [桌面端云端模型调用契约](./2026-10-18-desktop-cloud-model-call-contract.md) 里，没有可直接对接的路径、请求头、报文示例、SSE 分片与错误码表；网关已按「能力 ID 占位 model + 服务端改写 + OpenAI 兼容 + 专属错误形状」落地，桌面端又按 AI SDK 的 provider 行为调用，双方的字段理解、信封规则与重试动作容易各自漂移。

当前落地进度：网关侧 Phase 1 已实现并验证（迁移 246、影子 Key、`POST /api/v1/desktop/chat/completions`、能力目录 `endpoints[]`、OpenAI 形状错误体；`go build ./...` 与 24 例相关单测通过），尚未部署；桌面端接入进行中（shared 契约与凭据存储已改，authService/agent/UI 未完）。

同时需要明确**当前的限制范围**：本期只有**模型 API（AI 调用）受限**——是否放行、额度多少全由服务端订阅与额度校验决定；应用启动、本地笔记等**本地功能一律不受限**，既不登录也不消耗额度，也不进入能力目录。这一点若不在规格里写死，很容易被误当成「所有云端接口都要按能力目录逐项授权」。

## 涉及范围

- 网关侧（AnswraSite `gateway/`）：`internal/domain/desktop_capability.go`（能力目录唯一来源）、`internal/server/routes/desktop.go`（路由与占位 model 改写）、`internal/server/middleware/desktop_key_auth.go`（用户态鉴权与 OpenAI 形状错误）、`internal/service/desktop_access_service.go`（影子 Key 解析）、`internal/handler/auth_desktop.go`（令牌签发/刷新/撤销）、`internal/handler/subscription_handler.go`（能力目录下发）、迁移 `246_add_api_key_is_system.sql`。
- 桌面端：`packages/shared/src/channels.ts`（能力 ID、端点类型、内部线协议）、`apps/desktop/src/main/auth/authService.ts`（令牌与目录）、`apps/desktop/src/main/conversation/agentService.ts`（按运行注入令牌）、`apps/agent/src/worker/{protocol,host}.ts` + `apps/agent/src/conversation/runtime.ts`（请求构造与 401 单次重试）。
- UI/进程/协议/持久化表面：device access token 只存在于 main 内存与 agent 运行期请求头，不进 renderer、不进日志、不落盘；本规格不引入任何新的本地持久化面。
- 相关 Note：[桌面端云端模型调用契约](./2026-10-18-desktop-cloud-model-call-contract.md)、[桌面端账号登录与凭据](../../implemented/feature/2026-10-17-desktop-account-login-and-credentials.md)、[桌面端会员能力目录](../../implemented/feature/2026-10-17-desktop-capability-directory.md)、[调用边界登录门禁](../../implemented/feature/2026-10-18-login-required-at-model-call.md)、[对话与答题 AI 领域拆分及对话能力复用](../../implemented/architecture/2026-10-18-ai-capability-domains-and-reuse.md)。

## 提案

### 0. 限制范围（本期唯一权威口径）

- 桌面端唯一门禁是**登录**：本地功能（启动、窗口、笔记本、截图采集）不检查登录，也不消耗额度。
- **只有模型 API 受限**：`text.chat`、`image.answer` 两类调用走服务端「用户 → 系统影子 Key → 分组/额度」校验；额度或订阅不满足时由服务端拒绝，客户端只展示结果。
- 能力目录**只登记模型 API 类能力**。其他功能不进入目录、不下发 `endpoints`，因此「目录里没有」不代表功能被禁用，客户端也**不**用目录做任何功能置灰或升级引导。
- 未来新增 AI 能力时登记新的能力 ID 并复用同一通路；新增非 AI 功能不进目录、不受限。

### 1. 时序总览

```
桌面端                         站点(浏览器)                 网关
  |-- 打开授权页 --------------------------------->|
  |<-- 深链/环回回调 code --------------------------|
  |-- POST /api/v1/auth/desktop/exchange --------->|  换 device_access/refresh token
  |-- GET  /api/v1/capabilities (Bearer access) -->|  取 plan/capabilities/endpoints
  |-- 运行前取 access token（过期则 refresh）         |
  |-- POST /api/v1/desktop/chat/completions ------>|  jwtAuth -> 影子 Key -> 额度校验 -> 上游
  |<-- SSE data:{chat.completion.chunk} ... [DONE]-|
  |-- 401 时：单次刷新令牌并重放同一请求 -------------->|
```

### 2. 令牌接口

成功响应统一为信封 `{ "code": 0, "message": "success", "data": {...} }`（`internal/pkg/response/response.go`）。

| 接口 | 请求体 | 说明 |
| --- | --- | --- |
| `POST /api/v1/auth/desktop/exchange` | `{"code","code_verifier","device":{"id","name","os"}}` | PKCE S256 换令牌；`code_verifier` 长度 43~128 |
| `POST /api/v1/auth/refresh` | `{"refresh_token"}` | 滑动续期，返回同形状令牌 |
| `POST /api/v1/auth/logout` | `{"refresh_token"}` | 撤销 refresh token |
```json
{ "code": 0, "message": "success", "data": {
  "device_access_token": "eyJ…", "device_refresh_token": "…",
  "expires_in": 86400, "token_type": "Bearer" } }
```

- 客户端读 `device_access_token`/`device_refresh_token`，兼容 `access_token`/`refresh_token`；`expires_in` 为**秒**，缺省按 3600 兜底；客户端按 `expires_in - 60s` 提前判定过期。
- 桌面端不落盘 refresh token 之外的任何凭据语义，也不持有网关 API Key。

### 3. 能力目录 `GET /api/v1/capabilities`

请求头：`Authorization: Bearer <device_access_token>`（用户态 JWT）。

```json
{ "code": 0, "message": "success", "data": {
  "plan": "会员",
  "capabilities": ["text.chat", "image.answer"],
  "endpoints": [
    { "id": "text.chat",    "kind": "text",  "path": "/api/v1/desktop/chat/completions", "model": "text.chat" },
    { "id": "image.answer", "kind": "image", "path": "/api/v1/desktop/chat/completions", "model": "image.answer" }
  ] } }
```

| 字段 | 语义 |
| --- | --- |
| `plan` | 生效套餐展示名；`null` 表示无生效套餐。**仅展示**，不参与授权判定 |
| `capabilities` | 已实现接口面的能力 ID 列表，**兼容字段**：桌面端不再据此做任何判断或文案（不置灰、不显示「已解锁 N 项」） |
| `endpoints[].id` | 能力 ID，与 `capabilities` 同值 |
| `endpoints[].kind` | `text` / `image`，供客户端归类展示 |
| `endpoints[].path` | 能力调用路径（不含 origin）；**路径命名由服务端决定** |
| `endpoints[].model` | 客户端应写入请求体的占位模型（即能力 ID） |

- **目录是「接口面清单」，不是权益清单**：本期没有需要按能力解锁的特有能力，目录**闲置**——客户端只用 `endpoints[].path` 取调用路径，不用它判断能不能用；「目录里没有」也不代表功能被禁用（非模型功能根本不进目录）。
- **`endpoints` 非可选依赖**：任一能力缺失即视为「云端模型调用暂不可用」，客户端给出可重试提示，不猜路径、不回退本地模型。
- 客户端以「配置的云端 origin + `path` 去掉 `/chat/completions` 后缀」作为 provider 的 `baseURL`，因此服务端改路径无需发布客户端。
- 目录变更只在客户端刷新（下次 `getStatus`/`refresh`）后生效，本期**无推送、无版本号**（刻意接受，见风险）。

### 4. 模型调用 `POST /api/v1/desktop/chat/completions`

```http
POST /api/v1/desktop/chat/completions HTTP/1.1
Authorization: Bearer <device_access_token>
Content-Type: application/json
```

```json
{ "model": "text.chat", "stream": true, "messages": [
  { "role": "system", "content": "…（能力对应的系统提示）" },
  { "role": "user", "content": [
    { "type": "text", "text": "解释这张截图" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0…" } } ] } ] }
```

- 对话与答题**共用同一路径**，只靠 `model`（能力 ID）区分；差异在客户端的系统提示与是否携带历史。
- `model` 必须是能力 ID：网关把它改写成**统一模型别名 `desktop`**（`domain.DesktopUnifiedModelAlias`），再由分组渠道映射解析到真实上游模型；未登记的能力 ID → `400 unknown_capability`。客户端**永远不知道**真实模型名与供应商。
- 统一别名意味着站点只需配置一个名为 `desktop` 的模型即可同时支撑对话与答题；将来若答题要换视觉模型，只改该能力的 `ModelAlias`，客户端无需发版。
- 客户端固定 `stream: true`（AI SDK 行为），服务端以 SSE 返回：

```
data: {"id":"…","object":"chat.completion.chunk","created":1,"model":"…","choices":[{"index":0,"delta":{"role":"assistant","content":"收到"},"finish_reason":null}]}

data: {"id":"…","object":"chat.completion.chunk","created":1,"model":"…","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

- 图片输入沿用 OpenAI `image_url` data URL 形状；单图 ≤ 8 MB，客户端限制单次 ≤ 8 张（客户端侧校验，服务端仍需自守）。
- 非流式请求沿用网关既有 chat completions 逻辑，桌面端当前不使用。

### 5. 已定与不做（本期结论）

| 议题 | 结论 |
| --- | --- |
| 统一别名 | **已定**：两类能力共用别名 `desktop`（`domain.DesktopUnifiedModelAlias`）；站点只需配置一个同名模型，真实模型只在站点侧 |
| 登录提示路径 | **已定**：只有一条用户可见路径——main 门禁与服务端 401 都归一到客户端码 `auth-required`，提示同一句并打开设置面板 |
| 失败码 | **已定**：见 §5 表，两侧冻结；网关只增码不改已有码语义 |
| 能力目录 | **闲置**：本期没有需要解锁的特有能力，客户端只用 `endpoints` 取路径，不展示、不置灰、不据此判断额度 |
| 目录推送/版本号 | **不做**：变更随客户端刷新生效，接受最长一个令牌周期的延迟 |
| 请求 ID 关联 | **不做**：只有模型调用可能出现难判归属的失败，而模型调用错误由 SDK 原样上报（含云端返回的消息），足以判断「云端模型出错」；不引入跨服务 ID 约定 |

### 6. 错误契约（两侧冻结）

模型端点用 **OpenAI 形状**（**不是**信封），由 `middleware.AbortWithDesktopError` 输出：

```json
{ "error": { "message": "…", "type": "insufficient_quota", "code": "desktop_access_not_entitled" } }
```

| HTTP | `error.type` | `error.code` | 触发条件 | 客户端动作 |
| --- | --- | --- | --- | --- |
| 401 | `authentication_error` | `unauthorized` | 无用户身份 / access token 失效 | 刷新令牌后**单次**重放；仍 401 → 转成客户端码 `auth-required`，提示「请到设置里登录账号」并打开设置面板 |
| 403 | `insufficient_quota` | `desktop_access_not_entitled` | 无生效订阅、订阅指向分组缺失、分组停用 | 原样展示服务端 `message`（已面向用户可读），**不重试** |
| 403 | `insufficient_quota` | `desktop_access_unavailable` | 系统影子 Key 被停用 | 原样展示，不重试 |
| 429 / 403 | `insufficient_quota` | 额度类业务码 | 余额/配额不足、限流 | 原样展示，不重试（限流可按 `message` 由用户手动重试） |
| 400 | `invalid_request_error` | `unknown_capability` | `model` 不是已登记能力 ID | 客户端编码缺陷，上报日志 |
| 500 | `invalid_request_error` | `internal_error` | 服务端内部失败 | 可重试，不泄露内部信息 |

- 判定规则：**模型端点只看 HTTP 状态码 + `error.code`**；`/api/v1/*` 其他接口用信封（成功 `code: 0`，失败 `code` 为 HTTP 状态码），两者不可混用。
- **登录失败只有一条用户可见路径**：main 侧门禁（未登录直接拒绝）与服务端 401 都归结为客户端失败码 `auth-required`（`packages/shared` 常量为准），渲染层只认这一个码 → 统一提示 `AUTH_REQUIRED_NOTICE`「请先登录后再使用（设置 → 账户）」并打开设置面板；两条路径都不弹出浏览器。
- `error.message` 面向用户可读，桌面端直接展示；客户端不术语化（不出现「档位」「套餐」「能力」等字样）。
- 流已开始后的失败走流内错误通道（SSE 内 error 分片），不再有 HTTP 错误体，也不重试。

### 7. 桌面端内部线协议（配合实现，非对外接口）

- `AgentCommand`：`chat-send` / `answer-run` 携带本次运行的 `accessToken`；`token` 是宿主对反向请求的回答（`{id, accessToken?}` 或 `{id, error?}`）。
- `AgentFrame`：`response` / `change`，新增 `token-request`（`{version:1, id, forceRefresh:true}`），由 agent 在收到 401 时发出，宿主用同 id 的 `token` 命令回答；宿主未实现时 10s 超时，本轮以客户端码 `auth-required` 结束。
- 令牌按运行注入，**不进 renderer、不落盘、不进日志**；`configure` 只下发各能力端点（`{chat:{baseUrl,model}, answer:{baseUrl,model}}`），不含凭据。

## 模块边界

- 网关：能力目录以 `internal/domain/desktop_capability.go` 为唯一来源，路由/目录/占位改写三处必须同源；鉴权与错误输出集中在 `desktop_key_auth.go`，额度判定复用 `/v1` 通路的同一个执行器，避免两套计费漂移。
- 桌面 main（`apps/desktop/src/main/auth`）：唯一持有令牌、唯一接触目录，对外只暴露「组装模型端点」与「取一个可用令牌」；`agentService` 不再拥有模型配置、密钥与落盘。
- `apps/agent`：只认 `baseUrl` + Bearer 令牌 + 占位 `model`，对真实模型、档位、额度零知识；401 后的换令牌经反向帧回到宿主，不在 agent 内实现刷新。
- `packages/ui`：不接触令牌；只展示登录态与服务端错误消息。

## 曾考虑的替代方案

- **把路径硬编码进客户端（如 `/v1/cap/{id}/chat/completions`）：** 服务端命名未最终确定，硬编码会让改名变成客户端发版。舍弃，改为服务端下发 `endpoints[].path`。
- **模型端点也返回信封 `{code,message,data}`：** AI SDK 的 OpenAI 兼容 provider 只解析 OpenAI 错误形状，信封会让失败原因丢失成不可读错误；且与「OpenAI 兼容」契约冲突。舍弃，改为 `error.code` 承载稳定业务码。
- **让客户端解析 `plan`/额度做置灰与升级引导：** 用户已明确桌面端不引入档位概念，客户端预判会与服务端不一致。舍弃，`plan` 仅展示。
- **目录里登记全部产品功能（含本地功能）以统一「能力」语义：** 本期只有模型 API 受限，把本地功能放进目录会让「目录缺失 = 功能禁用」的错误语义扩散，并诱导客户端做置灰。舍弃，目录只登记模型 API。
- **把令牌写进 agent 的 `configure`（一次配置长期复用）：** 令牌会随配置被缓存，长会话必然过期，且扩大了凭据生命周期。舍弃，改为按运行注入 + 401 反向换取。

## 验收标准

- 可观察结果：登录后对话/答题请求命中 `/api/v1/desktop/chat/completions`，头带 `Bearer <access token>`，body 的 `model` 是能力 ID 且不含真实模型名（站点侧命中统一别名 `desktop`）；未登录或令牌失效时提示「请到设置里登录账号」并打开设置面板，不打开浏览器；无生效订阅时 UI 显示服务端文案；本地功能（启动、笔记本）在未登录、无额度时照常可用；设置面板没有任何模型/API Key 入口，本机不存在 `conversation-model.json`。
- 自动化验证：网关侧 `desktop_access_service_test.go`（12 例）、`desktop_key_auth_test.go`（9 例）、`desktop_capabilities_test.go`、`desktop_test.go`（统一别名与占位改写、未登记模型拒绝）；桌面侧断言 provider `baseURL` 由 origin + 去后缀 path 拼出、令牌不落盘、`readProfile` 解析 `endpoints[]`、401 → `auth-required` 且只重试一次、host 反向令牌请求往返、设置面板无 BYO 入口。
- 需要的实机验证：Windows 打包版登录 → 对话 / 截图答题 → 额度耗尽提示 → 登出后立即被拦（提示同一句）；网关离线与目录缺端点时的可重试提示。

## 风险

- **别名未配置即不可用**：站点必须存在名为 `desktop` 的模型（该别名属部署配置，不是代码常量），未配置时请求会以 403/上游错误结束；需在部署检查里前置校验。
- **目录无推送**：服务端改 `path`/新增能力后，客户端要等下次刷新（最长到令牌过期）才生效；已接受，如需即时生效要另加推送或短 TTL 缓存。
- **长流中途令牌过期**：SSE 已开始后无法换令牌，只能以流内错误结束本轮；当前策略是运行前预刷新 + 401 单次重试，不做运行中续期。
- **排障依赖 SDK 错误文本**：不引入请求 ID 关联（见 §5），判断「云端模型出错」依赖 SDK 展示的服务端消息；若将来出现难判归属的失败，再补 `X-Client-Request-ID` 记录与回传。
- **额度文案责任在服务端**：桌面端不感知档位，所有「为什么不能用」依赖服务端 `message` 的可读性。
- **两侧同源风险**：能力 ID 与路径在两仓库各有一份常量（`packages/shared/src/channels.ts` 与 `internal/domain/desktop_capability.go`），改名必须同步，缺一方即静默失效。
