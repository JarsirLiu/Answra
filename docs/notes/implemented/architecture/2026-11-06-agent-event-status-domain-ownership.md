# Note：Agent 事件与状态的领域归属

状态：已实施

## 问题

`apps/agent/src/conversation/` 曾把 session store、model generation、profile、request validation、retry policy 等不同职责散放在目录根部，只把 tools 归入子目录。此前尝试增加通用 `events`、`status`、`*Store` 空文件也没有定义事实 owner。需要按领域与子域整理现有代码，并为已确定的 Execution 领域预留可识别的模块入口。

## 涉及范围

- 代码/模块：`packages/shared/src/schema/`、`apps/agent/src/core/`、`apps/agent/src/conversation/`、`apps/agent/src/worker/`
- UI/进程/协议/持久化表面：模型流、Agent 执行生命周期、会话 transcript、worker/IPC 投影与未来持久化 adapter
- 相关 Note：[事件 schema 单一来源与 AI SDK 边界](./2026-11-03-event-schema-single-source.md)、[为托管 Agent 预留执行事实 schema](./2026-11-06-execution-schema-for-hosted-agents.md)、[产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)

## 决定

按业务事实的所有者组织事件和状态，不按 Event/Status/Store 等技术名词建立平行领域。

### 领域归属

| 事实 | 领域所有者 | 说明 |
| --- | --- | --- |
| 用户输入、assistant 消息、消息 parts、会话历史 | Conversation/Session | 长期 transcript；消息不是事件，也不是 run 状态 |
| 一次 Agent 执行、attempt、step 的开始、重试等待、成功、失败、取消 | Execution | `queued/running/retry-wait/completed/failed/aborted` 等状态属于执行，不属于 transcript 或 UI |
| AI SDK 产生的 text/reasoning/tool delta | Model Stream | 供应商流的归一化输出；高频增量是否进入当前会话 journal 由 Conversation store 决定，不自动成为长期 durable event |
| “有更新，请重新读取” | Worker/Transport | 通知是传输唤醒，不是业务事实，不单独持久化 |
| 跨进程公开 DTO | Shared contract | 只放需要跨包/进程稳定传输的 schema；不能因此把 IPC change 命名成 durable domain event |

`RunRegistry` 当前只管理进程内 `AbortController`、取消和完成等待，是执行生命周期的临时协调器；它不代表 durable run state。当前 `ConversationEvent` 是带序号的模型内容 feed，`ConversationChange` 是 snapshot/feed 的传输更新，`AgentStreamEvent` 是 SDK 归一化后的模型流事件。这三者都不是已实现的通用领域事件存储。

### 目录职责

当前目录按领域与子域组织：

```text
packages/shared/src/schema/
  conversation.ts   跨进程会话消息、快照和 change DTO
  events.ts         全部 Agent 事件、执行/流消费子集、durable 候选集和唯一 envelope
  status.ts         跨包 run/step 状态词汇与快照

apps/agent/src/
  core/run/registry.ts       进程内 run 取消与完成等待原语
  core/model/                AI SDK/provider 归一化与 HTTP 重试
  execution/                 run/attempt/step 状态、事件、进程内 store 和 projection
  conversation/
    session/                 会话 transcript、snapshot 恢复游标、内存 store
    turn/                    对话/答题的一次 assistant 回合与模型执行
    profiles/                profile 注册与答题策略
    tools/                   Conversation 工具实现和静态授权
  interview/                 语音采集后的转录、turn 与自动回复领域
  worker/                    命令分发、线协议及领域 DTO 投影
```

`conversation/session/*`、`conversation/turn/*`、`conversation/profiles/*` 和 `core/model/*` 已按职责归档；Agent 测试也按相同子域归档。Conversation 的进一步拆分见 [Conversation 领域目录按会话与回合组织](./2026-11-06-conversation-domain-layout.md)。`execution/{events,status,store,projection,memoryStore}.ts` 负责共享 schema 之上的状态转移、事件 envelope、进程内快照和读取；当前没有磁盘、Redis 或重启恢复。

跨包 schema 暂时继续位于 `packages/shared/src/schema/`，不为模仿 OpenCode 的 `packages/contracts`、`packages/schema` 立即拆包。Agent 事件载荷集中在 `events.ts`，不再按执行/模型生产方拆成两份事件定义；状态词汇独立放在 `status.ts`。IPC channel map 仍留在 `packages/shared/src/channels/`。完整事件目录与 delta 持久化资格见[集中 Agent 事件目录](./2026-11-07-unified-agent-event-catalog.md)。

### 持久化语义

