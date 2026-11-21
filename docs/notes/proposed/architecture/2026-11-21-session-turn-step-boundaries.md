# Note：Session、Turn、Step 的职责边界

状态：提案

## 当前状态

- 本文是设计提案；阶段 0-4.5 的内存/端口版已落地，真实 provider StepRunner adapter 已提供，尚未接业务执行链。
- 已新增 `Turn/Step/Compaction` 事件、`SessionEventEnvelope`、`core/session` 的 contracts/eventFactory/journal/memoryJournal/projection/recovery/sessionRuntime，并补了目标测试。
- 已新增 SQLite v2 schema 与 `20261121120000_add_session_turns`：回填历史消息 `turn_id` 和 `session_turns`；尚未接新 runtime 写入。
- 已新增 `core/session/scheduler.ts`：每会话 FIFO、单活动 Turn、queued 取消、手动压缩排序、`resume` 与 `waitForIdle`；`SessionCompactor` 仍为端口，未接真实压缩实现。
- 已新增 `stepExecutor.ts` 与 `turnExecutor.ts`：StepExecutor 写 `step-*`/usage，TurnExecutor 只写 `turn-handoff` 并返回 `TurnFinish`。
- 已新增 `sessionStepRunner.ts` 与 `stepContextManager.ts`：StepRunner 使用真实 AI SDK/provider 流执行单次请求，ContextManager 委托 `ContextPreparation` 准备与恢复上下文。
- 已新增 `conversation/stepRunner.ts`：按 `StepStart.agentId` 解析 Conversation Bot、用 `StepStart.input`/`StepStart.handoff` 构建领域输入，并通过 `AgentExecutor.result` 解析同 Turn handoff；业务执行链尚未接入。
- 已新增 `sessionRuntime.ts`：按 session 创建 scheduler，提供 submit/cancel/compact/snapshot/events/recover/waitForIdle；snapshot 与 events 直接读 journal，不复制 turn/queue 状态。
- 已新增恢复写回：`recoverSession` 把未完成 Step、Turn、Compaction 收口为 failed/interrupted，重复调用不重复追加；`SessionRuntime.recover` 恢复后继续消费 queued Turn，并拒绝已启动 session 的启动恢复。
- `turn-finished` 与 `step-finished` 增加可选 `errorText`，失败不再只能靠自由文本或日志观察。
- 状态词汇只保留在 `packages/shared/src/schema/status.ts`：`StepOutcome` 复用 `TurnOutcome`；`CompactionProjection.state` 直接使用 `ContextCompactionState`，`compaction-finished` 投影为 `succeeded`，不再维护 `finished` 投影子集。
- 阶段 0-2 已提交；阶段 3-4.5 端口级实现与 StepRunner adapter 已通过目标测试，全量 `pnpm verify` 曾通过；当前工作区并行改动会影响全量门禁。
- 压缩会话后继续时，先读“执行交接”“持久化与迁移”和“模块边界”，再从第一个未完成阶段开始，不要直接改 `ConversationApplication` 或 `executeRun.ts`。

## 问题

当前代码把多个生命周期都压在 `run` 上，导致层与层之间没有单一职责：

- `run` 实际上是一次 Bot 的 assistant 回复段，但队列把它当成“一轮问答”使用。
- 多 Bot 交接时，一轮用户问答会产生多个 `run`，于是又引入了 `turn` 队列项来补边界。
- 上下文准备、usage 锚点、压缩和手动压缩锁都挂在 `run` 上：`executeRun.ts:60-72`、`usageAnchor.ts:42-61`，应用层还用 `activeRunCount` 拒绝手动压缩。
- TUI 的 `TuiRunPhase` 同时表示“模型在跑”和“正在压缩”，UI 状态与执行状态混用。
- `runId` 同时是执行 id 和 assistant 消息 id，transcript 的 `activeRunId` 又把它变成会话级门控。
- 队列用 `shouldYield` 在 step 边界结束当前 `run`，再用 `hasQueuedAhead` 结束交接链；一轮问答会被排队消息从中间切断。

用户可见的语义应该是：

```text
Session  会话
  └─ Turn  一轮问答
      └─ Step  一次模型调用
```

其中：

- 一轮问答 = 用户输入 + 最终回答；多 Bot 接管仍属于同一轮。
- 一次模型调用 = 一次 provider 请求；工具调用和工具结果属于该 step。
- AI SDK 本身没有 `session`、`turn`、`run`，只有 `streamText` 内的 step 循环、`prepareStep`、`stopWhen` 和 `StepResult`。`session`、`turn` 是宿主语义。

问题不是“概念不够多”，而是把 session、turn、response、step 都叫成了 run，最后既解释不了 handoff，也解释不了压缩应该在哪一层发生。底部运行时也不该再靠一堆 Promise 队列和 `activeRunCount` 拼出来。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/agent/definition.ts`：删除 `prepareContext` / `recoverContext` / `shouldYield`；执行契约只接收 step 请求和已准备好的模型请求。
  - `apps/agent/src/core/agent/runtime.ts`、`executeRun.ts`：由 `SessionRuntime` 取代 `AgentRuntime.startRun`；不再暴露 run 生命周期。
  - `apps/agent/src/core/queue/turnQueue.ts`、`turnQueueRegistry.ts`：Promise 队列升级为可投影、可恢复的 TurnScheduler。
  - `apps/agent/src/core/context/preparation.ts`、`usageAnchor.ts`、`usageState.ts`：上下文状态按 session 持有，按 step 准备和更新。
  - `apps/agent/src/core/transcript/contextState.ts`、`memoryStore.ts`：`activeRunId` 拆为 `activeTurnId` 与 assistant 消息 id。
  - `apps/agent/src/coding/application.ts`、`conversation/application.ts`、`interview/application.ts`：只提交 Turn、取消 Turn、请求压缩；不再自己拼 handoff 链、上下文准备和队列。
  - `apps/cli/src/tui/app/App.tsx`、`viewStore.ts`、`runController.ts`、`sessionRunQueue.ts`：turn 状态、step 活动、压缩操作分开投影。
- UI/进程/协议/持久化表面：
  - `AgentEventEnvelope` 的 `conversationId`、`runId`、`stepId` 等字段需要按 session/turn/step 重新命名；这会触及 worker 协议、desktop IPC、CLI 投影和持久化 session 记录。
  - 事件 schema 增加 turn 生命周期、step 归属、压缩操作生命周期；step 不再借用 run 状态。
  - 不新增 response/attempt 架构层；它们只作为执行实现细节，不进入 UI 或会话模型。
- 文档与门禁：
  - `AGENTS.md`：增加 Session/Turn/Step 术语表与修改入口。
  - `scripts/architecture/architecture-check.mjs`：增加层归属检查。
  - `.agents/skills/answra-code/SKILL.md`：增加“改哪一层”的快速判断。
  - 相关测试：turn 生命周期、step 上下文准备、事件归属、TUI 状态分离。
- 相关 Note：
  - [Codex 对齐的 token 驱动上下文压缩](../../implemented/architecture/2026-11-20-codex-aligned-token-driven-compaction.md)
  - [Agent 在 step 边界消费用户排队消息](../../implemented/architecture/2026-11-21-agent-step-boundary-queue.md)
  - [摘要压缩共享清理后的上下文视图](../../implemented/architecture/2026-11-21-compaction-shares-pruned-context-view.md)
  - [上下文压缩只保留摘要与当前用户回合](../../implemented/architecture/2026-11-17-context-compaction-user-turn-retention.md)
  - [会话上下文摘要压缩与旧上下文归档](./2026-11-13-conversation-context-compaction-and-archive.md)

## 提案

### 1. 只保留三层

```text
Session
  └─ Turn（一轮问答）
      └─ Step（一次模型调用）
