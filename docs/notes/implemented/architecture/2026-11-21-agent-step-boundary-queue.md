# Note：Agent 在 step 边界消费用户排队消息

状态：已实施

## 问题

排队消息此前只在当前 run 完整结束后才可能开始下一轮。Agent 已经能在 run 内执行多个 step，但用户在执行过程中补充的信息仍要等整个 run 收尾，无法在下一步模型调用前生效。CLI 同时在 `TuiRunController` 里维护本地 FIFO，并串行调用 `CodingSession.send`，导致 host 的队列实际上没有承担排队职责。

## 涉及范围

- Agent core：`apps/agent/src/core/agent/definition.ts`、`executeRun.ts`、`core/queue/turnQueue.ts`、`core/queue/turnQueueRegistry.ts`
- Agent 应用层：`apps/agent/src/coding/application.ts`、`conversation/application.ts`
- Agent 宿主：`apps/agent/src/coding/host.ts`、`apps/agent/src/host.ts`
- CLI：`apps/cli/src/session/codingSession.ts`、`adapters/agentCodingHost.ts`、`remote/controller/sessionHost.ts`、`tui/runController.ts`、`tui/sessionRunQueue.ts`
- UI 表面：CLI TUI 的排队投影仍只是 host 队列的展示，不改变 transcript 消息顺序
- 相关 Note：
  - `docs/notes/implemented/architecture/2026-11-14-conversation-input-queue-and-remote-host-ordering.md`
  - `docs/notes/implemented/bug-fix/2026-11-19-cli-queued-prompt-visibility.md`

## 决定

1. **Host 队列是唯一顺序源。** CLI 每次提交都调用 host `enqueue`，不再在本地等上一轮结束才调用 `send`。`queued` 结果和位置直接来自 host 的 `TurnQueue`。
2. **活动 run 在 step 边界让位。** `AgentRunRequest.shouldYield` 由应用层注入，返回当前会话是否还有待发送队列项。`executeRun` 把它追加为一个 AI SDK stop condition；当前 step 的模型输出与工具结果落账后，run 结束，`TurnQueue` 立即启动下一条消息。
3. **不把用户消息插进同一个 run 的消息数组。** 当前 transcript 以“一个 run 一个 assistant 消息”为模型；同 run 插入 user 消息会让历史顺序变成 assistant 全量输出之后才是 user 消息，需要新增 part 类型并改造投影/渲染。step 边界让位可以复用现有消息模型，代价是排队消息成为新的 run。
4. **通用队列下沉到 `core/queue`。** 队列只承担单会话 FIFO、启动/完成等待、位置与取消 pending，不包含 Conversation/coding 语义。`TurnQueueRegistry` 提供 per-conversation 队列和 run 关联，coding 与 conversation 共用，消除 `coding` 反向 import `conversation` 的跨域依赖。
5. **取消仍清空队列。** Esc 中断活动 run 时，应用层 `cancel` 继续取消 pending；CLI 只在本地保留取消后新提交的消息，等旧 run 结算后再交给 host。最近一次 run 的会话关联保留到下一次 run 启动，覆盖“活动 run 已结束、下一条尚未启动”的取消窗口。
6. **退出先关闭队列消费。** `cancelPendingTurns()` 在 `AgentRuntime.shutdown()` 前释放队列；`AgentRuntime` 在关闭阶段拒绝新 run，避免 abort 活动 run 后队列又把 pending turn 拉起来。
7. **交接链为排队输入让位。** 当前 team turn 之后已有排队 turn 时（包括下一条已启动），conversation 不继续执行 handoff；排队用户消息优先于 Bot 交接。判断不能只看 pending 数，否则下一条 turn 启动后会重新进入交接链。

## 曾考虑的替代方案

- **把队列消息作为 attachment 注入同一个 run 的下一步。** 与 Claude Code 的 mid-turn 注入最接近，但需要 transcript 支持 run 内 user 与 assistant 交错；现有 schema 没有 user part，后续历史投影会错序。
- **只用 prepareStep 修改 messages，不写 transcript。** 用户看不到已发送内容，下一轮历史也无法解释模型为什么提前看到该消息。
- **在 CLI 里中断并重新发送。** 仍是客户端插入，remote/desktop 与 CLI 行为不一致，且 host 队列位置不可见。
- **保持 run 结束才出队。** 实现最简单，但多 step 工具链会让用户补充信息等待过久，正是本次要解决的问题。

