# Note：用户排队消息与 Bot 交接的 Turn 边界规则

状态：提案

## 问题

新的 Session/Turn 运行时同时存在两种异步输入：

1. 用户在当前 Turn 运行期间继续发消息，消息进入每会话队列；
2. 当前 Turn 的 Bot 决定交接给另一个 Bot，交接链继续回答同一个用户问题。

两者混在一起时，下面几个问题没有唯一答案：

- Bot A 正在回答，用户又发了一条消息，A 随后要交接给 B：B 先回答，还是用户新消息先插入？
- 交接是否算新的一轮，是否消耗一个队列位置？
- 用户取消 A 时，B 和排队消息分别怎么处理？
- append-only 日志里，`turn-queued` 是否意味着上一个 Turn 已经结束？
- 交接任务要不要写成一条 `role: "user"` 的消息？
- 一轮用户提问里出现多个 Bot 时，assistant 消息 id 怎么归属？

旧运行时的实现是“排队消息在 step 边界优先，交接链为用户消息让位”。这会让一轮问答被下一条用户消息从中间切断，与“一个用户提问 = 一个 Turn”的目标冲突。本提案明确新运行时的规则，并说明如何取代旧行为。

## 涉及范围

- 契约与事件：
  - `packages/shared/src/schema/events.ts`：继续使用 `turn-handoff`，不新增 handoff Turn 事件。
  - `packages/shared/src/schema/status.ts`：`TurnSource` 不增加 `handoff`。
- 运行时：
  - `apps/agent/src/core/session/contracts.ts`：`TurnStart`、`TurnHandoff`、`StepStart`、`StepHandoff`、`StepRunContext` 与 assistant `messageId` 归属。
  - `apps/agent/src/core/session/scheduler.ts`：Turn 边界 FIFO、取消 queued、活动 Turn 不被排队消息切断。
  - `apps/agent/src/core/session/turnExecutor.ts`：同 Turn handoff 循环、最大 step 数、失败传播。
  - `apps/agent/src/core/session/projection.ts`、`recovery.ts`：Turn 状态、队列、assistant 消息 id、恢复收口。
  - `apps/agent/src/core/session/sessionRuntime.ts`：提交、取消、恢复与队列投影入口。
- 后续迁移表面（本提案不直接改）：
  - `apps/agent/src/conversation/application.ts`、`coding/application.ts`、`interview/application.ts`、`answer/application.ts`
  - `apps/agent/src/worker/protocol.ts`、desktop IPC、CLI TUI
  - 旧 `apps/agent/src/core/queue/`、`shouldYield` 路径，迁移完成后删除。
- 相关 Note：
  - [Session、Turn、Step 的职责边界](./2026-11-21-session-turn-step-boundaries.md)
  - [多 Bot 同会话注册、发现与交接](./2026-11-11-multi-bot-session-registry-and-handoff.md)
  - [Agent 在 step 边界消费用户排队消息](../../implemented/architecture/2026-11-21-agent-step-boundary-queue.md)（旧运行时行为，本提案在新运行时取代其排队让位规则）
  - [会话输入队列与远程 host 排序](../../implemented/architecture/2026-11-14-conversation-input-queue-and-remote-host-ordering.md)

## 提案

### 1. 核心规则

1. **Turn 是一轮用户可见问答，不按 Bot 回复切分。**
   - 一个用户提问对应一个 `turnId`。
   - Bot A 交接给 Bot B 后，`turnId` 不变；Turn 完成条件是交接链最后一位 Bot 回复完成，且没有新的 handoff。

2. **Handoff 是同一 Turn 内的事件，不是新 Turn，也不是用户消息。**
   - 使用 `turn-handoff`，携带 `fromAgentId`、`toAgentId`、`task`。
   - 不新增 `source: "handoff"`，不写 `turn-queued`，不写 `role: "user"`。
   - 交接任务通过 `StepStart.handoff` 交给下一位 Bot 的领域 StepRunner；上一位 Bot 的回复用 `sourceMessageId` 指向 transcript，不复制正文，不进入用户可见 transcript 气泡。
   - 目标 Bot 的 prompt 由领域适配器按 `StepStart.agentId` 解析，`core/session` 不持有领域 prompt；模型流事件通过 `StepRunContext.events` 写入当前 step。

