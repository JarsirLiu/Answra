# Note：桌面端登录与会员解锁（Answra 侧）

状态：提案

## 问题

桌面端当前是**零认证**：没有账号/会话/会员概念，模型配置只存一份通用 OpenAI 兼容三元组 `{baseUrl, model, apiKey}`（`apps/desktop/src/main/conversation/appService.ts`、`packages/shared/src/channels.ts`）。产品模式是「免费能用 + 账号解锁会员」，因此需要一条路径让用户**登录后由服务端下发会员能力**，且客户端**不接触也不保存** API Key 与模型名——模型选择、上游路由、额度都必须由 AnswraSite 网关官方控制。此前的 [面试模式提案](../feature/2026-10-12-live-interview-assistant.md) 已把「账号授权 + 服务端持有 key + entitlement」列为上线前置工作；本 Note 冻结客户端侧的登录与凭据契约。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/`（协议注册、单实例、认证与凭据、模型配置切换）、`packages/shared/src/channels.ts` + `bridge.ts`（新增认证 IPC 契约）、`packages/ui/src/components/panels/`（账户/登录 UI）、`apps/app/src/conversationRuntime.ts`（云端能力调用）。
- 进程/隐私表面：device token 仅经 main `safeStorage` 持有，**不进 renderer、不进日志**；云端模式 renderer 只看到 `baseUrl` 与能力调用结果。
- 相关 Note：[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)、[Answra 实时语音识别私有协议（AVP）v1](2026-10-16-answra-voice-protocol-avp-v1.md)、[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)。

## 提案

### 认证（采用行业标准）

- 采用 **OAuth 2.0 for Native Apps（RFC 8252）**：浏览器 **Authorization Code + PKCE**（S256），自定义 URI scheme 回调 `answra://auth/callback`。桌面端**不接触用户密码**，复用站点登录/2FA/OAuth。
- 网关签发 **短期 access token（JWT）+ 长期 opaque refresh token（轮换，可撤销，RFC 7009）**。桌面端凭据仅 `safeStorage` 持有。
- 需要新增：`build.protocols` 声明 `answra`（`apps/desktop/package.json`）、运行时 `app.setAsDefaultProtocolClient("answra")`、单实例 `requestSingleInstanceLock()` + `second-instance`(Win/Linux) / `open-url`(macOS)。

### 客户端契约（关键约束）

1. 云端模式下**本地只保存 `baseUrl`**（指向网关），**不保存也不展示 API Key 与模型名**；模型由网关按「能力」在服务端解析。
2. 客户端只请求**能力 ID**（如 `text.chat`、`image.generate`、`voice.realtime`、`exam.grade`），调用统一端点 `POST /v1/cap/{capability}`（语音为 `WS /v1/cap/{capability}`），携带 `Authorization: Bearer <device_access_token>`。
3. 登录后拉取账号可用能力与额度（站点/网关 `GET /api/v1/capabilities`、`/subscriptions/*`），用于 UI 门禁与展示；**计费与限额以服务端为准**。
4. 免费态（未登录/未订阅）沿用现有 BYO Key 三元组，不改变现状。

### 状态与切换

- 认证凭据（device token）与「模型配置」**分离管理**：前者仅 main 持有，后者云端模式仅 `baseUrl`。
- 登录会员态 → 运行时切到云端能力调用；登出/失效 → 清凭据、回退免费态。

## 模块边界

- `packages/shared`：新增认证 IPC 契约（登录/登出/查询账号与能力），**不承载** device token 明文，也不承载任何上游模型名；renderer 只能看到能力 ID 与额度。
- `apps/desktop/src/main`：协议注册、单实例、PKCE、`shell.openExternal`、回调校验、token 刷新与 `safeStorage` 持有；是**唯一**接触 device token 的层。
- `apps/app`：按能力调用云端，**无模型/上游知识**；与 AVP 一致的原则——上游切换只发生在服务端。
- `packages/ui`：登录/会员状态/能力门禁的展示层，不接触 token。

## 曾考虑的替代方案

- **OAuth 2.0 设备授权（RFC 8628，device code flow）：** 无需协议注册，适合 CLI；但需用户手抄/确认码，桌面体验差，且网关需新增轮询端点。作为**备选**保留，不作主路径。
- **桌面端直连 `/auth/login` 存 JWT：** 实现最简，但无法走 2FA/OAuth、桌面端需处理密码、且要开放网关 CORS，安全性差。**舍弃**。
- **站点生成码 + 桌面端手动粘贴：** 无需协议注册；但需用户复制粘贴，交互割裂，用户明确不需要。**舍弃**。
- **客户端本地保存 API Key / 模型名（沿用 BYO 三元组）：** 与「模型由官方控制」冲突，且用户可提取/滥用。**舍弃**。

## 验收标准

- 可观察结果：桌面端点「登录解锁会员」→ 浏览器完成登录 → 自动回跳桌面端 → UI 显示会员档位与额度；云端模式下本机**只存在 `baseUrl`**，无 API Key、无模型名。
- 自动化验证：PKCE/state 单测；回调解析与单实例唤起单测；凭据存储读写单测（不含明文）；能力调用请求体断言（无 model 字段）。
- 需要的实机验证：Windows NSIS 安装包下协议唤起、深链回调、登录/登出/换号、免费态回退。

## 风险

- 自定义协议在 Windows 可能被其他程序抢占：以 **PKCE** 缓解（回调码即使泄漏也无法兑换）。
- 单实例/深链在 Win/Linux 与 macOS 行为不同，需分平台处理 `second-instance` 与 `open-url`。
- token 过期与时钟漂移：需静默刷新 + 失败回退登录态。
- 免费档额度、能力集合等策略由服务端决定，客户端不得假设具体模型或额度（防回退）。

<!-- 实施后迁到 implemented/：改写为「决定」，补「后果与防回退」「验证」。AnswraSite 侧完整方案见 D:\learn\xx\AnswraSite\docs\desktop-login-unlock-membership.md。 -->
