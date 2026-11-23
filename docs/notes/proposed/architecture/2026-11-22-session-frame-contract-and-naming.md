# Note：统一 SessionFrame 线协议与四层命名

状态：提案

## 问题

Session/Turn/Step 底座已经落地，但对外的事件协议还是旧 run 模型的形状，导致同一个东西在三层有三个名字，每次读代码都要先做一次术语翻译。

具体证据：

- **三套词汇指同一件事。** 事实叫 `turn-started` / `step-finished`，线上叫 `run-state-changed` / `runId`，UI 状态叫 `activeRunId`。三者分别定义在 `packages/shared/src/schema/events.ts:253`、`packages/shared/src/schema/status.ts:14`、`packages/shared/src/schema/conversation.ts:71`。
- **一个 envelope 装了三类语义。** `AgentEventEnvelope.event` 同时包含 durable 事实（`turn-*` / `step-*` / `compaction-*`）、派生生命周期（`run-state-changed`）和渲染增量（`text-delta` 等）。UI 只能消费后两类，`packages/ui/src/app/conversationView.ts:166-182` 明确把 durable 事实全部 `return next` 丢弃——前端背着一份自己不用、却必须跟着改的存储契约。
- **无空洞 delta 是自找的不变量。** `aggregateRevision` 要求 durable 与 live 共用同一个连续计数器，于是 `packages/ui/src/app/useConversationView.ts:80-93` 必须在缺号时回读补齐。增量本身不需要这种保证：完整值事件总会到来，丢掉一段 delta 不影响最终结果。
- **取消句柄与消息身份绑死。** `ConversationSendResult` 返回 `runId`（`packages/shared/src/channels/conversation.ts:188`），远程取消命令带 `runId`（`packages/shared/src/schema/remote/commands.ts:69`），桌面 bridge 也是 `cancelConversationRun(runId)`（`packages/shared/src/bridge.ts:158`）。真正需要取消的是 Turn，真正要渲染的是 Message，两者被同一个字符串混用。
- **存在第二套执行引擎。** `apps/agent/src/answer/application.ts` 仍走 `executor.startRun` → `apps/agent/src/core/agent/executeRun.ts`，并自行生产 `run-state-changed`；会话三个域走 `ProviderStepRunner` + `TurnExecutor`。只要 Answer 不迁移，`run` 就无法从共享 schema 中删除。

维护痛点不是"多了一层代码"，而是**命名无法预测职责**：看到 `SessionEventProjector` 以为它在做状态推导，实际只做协议映射；看到 `ExecutionStore` 以为它在存执行状态，实际只是一个内存广播器。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/schema/events.ts`、`packages/shared/src/schema/conversation.ts`、`packages/shared/src/schema/status.ts`、`packages/shared/src/schema/remote/`、`packages/shared/src/channels/conversation.ts`、`packages/shared/src/bridge.ts`
  - `apps/agent/src/core/session/sessionEventProjector.ts`、`apps/agent/src/core/session/sessionRuntimeJournal.ts`、`apps/agent/src/execution/store.ts`、`apps/agent/src/execution/memoryStore.ts`
  - `packages/ui/src/app/conversationView.ts`、`packages/ui/src/app/useConversationView.ts`
  - `packages/remote/src/host/hostPort.ts`、`packages/remote/src/reconnect/remoteControllerConnection.ts`
  - `apps/cli/src/tui/app/viewStore.ts`、`apps/cli/src/tui/sessionRunQueue.ts`、`apps/cli/src/presentation/`
  - `apps/desktop/src/main/`（worker 传输与 IPC handler）、`apps/agent/src/worker/protocol.ts`
  - `apps/agent/src/answer/application.ts`、`apps/agent/src/core/agent/executeRun.ts`（P3）
- UI/进程/协议/持久化表面：worker 帧 `AgentFrame`、desktop IPC 事件频道、远程帧协议版本、CLI/TUI 事件消费、`ConversationSnapshot` 的活动字段。持久化表结构不变。
- 相关 Note：
  - [Session/Turn/Step 边界](./2026-11-21-session-turn-step-boundaries.md)（§17.1 已决定 `run` 从词汇中退役，本 Note 是其执行方案）
  - [SQLite session journal](../../implemented/architecture/2026-11-22-sqlite-session-journal.md)
  - [拒绝细粒度执行状态投影](../../rejected/architecture/2026-11-08-fine-grained-execution-state-projection.md)（本 Note 不新增任何并行状态投影，只删除一个）

## 提案

### D1 一条 durable 通道，一条 live 通道

把"一条无空洞的混合流"拆成两条，各自有独立的可靠性承诺：

| | durable 通道 | live 通道 |
| --- | --- | --- |
| 载体 | `SessionFrame` | `LiveFrame` |
| 游标 | `seq`，会话内连续 | 无 |
| 可丢 | 否 | **是** |
| 断线补齐 | 按 `seq` 重读 | **不补** |
| 权威性 | 唯一真相 | 乐观预览，被完整值事件覆盖 |

依据：`text-delta` / `reasoning-delta` / `tool-input-delta` / `tool-output-delta` 的终点都有对应的 durable 完整值事件（`text-end`、`reasoning-end`、`tool-input-end`、`tool-result`）。因此 delta 丢失只影响瞬时观感，不影响正确性。

**这一条移除的是 `aggregateRevision` 的连续不变量**，也就是 `useConversationView.ts:80-93` 那段补洞逻辑的存在理由。

### D2 一份 envelope，不另造 payload

`SessionFrame` 就是 `SessionEventEnvelope` 的对外形态：同一份 `event` 联合类型，加上路由字段与 `seq`。

```ts
// packages/shared/src/schema/session/frame.ts
export const sessionFrameSchema = z.strictObject({
  schemaVersion: z.literal(2),
  sessionId: z.string(),
  seq: z.number().int().positive(),   // durable 唯一游标
  eventId: z.string(),
  occurredAt: z.string().datetime(),
  producerId: z.string(),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
  stepId: z.string().optional(),
  operationId: z.string().optional(),
  event: agentDurableEventSchema,
});