```

- `run` 从架构词汇中删除，不再作为独立层。
- 当前 `run` 的终态并入 `turn`；执行层内部循环不再暴露第二套用户可见状态。
- 当前 `turn` 队列项就是 `turn` 实体，不再只是 Promise 队列位置。
- 多 Bot 接管在同一 turn 内继续执行，不新建 turn。
- assistant 消息是 transcript 实体，不是架构层；每个 Bot 回复对应一条 assistant 消息，step 挂在消息上。

### 2. 身份

- 用户 Turn 的 `turnId` 复用用户消息 id；排队时用户消息 id 已存在，不再另造 turn id。
- worker/external/system Turn 没有用户消息，由运行时生成 `turnId`，并携带 `origin`；不能伪装成用户消息 id。
- `messageId` 是新 assistant 消息 id，由 transcript 生成；不复用 turn id。历史 assistant 消息 id 即使等于旧 `runId` 也保留原值，不重写。
- `stepId` 是一次模型请求 id，仅在 turn 内唯一。
- 手动压缩使用 `operationId`，不是 turnId，也不是 stepId。

### 3. Session 拥有什么

Session 是持久化聚合，不是状态机：

- 拥有：消息历史、context state、checkpoint、compaction 结果、usage、turn 投影、队列投影。
- 不拥有：turn 执行、step 执行、模型重试。
- 唯一 writer：session store。
- 事件前缀：`session-*`；只描述会话级事实，不推断 turn 状态。

### 4. Turn 拥有什么

Turn 是一轮用户可见问答，也是唯一用户可见状态机：

```ts
type TurnStatus = "queued" | "running" | "completed" | "failed" | "aborted";
```

Turn 负责：

- 用户输入被接受、排队位置、开始执行。
- 多 Bot 接管的编排：handoff 仍在同一 turn 内。
- 取消、失败、最终完成。
- 用户可见状态和 UI 投影。

Turn 不负责：

- 模型请求和工具执行。
- 上下文准备、压缩、清理、usage、checkpoint。
- step 细节。
- 手动压缩。

`retry-wait`、`compacting`、`calling-model`、`running-tool` 不是 turn 状态；它们是 turn 内部的活动投影。turn 只有上面的生命周期。

### 5. Step 拥有什么

Step 是一次 provider 请求，加上这次请求产生的工具执行：

- 持有：本次请求的 system/messages/tools、工具结果、provider usage、finishReason。
- 负责：请求前通过 ContextManager 准备上下文；请求后记录 usage；工具调用和结果归属该 step。
- 不负责：turn 是否开始/结束、队列、用户消息、handoff、用户可见状态。
- 没有持久状态机；只有事件。

```text
step-started（turnId、messageId、agentId、modelId、index）
step-finished（usage、finishReason、outcome）
step-failed（error）
context-usage-changed
```

Step 的内部 provider 重试不新增 attempt 架构层，也不进入 turn 状态。

### 6. 底部运行时

底部运行时不是更多层，而是四个确定性机制：

```text
SessionRuntime
├─ SessionJournal      只追加事件，唯一真相
├─ SessionProjection   messages / turns / queue / context / usage
├─ TurnScheduler       每会话串行：队列、活动 turn、手动压缩
└─ TurnExecutor        一轮问答：handoff 链、step 循环、终态
```

其中：

- `SessionJournal`：append-only 事件日志；先落事件再更新投影。当前可先内存适配，但端口必须允许 SQLite。
- `SessionProjection`：从事件重建消息、turn、队列位置、压缩边界和 usage；UI 只读投影。
- `TurnScheduler`：同一 session 同一时刻最多一个活动 turn；队列 FIFO；手动压缩是独立操作。
- `TurnExecutor`：只负责一轮问答；内部调用 StepExecutor 和 ContextManager，不直接操作队列。
- `StepExecutor`：一次模型请求 + 工具执行；不读写 transcript，不改变 turn 状态。
- `ContextManager`：session 级上下文状态 + step 前准备；自动/手动压缩都由它执行。
- `ToolRuntime`：继续作为工具执行底层；工具结果写 step 事件，不决定 turn 状态。

这些是运行时组件，不是用户可见的第四层概念。用户和 UI 只看到 Session、Turn、Step。

### 7. 事件是唯一真相

统一 envelope 字段：

```text
sessionId
turnId?
messageId?
stepId?
operationId?
sequence
event
```

最小事件集：

```text
turn-queued          用户消息被接纳；payload 含消息内容
turn-started         活动 turn 开始
turn-finished        completed / failed / aborted + reason
turn-handoff         同一 turn 内切换 Bot
step-started         assistantMessageId + agentId + modelId + index
step-finished        usage + finishReason
step-failed          error
compaction-started   operationId + reason(auto/manual)
compaction-finished  summary + checkpoint + usage
compaction-failed    error
tool-*               继续由现有工具事件承载
```

归属规则：

| 组件 | 可写事件 | 禁止 |
| --- | --- | --- |
| SessionJournal | 所有事件的追加 | 不推导业务状态 |
| TurnScheduler | `turn-queued`、`turn-started`、`turn-finished` | 不写 step 事件 |
| TurnExecutor | `turn-handoff` | 不写压缩细节 |
| StepExecutor | `step-*`、`context-usage-changed`、`tool-*` | 不写 turn 终态 |
| ContextManager | `compaction-*` | 不写 turn 状态 |

硬规则：

- 只有 TurnScheduler / TurnExecutor 能改 turn 状态。
- `step-finished` 只能更新 session 的 context/usage，不能改 turn 状态。
- turn 完成只能由“最后一个 Bot 回复完成且无 handoff”触发，不能由单个 step 完成触发。
- 事件按 aggregate 顺序追加；投影是纯函数，重放必须幂等。
- 崩溃恢复以 journal 为准，不以内存队列为准。

### 8. 自动压缩

自动压缩是 Step 的准备阶段，不是 turn 开始/结束：

1. StepExecutor 向 ContextManager 请求 `prepare(turn, step)`。
2. ContextManager 根据 transcript + context state 组装候选请求，并估算 token。
3. 超过 `contextWindow - max(output, buffer)` 时，执行一次 `compaction-started`。
4. 压缩成功：写 `compaction-finished`，更新 checkpoint，重建候选请求。
5. 压缩失败或仍超限：step 在发 provider 前以 `context-exhausted` fail-closed，不发送超限请求。
6. provider 仍返回 overflow 且没有 assistant 输出 / 工具执行时，允许一次 recovery compaction，然后重试一次；第二次 overflow 直接失败。
7. 每次 `step-finished` 用 provider usage 校准锚点；压缩自身 usage 单独记录，不混入 turn 回答。

自动压缩可以发生在长工具循环中间。它不创建 turn，不创建 assistant 消息，不改变 turn 状态。

### 9. 手动压缩

手动压缩是 Session 维护操作，不是 turn，也不是 step：

- 不创建 turn，不写用户消息，不产生 assistant 消息。
- 由 TurnScheduler 串行：活动 turn 结束后、下一个 queued turn 开始前执行。
- 如果用户希望立即压缩，先取消当前 turn；不能用“有活动 turn”直接拒绝。
- 使用 `operationId`，写 `compaction-started` / `compaction-finished` / `compaction-failed`。
- 支持 instructions、取消和结构化结果；失败不得破坏上一个有效 checkpoint。
- 手动压缩失败不阻塞后续 queued turn；返回失败并继续调度。

如果把手动压缩建模成 turn，会让“turn = 一轮问答”失效，并再次制造假状态。这个提案不这样做。

### 10. 多 Bot 接管

- `TurnSource` 不包含 `handoff`；handoff 是同一 turn 内的事件，不是新 turn 的来源。
- 一个 turn 内可以有多次模型调用、多个 assistant 消息。
- 每个 Bot 的回复是新的 assistant 消息；step 记录实际 `agentId` 和 `modelId`。
- handoff 写 `turn-handoff`，不创建新 turn；TurnExecutor 继续同一 turn 的 step 循环。
- turn 完成条件是：最后一个 assistant 消息完成，且没有待执行的 handoff。
- handoff 必须校验参与者、目标和最大深度/循环；失败将 turn 置为 `failed`，不能静默忽略。
- 队列消息在 handoff 期间不插入；当前 turn 完整结束后才启动下一个 turn。

### 11. 用户消息排队

- `turn-queued` 在用户提交时立即落 journal；排队消息内容和位置可重放。
- TurnScheduler 按 FIFO 消费：当前 turn 完成后启动下一个 turn。
- 不再把 `shouldYield` 放进 step stop condition；`hasQueuedAhead` 不再用于切断 handoff 链。
- 取消活动 turn 只终止当前 turn；是否同时取消 queued turn 由显式参数决定。
- queued turn 的取消写 `turn-finished: aborted/cancelled` 并从队列移除；queued turn 不允许 `completed`/`failed` 终态。
- 进程重启后，queued turn 保留并可重新调度；已开始的 turn 不自动重试，避免重复工具副作用。

如果未来需要“中途插入用户消息”，必须单独提案并改造消息交错模型；不能靠 step 让位偷偷实现。

### 12. 取消、重试与恢复

- 取消：abort 当前 step / tool / compaction；写 `turn-finished: aborted`；晚到事件按 generation 丢弃。
- 重试：provider 重试留在 StepExecutor 内，只产生活动投影，不改变 turn 状态。
- 恢复：启动时重放 journal；有 `turn-started` 无 `turn-finished` 的 turn 标记为 `failed`，reason=`interrupted`；running tool 标记失败；有 `compaction-started` 无终态的压缩标记失败。
- 恢复不自动重试已开始 turn；queued turn 可以继续。恢复结果必须可观察，不能静默清理。

### 13. 迁移顺序

1. 先统一术语：文档、AGENTS、代码注释明确 Session/Turn/Step；冻结新增 `run` 语义。
2. 建立 `SessionJournal` / `SessionProjection` 端口，先接内存实现，再考虑 SQLite。
3. 持久化 v2：给消息补 `turn_id`，新增 `session_turns`，一次性回填旧会话；消息 id 和消息正文不改写。
4. 事件 envelope 增加 `turnId`、`messageId`、`operationId`；确定 `runId` 的迁移/删除方案。
5. transcript 把 `activeRunId` 拆为 `activeTurnId` 与 assistant 消息 id。
6. `TurnQueue` 升级为 TurnScheduler；去掉 `shouldYield` / `hasQueuedAhead` 的切 turn 逻辑。
7. 把 `ConversationApplication.continueTeamTurn` 收编为 TurnExecutor 的 handoff 链。
8. StepExecutor 改为一次 provider 请求一个 step；上下文准备从 `AgentRunRequest` 移到 ContextManager。
9. 自动/手动压缩统一走 `compaction-*` 事件；移除 `activeRunCount` 手动压缩锁。
10. TUI 拆分 turn 状态、step 活动、压缩操作。
11. 更新架构检查、测试和旧 Note 的后续变更指向。

### 14. 明确不做

- 不新增 response/attempt 架构层。
- 不把 run 保留为第四种用户可见状态。
- 不让 turn 持有压缩、usage 或模型请求。
- 不让 step 修改 turn 状态。
- 不把手动压缩伪装成 turn。
- 不在当前 turn 中途用 step 让位启动下一条用户消息。
- 不引入后台异步压缩。
- 不改变 216k/172k/16k 预算、清理水印和摘要内容策略。

### 15. 执行交接（压缩会话后继续用）

#### 15.1 不变式

1. 唯一真相是 `SessionJournal`；turn、queue、context、usage 都是投影。
2. 同一 session 同一时刻最多一个活动 turn；手动压缩是独立串行操作。
3. turn 状态只由 TurnScheduler / TurnExecutor 写；step 事件不能改 turn。
4. 每个 provider 请求前必须经过 ContextManager；没有绕过路径。
5. 自动压缩失败必须 fail-closed；provider overflow 只允许一次恢复。
6. 多 Bot handoff 不新开 turn；队列在 turn 完成后消费。
7. 取消或恢复后必须写终态；已开始的 turn 不自动重试。

#### 15.2 阶段表

| 阶段 | 状态 | 交付 | 退出条件 |
| --- | --- | --- | --- |
| 0 术语与契约 | 已完成（内存版） | 统一 Session/Turn/Step；新增事件/类型/接口；目标测试通过 | 类型编译通过；不接业务 |
| 1 Journal 与投影 | 已完成（内存版） | `SessionJournal`、`SessionProjection`、重放与幂等测试 | 同一事件流重建一致；崩溃重放不重复 |
| 1b 持久化 v2 | 已完成（schema/回填） | `session_turns`、消息 `turn_id`、旧会话回填、v1 fixture | 旧会话回填正确；消息 id/正文不变 |
| 2 Scheduler 与队列 | 已完成（内存版） | `TurnScheduler` 每会话串行、FIFO、取消、queued 投影、手动压缩排序、`resume` | 活动 turn 不被排队消息切断；queued 可取消；测试通过 |
| 3 Turn 与 handoff | 已完成（端口级） | `SessionTurnExecutor`、同 Turn handoff、终态结果与 `errorText`；按 Bot 分配 assistant `messageId`，handoff envelope 记录来源消息；`StepStart.handoff` 把来源与任务传给目标 Bot 的每个 step | 多 Bot 同一 turn；队列不插入 handoff；每个 Bot 一条 assistant 消息 |
| 4 Step 执行 | 已完成（端口级 + provider adapter + Conversation 绑定） | `SessionStepExecutor`、`StepRunner` 端口、`SessionStepRunner` 真实 provider 流、`StepContextManager` adapter、`StepRunContext.events` 模型流 sink、step 事件/usage；`conversation/stepRunner.ts` 按 agentId 绑定 Bot 输入与 handoff；业务执行链待接 | 每个 step 有 agent/model/usage；不改 turn；交接输入进入目标 step |
| 4.5 SessionRuntime 与恢复 | 已完成（内存版） | `SessionRuntime` 门面、恢复写回、queued 继续、facade 测试 | 恢复只写一次；启动后拒绝 recover；不接业务 |
| 5 自动压缩 | 未开始 | ContextManager step 前准备；超限 fail-closed；overflow 一次恢复 | 长工具循环每 step 都准备；353k 不再发出 |
| 6 手动压缩 | 未开始 | Scheduler 维护操作；operation 事件；取消/失败结果 | 不创建 turn；活动 turn 后执行；失败不坏 checkpoint |
| 7 UI/协议 | 未开始 | envelope、worker、desktop IPC、CLI 投影 | turn/step/压缩/队列分别显示；旧字段删除 |
| 8 恢复与门禁 | 部分完成 | 启动恢复写回已完成；跨领域恢复、架构检查、CLI/desktop 恢复接入与门禁待做 | 恢复测试通过；`pnpm verify` 通过 |

#### 15.3 契约草案

```ts
interface SessionRuntime {
  submit(submission: TurnSubmission): Promise<TurnSubmissionResult>;
  cancel(sessionId: SessionId, turnId: TurnId, options?: CancelTurnOptions): Promise<void>;
  compact(sessionId: SessionId, request?: ManualCompactionRequest): Promise<ManualCompactionResult>;
  snapshot(sessionId: SessionId): Promise<SessionProjection>;
  events(sessionId: SessionId, after?: number): Promise<SessionEventEnvelope[]>;
  recover(sessionId: SessionId): Promise<SessionRecoveryPlan>;
  waitForIdle(sessionId: SessionId): Promise<void>;
}

