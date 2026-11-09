# Note：Agent 事件、消息与运行状态边界

状态：已实施

## 问题

Answra 已有统一的 `AgentEventEnvelope` 事件流、Run 状态迁移和 Transcript 内存存储。此前把 Session、Run、Step、Tool、Part 都设计成需要独立快照的状态对象，容易让运行状态、消息状态和事件事实重复，增加漂移风险。

本 Note 已收敛并实施为一个最小范式：事件记录发生过的事实；Transcript 保存可恢复的消息内容；运行状态只作为事件 reducer 的内存查询结果。当前只支持单 Agent 实例，不实现实例切换、跨实例接管或分布式运行。

## 涉及范围

- 代码/模块：`packages/shared/src/schema/status.ts`、`packages/shared/src/schema/events.ts`、`apps/agent/src/execution/`、`apps/agent/src/core/transcript/`、`packages/ui/src/app/`。
- 当前实现：进程内 `ExecutionStore` 和 Transcript store；不引入 SQLite、Redis 或跨进程恢复。
- 相关 Note：[统一 Agent 事件目录](../../implemented/architecture/2026-11-07-unified-agent-event-catalog.md)、[完整 AI SDK 事件契约](../../implemented/architecture/2026-11-07-complete-ai-sdk-event-contract.md)、[Conversation transcript store](../../implemented/architecture/2026-11-08-core-transcript-store.md)。

## 提案

### 三个概念，三个职责

```text
AgentEventEnvelope  ->  事实：发生了什么
Transcript          ->  内容：对话里保存什么
Run 状态缓存         ->  查询：当前执行到哪里
```

`AgentEventEnvelope` 是唯一事件事实格式。它承载 Run 生命周期、重试、工具调用边界、工具结果、文本/推理边界、错误和终态等事件。不得建立 `SessionEvent`、`ToolEvent` 或第二个 journal。

Transcript 保存完整的用户消息、助手回复，以及确实需要恢复的工具、推理等内容。Message/Part 的状态是内容对象的字段，不是另一条状态事件流。高频 `text-delta`、`reasoning-delta` 和 `tool-input-delta` 只用于实时传输，不逐片写入历史。

Run 状态由明确的 `run-state-changed` 事件驱动，保存在 `ExecutionStore` 的内存缓存中。缓存可以删除并由事件重放重建；当前不要求进程重启后恢复活动 Run。Step/Tool/Part 的运行态不单独暴露快照 schema；需要展示的消息内容和 Part 状态由 Transcript 消费同一个 envelope 后保存。

### 当前状态与历史加载

加载已完成的会话只读取 Transcript，不扫描全部事件。事件用于实时订阅、运行过程查询和后续调试；当前 Agent 进程退出后，内存事件和运行状态一起丢失，这是明确的当前限制。

未来实现持久化时，优先保存：

- Transcript 的 Message/Part 完整内容和恢复游标；
- 有回访价值的 `AgentEventEnvelope` 事件，不包括每个 delta；
- 必要的 Run 查询索引。

不要先增加一张“当前状态表”。如果将来为查询性能增加状态快照，它只能是带 revision 的可删除缓存，必须能从事件重建，不能成为第二事实来源。

### 当前明确不做的分布式能力

本提案不实现：

- Redis 状态缓存；
- Agent 实例租约、锁或 fencing token；
- 负载均衡后的 Run 接管；
- 跨实例事件订阅；
- Agent 崩溃后继续原模型请求。

这些能力只有在明确启动多租户、多实例目标时另立提案。届时 Redis 可以用于运行状态缓存和租约，但权威 Transcript 与事件仍需具备持久性和事务语义的共享存储；Redis 不能替代完整历史存储。

## 决定

本阶段采用上述最小边界并已落地：三个领域共用一条 `AgentEventEnvelope` 流、一个
Transcript Store 适配器和一个 Execution Store 适配器。状态不靠 UI 推导，也不在各领域
复制；Run 状态只由 ExecutionStore 依据 `run-state-changed` 更新，Message/Part 状态只由
Transcript Store 依据同一 envelope 更新。当前后端固定为进程内内存实现。

