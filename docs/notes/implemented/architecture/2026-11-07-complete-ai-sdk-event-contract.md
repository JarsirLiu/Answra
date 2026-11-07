# Note：补齐 AI SDK 模型生命周期事件契约

状态：已实施

## 问题

共享契约已有 4 种执行事件和 22 种模型流事件，`streamText` 消费 `result.fullStream`。但归一化遗漏了 `start-step` 携带的模型调用 warning，且 `streamText` 的 `experimental_onToolCallStart` / `experimental_onToolCallFinish` 回调没有进入唯一 Agent 事件流。因此模型请求、工具执行和结果事实不完整。

## 涉及范围

- 代码/模块：`packages/shared/src/schema/events.ts`、`packages/shared/src/schema/README.md`、`apps/agent/src/core/model/`、`apps/agent/src/conversation/turn/executeTurn.ts`
- UI/进程/协议/持久化表面：共享 Agent 事件 schema；Agent 进程内事件 store 和现有 UI 消费入口
- 相关 Note：`docs/notes/implemented/architecture/2026-11-07-ai-sdk-full-stream-as-agent-fact-source.md`

## 决定

继续使用 AI SDK `fullStream` 作为模型流事实来源。当前共享契约在 `packages/shared/src/schema/events.ts` 一个文件中定义全部 31 种事件 payload：4 种执行事件和 27 种模型流事件；同一事件定义导出完整联合、执行/流子集和单一 `AgentEventEnvelope`。持久化资格清单排除 `text-delta`、`reasoning-delta` 和 `tool-input-delta`。新增模型 warning 三种事件，以及工具执行开始/完成两种事件；工具执行回调和 fullStream 事件写入相同 journal。

工具模型请求（`tool-call`）、工具执行生命周期（`tool-execution-started` / `tool-execution-finished`）、模型流中的工具结果（`tool-result` / `tool-error`）分别记录，表示不同来源和阶段。工具执行完成的结果使用显式成功/失败联合。

共享契约保持 provider-neutral，不暴露 AI SDK 类型。AI SDK `raw` chunk、provider metadata、完整 request/response 对象不纳入跨包 schema，因为它们不是稳定的 provider-neutral 事实。`start-step` warning 被映射为共享 warning 事件；完整 request/response 元数据仍不转发。

## 模块边界

- `packages/shared/src/schema/events.ts` 集中定义跨包 Agent 事件载荷，不依赖 AI SDK；`status.ts` 独立定义状态词汇和快照。
- `apps/agent/src/core/model/` 负责 AI SDK 流事件到共享事件的显式归一化。
- `apps/agent/src/conversation/turn/executeTurn.ts` 将工具执行回调写入同一 journal，不创建第二事件流。
- `apps/agent/src/execution/` 继续负责 envelope、状态迁移和进程内 store；共享 schema 是跨包唯一事件契约。

## 曾考虑的替代方案

- **把 AI SDK 所有类型和字段原样复制到 shared：** 舍弃，因为这会让 provider metadata、原始 request/response 结构成为跨包承诺，并把 shared 绑到供应商演进。
- **只补工具执行回调，不补 step warnings：** 舍弃，因为 warning 是 SDK 提供的模型调用事实；遗漏它会使事件定义不完整。

## 后果与防回退

- Agent stream schema 现在有 27 种模型流事件，事件清单和排除边界记录在 schema README。
- `tool-execution-finished` 与 `tool-result` / `tool-error` 可能针对同一调用先后出现，消费者必须按阶段区分，不能按重复事件去重。
- AI SDK 新增 provider-neutral `TextStreamPart` 时，归一化层应显式评估；不能把 `raw` 或 provider metadata 直接转发到跨包契约。
- 事件 store 仍为进程内实现；`AgentDurableEvent` 只是未来适配器的资格契约，不代表本次增加 durable persistence 或进程恢复能力。

## 验证

- `apps/agent/test/core/model/streamEvents.test.ts` 验证流事件归一化和 step warnings。
- `packages/shared/test/schema.test.ts` 往返验证全部 31 种事件，并断言 durable catalog 排除三种 delta。
- 本次全量门禁：`pnpm verify` 通过，包含全包 typecheck、642 项测试、lint 和 architecture check。