interface TurnScheduler {
  submit(sessionId: string, input: UserInput): Promise<{ turnId: string; position: number }>;
  cancel(sessionId: string, turnId: string, options?: { cancelQueued?: boolean }): Promise<void>;
  requestCompaction(sessionId: string, options: ManualCompactionOptions): Promise<ManualCompactionResult>;
  resume(sessionId: string): Promise<void>;
}

interface TurnExecutor {
  run(turn: TurnStart, signal: AbortSignal): Promise<TurnFinish>;
}

interface StepExecutor {
  run(step: StepStart, signal: AbortSignal): Promise<StepResult>;
}

interface ContextManager {
  prepare(input: StepContextInput): Promise<AgentModelRequest>;
  recordStepUsage(input: StepUsageInput): Promise<void>;
  compactNow(input: ManualCompactionInput): Promise<ManualCompactionResult>;
}

interface SessionJournal {
  append(
    sessionId: SessionId,
    event: AgentEvent,
    metadata?: SessionJournalAppend,
  ): Promise<SessionEventEnvelope>;
  readAfter(sessionId: SessionId, sequence: number): Promise<SessionEventEnvelope[]>;
}
```

`SessionRuntime` 只按 session 创建 Scheduler；`snapshot`/`events` 直接读 journal，`recover` 在 Scheduler 创建前写回未完成事实，随后 `resume` 消费 queued Turn。已启动 session 不允许再执行启动恢复。

`TurnSubmission` 由 Scheduler 接收，只含 `sessionId/source/agentId/input?`，没有 `turnId`；Scheduler 分配后生成带 `turnId` 的 `TurnStart` 交给 `TurnExecutor`。`TurnExecutor.run` 只返回 `TurnFinish`，终态事件由 Scheduler 写入，避免双 writer。`SessionCompactor` 只执行手动压缩；事件和 checkpoint 由其实现写，Scheduler 只负责“活动 Turn 后、下一条 queued 前”的排序。

`TurnStart` 至少包含 `sessionId/turnId/source/agentId/input?`，`TurnProjection` 额外包含 `status/activeAgentId/assistantMessageIds/handoffCount/finishReason/errorText/createdAt/startedAt/finishedAt`。`StepStart` 至少包含 `sessionId/turnId/messageId/stepId/agentId/modelId/index`。

`SessionTurnExecutor` 只消费 `StepExecutor`：`tool-calls` 继续下一 step，handoff 写 `turn-handoff` 后同 Turn 切换 `agentId`，其余终态返回给 Scheduler。`SessionStepExecutor` 通过 `StepRunner` 端口执行真实请求；runner 异常转成 `step-finished: failed` 的 `errorText`，不自行写 `turn-finished`。

#### 15.4 必须锁住的测试

- Scheduler：FIFO、活动 turn 不被打断、取消活动 turn 与取消 queued turn 分开。
- Turn：completed/failed/aborted；handoff 不新开 turn；handoff 失败与最大 step 数传播；不写 `turn-finished`。
- Step：每个 provider 请求独立 step；agent/model/usage 归属正确；step 不改 turn；异常写 `step-finished.errorText`，已取消不启动 provider。
- 自动压缩：每个 step 前超限都压缩；压缩失败不请求 provider；overflow 只恢复一次。
- 手动压缩：不创建 turn；活动 turn 后执行；失败保留旧 checkpoint；可取消。
- 恢复：turn-started 无终态、running tool、compaction-started 无终态；写回后重复恢复不再追加；queued Turn 仍可继续。
- 事件：重放幂等；`step-*` 不改 turn；`turn-*` 不携带 provider usage。
- 架构：`core/context` 不读 turn/queue；`core/queue` 不 import model/context；`core/agent` 不写 transcript context state。

#### 15.5 验证命令

```text
pnpm --filter @answra/agent test
pnpm architecture:check
pnpm notes:check
pnpm verify
```

本轮阶段 2-4.5 验证：`pnpm --filter @answra/agent test` 通过 778 个测试；其中 Session/StepRunner 目标集 63 个测试；`pnpm --filter @answra/shared test -- test/schema.test.ts` 通过 21 个测试；`pnpm exec biome check` 目标文件通过；`pnpm --filter @answra/agent typecheck` 通过。

#### 15.6 实现时禁止

- 不新增 response/attempt 层，不恢复 `run` 语义。
- 不把 `shouldYield` 或 `hasQueuedAhead` 留在执行路径。
- 不用 `activeRunCount` 阻塞手动压缩。
- 不在领域 application 里复制 handoff 链、队列或压缩判断。
- 不在 step 事件里改 turn 状态。
- 不同时维护两套事件 schema 或两套 turn 状态。
- 不把自动压缩做成后台异步任务；它必须在 step 前完成并提交 checkpoint。

#### 15.7 未决问题与默认决定

- **是否支持中途 steer。** 默认不支持；只支持 turn 后 FIFO。若产品需要 steer，另立提案。
- **活动 turn 期间手动压缩。** 默认排到当前 turn 结束后、下一个 queued turn 前执行；不直接拒绝。
- **崩溃时已开始 turn。** 默认标记 `failed`，reason=`interrupted`；不自动重试。
- **Journal 持久化。** conversation/coding/interview 使用持久实现；answer-only 可保持内存且不恢复。
- **事件 schema 迁移。** 默认一次性迁移，不做长期双轨；旧 run 事件只读。
- **turnId 来源。** 默认复用用户消息 id；排队输入必须在入队时已有消息 id。

### 16. 未来多会话与多 Agent 扩展

结论：当前提案能承载“单会话内的 Turn/Step”，但**不能自然长成多会话派发、搜索和跨会话提问**。需要补的是会话编排能力，不是再加一层 Turn/Step。子会话仍然是普通 Session，拥有自己的 Turn、Step、队列、上下文和压缩。

#### 16.1 Handoff 与 Delegation 必须分开

| 能力 | 边界 | 是否新会话 | 是否共享 transcript | 执行方式 |
| --- | --- | --- | --- | --- |
| Handoff | 同一 Session、同一 Turn | 否 | 是 | 顺序切换 Bot |
| Delegation | 新 Session | 是 | 否 | 并行/独立 worker |

`turn-handoff` 只表达顺序接管；不能拿它承载并行 worker。并行 worker 用 `SessionSupervisor.spawn()` 创建子会话，父会话只持有 `WorkerHandle`。

#### 16.2 Session 元数据扩展

未来 `Session` 需要增加，且现在就应避免字段名冲突：

```ts
interface Session {
  parentSessionId?: string;
  rootSessionId?: string;
  createdBy?: { sessionId: string; turnId: string; agentId: string };
  kind: "root" | "worker" | "shared";
  visibility: "private" | "team" | "workspace";
  tags?: string[];
  capabilities?: string[];
  resourceLimits?: { maxTurns?: number; maxTokens?: number; deadlineMs?: number };
}
```

- 子会话必须有 `parentSessionId` / `rootSessionId`，用于取消链、用量聚合和 UI 树。
- `createdBy` 记录是谁派的，不靠模型传任意 session id。
- `visibility` 是搜索和跨会话提问的授权基础；默认 `private`，不默认全库可搜。

#### 16.3 运行时新增组件（不是新层）

```text
SessionSupervisor   全局并发、父子会话、配额、取消树、WorkerGroup
SessionRegistry     可搜索会话索引、摘要、可见性过滤、异步 ask 路由
WorkerHandle        子会话句柄：状态、结果、取消
WorkerGroup         一组 worker 的聚合条件与结果投递
```

- `SessionSupervisor.spawn(parent, spec)`：创建子 Session 并投递初始 Turn；**只做 durable admission，立即返回 `WorkerHandle`，不等模型执行**。
- `SessionSupervisor.createGroup(handles, { mode: "all" | "any" | "manual", timeoutMs })`：只登记完成条件，不阻塞父 Turn。
- 子会话进入终态后，Supervisor 把结果写入父 Session 的 inbox；父 Session 空闲时启动一个新的 `source: "worker"` Turn，忙碌时排队。
- `cancelTree(sessionId)`：父取消级联到子；是否允许 detached 子会话由策略决定。
- `SessionRegistry.search(query, viewer)`：只返回有权限的会话摘要、标签、最近状态；不返回原始 transcript。
- `SessionRegistry.ask(targetSessionId, question, origin)`：向目标会话投递带来源的 Turn，**立即返回 request handle**；目标回答完成后同样投递到请求方 inbox。
- 这些都是内部组件；用户仍只看到 Session/Turn/Step。

#### 16.4 子会话结果与跨会话消息

- 子会话的最终结果默认只返回：`status`、最终 assistant 文本、usage、错误摘要；不复制完整 transcript。
- 父会话拿到的是 `WorkerResult`，不是子会话的 Step 事件流。
- 子会话完成不是父 Turn 的事件，也不能注入父 Turn 的 step；它是父 Session 的新输入：

```ts
interface WorkerTurnInput {
  source: "worker";
  origin: { sessionId: string; turnId: string; agentId: string };
  groupId?: string;
  replyTo?: string;
  result: WorkerResult;
}
```

- 跨会话提问使用同一个 inbox 机制，`source` 为 `"external"`，带 `origin` 和 `replyTo`。
- 父 Session 的 Scheduler 在 turn 边界消费这些输入；父 Turn 如果还在运行，结果排队等待，不能中途插入。
- 目标会话把外部问题当作受策略约束的 user turn；是否接受、是否展示给用户、是否允许反问，由目标会话的 Bot 策略决定。
- 外部问题不能绕过目标会话的权限、可见性和队列；目标忙时排队，不能插队到活动 Turn 中间。

#### 16.5 异步 worker 是唯一形态

- `delegate` 工具只负责 `spawn` 和创建 group，返回 handle/groupId 后立即结束；**父 step 不等待子会话执行**。
- 父 Turn 可以继续做别的事，也可以正常结束。父 Session 空闲时，worker 结果到达会启动一个新的 `source: "worker"` Turn；不会占住父 Session。
- 父 Turn 如果仍在运行，子结果进入 inbox 等待；不阻塞 provider stream，不插入当前 Turn。
- “等待结果”不是同步 `wait()`，而是 `WorkerGroup` 完成条件：`all` 等全部终态、`any` 等第一个终态、`manual` 每个结果单独投递。条件满足后由 Supervisor 投递一次聚合结果。
- `any` 默认取消其余 worker；`timeout` 产生超时结果并取消未完成 worker；是否 detach 由策略决定。
- 不把父 Turn 保持在 `running` 来等 worker，也不把 provider 请求挂在一个长时间工具上。父 Turn 结束就是结束，worker 结果通过新 Turn 回到会话。
- 如果产品需要“同一个 Turn 内暂停再恢复”，那是另一个 suspend/resume 机制，不能和这里的异步 worker 混为一谈。

#### 16.6 必须补的约束

- 并发上限：每 Turn 最大子会话数、每 Session 最大活跃子会话、全局最大活跃 worker。
- 深度/环：父子深度上限；禁止父等子、子又等父的等待环；`ask` 也要检测环路。
- 取消树：取消父是否级联子，必须显式；不能留下孤儿 worker。
- 权限：子会话只能继承父权限的子集；不能通过 spawn 提权；工作区、工具、网络权限都要显式。
- 配额：token、费用、墙钟、工具调用次数按树聚合；超限 fail-closed。
- 搜索 ACL：可见性、团队、租户、工作区多层过滤；搜索结果不泄露 transcript 正文。
- 结果投递：父 Turn 已结束时子结果默认写入父 inbox；父 Session 空闲则自动启动 `source: "worker"` Turn，忙碌则排队。是否自动启动必须可配置。
- 持久化：父子链接、WorkerGroup、父 inbox 必须 durable；重启后 queued worker 可恢复，已开始 worker 不自动重试。
- 观测：父子树、worker 状态、等待原因、取消链、用量汇总必须可投影。

#### 16.7 当前提案已经支持的部分

- 子会话可以直接复用 `SessionJournal`、`TurnScheduler`、`TurnExecutor`、`StepExecutor`、`ContextManager`。
- 每个子会话有自己的 Turn/Step/队列/压缩，不会污染父会话上下文。
- `turnId`、`messageId`、`stepId` 的归属规则可原样用于子会话。
- `turn-finished` 可作为 worker 完成的 durable 事实；`SessionSupervisor` 只做编排，不复制 Turn 语义。
- 自动/手动压缩对子会话同样按 step 边界执行，不需要父会话参与。

#### 16.8 未来验收

- 父 Turn spawn 3 个 worker 后立即结束；父 Session 变 idle，不被 worker 占住。
- 3 个 worker 并行运行；`all` 条件满足后，父 Session 收到一次聚合结果并启动 `source: "worker"` Turn。
- 父 Turn 结束后、worker 完成前，用户可以继续发消息；用户 Turn 与 worker 结果按 turn 边界排队，不互相插入。
- 父 Turn 仍在运行时 worker 完成：结果进入 inbox，不注入当前 Turn，不阻塞 provider stream。
- 一个 worker 失败时，`all` 聚合结果包含失败摘要；父 Turn 按策略继续或失败。
- `any` 收到第一个终态后取消其余 worker；`timeout` 产生超时结果并取消未完成 worker。
- 子会话 busy 时，跨会话 `ask` 立即返回 request handle，不阻塞请求方；回答完成后进入请求方 inbox。
- `SessionRegistry.search` 只返回有权限的摘要；无权会话不可见，搜索结果不含消息正文。
- 两个会话互相 `ask` 被环检测拒绝；超过深度/并发配额 fail-closed。
- 每个子会话独立压缩；父子 token/费用汇总正确。
- 重启后 queued worker 可恢复，已开始 worker 标记 interrupted，不自动重试；父 inbox 的结果不丢。

#### 16.9 明确不在当前阶段

- 不做同步 `delegate/wait`，不把父 Turn 或 provider stream 挂在 worker 上。
- 不做同一个 Turn 内的 suspend/resume；父 Turn 结束，worker 结果通过新 Turn 回来。
- 不做开放 agent 市场或全库自动发现；搜索必须有 ACL。
- 不做无限后台 worker 或无限 fan-out。
- 不允许模型传任意 session id 或跨租户访问。
- 不把 worker 结果伪装成父会话的同 Turn assistant 消息。

### 17. 持久化与迁移

目标：旧会话只迁移一次，之后新功能不再反复兼容旧消息。

#### 17.1 `runId` 的最终处理

- `run` 从新架构词汇中退役；新代码只使用 `turnId`、`messageId`、`stepId`。
- 旧 `runId` 的实际值等于旧 assistant 消息 id，迁移后保留为 `messageId`，不改写。
- 旧 `runId` 不能整体改名为 `turnId`：一轮用户问答可能包含多个旧 run（handoff），改名会拆出假 turn。
- 用户 Turn 的 `turnId` 复用用户消息 id；无用户消息的 opening/reply/worker Turn 由运行时生成确定性的 `turnId`。
- 旧事件不迁移。当前 execution store 是进程内内存实现，没有持久事件表；历史事件本来不跨重启。
- 持久 `state_json` 本来就不保存 `activeRunId`；迁移不重写它。旧活动 run 在进程重启时已失效，新 runtime 不继承。

#### 17.2 v2 表结构

`session_messages` 保持 append-only；`message_id` 和 `message_json` 原值不变。新增 `turn_id` 归属列和 `session_turns`：

```sql
ALTER TABLE session_messages ADD COLUMN turn_id TEXT;

