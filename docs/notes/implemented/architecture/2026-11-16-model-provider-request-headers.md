# Note：模型 provider 请求头按端点显式声明

状态：已实施

## 问题

模型请求需要区分两类 header：

- provider 级：客户端身份、组织/路由标识，所有请求共用；
- 请求级：会话 ID，每次 run / 每次对话不同。

此前 `createLocalFetch` 通过 base URL 猜测 OpenCode Go，并把 `x-opencode-session` 写进 `fetch` 适配器。问题：

- header 来源藏在 URL 判断里，AI SDK 与调用方都看不到真实 provider 配置；
- provider 级与请求级 header 混在同一个 `fetch`，`generateText` 和 `streamText` 无法分别表达；
- 无法为云端端点或后续供应商复用，新增供应商只能继续堆 URL 分支；
- 单测只能验证 fetch 内部实现，不能验证 AI SDK 实际收到的 header。

该实现也掩盖了真正的 Go 403：当前 key 所属 org 在 Console 没有被判定为 Go 订阅，换 endpoint、加 session header 都不会改变结果。

## 涉及范围

- `packages/shared/src/channels/conversation.ts`：`ConversationCapabilityEndpoint` 增加非 secret 的 `headers` 与 `sessionHeader`。
- `apps/agent/src/core/model/modelTransport.ts`：AI SDK `streamText` / `generateText` 的唯一执行入口，组合 provider、端点 headers、会话头与重试边界。
- `apps/agent/src/core/model/provider.ts`：把 provider 级 headers 作为 AI SDK provider 选项传入。
- `apps/agent/src/core/model/requestHeaders.ts`：把 `sessionHeader` 投影为请求级 headers。
- `apps/agent/src/core/agent/executeRun.ts`：只保留 run 生命周期、事件消费与上下文恢复；模型传输细节交给 `modelTransport`。
- `apps/agent/src/core/agent/runtime.ts`：只保留注册、路由与 run 管理；内部文本任务调用 `modelTransport.generateModelText`。
- `apps/cli/src/adapters/localProviderProfiles.ts`：CLI 侧把已知 OpenCode Go 端点映射为 UA 与会话头；模型设置域本身不感知供应商。
- 相关 Note：
  - [CLI 模型配置与选择器](../feature/2026-11-13-cli-model-config-and-picker.md)
  - [CLI 重试提示缺少原因与倒计时](../bug-fix/2026-11-16-cli-retry-notice-visibility.md)

## 模块边界

- `core/model/modelTransport.ts` 是唯一知道“如何调用 AI SDK”的模块：provider 构造、provider/request headers、`maxRetries: 0` 与重试回调都在这里。
- `core/agent/executeRun.ts` 只负责 run 状态、事件消费、工具输出中继与上下文恢复；新增 header/provider 细节不得再改这里。
- `core/agent/runtime.ts` 只负责静态注册、模型路由、run 取消/等待；内部摘要任务通过 `generateModelText` 调用，不直接构造 provider。
- `core/model/provider.ts` 只做 OpenAI-compatible provider 构造；`providerFetch.ts` 只做鉴权与令牌刷新，不识别供应商。
- 宿主差异（CLI 的 OpenCode Go profile）留在 `apps/cli/src/adapters`，通过端点字段注入；桌面端将来需要时复用同一契约。

## 决定

端点显式声明 provider 级 `headers` 与会话头名称 `sessionHeader`；`core/model` 不再按 URL 推导 provider。

- provider 级 headers 传给 `createOpenAICompatible`；
- 请求级 headers 由 `requestHeadersFor` 生成，和 `maxRetries: 0` 一起由 `modelTransport` 传给 `streamText` / `generateText`；
- `executeRun` 与 `runtime` 只消费 `modelTransport`，不再各自拼 AI SDK 选项；
- 具体供应商的 UA/会话头由宿主适配层（当前为 CLI `localProviderProfiles`）提供；
- 凭据仍只走 `Authorization`，不进入 `headers`。

## 根因

1. `openCodeGoHeaders` 在 `createLocalFetch` 内按 `opencode.ai` + `/inference/go/` 判断，provider 配置没有进入 AI SDK 的 options。
2. 会话 ID 被当成静态 fetch header，与 provider 身份混在一起。
3. 当前 OpenCode Go 403 的真实原因是订阅权益：`console.opencode.ai/api/config` 只返回 `opencode` PAYG provider，没有 `opencode-go`；`/zen/go/v1` 与 `/inference/go/openai/v1` 均返回 `403 An active OpenCode Go subscription is required`。

## 曾考虑的替代方案

- **保留 URL 嗅探在 `fetch` 内：** 舍弃。隐藏 provider 配置，无法验证 AI SDK 实际收到的 headers，也会让后续供应商继续堆分支。
- **把会话头固定进 provider headers：** 舍弃。会话是请求级事实，固定进 provider 会让内部任务或后续复用共享错误的 session。
- **在 `core/model` 内直接识别 OpenCode：** 舍弃。`core/model` 是跨领域 provider 边界，不应知道具体供应商的计费通道。
- **从 Console `/api/config` 动态发现 provider：** 本次不采用。它更接近 opencode 的完整做法，但需要新增 provider 目录、凭据与缓存契约，且不能修复当前 key 未覆盖 Go 的权益问题；留作后续独立能力。
- **把 org id 写进请求头：** 舍弃。org 不是通用 provider 身份，且会随账号变化；当前实测加 `x-opencode-org-id` 仍为 403。

## 后果与防回退

- `ConversationCapabilityEndpoint.headers` 只能放非 secret 字段；凭据不得写入。
- 新增供应商时，先增加显式 profile 与测试，不得在 `providerFetch` 或 `provider.ts` 中按 URL 分支。
- provider 级 headers 必须走 AI SDK provider options；请求级 headers 必须走 `streamText` / `generateText`，不得重新塞回 fetch。
- CLI 的 OpenCode Go profile 只覆盖 `opencode.ai` 的 `/inference/go/` 与 `/zen/go/`；PAYG 与通用 OpenAI-compatible 端点保持原样。
- 桌面端尚未消费新字段；若桌面本地模型需要供应商 profile，应在桌面适配层复用同一契约，不复制 `core/model` 语义。

## 验收标准

- OpenCode Go 端点解析出 `User-Agent` 与 `x-opencode-session`；PAYG/本地通用端点不新增 header。
- `createModelProvider` 把 endpoint headers 原样传给 `createOpenAICompatible`。
- `executeRun` 与内部 `generateText` 使用当前 conversation/session 填充会话头。
- 当前 key 仍返回 403 时，错误应继续是供应商的订阅提示，而不是缺失 header 或 AI SDK 构造错误。

## 验证

- 2026-11-16：`providerFetch.test.ts` 2 项、`requestHeaders.test.ts` 2 项、`provider.test.ts` 2 项、`modelTransport.test.ts` 2 项、`retryFetch.test.ts` 7 项通过。
- 2026-11-16：`localProviderProfiles.test.ts` 3 项通过。
- 2026-11-16：`@answra/agent`、`@answra/cli` typecheck 通过；`@answra/agent` 全量测试 555 项通过；`biome check` 通过。
- 2026-11-16：真实 CLI 请求 OpenCode Go 仍返回 403；证明请求已走 Go endpoint，但当前 key 未获得 Go 权益。

## 风险

- CLI 适配层仍以 endpoint host/path 匹配已知 provider；新增供应商需要显式 profile，不能靠猜测。
- 当前没有实现 Console provider 自动发现；账号/workspace 切换后仍需用户确认 Go 订阅归属并重新生成 key。