- Conversation 存 transcript：用户输入、assistant 消息与 `eventRevision` 恢复游标；UI 恢复最近一轮流式细节时从该游标重放 Agent 事件。
- Execution 持 run/attempt 当前状态；重试等待中的 `attempt` 与 `nextRetryAt` 必须有执行事件/状态写入来源，不能从 Wi-Fi 图标或时间反推。
- 只将对审计、恢复或产品查询有价值的执行事实写入 durable event log。token 级 delta、网络 tick 和动画状态不写入长期事件表；完整消息或有界 checkpoint 才是恢复边界。
- Snapshot/projection 是查询读模型；它可以持久化用于加速，但必须带来源 revision/sequence，能够从权威事实校验或重建。
- Notification 在状态/事实提交后发出；丢失后消费者可以通过 snapshot 和序号增量读取恢复。
- 事件、状态和 transcript 若共同构成一次可见迁移，未来 adapter 必须在一个事务或等价原子边界内提交。Redis 不是 transcript 或长期执行事实的默认存储。

以上是目标责任，不是当前能力声明。当前 Agent 会话 store 是内存实现，worker/IPC 仍发送完整 `ConversationChange`，重启恢复、SQLite durable event log 和 durable run snapshot 均未实现。

## 模块边界

- `packages/shared/src/schema/`：跨包稳定 DTO 与执行词汇；不实现领域 runtime、存储或 reducer。
- `apps/agent/src/conversation/session/`：Conversation transcript、快照和当前内存 store。
- `apps/agent/src/conversation/turn/`：Conversation/Answer 的回合认领与模型生成编排；具体拆分见配套 Note。
- `apps/agent/src/conversation/profiles/` 与 `tools/`：场景策略和工具授权，各自由 Agent 静态注册。
- `apps/agent/src/core/model/`：当前模型 SDK 边界归一化和 HTTP 重试实现；不持有领域策略。
- `apps/agent/src/core/run/`：现有进程内取消/等待原语。
- `apps/agent/src/execution/`：负责 Execution 状态转移、事件 envelope、进程内 store 与读投影；持久化 adapter 仍未实现。
- `apps/agent/src/worker/`：把领域结果投影到 worker 协议；不拥有 Conversation 或 Execution 业务状态。
- 未来持久化 adapter：由具体运行应用装配；领域端口必须由真实持久化需求驱动，不预建空接口目录。

## 曾考虑的替代方案

- **在 `conversation/` 下平铺 event/status/transcript/projection 多个空壳：** 已舍弃。事件和状态属于 Execution 领域，应与 Conversation transcript 分开。
- **所有模块继续平铺在 `conversation/`：** 初始改动最小，但模型生成、会话记录、场景策略和工具授权难以按领域定位；已按真实职责移动现有模块。
- **立即创建 `packages/contracts` 或模仿 OpenCode 的多 package 拆分：** 当前只有 shared 是稳定跨包契约入口；新增包会违反本仓库“不为第一消费者预抽象”的约束。
- **所有运行状态只由事件重放得出：** 能提供审计，但恢复与查询需要扫描长日志；应保留可校验的当前状态快照。
- **只保存消息和当前 run status：** 无法解释重试历史和状态变化，排障与增量恢复能力不足；对有恢复价值的执行迁移应保留事件事实。

## 验收标准

- 可观察结果：Conversation 子域、模型边界和 Execution 领域各有明确目录；每次 run 状态迁移都有共享 schema 定义的 Execution event；重试等待同时有 Execution `retry-wait` 事实和现有 Conversation Wi‑Fi 流事件。
- 自动化验证：Agent 测试与类型检查通过；Note、架构检查和 diff 空白检查通过。
- 需要的实机验证：无；只有实现持久化恢复时才需验证进程重启与真实 retry-wait 恢复。

## 风险

- `execution.ts` 现在是 run/step 状态和 event envelope 的唯一共享契约，Conversation runtime 已通过 `ExecutionStore` 写入进程内事实；它仍不是 durable 状态机。
- 现有 stream retry event 被 Conversation journal 暂存并通过 UI 显示；未来若接入 durable Execution，需要定义从 HTTP 重试回调到 attempt 事实的显式映射，不能通过 UI 投影推断。
- 当前内存 store 在 Agent 进程退出后丢失 transcript 与运行信息；本提案不消除该限制。

## 后果与防回退

- 新增 Conversation transcript 代码归 `conversation/session/`；回合认领与执行编排归 `conversation/turn/`；场景策略归 `conversation/profiles/`；工具归 `conversation/tools/`。
- `execution/` 的模块是当前进程内领域实现；新增 durable adapter、恢复语义和跨实例一致性前必须补原子写入、幂等、租约和重启测试。
- AI SDK 类型只在 `core/model/` 的 adapter 边界出现；跨进程 schema 仍从 `@answra/shared/schema` 导入。
- 新增能力领域放在 `apps/agent/src/` 与 `conversation/` 平级，并同步 `AGENTS.md` 和 README 结构表。

## 验证

- Agent 全部测试通过，覆盖目录移动后的模型流归一化、retryFetch、Conversation runtime/store 和工具行为。
- `pnpm verify`、`pnpm notes:check`、`pnpm architecture:check` 与 `git diff --check` 通过。