CREATE INDEX session_messages_turn
ON session_messages(conversation_id, turn_id, seq);

CREATE TABLE session_turns (
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,          -- user/reply/opening/worker/external
  status TEXT NOT NULL,          -- queued/running/completed/failed/aborted
  finish_reason TEXT,
  entry_agent_id TEXT,
  active_agent_id TEXT,
  input_message_id TEXT,
  origin_session_id TEXT,        -- 为未来 worker turn 预留
  origin_turn_id TEXT,
  origin_agent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, turn_id),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
```

- `turn_id` 回填后历史行都有值；新写入要等 transcript store 接入 TurnExecutor 的 `turnId` 后强制非空。当前 v2 迁移只回填历史行。
- `session_turns.status` 是最后一次已知投影，不是第二套执行真相；运行中由 journal 投影更新，启动时未收口状态按恢复规则处理。
- `session_turns` 不保存 prompt、step 事件流或完整消息；消息正文仍在 `session_messages.message_json`。
- 不把 `turnId` 写进 `ConversationMessage` JSON，避免消息契约和 turn 归属两处漂移；读取时由持久化列或 `SessionSnapshot` 投影附带。
- `session_message_drafts` 不改，仍按 `message_id` 关联。

#### 17.3 旧会话回填

按 `seq` 扫描每个会话：

1. `role=user` 消息开启新 turn，`turn_id = message_id`，source=`user`。
2. 后续 assistant/handoff 消息归入当前 turn；handoff 不新开 turn。
3. 第一条消息就是 assistant 时，创建 synthetic turn，例如 `opening:${firstMessageId}`，source=`opening`。
4. 连续 user 消息各自开启新 turn。
5. assistant 状态 `streaming`/`interrupted` 的历史 turn 标为 `aborted`，finishReason=`interrupted`。
6. assistant 状态 `failed` 的历史 turn 标为 `failed`；全部 complete 标为 `completed`。
7. 持久 `state_json` 不含 `activeRunId`，不重写；`activeAgentId` 保留。
8. 旧排队请求没有持久消息，无需迁移；新 runtime 可以选择在提交时持久化 queued turn。

迁移必须由 `_migrations` 账本保护，可重复执行且结果一致。

#### 17.4 兼容边界

- 只保留一次性迁移器，不保留长期“有 turn_id 走新逻辑、没有走旧逻辑”的双读分支。
- 消息正文仍只从 `session_messages` 读取；`turn_id`/`session_turns` 由后续 session 投影使用，不另建消息副本；旧 `runId` 不新增 `legacyRunId` 列。
- 新 `SessionEventEnvelope` 不同时写 `runId` 和 `turnId`；旧 `AgentEventEnvelope` 只服务未迁移执行链。
- worker/desktop/CLI 的 `cancel(runId)` 在统一切换时改为 `cancel(sessionId, turnId)`；remote 协议 bump 版本，不做长期双命令。
- UI 只读一个 turn 投影，不同时维护 run 和 turn 两套状态。

#### 17.5 迁移测试

- 单轮：user + assistant，turnId=user message id，message id 不变。
- handoff：user + assistant A + handoff + assistant B，同一 turn、三个消息归属。
- opening：仅 assistant，synthetic turnId 稳定。
- interrupted：streaming assistant 迁移为 aborted，不自动重试。
- draft：旧 draft 仍按 message id 可读。
- 幂等：重复迁移不新增 turn、不改消息。
- 新写入：未带 turnId 的消息写入 fail-closed。

## 与现有决定的关系

- 本提案修正 [Agent 在 step 边界消费用户排队消息](../../implemented/architecture/2026-11-21-agent-step-boundary-queue.md)：排队从 step 边界改到 turn 边界，`shouldYield` 不再属于 step。
- 用户排队消息与 Bot 交接的交互细则见 [用户排队消息与 Bot 交接的 Turn 边界规则](./2026-11-21-turn-boundary-queue-and-handoff.md)。
- 本提案延续 [Codex 对齐的 token 驱动上下文压缩](../../implemented/architecture/2026-11-20-codex-aligned-token-driven-compaction.md) 的“每次模型请求前准备”意图，并把它落实到 step。
- 本提案替代此前“保留 run 作为执行层”的表述；`run` 不再作为架构概念，当前执行循环只作为 turn 内部实现。
- 不照搬 opencode 的内部 `TurnTransition` 或 V1 run 状态；只采用“单一持久真相、step 归属消息、压缩独立生命周期、输入投递显式化”的原则。

## 模块边界

- `core/transcript`：session 历史、消息 id、context state；不解释 turn 状态和模型请求。
- `core/session`：journal 与 projection；唯一真相和重建入口。
- `core/session` / TurnScheduler：turn 生命周期、FIFO、取消、手动压缩调度；不 import model/context。
- `core/session` / TurnExecutor：turn 内的 handoff 链和 step 编排；不定义压缩阈值、不读写 transcript context state。
- `core/session` / StepExecutor：一次模型请求与工具执行；不改变 turn 状态。
- `core/agent`：静态注册、模型路由与 AI SDK 执行适配；不拥有 turn 调度或终态写入。
- `core/context` / ContextManager：session 级上下文状态、自动/手动压缩、usage/checkpoint；不读取队列或 turn 状态机。
- 领域 application：只提交 Turn、取消 Turn、请求压缩；不复制 handoff、队列或压缩逻辑。
- CLI/desktop UI：只消费 turn 状态、step 活动和压缩操作投影；不自己推导状态。

## 曾考虑的替代方案

- **保留当前 run + turn 两层。** 舍弃。用户已经明确指出 turn 才是一轮问答，run 作为回复段继续暴露会让两层语义重复。
- **把当前 run 改名为 response，再新增 run。** 舍弃。会增加第四个层，和“减少概念”目标相反。
- **turn = 用户消息，run = 回复。** 舍弃。多 Bot handoff 会让一轮问答出现多个 run，turn 仍然不是用户理解的问答边界。
- **手动压缩也作为 turn。** 舍弃。手动压缩没有用户问答；伪造成 turn 会污染 turn 状态和 UI。
- **排队消息继续在 step 边界让位。** 舍弃。会中途切断一轮问答，turn 边界失效。
- **上下文挂在 turn。** 舍弃。turn 内可以有很多 step 和多个 Bot，压缩必须按每次模型请求判断。
- **保留 `activeRunCount` 阻塞手动压缩。** 舍弃。压缩应该被 TurnScheduler 串行，而不是被“有 run”拒绝。
- **只做内存 turn 状态机，不做 journal。** 舍弃。重启后无法恢复队列、压缩和活动 turn，不能支撑成熟运行时。
- **照搬 opencode 的 TurnTransition。** 舍弃。它是内部异常控制流，不是我们的领域模型；我们只借持久化和 step 归属原则。

## 验收标准

- 可观察结果：
  - 一轮问答只产生一个 `turnId`；多 Bot 接管期间 `turnId` 不变。
  - 每个 assistant 消息只属于一个 turn；每个 step 带 `assistantMessageId`、`agentId`、`modelId`。
  - 排队消息在当前 turn 完成后再启动；不会在 step 边界切断当前 turn。
  - 自动压缩可以在长工具循环的任意 step 前发生；超限请求不会发往 provider。
  - 手动压缩不产生 turn，不改变 turn 状态；活动 turn 结束后、下一个 queued turn 前执行。
  - 重启后能从 journal 恢复 queued turn、压缩边界和终态；未完成 turn 不自动重试。
  - CLI 状态栏能同时表达 turn 状态、step 活动、压缩操作和队列位置。
- 自动化验证：
  - Turn 生命周期测试：queued -> running -> completed/failed/aborted；handoff 不新开 turn。
  - 队列测试：当前 turn 完成前不启动下一条；取消活动 turn 与取消 queued turn 分开。
  - 手动压缩测试：不创建 turn；活动 turn 结束后执行；失败不破坏 checkpoint。
  - Step 上下文测试：每个 provider 请求前都调用 prepare；`step-finished` 更新 usage 锚点。
  - 自动压缩测试：每个 step 前超限都会压缩；压缩失败 fail-closed；provider overflow 只恢复一次。
  - 事件归属测试：`step-*` 不改 turn 状态；`turn-*` 不携带 provider usage；重放幂等。
  - 恢复测试：turn-started 无终态、running tool、compaction-started 无终态的恢复结果。
  - TUI 测试：turn 状态与 context activity 独立；压缩边界不 fallback 到 transcript 末尾。
  - `pnpm verify`、`pnpm notes:check` 通过。
- 需要的实机验证：
  - CLI 单用户长工具循环，在下一次 step 前自动压缩。
  - Conversation 多 Bot 接管，确认同一 turn 内 handoff 和消息 id 正确。
  - 手动 `/compact` 在 turn 空闲和活动 turn 两种场景下的行为。
  - Desktop/CLI 长上下文、provider 超限恢复、进程重启后的队列恢复。

## 风险

- 事件 envelope 从 `runId` 迁移到 `turnId`/`messageId`/`operationId` 会触及 worker 协议、desktop IPC、CLI 和持久化；必须一次性设计迁移，不能长期双轨。
- 历史 `runId` 只能映射为 assistant `messageId`，不能映射为 `turnId`；否则多 Bot handoff 会被迁移成多个假 turn。
- 当前 `activeRunId` 同时承担 assistant 消息 id 和会话门控；拆成 `activeTurnId` + `messageId` 会牵动 transcript 认领、恢复和 UI 投影。
- 队列从 step 边界改到 turn 边界会增加排队消息等待时间；这是保持“一轮问答一个 turn”的代价，需要产品确认。
- 多 Bot handoff 的 assistant 消息归属、turn 完成条件和失败传播需要重新测试；不能只改字段名。
- 手动压缩与活动 turn 的并发策略如果只用“拒绝”，用户体验可能变差；本提案选择“排队到 turn 结束后执行”，需要产品确认等待时长。
- Step 没有持久状态，崩溃恢复只能依赖 session journal/transcript/checkpoint；不能把 step 当成可恢复状态机。
- 自动压缩在 step 内同步执行会增加首 token 延迟；如果后续要异步预压缩，必须保证 checkpoint 提交和请求重建的原子性。
- 这是一次跨模块契约变更，不能和普通上下文压缩修复混在一个提交里；迁移期间旧 run 事件必须明确只读或拒绝。
