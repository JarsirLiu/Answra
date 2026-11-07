# Note：模型限流指数退避与原地重试指示

状态：已实施

## 问题

SenseNova 等 OpenAI 兼容端点对 RPM/TPM 超限返回 429。AI SDK 自带重试默认 `maxRetries: 2`，按 2s、4s 指数退避，约 6.5s 内耗尽；对分钟级限流窗口无效，用户只能看到最终失败，且没有任何“正在重试”的反馈。

## 涉及范围

- 代码/模块：`apps/agent/src/conversation/retryFetch.ts`、`apps/agent/src/conversation/runtime.ts`、`packages/shared/src/schema/events.ts`、`packages/ui/src/app/conversationView.ts`、`packages/ui/src/components/chat/RetryNotice.tsx`、`packages/ui/src/components/panels/ChatPanel.tsx`、`InterviewCapturePanel.tsx`、`ReplyConversationPopover.tsx`
- 进程/协议/持久化表面：新增 `retry` 流事件，进入既有 `ConversationEvent` journal 与 IPC；不改消息快照结构
- 相关 Note：[Agent 模型调用诊断日志](./2026-11-06-agent-provider-diagnostics.md)、[前端会话消息投影收敛为唯一一套](./2026-11-06-unified-conversation-view-projection.md)

## 决定

### HTTP 层重试

新增 `createRetryingFetch`，包住授权/本地 fetch：

- 429：最多 5 次重试，初始 5s、指数翻倍、上限 60s，带 0–250ms 抖动；优先尊重 `Retry-After` / `Retry-After-Ms`。
- 408/409/5xx：最多 2 次，初始 1s、上限 8s。
- 已知瞬时网络错误（`ECONNRESET`、`ECONNREFUSED` 等）：按 5xx 策略重试。
- 只重试可重放请求体（字符串、URLSearchParams、ArrayBuffer、Blob）；`Request` 或流式 body 不重试。
- 等待期间监听 `AbortSignal`，用户取消立即终止。

`streamText` 显式设置 `maxRetries: 0`，避免 SDK 在 HTTP 层重试之后再次重试造成双倍消耗。

### 每次重试都是一个事件

`AgentStreamEvent` 新增：

```ts
{ type: "retry", kind, attempt, maxRetries, delayMs }
```

`kind` 区分 `rate-limit`、`server-error` 与 `network-error`，UI 按真实原因说明等待状态。每种失败类别各自使用独立重试预算，避免一次 429 消耗后续 5xx/网络错误的次数。重试事件属于会话 journal 的持久化事件；轮次最终失败时保留最后一次 Wi‑Fi 状态，直到新一轮开始或会话被清空。

重试前通过事件入口写入当前进程内 store 并推给 renderer；下一次请求真正收到 `start` 时清除，最终失败时保留。`retry` 列入未来 durable event adapter 的资格 schema，但当前没有 durable store 或进程重启回放；高频 text/reasoning/tool-input delta 不在该资格清单中。

### 原地 UI

`ConversationView` 增加 `retry?: { kind, attempt, maxRetries, finished? }` 与消息级显式 `thinking` 状态；`thinking` 只由流事件投影更新，不再由“流式且正文为空”推导。Chat、面试、回复详情都渲染同一个 `RetryNotice`，按限流、服务端错误或网络错误显示原因与次数。组件位置固定，只更新计数，不新增消息或浮层；重试全自动，不增加人工重试按钮。最终失败进入消息的 `failed` 异常结束态，错误横条保留，最后一次 Wi‑Fi 事件保留并标记为已结束，不再展示等待动画或等待文案。

## 模块边界

- `retryFetch.ts`：纯 HTTP 重试策略，不依赖会话、UI 或 Electron；
- `runtime.ts`：把重试回调转成 `retry` 流事件，仍由 store 负责持久化与广播；
- `conversationView.ts`：唯一投影，负责 retry 的设置/清除；
- `RetryNotice.tsx`：纯展示，不持有重试状态。

## 曾考虑的替代方案

- **只调大 AI SDK `maxRetries`：** 初始延迟和倍率不可配，无法保证覆盖 60s 窗口，也没有逐次事件；舍弃。
- **在应用层重新调用 `streamText`：** 已开始输出后重跑会产生重复内容，且需要额外判断；HTTP 层在收到 429 时尚未生成内容，重放更安全。
- **只做日志、不做 UI：** 用户仍不知道正在等待；本次同时补事件与原地指示。
- **每次重试新增一条消息：** 会污染对话历史；改为同一视图上的瞬时状态。

## 验收标准

- 429 在 60s 窗口内可自动恢复；重试期间 UI 原地显示 `1/5`、`2/5`，成功后消失，最终失败保留静止的 Wi‑Fi 记录和错误横条。
- 用户取消等待时不会继续发起请求。
- `retryFetch.test.ts` 覆盖 429 重试、`Retry-After`、不可重放 body、网络错误与重试耗尽；`conversationView.test.ts` 覆盖 retry 回放/保留、显式 thinking 事件与失败态；面试面板测试覆盖原地计数更新。
- 混合失败类别时各自预算独立，且 UI 原因与重试事件一致。

## 风险

- 最长可能等待约 135s（5+10+20+40+60，单次延迟封顶 60s），期间占用一个活动 run；用户可随时取消。
- 429 重试会再次消耗请求配额；策略已限制次数并带抖动，但无法解决账号额度本身不足。
- `retry` 事件增加 journal 体积；属于瞬时事件，不进入快照。

## 后果与防回退

- 新增可重试状态码或网络错误时，只改 `retryFetch.ts` 的策略表，不在 runtime 或 UI 复制判断。
- 任何新的会话表面都必须消费 `ConversationView.retry` 并复用 `RetryNotice`，不得各自实现重试提示。
- `streamText` 的 `maxRetries` 必须保持 0；若改回 SDK 重试，会与 HTTP 层重试叠加。

## 验证

- `pnpm --filter @answra/agent test`：20 个测试文件、138 个测试通过。
- `pnpm --filter @answra/ui test`：26 个测试文件、218 个测试通过。
- `pnpm --filter @answra/shared test`：3 个测试通过。
- agent/shared/ui/desktop typecheck 通过；`pnpm architecture:check` 通过。
- 未完成：`pnpm dev:full` 下对真实 SenseNova 429 的实机重试与 UI 指示确认。
