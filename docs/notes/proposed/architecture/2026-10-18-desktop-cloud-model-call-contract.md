# Note：桌面端云端模型调用契约（所有 AI 调用经登录态走云端）

状态：提案

## 问题

桌面端当前所有 AI 能力都走本机自带的 OpenAI 兼容配置：用户在设置里自填 `{baseUrl, model, apiKey}`，由 desktop main 加密落盘（`conversation-model.json` + `safeStorage`，`apps/desktop/src/main/conversation/agentService.ts`）后下发给 agent。产品要求与之相反，且已由用户明确：

1. 应用启动、笔记等本地功能**不需要登录**；
2. **所有 AI 调用（对话、截图答题，以及未来新增 AI 能力）必须登录后走云端模型**；
3. 模型选择、上游路由、额度与放行**全部由服务端决定**。桌面端不保存 API Key、不保存模型名，也不判断免费/付费档位——「云端给了额度就能用，没给就报错」。

登录（Phase 0）与调用边界登录门禁已实现（`chat.send`/`answer.run` 未登录返回 `auth-required`）；本 Note 冻结**登录之后到云端模型之间**的契约，并据此移除 BYO 配置面。

关键前提：AnswraSite 网关**目前不存在**面向桌面端的模型调用端点。`/v1/*` 中转只接受 API Key（`gateway/internal/server/middleware/api_key_auth.go:21,34`、`routes/gateway.go:21,185,233`），设备令牌只能进 `/api/v1/*`；`GET /api/v1/capabilities` 恒返回空数组（`2026-10-17-desktop-capability-directory.md`），能力 ID 与 `capability_not_entitled` 只存在于站点 Draft 文档。因此本 Note 必须与站点侧方案（AnswraSite `docs/desktop-login-unlock-membership.md`）同日对齐后实施，且实施顺序为「网关端点先可用 → 桌面接入 → 删 BYO」。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`（能力 ID、云端调用错误码、agent 令牌注入命令）、`apps/desktop/src/main/auth/authService.ts`（token 供给）、`apps/desktop/src/main/conversation/agentService.ts`（改为注入云端 `baseURL` + 短时 token，删除 BYO 配置与落盘）、`apps/desktop/src/main/index.ts`（接线）、`apps/agent/src/conversation/runtime.ts`（provider 指向云端能力端点）、`apps/desktop/src/preload/index.ts` + `packages/ui/src/components/panels/SettingsPanel.tsx`（移除模型设置 UI）。
- UI/进程/协议/持久化表面：device access token 只存在于 main 内存与 agent 运行期请求头，**不进 renderer、不进日志、不落盘**；删除 `conversation-model.json` 这一持久化面；对话与答题的请求 URL/鉴权头形状变化。
- 相关 Note：[桌面端云端模型调用对接规格](./2026-10-18-desktop-cloud-api-integration-spec.md)（可直接照着实现的报文/错误码规格）、[桌面端账号登录与凭据（Phase 0）](../../implemented/feature/2026-10-17-desktop-account-login-and-credentials.md)、[桌面端会员能力目录](../../implemented/feature/2026-10-17-desktop-capability-directory.md)、[调用边界登录门禁](../../implemented/feature/2026-10-18-login-required-at-model-call.md)、[对话与答题 AI 领域拆分及对话能力复用](../../implemented/architecture/2026-10-18-ai-capability-domains-and-reuse.md)。

## 提案

### 两侧共同冻结的契约

1. **协议**：**OpenAI 兼容**（用户已确认「base url 自定义，模型调用协议都是 OpenAI 兼容」）。请求体、响应体与流式分片沿用 OpenAI 形状（`messages`、`stream: true`、`data: {...}` + `data: [DONE]`）。
   - **base URL 可配置、不写死路径**：实际路径与命名由服务端/部署决定（用户明确「命名不太一致」），因此桌面端把「能力 → base URL」作为配置项：构建默认值 + 登录后由 `GET /api/v1/capabilities` 下发 `base_url` 覆盖（服务端改名不必发版客户端），开发态可用环境变量覆盖。
   - 客户端 provider 只公开 `baseURL` 与 `apiKey`（`node_modules/@ai-sdk/openai-compatible/dist/index.d.ts:252-310`），会自动补 `/chat/completions` 并把 `apiKey` 变成 `Authorization: Bearer`；**agent 侧除注入 baseURL/token 外零改动**。
   - provider 会带上占位 `model` 字段，服务端必须**忽略并覆盖**（不信任客户端）；模型选择、上游路由全部在服务端。
   - 图片输入沿用现有 OpenAI `image_url` **data URL** 形状（`runtime.ts` 现行行为），对话与答题共用同一传输。
2. **鉴权**：`Authorization: Bearer <device_access_token>`，由网关新增的设备凭据中间件校验，服务端解析 `device → user → 生效订阅/额度`。
3. **能力 ID**（桌面端只认这两个；映射、上游、额度全在服务端）：`text.chat`（对话）、`image.answer`（截图答题）。两者**都不设客户端付费门槛**——统一由服务端额度控制（「免费的，我也能随时送给他们额度」）。客户端把能力 ID 作为占位 `model` 下发，网关改写为**统一模型别名 `desktop`**（`domain.DesktopUnifiedModelAlias`）：站点只需配置一个同名模型，真实上游模型只在站点侧；将来按能力分流只改该能力的 `ModelAlias`，不必发布客户端。
4. **错误契约**（服务端权威，桌面端不推断档位；借鉴 WeCode 的「结构化业务码 → 客户端动作」）：
   - **信封判定**：仅当 `success !== false && (code === undefined || code === 0 || code === 200)` 视为成功；存在 **HTTP 200 + 业务码表示失败**，桌面端不得只看 HTTP 状态码。
   - reason → 桌面端动作：`TOKEN_EXPIRED`/`UNAUTHORIZED` → main 预刷新后**单次**重试，仍失败清会话态并提示登录（复用 `AUTH_REQUIRED_NOTICE`）；`QUOTA_EXCEEDED` → 原样展示服务端 `message`，**不自动重试**；限流/`CAPABILITY_UNAVAILABLE`/上游 5xx → 展示并可重试；`CAPABILITY_NOT_ENTITLED` 作为契约保留（本期对话与答题不使用）。
   - 桌面端不出现「档位/套餐/能力置灰」概念；流已开始后的失败走现有流内错误通道（`runtime.ts` 的 error 事件）。
5. **额度展示（可选）**：`GET /api/v1/capabilities` 升级为**服务端权威快照**（含 `server_time` 与剩余额度字段），桌面端只展示快照里可直接呈现的剩余额度，不推导档位。
6. **token 供给**：main 在每次运行前提供**内存态** access token（过期则用 refresh 换新），经 worker 端口按运行注入 agent（新增 `AgentCommand` 成员或运行参数）；agent 只把它放进请求头，不持久化、不写日志。
7. **移除 BYO**：`conversation-model.json` 落盘读写、`configureConversation`/`getConversationConfig`/`getConversationApiKey` IPC、`ConversationModelConfig` 类型、SettingsPanel「模型」分组、相关单测，一并删除。模型连接不再由用户配置。

### 门禁：桌面端唯一门禁 = 登录

- 应用启动、笔记等本地功能不检查登录。
- **本期限制范围只有模型 API**：`text.chat`/`image.answer` 走服务端订阅与额度校验；其他功能不进入能力目录、不受限，客户端也不因目录内容置灰任何功能。
- 所有 AI 调用（`chat.send`、`answer.run`、未来能力）在 main 调用边界统一校验 `authService.hasSession()`；未登录返回 `auth-required`，UI 提示并打开设置账户区（已实现）。
- 桌面端**不**读 `capabilities` 做门禁、不区分免费/付费：额度与放行由服务端决定，客户端只呈现服务端结果。

## 模块边界

- `apps/desktop/src/main/auth`：唯一持有与刷新 device token 的层，对外只暴露「取一个可用的 access token」。
- `apps/desktop/src/main/conversation/agentService.ts`：不再拥有模型配置、密钥与落盘；只把云端 `baseURL`、capability 与短时 token 注入 agent 运行。
- `apps/agent`：只认 `baseURL` + Bearer `apiKey` + 能力路径，对模型名、上游、档位零知识；profile/用例仍按 `2026-10-18-ai-capability-domains-and-reuse.md` 的静态注册表隔离。
- `packages/ui`：不接触 token；只展示登录态与服务端错误消息。

## 曾考虑的替代方案

- **保留 BYO 作为未登录回退（现状）：** 与「所有 AI 调用必须登录走云端」冲突，且要求桌面端长期持有用户 API Key、扩大泄露面。舍弃。
- **客户端调用站点 `/v1/chat/completions` 并沿用 API Key 语义：** 需要把设备令牌伪装成 `sk-` Key 或给用户发 API Key，暴露官方模型与上游；且 `/v1/*` 由 API Key 中间件与按 key 计费链路独占，无法表达「按账号额度」。舍弃。
- **纯自有端点（非 OpenAI 编码）+ 客户端手写 fetch/SSE：** 契约更纯，但 agent 侧要自建流式解析、错误结构与取消逻辑，替换掉 AI SDK 已验证的 SSE/chunk 处理；且用户已确认云端按 OpenAI 兼容协议提供。舍弃。
- **把能力路径硬编码进客户端（如 `/v1/cap/{capability}/chat/completions`）：** 服务端命名尚未最终确定，硬编码会让服务端改名就必须发版客户端。舍弃，改为「能力 → base URL」配置项。
- **用 provider 的 `languageModel(modelId, { url })` 覆盖 URL 构造器：** `url` 构造器存在于内部配置类型（`index.d.ts:72-78,242`）但不在 `OpenAICompatibleProviderSettings` 公开面内，依赖 provider 内部实现；舍弃，改用「baseURL 带能力路径」达到同样效果。
- **桌面端按 `capabilities` 做能力置灰与升级引导：** 用户已明确桌面端不引入免费/付费概念，且能力级授权站点本期不实现；客户端预判会与服务端不一致。舍弃。

## 验收标准

- 可观察结果：未登录发起对话/答题 → 提示登录并打开设置账户区，不发出任何模型请求；登录后（不论档位）对话与答题直接可用（受服务端额度限制），请求头带 `Bearer <access token>`、URL 为配置的能力 base URL + `/chat/completions`；服务端拒绝时 UI 显示服务端消息；本机不再存在 `conversation-model.json`，设置中无 API Key / 模型输入入口。
- 自动化验证：shared 能力 ID 与错误码类型测试；agent 断言请求 URL、Bearer 头、body 不含客户端模型名；main 断言 token 不落盘、不进日志；UI 断言模型分组已移除、未登录提示复用 `AUTH_REQUIRED_NOTICE`。
- 需要的实机验证：Windows 打包版登录 → 对话 / 截图答题 → 登出后立即被拦；网关离线与额度用尽时的错误展示。

## 风险

- 网关端点未落地前无法联调；若先删 BYO 会让开发态完全没有 AI 能力，必须按「网关先可用 → 桌面接入 → 删 BYO」顺序推进。
- 长流式运行中 access token 过期：只能在运行前预刷新 + 401 单次重试；SSE 已开始后无法换 token，只能以流内错误结束本轮。
- `capabilities` 曾长期返回空数组；网关 Phase 1 已登记 `text.chat`/`image.answer` 并新增 `endpoints[]`（见[对接规格](./2026-10-18-desktop-cloud-api-integration-spec.md)），客户端接入时以 `endpoints` 为准。
- 桌面端不感知档位，所有「为什么不能用」的解释都依赖服务端 `message` 文案，服务端需给出面向用户可读的说明。
- 统一别名 `desktop` 是部署配置：站点侧必须存在同名模型，未配置时请求以 403/上游错误结束；路径由服务端下发，客户端不硬编码，避免静默失败或回退到任何本地模型。
