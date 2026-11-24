# Note：CLI 重试提示缺少原因与倒计时

状态：已实施

## 问题

模型请求触发 429 或服务端错误时，CLI transcript 尾部只显示 `retry 1/5…`：

- 不显示重试原因（限流 / 服务端错误 / 网络错误），也不显示 HTTP 状态码。
- 不显示本次等待多久，用户不知道 5 秒、30 秒还是 60 秒后会再次请求。
- 等待结束、请求恢复时，`running` 事件没有清除重试态，于是旧计数会一直挂到下一个 retry 事件或流式内容出现，看起来像卡在 `retry 1/5`。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/schema/status.ts`：`AgentRetry` 增加可选 `statusCode`。
  - `apps/agent/src/core/agent/executeRun.ts`：把 `RetryAttempt.statusCode` 同时写入 execution 状态与 `retry` 流事件。
  - `packages/ui/src/app/conversationView.ts`：run 从 `retry-wait` 恢复到 `running` 时清除重试态；`ConversationRetry` 增加 `delayMs/statusCode`。
  - `apps/cli/src/tui/transcript/RetryNotice.tsx`：按 kind 显示原因、HTTP 状态、剩余秒数与次数；替代原 `retry 1/5…` 单行。
  - `apps/cli/src/tui/transcript/Transcript.tsx`：在 transcript 尾部挂载 `RetryNotice`。
- UI 表面：只改 CLI transcript 的重试提示；不改变重试策略、模型请求次数或错误终态。
- 相关 Note：
  - [CLI 模型配置与选择器](../feature/2026-11-13-cli-model-config-and-picker.md)

## 决定

重试提示必须同时回答三个问题：为什么重试、还要等多久、这是第几次。事件契约只补 `statusCode`，原因由稳定的 `kind` 在 UI 映射，避免把供应商响应体透传到共享事件。

## 根因

1. `AgentRetry` 只有 `kind/attempt/maxRetries/delayMs`，`RetryAttempt.statusCode` 在 `executeRun` 转发时被丢弃。
2. CLI 只渲染 `attempt/maxRetries`，没有消费已有的 `kind` 与 `delayMs`。
3. `applyAgentEvent` 只在 `start` 或终态清理 `retry`，`retry-wait -> running` 的恢复事件不会清理，导致等待结束后的新请求期间仍显示旧计数。

## 修复

- `AgentRetry`/`ConversationRetry` 增加可选 `statusCode`；`executeRun` 一次性构造 retry facts，同时用于 `scheduleRetry` 与 `retry` 流事件。
- run 恢复到 `running` 且 `retryRunId` 属于该 run 时清空 `retry` 与 `retryRunId`；`start` 仍按原逻辑兜底清理。
- `RetryNotice` 以 `delayMs` 计算截止时间，每 250ms 刷新剩余秒数；文案为“原因（HTTP 状态）”与“N 秒后重试 · attempt/maxRetries”。
- 组件以 `kind:attempt` 作为 key，新的重试次数会重新计算倒计时；`finished` 只显示“重试已结束”，不再假装仍在等待。

## 曾考虑的替代方案

- **只加倒计时，不显示原因：** 舍弃。用户仍然不知道为什么被重试。
- **把供应商错误响应体写进 retry 事件：** 本次不采用。需要解析不同供应商的响应、控制长度并评估敏感信息，超出提示可见性的范围；终态错误已有 `errorText`。
- **重试期间保留旧计数并在成功后清理：** 舍弃。等待结束到首个流事件之间没有新事实，保留旧计数正是“卡在 retry 1/5”的来源。
- **取消自动重试：** 舍弃。会把本可恢复的 429/瞬时 5xx 直接变成失败，且不符合既有策略。

## 后果与防回退

- `ConversationRetry` 的等待时长来自事件 `delayMs`，不得在 UI 写死退避表；策略仍在 `apps/agent/src/core/model/retryFetch.ts`。
- `running` 清理只作用于当前 `retryRunId`，不得误清其他 run 的重试态。
- `statusCode` 为可选字段；新增重试来源时必须继续填 `kind/attempt/maxRetries/delayMs`，否则 schema 校验失败。
- 桌面端 `RetryNotice` 继续使用自己的 kind 文案；本次不改桌面视觉。
- 2026-11-24 起 CLI 的重试行并入 [模型失败提示块](../feature/2026-11-24-cli-tui-model-error-notice.md) 的 `⎿` 错误块，原因、HTTP 状态、倒计时与次数文案保持不变；`RetryNotice.tsx` 已删除，回归由 `modelErrorNotice.test.tsx` 覆盖。

## 验收标准

- 可观察结果：触发限流时 transcript 显示“请求触发限流，等待后重试（HTTP 429）”“5 秒后重试 · 1/5”，倒计时递减；恢复请求后提示消失；再次失败显示 2/5。
- 自动化验证：
  - `apps/cli/test/tui/transcript/modelErrorNotice.test.tsx` 断言原因、状态码、倒计时与次数（原 `retryNotice.test.tsx` 已并入该文件）。
  - `packages/ui/test/conversationView.test.ts` 断言 `retry-wait` 保留状态、`running` 清除状态。

## 验证

- 2026-11-16：`retryNotice.test.tsx` 2 项、`conversationView.test.ts` 19 项、`retryFetch.test.ts` 7 项、`store.test.ts` 6 项、`schema.test.ts` 17 项通过。
- 2026-11-16：`@answra/cli`、`@answra/ui`、`@answra/agent`、`@answra/shared` typecheck 通过；`biome check` 通过。

## 风险

- 倒计时从客户端收到 retry 事件时开始，与 agent 实际开始等待可能相差一个事件传输延迟；仅影响显示，不影响重试时刻。
- 等待结束后到下一次失败之间不显示重试行；这是刻意选择，避免把“正在请求”误报成“仍在等待”。
