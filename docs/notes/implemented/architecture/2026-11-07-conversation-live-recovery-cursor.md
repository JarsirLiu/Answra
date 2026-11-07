# Note：会话切页恢复游标

状态：已实施

## 问题

renderer 切换页面或重新挂载对话面板时，之前先加载 transcript，再从事件 revision `0` 回放全部 Agent 事件。完整文本已经在 transcript 中，重放 `text-delta` 会重复追加；旧 snapshot 也没有表达其对应的事件位置。

## 涉及范围

- 代码/模块：`packages/shared/src/schema/conversation.ts`、`apps/agent/src/conversation/session/`、`apps/agent/src/conversation/turn/`、`apps/agent/src/execution/`、`packages/ui/src/app/`
- UI/进程/协议/持久化表面：Agent 存活期间的 conversation snapshot、统一 `AgentEventEnvelope` 流、renderer 切页和缺口补读
- 相关 Note：[统一 Agent 事件事实流](./2026-11-07-single-agent-event-stream.md)、[Agent 事件与状态的领域归属](./2026-11-06-agent-event-status-domain-ownership.md)

## 决定

`ConversationSnapshot` 使用唯一的 `eventRevision` 作为恢复游标；移除只描述 transcript 写入次数且没有消费者的 `revision`。开始 run 前记录当前 conversation 的 `aggregateRevision`。活动 run 的恢复响应会清空 assistant 文本，并从该位置重放该轮事件；run 终结时推进 snapshot 游标到终态事件之后，后续恢复直接使用完整 transcript，不重复回放已完成轮次。

读取时先订阅并暂存 live envelope，再读取 snapshot 与游标之后的事件。UI 按 `aggregateRevision` 去重并顺序应用；发现缺口时从当前游标补读。现有 worker/IPC `snapshot` 与 `read-events` 命令保持不变。

本次只支持 Agent 进程存活期间恢复。事件 store 与 transcript 仍是内存实现，不处理进程重启、持久化或事件保留窗口。

## 模块边界

- `packages/shared/src/schema/conversation.ts`：定义跨进程 transcript snapshot 和 `eventRevision`。
- `apps/agent/src/execution/`：提供 conversation 当前事件 revision 与按游标读取事件。
- `apps/agent/src/conversation/session/`：保存 transcript 和其事件恢复游标；不保存事件日志。
- `apps/agent/src/conversation/turn/`：在 run 开始和终结时推进 transcript 的恢复边界。
- `packages/ui/src/app/useConversationView.ts`：订阅缓冲、初始化回放、顺序应用与缺口补读。

## 曾考虑的替代方案

- **从 revision `0` 重放所有事件：** 会把已经在 transcript snapshot 中的文本重复追加，也不能界定恢复起点，因此舍弃。
- **只把游标设为 snapshot 时的最新事件 revision：** transcript 没有保存推理、重试和工具活动，跳过这些事件会丢失 UI 状态，因此舍弃。
- **新增 UI snapshot/projection 或第二种 change 通知：** 会引入第二个投影/传输责任；现有 Agent envelope 已能重放最近一轮，因此舍弃。
- **加入 epoch 与重启恢复：** 当前没有 durable transcript/event store；本次只处理同一 Agent 进程内的切页恢复，留待持久化设计。

## 后果与防回退

- snapshot 和事件仍各自归属 Conversation transcript 和 Execution event store；`eventRevision` 只标记恢复边界，不构成第二事实流。
- 最近一轮事件必须在 Agent 存活期间可读取；若未来引入有界保留策略，缺失游标需要显式回退到能重建 UI 的 snapshot。
- 进程重启后事件和 transcript 丢失仍属当前限制；不得将本次能力描述为重启恢复。

## 验收标准

- 切回活动对话时，已有文本不重复，最新 delta 只应用一次，推理/重试/工具/终态可由同一事件流恢复。
- 初始化期间到达的事件不会丢失；重复事件被忽略；revision 缺口会请求补读。
- 普通对话、答题和 interview 继续使用同一 `ConversationSnapshot` 与 `AgentEventEnvelope` 契约。

## 风险

- Agent 事件与 transcript 都是进程内内存数据；Agent 退出后两者同时丢失，当前没有重启恢复。
- 当前事件 store 不淘汰事件；未来增加事件保留窗口时必须提供游标失效后的 snapshot 回退行为。

## 验证

- `pnpm --filter @answra/agent test -- test/conversation/session/store.test.ts test/conversation/turn/runtime.test.ts test/execution/store.test.ts`：30 项通过。
- `pnpm --filter @answra/ui exec vitest run test/conversationView.test.ts test/useConversationView.test.tsx`：12 项通过，包含初始化期间缓冲、revision 缺口补读、snapshot 推进后继续 drain。
- Agent 与 UI typecheck 通过。
