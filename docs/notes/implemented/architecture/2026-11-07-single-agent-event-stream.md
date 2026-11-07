# Note：统一 Agent 事件事实流

状态：已实施

## 问题

迁移前，运行生命周期由 `ExecutionStore` 写入 `AgentEventEnvelope`，模型流则由 `ConversationStore.appendEvent()` 写入 `ConversationEvent`。worker 分别发送 `execution-event` 和 `change`，renderer 再合并两种来源，造成同一回合有两条事件日志与两套游标。本次实现已移除这套旧路径。

## 涉及范围

- 代码/模块：`packages/shared/src/schema`、`apps/agent/src/execution`、`apps/agent/src/conversation/session`、worker IPC、desktop bridge、`packages/ui/src/app/conversationView.ts`
- UI/进程/协议/持久化表面：worker 上行事件、对话 transcript 快照、统一 UI reducer
- 相关 Note：产品与 Agent 底座架构约束

## 决定

统一用 `AgentEventEnvelope` 承载已有的 run lifecycle 与模型 stream 事件。事件载荷保持现有名称，不新增第二套事件命名。事件 schema 放在 `events.ts`，run/step 状态与快照类型单独放在 `status.ts`。

`ExecutionStore` 是当前唯一进程内事件 store：append envelope 后验证 run 状态迁移、更新可重建的状态缓存，并保留事件用于读取和订阅。当前实现仍为内存，不声称具备重启恢复或分布式能力。

`ConversationStore` 只保存 transcript 消息与快照，不保存事件日志或通知 journal。snapshot 携带 `eventRevision` 恢复游标；run 中的实时变化统一由 envelope 订阅。UI 的 `conversationView.ts` 是唯一事件投影。

普通对话、截图答题与基于 ConversationRuntime 的回复共用同一事件 store 和 envelope 通道。

## 模块边界

- `execution/` 拥有 AgentEventEnvelope 的写入、事件读取订阅和运行状态缓存。
- `conversation/session/` 拥有 transcript 消息、快照和会话认领，不拥有事件日志。
- `packages/ui/` 从 snapshot 初始化，随后只把 AgentEventEnvelope 投影为界面状态。
- `status.ts` 不定义 event payload；`events.ts` 不定义 status vocabulary。

## 移除内容

- 移除 `ConversationEvent`、`ConversationChange` 作为事实事件与传输通知的定义。
- 移除 `ConversationStore.appendEvent()`、会话事件 journal 和独立 `execution/projection.ts`。
- 移除 `execution-event` 与 `change` 两条并行 worker 上行帧，改为唯一 Agent envelope 帧。

## 曾考虑的替代方案

- **保留 ConversationEvent 作为模型事件日志：** 舍弃，因为它与 AgentEventEnvelope 重复记录同一回合输出，并需要第二个序列与恢复逻辑。
- **把状态字段放进 events.ts：** 舍弃，因为 event 是事实载荷，status 是独立的运行时状态词汇与可重建缓存契约。
- **先只合并 screenshot answer：** 舍弃，因为 answer、chat 与 reply 已共用 `executeTurn` 和 `ConversationRuntime`，分批迁移会保留两套入口。

## 后果与防回退

- 事件 store 当前是进程内内存实现；替换为 SQLite 或 Redis 时应只替换该 store，不增加 Conversation 事件表。
- `ConversationSnapshot.eventRevision` 标记 transcript 初始化后应从哪里回放最近一轮事件；它不是 transcript 版本。事件顺序使用 envelope 的 `sequence` 与 `aggregateRevision`。
- 自动答题完成后可清空 transcript snapshot，但已生成的事件仍属于 Agent event store；renderer 可保留当前投影直到用户关闭。
- 新的会话 UI 通知不得重新引入第二种事件帧；需要的实时行为应来自既有 envelope 事件或用户操作后的显式快照读取。

## 验收标准

- 共享 schema 不再导出 `ConversationEvent` / `ConversationChange`。
- worker 对话执行只发送 AgentEventEnvelope；renderer 用该 envelope reducer 更新模型输出与 run 终态。
- 普通聊天、截图答题与回复详情都消费同一 envelope 流。
- `ConversationStore` 无事件写入口、事件 journal 或事件读取 API。
- 自动化验证：`pnpm verify` 与严格 Note 检查通过。

## 验证

已通过：

- `pnpm notes:check`
- `pnpm verify`（Biome、全包 typecheck、Vitest、架构检查）
- `git diff --check`