3. **用户排队消息只在 Turn 边界启动，永不插入 handoff 链。**
   - 当前 Turn 运行期间提交的用户消息只追加 `turn-queued` 并进入队列。
   - 当前 Turn 的整条 handoff 链完成后，Scheduler 才启动队首用户 Turn。
   - 队列 FIFO 只包含用户 Turn；handoff 不占队列位置，不会让 UI 显示“排队位置 2”。

4. **活动 Turn 是取消边界。**
   - 取消活动 Turn 会终止当前 step、停止后续 handoff、写入 `turn-finished: aborted/cancelled`。
   - 默认保留 queued 用户 Turn；显式 `cancelQueued` 才一并取消。
   - 不需要为 handoff 单独建立父子取消树，因为 handoff 不是独立 Turn。

5. **Handoff 失败不阻塞队列。**
   - 目标为空、目标等于当前 Bot、任务为空或超过最大 step/交接深度时，当前 Turn 以 `failed` + `handoff-failed` 结束。
   - 下一条 queued 用户 Turn 继续正常启动。

6. **每个实际发言的 Bot 有自己的 assistant 消息 id。**
   - 同一 Turn 内可以有多个 assistant 消息，分别归属不同 Bot。
   - `messageId` 在该 Bot 的回复开始时确定，跨该 Bot 的多个 step 保持不变。
   - `turn-handoff` 可携带来源 Bot 的 `messageId` 供投影使用，但 handoff 任务本身不是 assistant 消息。

### 2. 事件与 append-only 边界

典型日志：

```text
1  turn-queued    turn-1  user U1
2  turn-started   turn-1  general
3  step-started   turn-1  general
4  step-finished  turn-1  general
5  turn-handoff   turn-1  general -> intake
6  step-started   turn-1  intake
7  turn-queued    turn-2  user U2    // U2 被接纳，但 turn-1 仍在运行
8  step-finished  turn-1  intake
9  turn-finished  turn-1  completed
10 turn-started   turn-2  general
```

关键语义：

- `turn-queued` 只表示输入被接纳，**不表示前一个 Turn 已结束**。
- Turn 结束只由 `turn-finished` 表示；不能从“又追加了一条消息”推断。
- `turn-handoff` 追加时 Turn 仍是 `running`，不产生新 `turnId`。
- 队列投影只包含 queued 用户 Turn；`turn-handoff` 不进入队列。
- append-only 只保证不覆盖历史；Turn 边界必须由显式事件和 `turnId` 写入，不能事后靠 bot 字段推断。

### 3. 调度与取消场景

| 场景 | 行为 |
| --- | --- |
| Turn A 运行中，队列有 U2；A 交接 B | B 继续在 Turn A 内执行；U2 等待；A 完成后 U2 启动 |
| Turn A 运行中，队列有 U2、U3；A 交接 B、C | B、C 依次完成；然后 U2、U3 按 FIFO 启动 |
| 取消 Turn A，发生在 A 交接 B 之前或之后 | 当前 step 停止；B 不再启动；A 写 `aborted/cancelled`；U2 保留 |
| 取消 Turn A 且 `cancelQueued: true` | A 中止；U2、U3 也写 `aborted/cancelled` 并移出队列 |
| Handoff 目标/任务非法 | A 以 `failed/handoff-failed` 结束；B 不启动；U2 启动 |
| 用户在 A 交接后、B 启动前发消息 | 新消息进入队列；B 继续；新消息等 A 完成后再启动 |
| 进程在 handoff 后崩溃 | 恢复把 A 收口为 `failed/interrupted`；不自动重启 B；queued U2 继续 |

### 4. UI 与投影

- UI 一轮只显示一个 Turn 行；handoff 显示为“已交接给 intake”的活动或分隔线，不显示成用户气泡。
- Turn 行内展示当前 active Bot、step 活动和 handoff 次数；不把 B 的回复放进新的 Turn 卡片。
- 队列区域只显示用户消息和位置；handoff 不显示为排队项。
- 取消按钮作用于整个 Turn 及其 handoff 链；不要求用户分别取消 A 和 B。
- 如果将来需要在 transcript 中保留交接记录，只能作为独立的内部事件/分隔线投影，不能写 `role: "user"` 消息。

