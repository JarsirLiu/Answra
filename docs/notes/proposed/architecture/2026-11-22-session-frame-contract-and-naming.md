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

**禁词**（`pnpm architecture:check` 强制，`apps/agent/src/answer/` 的 P3 前 shim 除外）：`run`、`Run`、`execution`、`Execution`、`AgentEventEnvelope`、`aggregateRevision`。

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
- 远程协议 `REMOTE_PROTOCOL_VERSION` 从 `1` 升到 `2`（`packages/shared/src/schema/remote/capabilities.ts:4`）。旧 host 与旧 controller 握手时应明确拒绝，不做双命令兼容。

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
| P2 换协议（含原 P3） | `SessionFrame` / `LiveFrame` 走完 worker、desktop IPC、remote 与 CLI；`conversationView.ts` 折叠事实并按 `seq` 补齐；删除 `SessionEventProjector` 与 `run-state-changed`（Answer 走临时 shim）；`cancelTurn(turnId)`、`ConversationSendResult.turnId`、snapshot `activeTurnId` + `activeMessageId`；`REMOTE_PROTOCOL_VERSION` 升到 `2` | 桌面、CLI、远程的会话/handoff/压缩/重连/取消测试通过；全仓 `\brunId\b` 归零（Answer shim 除外）；v1 controller 连 v2 host 被明确拒绝 |
| P3 删旧引擎 | Answer 迁到 `SessionRuntime`（内存 journal、单 Turn）；删除 `executeRun.ts` 与 Answer shim | `run-state-changed` 全仓归零；Answer 截图答题回归通过 |
| P4 上锁 | `architecture:check` 增加禁词与 import 方向检查 | 故意引入 `runId` 时构建失败 |

原 P3（取消语义）并入 P2：只要事件载荷从 envelope 换成 frame，所有宿主就必须同时切换；若远程仍留在 v1，桌面 renderer 会同时收到两种形状，等于再引入一个翻译层。因此协议只切断一次、版本只升一次，`turnId` 与 snapshot 字段在同一变更内完成。

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

**第 3 步：切换协议（唯一破坏点）**

- 折叠：新增 `applySessionFrame` / `applyLiveFrame`，按 D4 映射逐项落实现；`useConversationView` 改用 `seq`，删除 `cursor + 1` 补洞（durable 缺口改为整段重读，live 直接丢）。
- 取消：`cancelTurn(turnId)` 贯穿 agent / worker / IPC / remote / CLI；`ConversationSendResult`、`waitQueueStart` 返回 `turnId`；snapshot 改为 `activeTurnId` + `activeMessageId`。
- 远程：`remoteEventBatch` 换成帧批量、`throughRevision` 换成 `throughSeq`，`REMOTE_PROTOCOL_VERSION` 升到 `2`，v1 hello 明确拒绝，不做双命令兼容。
- Answer 仍走 envelope：保留独立的 `applyAgentEvent` 与 envelope 订阅，标注为 P3 删除的临时路径，不与会话帧混用。
- 删除会话/面试/Coding 路径的 `SessionEventProjector` 与 `run-state-changed`；`aggregateRevision` 只留在 Answer shim。
- 出口：D4 映射逐项测试、幂等测试、重连/断线/取消/排队测试、v1→v2 拒绝测试；桌面与 CLI 实机验证。

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
- P2 第 2–4 步与 Answer 迁移未开始；线上仍走旧 `AgentEventEnvelope`。

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
  - `pnpm architecture:check` 的禁词规则自带反例测试（故意违规必须失败）。
  - `pnpm verify` 全绿。
- 需要的实机验证：
  - 桌面：长会话自动压缩后继续、断网重连、取消活动 Turn 后立即发送下一条。
  - CLI：排队 Turn 原子启动、`/compact` 期间取消、进程重启后 queued Turn 续跑。
  - 远程：v1 controller 连 v2 host 必须被明确拒绝，不得静默降级。

## 风险

- **P2 的协议版本升级对旧客户端是硬切断。** 移动端目前只有 Phase 0 骨架、没有会话 UI，因此现在升级的代价最低；若延后到移动端上线，则必须同时维护两套 controller。这是本提案建议尽早执行 P2 的主要理由。
- **live 通道变"可丢"后，极端情况下文本会短暂停在旧内容再跳到完整值。** 这是有意接受的代价，换取的是取消 revision 连续不变量；若实测观感不可接受，补救方式是提高 delta 发送频率，而不是恢复无空洞要求。
- **Answer 在 P3 之前仍依赖 shim。** shim 期间必须显式标注为临时路径并在 P3 同一变更内删除；不得让 shim 成为长期第二引擎。
- **`compaction-*` 不进入折叠。** 压缩状态继续只走 `ConversationSnapshot`，因为压缩是会话级事实，没有 `messageId` 归属；若未来要显示压缩进度流，需单独提案，不得复用消息事件。
- **禁词检查可能误伤历史命名。** 规则只作用于 `apps/` 与 `packages/` 的源码，`docs/` 与迁移期 shim 显式豁免，豁免清单必须在同一文件内可审计。