## 模块边界

- `core/agent` 只接收 `shouldYield` 回调并把它组合成 stop condition，不读取队列、不判断会话；它只决定“当前 run 是否在 step 后结束”。
- `core/queue` 只持有单会话 FIFO、启动/完成等待、位置与取消 pending；不 import coding/conversation，不写 transcript。
- `coding/application` 与 `conversation/application` 通过 `TurnQueueRegistry` 持有各自会话的队列，把 `queuedCount > 0` 作为 `shouldYield`，保持 host 为唯一顺序源。
- CLI `session` 只把 `enqueue` / `waitForQueueStart` 映射到 host 端口；`sessionRunQueue` 负责提交、取消代际和排队投影，`runController` 只做会话注册/切换与视图投影，不再自行串行发送。
- `runTui` 仍只做命令分派和面板接线；排队状态来自 `TuiViewStore` 的投影，不写入 transcript。

## 后果与防回退

- 排队消息在活动 run 的当前 step 后生效，而不是等所有 step 完成；每个排队消息会启动新的 assistant run，因此 transcript 中表现为独立的 user/assistant 回合。
- 一次提交多条消息时按 host FIFO 逐条启动；若后续 run 启动时队列仍有内容，它也会在第一个 step 后继续让位，直到队列清空。这是“每条消息尽快生效”的取舍，不做同一 run 内批量注入。
- 队列仍在内存中，进程退出会丢失；不引入 durable queue 或恢复语义。
- `shouldYield` 只看本会话的 pending 数；其他会话的排队不影响当前 run。
- 运行失败时 `yieldedToQueue` 仍按 completed 处理，避免把“主动让位”误判为工具循环未完成；真正的模型/工具失败仍由 `metrics.failed` 判为 failed。
- 已完成 turn 的等待结果只保留有界数量；取消 pending 同时清理位置。队列不是持久记录，不能把它当历史查询源。
- `CodingSessionHost.enqueue` 与 `waitForQueueStart` 是必选契约；不要再为缺省 host 回退到 `send`，否则会在活动 run 时退化为“上一轮尚未结束”而不是排队。
- 不要再把 `CodingSession.send` 作为 TUI 串行入口；新增客户端必须通过 `enqueue` 使用 host 队列，否则会重新引入客户端排序。
- 退出时先 `cancelPendingTurns()` 再 `AgentRuntime.shutdown()`；顺序反过来会让 pending turn 在 abort 后重新启动。

## 验证

- `apps/agent/test/core/queue/turnQueue.test.ts`：FIFO、取消 pending、位置清理、失败错误保留、dispose 后不再启动 pending。
- `apps/agent/test/core/agent/executeRun.test.ts`：增加 yielded 场景的 outcome 断言。
- `apps/agent/test/coding/application.test.ts`：真实 HTTP 假模型返回一次 `Read` 工具调用；工具 step 后第二条消息启动，第二次模型请求包含新消息，首个 run 终态为 `completed`，transcript 顺序为 user/assistant/user/assistant；新增 shutdown 不启动 pending 的断言。
- `apps/agent/test/conversation/teamHandoff.test.ts`：handoff 链正常执行；队列中已有用户 turn 时不继续 handoff，且下一条用户 turn 启动后也不会补跑交接链。
- `apps/cli/test/session/codingSession.test.ts`：host queued 接受、`waitForQueueStart` 后激活 run、取消目标正确。
- `apps/cli/test/tui/runController.test.ts`：覆盖 host `started`、host `queued` 后等待启动、取消后新提交不丢失。
- `apps/cli/test/tui/runTui.test.ts` 与 `runTuiHarness.ts`：使用带 FIFO 的假 host 队列验证 TUI 不再本地串行、取消会清空排队投影。
- 命令：最终 `pnpm verify` 通过（Agent 708、CLI 400；Note、架构边界与设计令牌检查通过）。