### 5. 与现有决定的关系

- 本提案落实 [Session、Turn、Step 的职责边界](./2026-11-21-session-turn-step-boundaries.md) 中“handoff 同一 Turn”和“用户消息在 Turn 边界排队”的规则，并补齐两者交互。
- 本提案在新运行时取代 [Agent 在 step 边界消费用户排队消息](../../implemented/architecture/2026-11-21-agent-step-boundary-queue.md) 的以下行为：排队消息不再在 step 边界抢占交接链；handoff 完整结束后才启动下一条用户 Turn。
- 旧运行时的 `shouldYield` / `core/queue` 在迁移完成前保持现状，不因本提案直接修改；新旧路径不能同时驱动同一会话。
- 如果未来产品需要“用户在 Bot 回答中途插入/steer”，必须另立提案，不能把消息塞进当前 Turn 的 step 循环。

### 6. 明确不做

- 不新增 handoff Turn，不新增第二条队列。
- 不把交接任务写成普通用户消息，也不写 `role: "user"`。
- 不让 queued 用户消息在 step 边界切断 handoff 链。
- 不让 handoff 消耗队列位置。
- 不为 handoff 建立独立取消树或独立 Turn 状态。
- 不在本提案中改业务 application、worker、desktop IPC 或 TUI。

### 7. 实现进度（2026-11-21）

- `core/session` 已实现 Turn 边界 FIFO、同 Turn handoff、handoff 非法失败、活动 Turn 取消整条链、恢复收口与 queued 继续。
- `SessionTurnExecutor` 现在由宿主注入 `createMessageId`，每个实际发言的 Bot 获得独立 assistant `messageId`；同一 Bot 的多个 step 复用，handoff 事件 envelope 记录来源 Bot 的 `messageId`。
- `SessionProjection` 从 `step-started` 与 `turn-handoff` 统一收集 assistant 消息 id，并按 id 去重；多 step 不会产生重复消息，handoff 后新 Bot 的 step 产生新 id。
- `StepStart.handoff` 已携带 `fromAgentId`、`task`、`sourceMessageId`，并让目标 Bot 的每个 step 都持有同一份交接输入；`StepStart.input` 同时提供 Turn 用户输入，供领域适配器构建目标 Bot 输入；`StepRunContext.events` 提供只接受模型流事件的串行 sink，`step-*` 与 usage 仍由 `SessionStepExecutor` 独占。
- 已新增 `SessionStepRunner` 与 `PreparationStepContextManager`：StepRunner 使用真实 `streamModel` 路径执行单次 provider 请求，调用 ContextManager 准备/恢复上下文，消费模型流并写模型事件；provider 内部的 step framing 被过滤，不占用 Session 的 step 身份。
- 已新增 `conversation/stepRunner.ts`：按 `StepStart.agentId` 解析 Conversation Bot，handoff task 优先于 Turn 用户输入，并通过 `AgentExecutor.result` 把 `BotTurnResult` 映射为 `TurnHandoff`；目标 Bot 的每个 step 复用同一份交接输入，不新开 Turn 或队列项。
- 自动化证据：`pnpm --filter @answra/agent test` 通过 778 个测试；其中 Session/StepRunner 目标集 63 个测试，覆盖“交接链完成后才启动 queued 用户 Turn”“取消交接链后 queued 用户 Turn 继续”“handoff 输入传给目标 Bot 的每个 step”“step 事件 sink 按序写入 journal”“context overflow 仅恢复一次”以及“Conversation handoff 输入与结果映射”。
- 未完成：业务 application 迁移、worker/desktop/CLI 投影、旧 `shouldYield` 路径删除、transcript 写入 `turn_id`。Conversation 领域 StepRunner 绑定已具备，但尚未替换 `ConversationApplication` 的旧 run 执行链；因此本 Note 仍为提案，不迁移到 `implemented/`。

## 模块边界