export const liveFrameSchema = z.strictObject({
  sessionId: z.string(),
  messageId: z.string(),
  stepId: z.string().optional(),
  event: agentLiveOnlyEventSchema,    // 仅四个 delta
});
```

约束：

- `LiveFrame` 不带 `seq`、不带 `revision`、不带 `eventId`；它不参与重放。
- `SessionFrame.event` 只允许 `agentDurableEventSchema`，**编译期禁止增量进入持久化通道**。
- P1 不改任何事件 payload。`step-started.stepId` 与 envelope 重复这类问题留到 P3，避免一次变更同时改协议和语义。

### D3 四层命名，后缀即职责

| 后缀 | 含义 | 现存例子 | 规则 |
| --- | --- | --- | --- |
| `*Event` | 已发生的过去式事实，落盘 | `turn-started`、`step-finished` | 必有 `seq`；不得表达"正在" |
| `*Frame` | 传输单位，不另造 payload | `SessionFrame`、`LiveFrame` | 只加路由字段 |
| `*Projection` | 从事实纯函数重算 | `SessionProjection` | 不落盘、不写事件 |
| `*View` | 前端内存状态 | `ConversationView` | 只由 fold 写 |
| `*Snapshot` | 完整状态，整体替换 | `ConversationSnapshot` | 迟到者唯一入口 |
| `journal` | 只 append | `SessionJournal` | 不推导状态 |
| `present*` / `group*` | 转人类语言 / 合并相邻项 | `presentToolCall`、`groupToolCalls` | 不接触事件 |

改名清单（旧 → 新）：

| 旧 | 新 | 处置 |
| --- | --- | --- |
| `AgentEventEnvelope` | — | 删除，统一为 `SessionFrame` / `LiveFrame` |
| `agentEventSchema` | `agentDurableEventSchema` + `agentLiveOnlyEventSchema` | 拆成两个联合，不再有"包含全部"的中间类型 |
| `run-state-changed` | — | 删除，语义见 D4 映射表 |
| `ExecutionStore` | `SessionFrameBus` | 只广播，不保存历史、不分配 revision |
| `ExecutionRunStart` / `ExecutionEventMetadata` | — | 删除 |
| `SessionEventProjector` | — | 删除，折叠逻辑回到 `conversationView.ts` |
| `projector.readEvents` | `SessionFrameBus.readFrames`（转读 journal） | 重放源改为 journal |
| `activeRunId` | `activeTurnId` + `activeMessageId` | 取消按 Turn，渲染按 Message |
| `cancel(conversationId, runId)` | `cancelTurn(conversationId, turnId)` | 提交结果返回 `turnId` |
| `ConversationSendResult.runId` | `turnId` | 排队与活动槽位都以 Turn 为单位 |
| `AgentRunSnapshot` | — | 随 P3 删除 |

命名约束以实际职责和公开契约为准：事件使用过去式事实名，帧表示传输单位，投影与视图分别表示纯折叠结果和前端状态。保留历史兼容代码时，应通过类型和调用关系明确其边界，不以全局禁词扫描替代语义审查。

### D4 `run-state-changed` 的逐项映射

删除前必须逐项有接收者；下表即实现清单：

| 旧 `state` | 新事件 | 折叠后的 UI 结果 |
| --- | --- | --- |
| `queued` | `turn-queued` | 排队位置，无 activeMessage |
| `claimed` / `running` | `turn-started`（`messageId` 在 frame 上） | `activeMessageId`、`waitingForStream: true` |
| `retry-wait` | `retry` 流事件（已含 `attempt` / `maxRetries` / `delayMs`） | `retry` 卡片 |
| `completed` | `turn-finished { status: "completed" }` | message `complete` |
| `failed` / `orphaned` | `turn-finished { status: "failed" }` | message `failed` |
| `aborted` / `superseded` | `turn-finished { status: "aborted" }` | message `interrupted` |

`turn-handoff` 负责结束当前 `messageId` 并开启下一个；`compaction-*` 不进入折叠（UI 状态来自 `ConversationSnapshot.contextCompaction`，维持现状）。

### D5 取消身份改为 Turn

- 提交返回 `turnId`，排队项与活动槽位都以 Turn 为单位（与 `TurnScheduler` 一致）。
- 取消活动 Turn 时，queued Turn 保持原语义（同时取消，已在底座实现）。
- `ConversationSnapshot.activeRunId` → `activeTurnId` + `activeMessageId`。
- 远程协议 `REMOTE_PROTOCOL_VERSION` **保持 `1`，直接在 v1 上替换线协议形状**（修订见下文「为什么 remote 不升版本」）。原提案是从 `1` 升到 `2` 并拒绝 v1 握手，但因远程从未上线、没有已发布客户端，升版只会产生一份永远不会被使用的 v2 词汇，因此舍弃。

### D6 折叠只有一份

`packages/ui/src/app/conversationView.ts` 已经被桌面 renderer 与 CLI 同时引用（`apps/cli/src/tui/app/viewStore.ts:9` 从 `@answra/ui/conversation-view` 导入）。因此"让 UI 消费事实"不产生 N 份重复实现：

- `foldConversationFrame(view, frame)`：durable 折叠，纯函数，导出为 `@answra/ui/conversation-view`。
- `overlayLiveFrame(view, frame)`：live 叠加，幂等，允许丢失。
- 移动端尚未实现会话 UI（Phase 0 骨架），接入时直接复用这两个函数，不新增第三套。

## 模块边界

改动完成后的归属：

| 模块 | 唯一职责 | 明确不做 |
| --- | --- | --- |
| `apps/agent/src/core/session/journal.ts` | 事实追加与按 seq 读取 | 不广播、不投影 |
| `apps/agent/src/core/session/projection.ts` | journal → `SessionProjection` | 不写事件、不转协议 |
| `apps/agent/src/core/session/sessionFrameBus.ts` | 把新 frame 推给订阅者 | 不保存历史、不分配 revision、不判断状态 |
| `apps/agent/src/core/session/transcriptBridge.ts` | 事实 → transcript 消息 | 不服务 UI 渲染 |
| `packages/shared/src/schema/session/` | 事实与 frame 的唯一词汇表 | 不导出任何 `run*` |
| `packages/ui/src/app/conversationView.ts` | frame → `ConversationView` | 不 import agent 内部模块、不读写存储 |
| `packages/ui/src/tool-presentation/` | 单次工具调用 → 人类语言 | 不接触事件、不判断 Turn |
| `apps/cli/src/tui/transcript/tool/groups/` | 相邻工具调用 → 汇总句 | 不接触事件、不读 journal |

边界判定口径：**一个模块如果同时知道"事件类型"和"中文文案"，它就跨层了。** 现有代码中 `tool-presentation` 与 `groups` 都只吃 `ToolPresentation`，符合要求；`conversationView.ts` 必须只吃 frame，不得再出现 `present*` 逻辑。

## 迁移阶段

每阶段独立可交付、可回滚，出口条件必须全部满足才进入下一阶段。

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| P1 加通道 | 新增 `sessionFrameSchema` / `liveFrameSchema`、`SessionFrameBus`；journal 与 bus 并行发布；旧 projector 保持 | 新 schema 有单测；`pnpm verify` 全绿；线上仍走旧协议 |
| P2a 切读取面（第 3a 步） | UI / CLI 改吃 `SessionFrame` / `LiveFrame`，取消与渲染改用 `activeTurnId` + `activeMessageId`；快照与频道契约一次改到位；服务端继续双发（projector 保留） | 桌面、CLI 的流式/工具/handoff/排队/取消/压缩后继续与改动前一致；`pnpm verify` 全绿 |
| P2b 删写入面（第 3b 步） | 删除 `AgentEventEnvelope` 通道、`SessionEventProjector`、`run-state-changed`；恢复协调器端口收敛；remote 保持 v1 直接换成帧线协议 | 全仓 `\brunId\b` 归零（Answer shim 除外）；remote 命令/帧契约只剩 `read-frames` / `session-frame` / `live-frame`；`pnpm verify` 全绿 |
| P3 删旧引擎 | Answer 迁到 `SessionRuntime`（内存 journal、单 Turn）；删除 `executeRun.ts` 与 Answer shim | `run-state-changed` 全仓归零；Answer 截图答题回归通过 |
| P4 上锁 | `architecture:check` 保留 import 方向、包边界与运行时隔离检查；以真实类型和调用关系约束事件/帧职责 | 类型、行为与架构检查通过 |

原 P3（取消语义）并入 P2：只要事件载荷从 envelope 换成 frame，所有宿主就必须同时切换；若远程仍留在 v1，桌面 renderer 会同时收到两种形状，等于再引入一个翻译层。因此 `turnId` 与 snapshot 字段必须与读取面切换在同一变更内完成。

### 为什么 P2 拆成 3a / 3b（修订 2026-11-22）

原计划把第 3 步作为单次提交完成。实际执行后确认这个粒度不可控：它要同时改 shared schema、transcript 活动槽位、worker 线协议、desktop IPC、UI 折叠、CLI 视图与远程协议，任一环节未完成整仓就无法编译；而 `pnpm verify` 一轮约 6–8 分钟，于是退化成"改一批 → 跨包不匹配 → 再改一批"的循环，无法判断还剩多少工作量。

第 2 步已经把帧**并行双发**，因此可以按绞杀者模式拆成两段：

- **3a 切读取面**：UI / CLI 只吃帧，取消改用 `activeTurnId`；服务端写入链保持 `journal → frame → 旧 projector → transcript`，`SessionEventProjector` 保留。
- **3b 删写入面**：删除 `AgentEventEnvelope` 通道与 projector，收敛恢复端口，远程升 v2。

"协议只断一次"的约束仍然成立：**对外可见的契约形状**（快照字段、发送/等待/取消的请求与响应、frame schema）在 3a 内一次改到位，3b 不再改动它们。被拆开的只是"删除旧通道"的时机；3b 不含任何消费方重写，只有删除与收口。

这样做的代价是旧 envelope 在 3a 期间仍然存在（但已无 UI 消费者），收益是每段都能独立编译、独立验证、独立提交，不会出现长时间无法判断进度的中间态。

### 为什么 3b 不能再拆成 agent / CLI / remote 三笔（修订 2026-11-22）

3b 原计划按「agent 删写入面 → CLI 适配 → remote 帧化」拆成三笔提交。实施时确认这个粒度不成立：

`CodingHostOptions.emitEvent` 是 CLI 与桌面 remote host 把 envelope 转发给 controller 的唯一入口，而 `HostCommandPort.readEvents` / `onEvent`、remote 线协议 `event` / `events` 帧、`read-events` 命令又都还是 envelope 形状。删掉 agent 写入面后，两个 remote host 立刻失去历史读取面与实时流，无法编译；反之若先改 remote，CLI/桌面也没有帧可转发。

因此 3b 合并为**一笔提交**：agent 删除 + remote 帧化 + CLI/桌面宿主适配一起落盘。中间不存在可编译的半删状态，门禁只在一个完整状态上变绿。3a 已经把对外契约形状定死，所以合并的只是「删除时机」，不是「一次改两种形状」。

### 为什么 remote 不升版本（修订 2026-11-22）

原提案要求 `REMOTE_PROTOCOL_VERSION` 升到 `2` 并拒绝 v1 握手。实施时确认 **remote 从未上线**：没有已发布 host、没有已发布 controller，移动端只有 Phase 0 骨架且不消费帧。

升版的前提是「存在需要被拒绝的旧客户端」；该前提不存在，升到 v2 只会留下一份永远不会被使用的 v1 兼容分支与一套 v2 词汇。因此决定：

- `REMOTE_PROTOCOL_VERSION` 保持 `1`，直接替换 v1 的线协议形状。
- 删除 `events` 帧与 `remoteEventBatchSchema`（本就没有消费者），新增 `session-frame` / `live-frame` 帧与 `read-frames` 命令。
- `read-events` 命令与 `event` 帧**不删除**，但只允许服务 Answer 的 envelope shim（P3 一并删除）；会话 / 面试 / Coding 只走帧。

代价是「同一版本号对应两种形状」这件事在语义上不严谨；接受理由是这套协议没有任何外部部署，版本号在此刻没有兼容性职责。若将来需要兼容，应以届时实际发布的形状为 v1 基线。

### P2 执行顺序

P2 内部再拆四个子步，前两步不改变线上行为，第三步是唯一破坏点。

**第 1 步：快照游标改为 journal `seq`（非破坏）**

- `ConversationSnapshot` 增加 `lastSeq`，与迁移期的 `eventRevision` 并存；`lastSeq` 不持久化，恢复时重新 seed，避免旧记录迁移。
- `SessionJournal` 增加 `lastSequence(sessionId)`；SQLite 实现用 `MAX(sequence)`，内存实现取最后一行。
- `SessionTranscriptBridge` 每写一条 durable 事实后把 `lastSeq` 推进到 `envelope.sequence`；投影失败时不推进，客户端仍能从旧游标重读该事实。
- `clear` 同时清空 transcript 与 journal，`lastSeq` 归零而不是推到末尾：SQLite 的 `sessions_delete_session_events` 触发器已经随会话行删除事实，序号会从 1 重新开始；若把游标停在旧末尾，新会话的 `seq` 会小于游标而被客户端忽略。内存 journal 增加显式 `clear` 补齐同一语义。
- `SessionRecoveryCoordinator` 在 `recoverFacts` 之后、`restoreTranscript` 之前 seed `lastSeq = journal.lastSequence`；这样重启后不会重放整本 journal。
- 客户端折叠必须**按帧幂等**：同一条 durable frame 应用两次结果不变。游标与消息写入跨异步边界，幂等是唯一可靠的一致性保证。
- 出口：store / bridge / recovery 单测覆盖游标推进、清空、重启 seed；`pnpm verify` 全绿；线上仍走 envelope。

**第 2 步：并行增加 frame 传输（非破坏）**

- worker 协议增加 `session-frame`、`live-frame`、`read-frames`（按 `seq`）；旧 `event` / `read-events` 保留。
- `startAgentHost` 订阅 `SessionFrameBus` 并把帧转发给 transport；desktop main 新增两个 IPC 频道（durable / live），preload 暴露 `readSessionFrames`、`onSessionFrame`、`onLiveFrame`。
- CLI 的 `CodingHost` 暴露同一个 bus（或等价端口），`viewStore` 暂不消费。
- 出口：worker 往返、IPC 转发顺序、`read-frames` 边界测试；旧 UI 一行不改。

**第 3 步：切换协议（拆为 3a 切读取面 / 3b 删写入面）**

**3a 切读取面（对外契约一次改到位）**

契约形状（3b 不再改动）：

| 位置 | 3a 之后的形状 |
| --- | --- |
| `ConversationSnapshot` | `activeTurnId?`（取消定位）+ `activeMessageId?`（渲染定位），不再有 `activeRunId`；`eventRevision` 仅留给 Answer shim，`lastSeq` 是 durable 游标 |
| `ConversationSendResult` | `started` 分支返回 `turnId`（原 `runId`） |
| `ConversationTurnResult` | `{ turnId, snapshot }`，替换原 `ConversationRunResult` |
| `ConversationQueueCompletion` / `WaitQueue` | `turnId?`，替换 `runId?` |
| `ConversationChannels.Cancel` | `{ conversationId, turnId }` |
| `DesktopBridge` | `cancelTurn(conversationId, turnId)`，替换 `cancelConversationRun(runId)` |
| 面试 / intake 发送 | 返回 `{ turnId, snapshot }` |

活动槽位所有权（唯一写入点，禁止别处推演）：

- `beginSessionTurn` / `appendAssistantPlaceholder` / `beginMessages` 写 `activeTurnId` + `activeMessageId`。
- `finishSessionAssistant` 只清 `activeMessageId`（handoff 时活动 Turn 未结束）。
- `finishSessionTurn(conversationId, turnId)` 在 `turn-finished` 时清两者；Turn 不匹配时 no-op。
- 旧记录兼容：持久化 schema 用 `.extend({ activeRunId: z.string().optional() })` 读入，恢复时连同 `activeTurnId` / `activeMessageId` / `lastSeq` 一起丢弃，不做字段迁移。

其余 3a 工作：

- `Scheduler` / `SessionRuntime` 内部命名统一为 `messageId`：`waitForTurnStart` 返回该 Turn 首条 assistant 消息 id，`waitForTurn` 返回 `{ messageId?, outcome, errorText? }`。
- 面试回复循环改为 Turn 身份：`startReply → { turnId }`、`cancelReply(conversationId, turnId)`、`waitForReply(conversationId, turnId)`。
- 折叠：新增 `foldConversationFrame` / `overlayLiveFrame`（即 D6 命名；早期草稿写作 `applySessionFrame` / `applyLiveFrame`，以 D6 为准）。按 D4 映射逐项实现；`useConversationView` 按 `seq` 幂等折叠，durable 缺口整段重读，live 直接丢，删除 `cursor + 1` 补洞；渲染与滚动按 `activeMessageId` 定位。
- CLI：`viewStore` 折叠帧，`sessionRunQueue` / `runController` / `codingSession` / `presentation` 走 Turn 与帧。
- 出口：`pnpm verify` + `pnpm notes:check` 全绿；桌面与 CLI 的流式文本、工具卡片、handoff 多消息、排队、取消、自动压缩后继续与改动前一致；旧 envelope 仍在双发但已无 UI 消费者。

**3b 删写入面（纯删除与收口，不改契约）**

- 删除 `SessionEventProjector`、`run-state-changed`、`ExecutionStore`；`SessionRuntimeJournal` 写入顺序收敛为 `journal → frame → transcript`。
- `SessionRecoveryCoordinator` 端口收敛为 `recoverFacts → journalLastSeq → seedLastSeq → restoreTranscript(…, lastSeq) → resumeQueued → onRecovered`，删除 `eventRevision` / `seedRevision` / `revision` / `suspendUi`；恢复写回的收口事实作为新的 durable 帧广播，不再挂起 UI。
- `ConversationApplication` / `CodingApplication` / `InterviewApplication` 删除 `executionStore`、`projector`、`turnByRun`、`getExecutionRun`、`readExecutionEvents`；`readFramesAfter` 成为唯一读取口。`AgentRuntime` 的 `executionStore` / `emitEvent` 改为可选并新增 `requireExecutionStore()`，只有 Answer shim 构造时注入。
- desktop / worker / preload 删除面试事件读取口（`InterviewChannels.IntakeEvents`、`readInterviewIntakeEvents`、`interview-events` / `interview-intake-events` 命令，UI 无消费者）；`AgentService.readEvents` 固定路由 `read-events`，只服务 Answer。
- remote：`remoteEventListSchema` → `remoteFrameListSchema`，`throughRevision` → `afterSeq`，`HostCommandPort.readEvents` / `onEvent` → `readFrames` / `onFrame` / `onLiveFrame`；线协议新增 `session-frame` / `live-frame`，删除无人消费的 `events` 帧；命令 `read-events` → `read-frames`；`REMOTE_PROTOCOL_VERSION` 保持 `1`。
- Answer 仍走 envelope：保留独立 `applyAgentEvent` 与 envelope 订阅，标注为 P3 删除的临时路径，不与会话帧混用；`aggregateRevision` 只留在 Answer shim。
- 出口：D4 映射逐项测试、幂等测试、重连/断线/取消/排队测试、remote 帧往返测试；会话/面试/Coding 的 `\brunId\b` 与 `AgentEventEnvelope` 归零（Answer shim 除外）；桌面与 CLI 实机验证。

**第 4 步：Answer 迁移与上锁（原 P3/P4）**

- Answer 改走内存 journal 的单 Turn `SessionRuntime`，删除 `executeRun.ts`、envelope shim 与 `agentEventEnvelopeSchema`。
- `architecture:check` 加禁词与 import 方向规则，并带故意违规的反例测试。

## 实施进度

- **P1 已完成（2026-11-22）**：
  - 新增 `packages/shared/src/schema/session/frame.ts`：`sessionFrameSchema`（`schemaVersion: 2`、连续 `seq`、事实专用）与 `liveFrameSchema`（四个 delta、无游标），并提供 `toSessionFrame` 作为 journal v1 → v2 的唯一适配点。
  - `agentDurableEventSchema` 收紧为事实目录（36 种），新增 `agentLiveOnlyEventSchema`（4 种）；`run-state-changed` 只留在旧 wire 的 `agentExecutionEventSchema` / `agentEventSchema`，不再能进入 journal 或 frame。
  - 新增 `apps/agent/src/core/session/sessionFrameBus.ts`：只广播、不保存历史、不分配游标；订阅者异常被隔离，不影响事实写入。
  - `SessionRuntimeJournal` 的 `frames` 为必填项，写入顺序变为 journal → frame 广播 → 旧投影 → transcript，旧 projector 与旧 wire 保持不变。
  - Conversation、Interview、Coding 三个 application 在 `onStepStream` 发布 `LiveFrame`；`startAgentHost` / `startCodingHost` 为每个进程创建单一 `SessionFrameBus` 并传给各领域。
  - 路径调整：原 `packages/shared/src/schema/session.ts` 迁到 `session/summary.ts`，使 `session/` 目录同时容纳摘要 DTO 与 frame 词汇，避免同名文件与目录并存造成解析歧义。
  - 证据：`packages/shared/test/sessionFrame.test.ts`、`apps/agent/test/core/session/sessionFrameBus.test.ts`、`sessionRuntimeJournal.test.ts` 的广播顺序断言；`pnpm verify` 全绿。
- **P2 第 1 步已完成（2026-11-22）**：
  - `ConversationSnapshot` 增加必填 `lastSeq`；与 `eventRevision` 并存但语义不同（只数 durable 事实），属于运行期游标，持久化 schema 显式 omit，恢复时置 0 并由 journal 重新 seed。
  - `SessionJournal` 增加 `lastSequence` / `clear`：SQLite 用 `MAX(seq)` 与 `DELETE FROM session_events`，内存实现取末行并删除该会话；清空后 `seq` 从 1 重新开始。
  - `ConversationStore` 增加 `advanceLastSeq`（只单调前进，非法值抛错）与 `ConversationClearCursor`；`clear` 把 durable 游标归零、`eventRevision` 取新旧较大值。
  - `SessionTranscriptBridge.apply` 拆出 `project`，投影成功后才推进游标；投影失败时游标不动，事实留在 journal 等待重读。
  - `SessionRecoveryCoordinator` 顺序变为 `recoverFacts` → seed `lastSeq` → `restoreTranscript`，新增端口 `journalLastSeq` / `seedLastSeq`；Conversation / Coding / Interview 三个 application 接线。
  - 清空流程改为 `store.clear({ eventRevision })` + `runtimeJournal.clear(session)`，transcript 与 journal 一起清空。
  - 证据：`journal.test.ts` / `sqliteJournal.test.ts`（重启读末尾、清空后重编号）、`store.test.ts`（单调推进、重复帧 no-op、非法值、清空归零）、`sqliteConversationStore.test.ts`（游标不持久化）、`transcriptBridge.test.ts`（成功推进 / 失败不推进）、`sessionRuntimeJournal.test.ts`（观察点看到已推进游标）、`recoveryCoordinator.test.ts`（seed 顺序）。
- **P2 第 2 步已完成（2026-11-22）**：
  - worker 线协议新增 `read-frames` 命令与 `session-frame` / `live-frame` 上行帧；`startAgentHost` 订阅进程级 `SessionFrameBus` 后只做转发（`disposed` 后停发），旧 `event` / `read-events` 未改动。
  - `ConversationApplication.readFramesAfter` 直接读共享 journal（`runtimeJournal.readAfter` + `toSessionFrame`）：帧读取与会话所属领域无关，只有恢复仍由各领域自己执行。Interview 与 Coding 不再补未使用的读取口，避免死代码。
  - desktop：`AgentWorkerProcess` 增加帧监听与分发；`AgentService.onSessionFrame` / `onLiveFrame` / `readFrames`；`window.ts` 的 `sendSessionFrame` / `sendLiveFrame`（reply 窗口按 `sessionId` 过滤）；`conversationIpc` 的 `ReadFrames` handler（`afterSeq` 必须为非负安全整数）与两个订阅注册；preload 暴露 `readSessionFrames` / `onSessionFrame` / `onLiveFrame`。
  - CLI：`CodingHostOptions.sessionFrames` 可注入，`CodingHost.sessionFrames` 暴露同一个 bus；`composition.ts` 导出 `SessionFrameBus` / `SessionFrameListener`；TUI 暂不消费。
  - 证据：`apps/agent/test/worker/host.test.ts`（实时上行、`seq` 连续、`read-frames` 边界与全量重读）、`apps/agent/test/coding/application.test.ts`（bus 发布 durable + live、注入同一 bus）、`apps/desktop/test/conversationIpc.test.ts`（读取、游标校验、订阅注册、帧不与旧事件混流）。
- **P2 第 3a 步（切读取面）已完成（2026-11-22）**：
  - 决策：原"单次破坏性切换"改为 `3a 切读取面` + `3b 删写入面`，理由见上文「为什么 P2 拆成 3a / 3b」。
  - `packages/shared`：快照改为 `activeTurnId` + `activeMessageId`；`ConversationSendResult.started.turnId`；`ConversationTurnResult` 替换 `ConversationRunResult`；`WaitQueue` / `ConversationQueueCompletion` 使用 `turnId`；`Cancel` 请求改为 `{ conversationId, turnId }`；`DesktopBridge` 改为 `cancelTurn`；面试 / intake 发送返回 `turnId`。
  - `apps/agent`：transcript 活动槽位改名与写入规则（`beginSessionTurn` / `appendAssistantPlaceholder` / `beginMessages` 写 `activeTurnId`，`finishSessionAssistant` 只清 `activeMessageId`，新增 `finishSessionTurn` 由 `turn-finished` 调用）；`scheduler` / `sessionRuntime` 内部 `runId` → `messageId`；持久化与恢复对新字段做读入兼容并丢弃活动槽位；worker 取消拆为 `cancel-turn { conversationId, turnId }` 与 `cancel-run { runId }`（后者只服务 Answer shim），`host.ts` 按 `store.scopeOf` 路由、面试 scope 内按 `activeAgentId` 区分演练与 intake。
  - `apps/desktop`：`agentService` / `conversationIpc` / `window` / preload 切到 `cancelTurn` 与帧通道；renderer 只消费 `SessionFrame` / `LiveFrame`。`ConversationSnapshot.activeTurnId` / `activeMessageId` 由进程内 transcript 维护，不再从 envelope 推导。
  - `packages/ui`：新增 `foldConversationFrame`（durable，按 `seq` 幂等）与 `overlayLiveFrame`（可丢增量）；`useConversationView` 变成双通道游标机（`transport: "frames" | "events"`，缺口整段重读，`waitForOutcome(activityId)` 在 frames 通道传 `turnId`）；`ConversationView` 用 `activeTurnId` / `activeMessageId` / `lastSeq` / `retryMessageId`；`turn-handoff` 折叠为完成来源消息并清空 `activeMessageId`。
  - Answer 在 P3 前保留 envelope shim：`applyAgentEvent`、`readConversationEvents`、`aggregateRevision`、`cancelConversationRun` 仍在，但只有 `useScreenshotAnswer` / `useReplyConversation` 显式传 `transport: "events"`；会话与面试路径禁止调用 `applyAgentEvent`。`run-state-changed` 只保留在 Answer shim，用于 retry / active / terminal 语义。
  - `apps/cli`：`SessionHostOptions` 收敛为 `onSessionFrame` / `onLiveFrame` / `onSnapshot` / `workspaceRoot`；`CodingSession` 用 `turnId` / `waitForTurn` / `cancelTurn` / `readFrames`；`TuiViewStore` durable 帧即时折叠、live 帧 16ms 批处理、缺口整段重读（注入 `TuiFrameReader`）、snapshot 到达清空未应用的 live 增量；`streamPresenter` 改为 `presentFrame` / `presentLive`。CLI 仍向宿主传 `emitEvent: () => {}`，这是 3b 才删的过渡占位，不是新的消费路径。
  - `packages/remote` / `apps/mobile`：controller 侧字段同步改为 `turnId`，远程命令与 `remoteCommandPort` 不再读 `runId`。
  - 证据：`packages/ui/test/conversationView.test.ts`（帧折叠、handoff、重放幂等、Answer shim 分离）、`useConversationView.test.tsx`（帧通道游标、缺口重读、清空归零、`waitForOutcome`）、`apps/cli/test/tui/app/viewStore.test.ts`（live 批量、durable 折叠、stale snapshot、缺口整段重读）、`apps/cli/test/presentation/streamPresenter.test.ts`（turn 终态 exit code）、`apps/agent/test/worker/host.test.ts`（`cancel-turn` 与 Answer `cancel-run` 分流）、`apps/desktop/test/conversationIpc.test.ts`（`cancelTurn` 载荷校验）。`pnpm verify` 全绿。
- **P2 第 3b 步（删写入面）已完成（2026-11-22）**：
  - agent：删除 `sessionEventProjector.ts` 与其测试；`SessionRuntimeJournal` 写入顺序变为 `journal → frames → transcript`；`SessionTranscriptBridge` 用 `envelope.sequence` 推进 `lastSeq`（`eventRevision` 不再由 projector 推导）；三个 application 删除 `executionStore` / `projector` / `readEventsAfter` / `resetExecution` 与 `applyLive` 投影调用；`AgentRuntime` 的 `executionStore` / `emitEvent` 改为可选并新增 `requireExecutionStore()`；`CodingHostOptions` 删除 `emitEvent` / `executionStore`；worker 协议删除 `interview-events` / `interview-intake-events`；`host.ts` 的 `read-events` 只路由 Answer；`composition.ts` 不再导出 `MemoryExecutionStore` / `ExecutionStore`。
  - 恢复：`SessionRecoveryCoordinator` 端口收敛为 `recoverFacts → journalLastSeq → seedLastSeq → restoreTranscript → resumeQueued → onRecovered`；恢复写回不再挂起 UI，收口事实作为新的 durable 帧广播（`turn-finished{status:"failed", reason:"interrupted"}`），transcript 映射为 `interrupted`。
  - shared：删除 `InterviewChannels.IntakeEvents`、`readInterviewIntakeEvents`、`remoteEventBatchSchema` / `RemoteEventBatch`、`remoteEventListSchema` / `RemoteEventList`；新增 `remoteFrameListSchema` / `RemoteFrameList`。remote 线协议删除 `event` / `events` 帧与 `read-events` 命令，改为 `session-frame` / `live-frame` 与 `read-frames` + `afterSeq`；`REMOTE_PROTOCOL_VERSION` 保持 `1`（理由见上文修订）。
  - desktop：删除 `interviewIpc` 的 `IntakeEvents` handler / removeHandler、`AgentService.readInterviewIntakeEvents`、preload 对应方法与 `eventsCommandFor`（`readEvents` 固定走 `read-events`）；remote host 的 `DesktopRemoteAgentPort` 与 `createDesktopRemoteCommandPort` 改为 `readFrames` / `onSessionFrame` / `onLiveFrame`，并按 `sessionId` 过滤可见会话。
  - CLI：删除 `emitEvent: () => {}` 过渡占位；`remote/host/commandPort.ts` 改为转发宿主帧并经 `readFramesAfter` 提供历史。
  - 证据：agent `111 files / 842 tests`、remote `9 / 48`、cli `60 / 393`、desktop `54 / 378`、ui `49 / 346` 全绿；`pnpm verify` 全绿。测试改写要点：coding 用 `frames` / `live` 替代 envelope（队列顺序、取消、`text-delta`），conversation 聊天测试改用 `runtime.waitForTurn`，`sessionRuntimeIntegration` 断言帧契约与 `seq` 单调，interview 恢复测试断言新增 `turn-finished` 帧，`worker/host` 的 step 顺序断言改用 `session-frame`。
- **P3 第 3c 步（Answer 切帧 + 换引擎）已完成（2026-11-22）**：
  - 决策：3c 是唯一改行为的一步，同时完成「Answer 迁移到内存 `SessionRuntime`」与「删除 Answer envelope 读取通道」，避免留下两套 UI 投影。3d 只做纯删除（`executeRun.ts`、`execution/`、`AgentEventEnvelope` / `AgentRunSnapshot` / `run-state-changed` / `eventRevision`）。
  - agent：`AnswerApplication` 改为 `SessionRuntime` + `SessionTurnExecutor` + `SessionStepExecutor` + `ProviderStepRunner`，自建 `MemorySessionJournal`，帧经进程级 `SessionFrameBus` 发布；`SessionRuntime.forget(sessionId)` 新增（dispose scheduler 并移出缓存），成功/取消轮在终态帧后 `forget + clear journal + clear transcript`，失败轮保留到 UI 关闭。并发拒绝用 `active` 同步占位（第一个 `await` 之前检查并写入），文案保持「当前回复尚未完成」。
  - 一次性语义：Answer 不读 transcript 历史、不落盘、不参与启动恢复；截图图片只存在于本轮 `turn-queued.input`，清空后随 journal 释放。
  - 契约：操作名 `answer.run` → `answer.send`，类型 `AnswerSendCommand`，返回 `{ turnId, snapshot }`；删除 `ReadEvents` / `Event` / `CancelAnswerRun` / `AnswerRunSendResult` 及相关 bridge 方法。
  - 路由修复：`conversationIpc` 的 `isAnswerConversationId` 同时识别 `ActiveExamConversationId` 与 `screenshot-` 前缀。此前每轮新截图会话由通用 `Create` 以 conversation scope 落盘，迁移后必须走 answer 领域，否则 journal 清空与帧路由都会错。
  - desktop：worker 帧删除 `event` 上行与 `onEvent` 监听；preload（含 answer-only preload）补 `readSessionFrames` / `onSessionFrame` / `onLiveFrame` / `cancelTurn`；`window.ts` 删除 `sendConversationEvent`。
  - UI：`useConversationView` 收敛为单帧通道（durable `seq` + live），`waitForOutcome` 只认 `turn-finished` 与 `TurnOutcome`；`conversationView` 删除 `applyAgentEvent` / `eventRevision` / `conversationOf`；`useConversationChat` 删除 transport 分支与 `cancelConversationRun`，取消目标改为本轮实际发送的会话 id（Answer 每轮新建 `screenshot-<uuid>`，hook 入参仍是固定答题会话）；`useReplyWorkflow` 在新轮发送前显式清理上一轮；`useInterviewIntake` 去掉不存在的 `superseded`。
  - 证据：agent `111 files / 842 tests`、ui `48 / 343`、desktop `54 / 378`、cli typecheck 全绿；Answer 用例覆盖并发拒绝、失败轮保留、取消轮释放、401/刷新重试与异步 store 竞争；相关包和目标文件定向测试通过，完整 `pnpm verify` 尚无一次全绿记录，待 CI 首次完整执行确认。
  - 行为差异（有意）：`reasoning-delta` 属 live-only，不能从 journal 重放；回复面板的思维链改由 live 帧驱动，重连后的快照只恢复正文与工具活动。
- **3d 纯删除旧引擎已落地，P4 已按结构约束收敛**；旧执行引擎、旧事件写入面和旧快照游标已从生产代码删除。剩余工作是迁移仍依赖旧 transcript API 的测试，并完成 CI 的全量门禁记录。

## 下一步执行方案（3d 纯删除与 P4 上锁）

3c 之后，旧引擎只剩「调用方已消失的代码」，但**不能一次性 `git rm`**：`AgentExecutor` 仍是 Answer / Interview / Conversation 三处 step 绑定的类型，删除必须自内向外、每步可编译。

### 3d-0 动手前复核的三个事实（本次盘点已确认）

1. `apps/agent/src/core/agent/streamJournal.ts` 只被 `executeRun.ts` 引用（`createExecutionJournal` 的唯一调用点）→ 随它一起删。
2. `AgentDefinition.result?(input, runId)` 的唯一调用点是 `apps/agent/src/conversation/stepBinding.ts:49`，实参已经是 `step.stepId` → 只需把形参改名，交接语义不变。
3. `ConversationStore.beginSessionAssistant` 仍由 `transcriptBridge.ts:114` 生产调用，但它内部经 `beginHandoffRun` 写活动槽位 → 删除 `beginHandoffRun` 时必须把这段内联进 `beginSessionAssistant`，不能直接删。

### 3d-1 删除 run 执行引擎（agent 内部，最大的一步）

| 文件 | 动作 |
| --- | --- |
| `apps/agent/src/core/agent/executeRun.ts` | 删除 |
| `apps/agent/src/core/agent/streamJournal.ts` | 删除 |
| `apps/agent/src/execution/`（`store.ts` / `memoryStore.ts` / `events.ts`） | 整目录删除 |
| `apps/agent/src/core/agent/runtime.ts` | 删 `executionStore` / `emitEvent` / `startRun` / `getRun` / `readEvents` / `readEventsForRun` / `getConversationRevision` / `resetConversation` / `requireExecutionStore`；保留 `registerAgent` 与 `prepare` |
| `apps/agent/src/core/agent/definition.ts` | 删 `AgentRunPrepared` / `AgentRunRequest` / `AgentRunHandle` 与 `AgentExecutor.startRun`；`AgentDefinition.result?(input, stepId)` 形参改名 |
| `apps/agent/src/core/context/usageAnchor.ts:56-68` | 删 `run-state-changed` 分支与注释，只认 `step-finished` + `turn-finished` |
| `apps/agent/src/host.ts` | 删 `executionStore` 参数与 `MemoryExecutionStore` 默认注入 |
| `apps/agent/test/execution/store.test.ts` | 删除 |

出口：`apps/agent` typecheck + 测试绿；源码 `executionStore` / `startRun(` 归零。

### 3d-2 删除 transcript 的 envelope 写入面与 `eventRevision`

| 文件 | 动作 |
| --- | --- |
| `core/transcript/store.ts` | 删 `applyAgentEvent`、`AgentEventEnvelope` import、`beginRun` / `beginEphemeralRun` / `beginReplyRun` / `beginOpeningRun` / `beginHandoffRun` / `finishRun`，以及全部 `eventRevision` 形参；`ConversationClearCursor.eventRevision` 删除 |
| `core/transcript/memoryStore.ts` | 同步删除上述实现与 `aggregateRevision` 折叠；`beginSessionAssistant` 内联原 `beginHandoffRun` 的槽位写入 |
| `core/transcript/persistence/sqlite/sqliteConversationStore.ts` | 删 `applyAgentEvent` override |
| `core/transcript/persistence/sessionRecord.ts`、`restore.ts` | 删 `eventRevision: true` omit 与 `eventRevision: 0` 初始化 |
| `apps/agent/src/coding/application.ts:199` | 不再读 `load(...).eventRevision`（该处只用于透传，删除后不影响编译） |

出口：`apps/`、`packages/` 源码 `eventRevision` 归零；transcript 测试的 revision 单调性断言**替换**为等价的 `lastSeq` 断言（字段退役，不是删断言）。

### 3d-3 删除 shared 旧词汇（最后一步，避免中途失去类型）

| 文件 | 动作 |
| --- | --- |
| `packages/shared/src/schema/events.ts` | 删 `agentExecutionEventSchema` / `agentEventSchema` / `agentEventEnvelopeSchema` / `AgentEventEnvelope` / `AgentExecutionEvent`，以及 `run-state-changed` 分支 |
| `packages/shared/src/schema/status.ts` | 删 `AgentRunSnapshot` / `AgentRunState` / `runOutcomeSchema`（`RunOutcome` 随 3d-1、3d-2 一起消失） |
| `packages/shared/src/schema/conversation.ts:69` | 删 `eventRevision` 字段与注释 |
| `packages/shared/src/index.ts`、`schema/index.ts` | 同步 `exports` |

出口：`AgentEventEnvelope` / `run-state-changed` / `eventRevision` 全仓源码归零。

### 3d 测试 fixture 清理（随 3d-1..3d-3 各自一并提交，不单开一笔）

`eventRevision: 0` 以快照字面量形式散布在 `packages/ui/test/support/floatingBarHarness.ts`、`apps/cli/test/**`、`apps/desktop/test/**`、`packages/remote/src/testing/*`；`apps/agent/test/**` 另有 envelope 构造（`modelMessages.test.ts`、`preparation.test.ts`、`transcript/store.test.ts`、`sqliteConversationMessages.test.ts`）与 `run-state-changed` 断言。处理口径：

- 快照字面量：直接删字段，不改断言。
- envelope 构造：换成 `SessionFrame` 或直接构造事件对象。
- `run-state-changed` 断言：改写成对应的 `turn-*` / `step-*` 事实断言。

### P4 上锁（在 3d 全绿之后单独一笔）

1. 保留有明确结构依据的架构守护：包 exports、依赖方向、宿主隔离和 UI 不依赖 Agent 内部实现。
2. 不按名称清单扫描代码。局部名称应准确描述行为，公共事件/帧类型由 schema 明确限定可表达的语义。
3. 通过类型检查和行为测试验证 durable 与 live 事件边界、Turn 生命周期折叠以及取消身份，不以命中字符串作为验收。
4. 出口：`pnpm architecture:check`、相关包 typecheck 与行为测试通过。

### 提交切分

| 顺序 | 提交信息（建议） | 门禁 |
| --- | --- | --- |
| 1 | `refactor(agent): 删除 run 执行引擎与 ExecutionStore` | agent 测试 + `pnpm verify` |
| 2 | `refactor(agent): 删除 transcript envelope 写入面与 eventRevision` | 同上 |
| 3 | `refactor(shared): 移除 run 事件词汇` | 同上 |
| 4 | `chore(architecture): 对齐会话帧架构约束` | 依赖方向与公开契约通过检查 |

风险：3d-2 是唯一可能触碰行为的步骤（活动槽位写入从 `beginHandoffRun` 内联），其余为纯删除；若 3d-2 出现 handoff 多消息回归，先回滚该笔，其余三笔独立有效。

## 曾考虑的替代方案

- **只把 `runId` 改名 `messageId`（原 A 路线）：** 改动机械、风险最低，但 `SessionEventProjector` 与 `run-state-changed` 原样保留，UI 仍然背着一份不用的存储契约。用户提出的"为什么必须有一个翻译层"不会被回答，半年后会以同样的问题重现。舍弃。
- **让 UI 直接消费现有 `AgentEventEnvelope`（保持现状）：** 这就是当前形态。它并非不可维护，但要求每个消费者忽略 12 种 `turn-*` / `step-*` / `compaction-*` 事件，且无法解释为什么 UI 需要知道 `compaction-aborted`。舍弃。
- **把折叠放到每个客户端各写一份（原 B 路线的实际后果）：** 桌面、CLI、移动端三份实现，handoff 与多消息归属要重复正确三遍。经核实折叠函数已经是共享模块，此代价不成立。舍弃。
- **让 wire 直接传 journal 行（`SessionEventEnvelope` 原样上线，不区分 live/durable）：** 看起来最省事，但 delta 无法重放，会迫使客户端在重连后显示空消息直到完整值到达；也无法表达"这条可以丢"。舍弃，采用 D1 的双通道。
- **保留 `run-state-changed` 作为唯一的 UI 生命周期事件，只改名字：** 等于让 agent 侧继续维护一份从 Turn/Step 推导的状态副本，与 `SessionProjection` 构成两个真相源。这正是本 Note 要消除的问题。舍弃。

## 验收标准

- 可观察结果：
  - 桌面与 CLI 的流式文本、工具卡片、handoff 多消息、排队、取消、自动压缩后的继续对话行为与改动前一致。
  - 断线重连后不出现空消息或重复消息；丢掉的 delta 由完整值事件补齐。
  - `packages/ui` 不再 import `apps/agent` 任何模块，`conversationView.ts` 不出现 `run`。
- 自动化验证：
  - 新增 `packages/shared/test/sessionFrame.test.ts`：frame 编解码、`seq` 连续性、live 事件不得进入 durable schema。
  - 新增 `packages/ui/test/conversationFold.test.ts`：D4 映射表逐项断言，含 handoff 与多消息归属。
  - 改造 `apps/agent/test/core/session/sessionRuntimeJournal.test.ts`：确认 bus 只收 frame、不分配 revision。
  - `pnpm architecture:check` 验证包依赖方向和宿主隔离；事件语义由类型契约和行为测试验证。
  - `pnpm verify` 全绿。
- 需要的实机验证：
  - 桌面：长会话自动压缩后继续、断网重连、取消活动 Turn 后立即发送下一条。
  - CLI：排队 Turn 原子启动、`/compact` 期间取消、进程重启后 queued Turn 续跑。
  - 远程：controller 接收 durable / live 帧，重连后按 `seq` 重读补齐；`read-frames` 边界（`afterSeq` 非负）被拒绝非法载荷。

## 风险

- **remote 在 v1 上原地换形状，版本号不再表达兼容性。** 前提是远程从未上线；若在此之后发布过任何 host / controller，就必须先升版本再改形状，否则旧客户端会收到无法解析的帧。这条约束必须在下次改远程协议前重新核对。
- **live 通道变"可丢"后，极端情况下文本会短暂停在旧内容再跳到完整值。** 这是有意接受的代价，换取的是取消 revision 连续不变量；若实测观感不可接受，补救方式是提高 delta 发送频率，而不是恢复无空洞要求。
- **Answer 在 P3 之前仍依赖 shim。** shim 期间必须显式标注为临时路径并在 P3 同一变更内删除；不得让 shim 成为长期第二引擎。
- **`compaction-*` 不进入折叠。** 压缩状态继续只走 `ConversationSnapshot`，因为压缩是会话级事实，没有 `messageId` 归属；若未来要显示压缩进度流，需单独提案，不得复用消息事件。
- **仅按类型名称判断职责容易失真。** 不设置全局禁词；逐项评估公开类型、函数和模块职责是否表达真实行为。