## 模块边界

- `packages/shared/src/schema/events.ts`：唯一事件 payload 与 `AgentEventEnvelope`，不保存数据库逻辑。
- `packages/shared/src/schema/status.ts`：状态词汇与必要的类型，不定义事件或存储表。
- `apps/agent/src/execution/status.ts`：Run 状态迁移规则和终态判断。
- `apps/agent/src/execution/memoryStore.ts`：追加事件、更新 Run 内存状态、维护 revision 和订阅。
- `apps/agent/src/core/transcript/`：保存 Message/Part 内容、消息终态和恢复游标，不保存第二份事件日志。
- `packages/ui/src/app/`：唯一 UI projection；思考、等待首 token 和 Wi-Fi 重试图标只投影明确事件/Run 状态。

本轮同时移除了没有运行时消费者的 Session、Step、Tool、Part 快照 schema。保留的状态词汇
必须有实际写入者：`AgentRunState` 由 `ExecutionStore` 写入，`AgentMessageState`、
`AgentPartState` 和 `AgentToolCallState` 由 Transcript 适配器依据 envelope 更新。

### 已实施：Transcript 消息 Part 与三领域事件消费

`ConversationMessage` 现在可以携带带明确 `kind` 的 `parts`：`text`、`reasoning`、`tool`。
这些 Part 是消息可恢复内容，不是新的事件类型。`MemoryConversationStore` 消费已有的
`text-*`、`reasoning-*` 和工具生命周期事件，把内容累积到对应 Part；`text` 与
`reasoning` 字段保留为当前 UI 和旧快照的兼容投影。高频 delta 仍然只作为实时事件
传输，Transcript 不保存第二份 delta 日志。

这一步只完成消息内容模型和内存适配器的累积，不代表 SQLite、Redis 或进程重启恢复
已经存在。后续持久化适配器必须保存同样的 Message/Part 结构，并继续使用同一个
`AgentEventEnvelope` 事件契约。

### 当前运行时接入结果与下一步

本轮已把三个领域的事件消费入口统一为 `ConversationStore.applyAgentEvent`：
Conversation、Answer、Interview 都把完整的 `AgentEventEnvelope` 交给同一个 Transcript
适配器。适配器负责按事件更新 Part、消息终态和 `eventRevision`；领域 application 不再
各自筛选流事件或重复计算 Run 终态。`ExecutionStore` 仍负责 Run 状态迁移和事件顺序，
UI 仍负责唯一界面投影。

本阶段已经完成运行时一致性，不做持久化：

1. Conversation、Answer、Interview 都把完整 `AgentEventEnvelope` 交给同一个
   `ConversationStore.applyAgentEvent`，由同一适配器更新文本、推理、工具 Part、消息终态和
   `eventRevision`。
2. UI 从带 `parts` 的 snapshot 初始化历史正文；之后只按 `eventRevision` 接收增量事件，
   不依赖重放 delta 才能显示已有消息。
3. `MemoryConversationStore` 固定单调 revision、活动 run 原子认领、终态映射和重复终态幂等；
   `MemoryExecutionStore` 固定 Run 状态迁移、事件顺序和订阅。失败终态会把未完成的 Part
   收束为 `failed`；中止或替代终态会把未完成的 Part 收束为 `interrupted`，已终结 Part 不被覆盖。

本轮已完成第一版可替换的 Transcript/Execution 存储适配器契约测试，以内存适配器作为基线：
覆盖 Run 状态迁移与非法迁移、终态幂等、事件订阅顺序、会话隔离、`afterRevision` 边界、
Transcript revision 单调、旧事件丢弃、跨会话事件拒绝，以及清空不回退游标。适配器端口仍保持
不绑定具体存储实现；本轮仍不实现 SQLite、Redis、实例切换或进程重启恢复。只有内存契约和
实际运行链路继续稳定后，才另立 Note 讨论 SQLite 适配器和事务边界。