- `core/session` / Scheduler：只管理用户 Turn 队列、活动 Turn、queued 取消和手动压缩排序；不知道 handoff 细节。
- `core/session` / TurnExecutor：只负责同一 Turn 内的 step 循环和 handoff 链；不读写队列。
- `core/session` / StepExecutor：只执行一次 provider 请求与工具；不改变 Turn 状态，不启动下一位 Bot。
- `core/session` / Projection：只根据事件重建 Turn、queue、step、assistant 消息归属；不推演未写入的 handoff。
- 领域 StepRunner 绑定：按 `StepStart.agentId` 解析 Bot、用 `StepStart.handoff` 构建目标输入；不读取 Turn 队列，`core/session` 不持有领域 prompt。
- `core/context` / ContextManager：只接收已组装的模型请求并准备/恢复上下文；不解析 Bot prompt，不读取 Turn 队列。
- 领域 application：只提交用户 Turn、取消 Turn、请求压缩；不拼 handoff 链，不判断队列。
- UI/worker/desktop/CLI：只消费 Turn/Step/Queue 投影；不自行推断 handoff 是否新 Turn。

## 曾考虑的替代方案

- **交接开新 Turn，并给交接 Turn 单独的优先队列。** 舍弃。执行层可以复用，但会产生两条队列、父子 Turn、取消链、UI 合并展示和压缩归属问题；当前产品不需要“Bot 回复 = 一轮”。
- **把交接消息写成 `role: "user"` 的隐藏消息。** 舍弃。它会在持久化和投影里留下假用户输入，压缩、历史、统计和 UI 都要特殊处理；模型角色与产品角色混在一起。
- **排队消息继续在 step 边界抢占 handoff。** 舍弃。会从中间切断同一轮回答，用户看到一轮问答被新消息打断，Turn 的“一轮用户提问”语义失效。
- **用户消息直接插入当前 Turn 的模型消息数组。** 舍弃。需要交错 user/assistant part，现有 transcript 顺序和 UI 投影无法解释；需要单独的 steer 机制。
- **保持 handoff 为独立 assistant 消息并让 UI 分卡片展示。** 舍弃。会把内部交接暴露成多轮回复，和“一个用户提问一个 Turn”冲突。

## 验收标准

- 可观察结果：
  - Turn A 交接链执行期间，queued U2 不启动；A 完成后 U2 才启动。
  - A 的 handoff 不产生新 `turnId`，不写 `turn-queued`，不写 `role: "user"`。
  - 取消 A 后 B 不启动，U2 保留；`cancelQueued` 时 U2 也中止。
  - handoff 失败后 A 失败，U2 仍启动。
  - 恢复后未完成 A 为 `failed/interrupted`，B 不自动启动，queued U2 继续。
  - UI/投影中一个用户提问只有一个 Turn，handoff 是 Turn 内活动，queue 只显示用户 Turn。
- 自动化验证：
  - Scheduler/TurnExecutor/Projection/Recovery 测试覆盖上表全部场景。
  - 断言 handoff 前后 `turnId` 不变、assistant `messageId` 按 Bot 归属、queue 不包含 handoff。
  - 断言事件序列：`turn-handoff` 在 `turn-finished` 之前，`turn-queued` 不隐含前一个 Turn 结束。
  - `pnpm verify` 通过。
- 需要的实机验证：
  - Conversation 多 Bot 交接时，用户连续发送消息，确认 B 先答完，队列消息按 FIFO 后续执行。
  - 取消交接中的 Turn，确认 B 不启动、排队消息保留。
  - 重启后确认未完成 handoff Turn 被收口，queued 用户消息可继续。

## 风险

- 排队用户消息会更晚生效；这是保持一轮问答完整性的代价，需要产品接受。
- Handoff 链可能较长；必须保留最大 step/交接深度与失败收口，避免无限循环。
- 交接任务不进入用户可见 transcript，排查时需要读 journal；UI 至少要显示 active Bot 和 handoff 活动。
- 旧运行时仍按 step 边界让位；迁移期间新旧行为不同，不能把两个运行时同时接到同一会话。
- 如果产品后续需要中途插入或 steer，本提案不支持，必须另立提案。
- assistant `messageId` 归属必须严格按“每个发言 Bot 一个”执行；如果把它和 step 或 Turn 混用，transcript 与 UI 会再次失配。
