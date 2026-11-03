# Note：Agent core 的 RunRegistry 抽取

状态：已实施

## 问题

`ConversationRuntime` 同时持有 run 的 `AbortController` 表与完成信号表，并负责 `dispose` 时的统一收尾。面试自动回复已经作为第二个消费者使用同一套 run 生命周期；如果继续把 registry 留在 conversation 领域，第二消费者只能通过具体 runtime 借用实现，或复制一份取消/等待逻辑。

10-20 产品方向 Note 把「模型执行器 + Run 生命周期」的抽取触发器定在 interview 阶段 6（reply workflow）。该条件已经成立，因此先把风险最低的 run 生命周期移入 `core/run/`，不触碰模型执行、会话存储、工具与 loop。

## 涉及范围

- 代码/模块：`apps/agent/src/core/run/registry.ts`（新增）、`apps/agent/src/conversation/runtime.ts`、`apps/agent/test/core/run/registry.test.ts`（新增）。
- UI/进程/协议/持久化表面：无变化；`ConversationRuntime.cancel` / `waitForRun` / `activeRunCount` / `dispose` 的外部行为保持不变。
- 相关 Note：[产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)、[事件 schema 单一来源](2026-11-03-event-schema-single-source.md)、[candidate 语音对话的自动回复与开口打断](../feature/2026-11-03-interview-candidate-voice-reply-loop.md)。

## 决定

### RunRegistry

`RunRegistry` 提供：

- `register(runId, controller)`：登记 run 与完成信号。
- `cancel(runId)`：只 abort 对应 run，不提前释放等待者。
- `wait(runId)`：返回完成信号；未登记或已完成的 run 直接 resolve。
- `finish(runId)`：先 resolve 等待者，再移除登记。
- `abortAll()`：进程退出时 abort 全部 run、resolve 全部等待者并清空。
- `activeCount`：当前登记数。

### 边界

- `core/run/` 不 import 任何领域；只认识 `runId`、`AbortController` 和 Promise。
- `ConversationRuntime` 只把原有 map 操作委托给 registry，不改变 run 终态、store 写入顺序或 `dispose` 语义。
- 模型执行、`SessionStore` 端口、工具注册与 Agent loop 仍未抽取；它们分别等待真实第二消费者或独立变更。

## 曾考虑的替代方案

- **继续把 map 留在 `ConversationRuntime`：** 改动最小，但面试回复仍要依赖具体 runtime，且下一次新领域会复制同一套完成信号；舍弃。
- **用事件总线广播 run 完成：** 能解耦，但当前唯一消费者需要的是可 await 的完成信号；引入事件会让顺序与错误传播更隐晦，舍弃。
- **使用 `Promise.withResolvers`：** 当前 `lib: ES2022` 不提供；继续用显式 resolve 的 completion，避免提升运行时基线。
- **一次性抽完 core 五件套：** 本次只抽 run 生命周期；模型执行与会话端口涉及更多领域语义，按 10-20 Note 的触发纪律分步进行。

## 模块边界

- `apps/agent/src/core/run/registry.ts`：唯一持有 run 的 `AbortController` 与完成信号；只依赖 `runId`、`AbortController` 和 Promise，不 import 任何领域模块。
- `apps/agent/src/conversation/runtime.ts`：负责认领 run、执行模型、写 store 终态；结束时调用 `finish`，取消时调用 `cancel`，dispose 时调用 `abortAll`。
- `apps/agent/src/interview/reply/loop.ts`：只通过 `waitForRun` / `cancel` 消费完成信号，不直接接触 registry。
- 未抽取：模型执行、`SessionStore` 端口、工具注册与 Agent loop 仍留在原层；它们不得因为本 Note 而提前搬进 `core/run/`。

## 后果与防回退

- 正向后果：对话与后续领域共享同一套 run 完成语义；`wait`、`cancel`、`dispose` 的边界集中到一处，避免每个领域复制完成信号。
- 行为约束：`finish` 是唯一的正常释放入口；所有终态路径必须调用，否则 waiter 永久挂起。`cancel` 只 abort，不释放等待者；`abortAll` 只用于进程退出。
- 防回退：不得把 `core/run/` 变成会话策略层；不得在领域模块里重新维护 `Map<runId, AbortController>`；新增消费者必须通过 `ConversationRuntime` 的公开取消/等待方法，而不是直接 import registry 的内部状态。
- 防回退：`finish` 必须先 resolve 再删除；`wait` 对未登记 run 直接 resolve，保证迟到的 `wait` 不会挂起。相关行为由 `apps/agent/test/core/run/registry.test.ts` 压住。

## 验证

- `pnpm --filter @answra/agent test -- test/core/run/registry.test.ts test/conversation/runtime.test.ts test/worker/host.test.ts`：通过。
- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm notes:check`、`pnpm verify`：通过。
