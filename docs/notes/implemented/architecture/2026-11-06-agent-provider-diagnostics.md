# Note：Agent 模型调用诊断日志

状态：已实施

## 问题

模型调用失败时只能看到 UI 上的最终错误文案，无法判断是哪一次请求、哪个状态码、哪个 provider 响应体导致的。agent utility process 以 `stdio: "ignore"` 启动，`[conversation][run]` 的 `console.error` 全部被丢弃；主进程终端只有 `[agent-service]` 日志，模型请求链路的细节不可见。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/conversation/agentService.ts`、`apps/agent/src/conversation/runtime.ts`
- 进程/协议/持久化表面：只改 worker 的 stdout/stderr 转发与日志内容；不改 IPC 频道、shared schema、会话 store 或持久化格式
- 相关 Note：[前端会话消息投影收敛为唯一一套](./2026-11-06-unified-conversation-view-projection.md)、[事件 schema 单一来源与 AI SDK 边界](./2026-11-03-event-schema-single-source.md)

## 决定

### 转发 worker 日志

`utilityProcess.fork` 的 `stdio` 从 `ignore` 改为 `pipe`，用 `node:readline` 按行把 worker 的 stdout/stderr 转发到主进程 `console.info`/`console.error`。开发态直接出现在 `pnpm dev:full` 的终端；打包态仍受主进程 console 可见性限制，不额外写日志文件。

### 记录模型调用关键节点

`ConversationRuntime.execute` 增加：

- 开始：`runId`、模型、endpoint host、消息文本/图片数量、是否带历史、是否 ephemeral、工具数量、`maxRetries`；
- 首个 chunk（保留原有）；
- 每个 text/reasoning part 结束时记录 `partId` 与累计长度，不逐 delta 打印正文；
- tool call/result/error 记录 `toolCallId`、工具名或错误文本，不记录工具入参/结果；
- `onFinish`：`finishReason`、正文/思维链长度、工具调用数、usage；
- 结束：`outcome`、耗时、`finishReason`、正文/思维链长度、chunk 计数。

### 结构化错误摘要

`summarizeError` 从只取 `name/message/statusCode` 扩展为：

- `urlHost`、`isRetryable`、`responseBody`（截断 2000 字符）；
- AI SDK `RetryError` 的 `reason`、`attempts`（逐次错误）与 `lastError`；
- 递归深度限制为 2，避免异常结构导致无限展开。

不记录 Authorization、请求正文或图片内容。

## 模块边界

- `agentService.ts` 只负责 worker 生命周期与 stdout/stderr 转发，不解释日志内容；
- `runtime.ts` 只记录模型调用自身可观察到的节点，不把日志格式变成跨进程契约；
- 日志字段是诊断信息，不属于 `AgentFrame`/`ConversationChange`，renderer 不消费。

## 曾考虑的替代方案

- **直接 `stdio: "inherit"`：** 改动最小，但无法在主进程统一处理输出，也无法后续落文件；舍弃。
- **每个 chunk 都打日志：** 文本 delta 会刷屏，且包含用户内容；改为按 part 结束记录长度；舍弃。
- **只依赖 UI 错误文案：** 拿不到 statusCode、provider 响应体与重试次数；无法定位 429/额度/鉴权差异；舍弃。
- **引入日志框架并落盘：** 当前只有开发态诊断需求，先保持零依赖；若后续需要打包态排障，再单独设计文件日志。

## 验收标准

- 可观察结果：`pnpm dev:full` 终端能看到 `[conversation][run] started/provider error/failed/model finished/finished`，错误包含 `statusCode`、`urlHost`、`isRetryable`、`responseBody`；429 重试耗尽时能看到逐次 `attempts`。
- 自动化验证：`pnpm --filter @answra/agent test` 全绿；agent/desktop typecheck 通过。

## 风险

- `responseBody` 可能包含 provider 的调试信息或用户输入回显；已截断且不记录请求体，但仍应避免在公开日志中传播。
- `stdio: "pipe"` 必须持续消费 stdout/stderr，否则 worker 可能因管道背压阻塞；当前用 readline 持续读取。
- 打包态主进程没有终端时日志不可见，这是已知限制，不是本次目标。

## 后果与防回退

- 新增模型调用诊断点时复用 `summarizeError`，禁止直接把原始 `error` 对象塞进日志。
- 日志中不得出现 token、Authorization、完整请求正文或图片 data URL。
- 需要逐次重试信息时依赖 AI SDK `RetryError.errors`，不要自行在应用层再包一层重试。

## 验证

- `pnpm --filter @answra/agent test`：19 个测试文件、133 个测试通过。
- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/desktop typecheck`：通过。
- `pnpm exec biome check`（本次变更文件）：通过。
- 未完成：`pnpm dev:full` 下对真实 SenseNova 端点的实机日志确认。