随后对 Conversation、Answer、Interview、worker、Desktop IPC 和 UI 的生产接入做了逐层审计：
模型执行事件均从 `AgentRuntime` 进入 `AgentEventEnvelope`，三个领域都交给同一个
`ConversationStore.applyAgentEvent`；snapshot 通过 worker frame、Desktop listener 和 UI 的
统一恢复入口传递。发现并修复 Answer-only worker 的清空命令丢弃 snapshot 返回值且不广播
`conversation-snapshot` 的旧接法，并补充 worker 回归测试。Interview 的 `turn-committed`
仍是语音领域 DTO，用于转录/回合展示，不属于 Agent 执行事实流，不能与 envelope 混合。
生产代码中未发现 `ConversationEvent`、`run-finished` 或 `UIMessageChunk` 旧事件路径；测试夹具中
仍有兼容输入，只用于验证旧数据不会进入当前生产契约。

## 曾考虑的替代方案

- **为 Session、Step、Tool、Part 建独立持久化状态表：** 拒绝。会重复事件和 Message/Part 结果，增加一致性负担。
- **只保存一行 `message.streaming`：** 拒绝。无法表达可恢复的文本、推理和工具内容；需要时使用 Message/Part 对象字段。
- **只保存事件、不保存 Transcript：** 拒绝。历史恢复必须重放大量 delta，且 delta 不属于长期事件清单。
- **当前直接接入 SQLite/Redis 和实例切换：** 拒绝。当前产品仍是单实例，先固定内存端口和恢复游标。

## 验收证据

- 事件只有一个 `AgentEventEnvelope` 写入入口。
- Transcript 能提供完整消息内容；UI 不依赖重放每个 delta 恢复历史正文。
- Run 状态只能由明确事件迁移，不能由 UI 或文本是否到达推测。
- `pnpm notes:check`、`pnpm verify` 和 `git diff --check` 通过。
- Agent 24 个测试文件共 151 项通过；UI 28 个测试文件共 229 项通过；Desktop 43 个测试
  文件共 277 项通过。
- 架构检查通过：无跨包深导入、依赖环或平台依赖越界。

## 后果与防回退

- Agent 进程退出后内存事件、Run 状态和 Transcript 都会丢失；这不是当前阶段未完成的
  隐藏能力，而是明确限制。
- 新领域必须注入现有两个 Store 端口并消费完整 envelope，不得在领域目录筛选后另建事件
  或状态来源。
- 新的存储适配器必须通过与内存基线相同的契约测试，至少保持 revision 单调、事件顺序、
  终态幂等、活动 run 认领和清空游标语义。
- 新增状态词汇前必须先有真实 writer、来源事件和失效条件；没有消费者的快照 schema 不得
  进入共享契约。
- 后续实现 SQLite 时必须通过本阶段内存适配器的契约测试，不能以新后端改变事件顺序、
  revision、活动 run 认领或终态语义。

## 验证

本阶段已运行 `pnpm notes:check`、`pnpm verify` 和 `git diff --check`。存储契约定向测试现覆盖
18 项（Execution 6 项、Transcript 12 项），Answer worker snapshot 回归测试 1 项，验证结果包括：
Agent 24 个测试文件 151 项通过，UI 28 个测试文件 229 项通过，Desktop 43 个测试文件
277 项通过，架构检查通过。SQLite、Redis、进程重启恢复和多实例接管未实施，也未宣称
支持。

## 风险

- 当前 Agent 进程重启会丢失内存事件和活动 Run；需要重启恢复时，必须先补充持久化 Note，定义事件保留、Transcript 与事件 revision 的事务边界。
- 只有在明确多实例部署需求、共享存储和接管语义后，才重新评估 Redis、租约和 fencing token。
