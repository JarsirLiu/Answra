# Note：SQLite SessionJournal 与 Turn 投影

状态：已实施

## 问题

`SessionRuntime`、`TurnScheduler` 与压缩恢复都需要 `SessionJournal` 作为唯一追加真相，但此前只有 `MemorySessionJournal`。进程重启后 queued Turn、活动 Turn、未完成 Step 和压缩边界全部丢失，`SessionRuntime.recover` 只能重建本次进程写入的内存事件。现有 `sessions.sqlite` 只有 `session_turns` 投影，没有可重放的事件日志，不能把 Turn 状态表当成真相源。

## 涉及范围

- 代码/模块：`apps/agent/src/core/session/sqliteJournal.ts`、`apps/agent/src/core/session/sessionTurnProjection.ts`、`apps/agent/src/core/session/stepExecutor.ts`、`apps/agent/src/core/transcript/persistence/sqlite/schema.ts`
- 共享契约：`packages/shared/src/schema/events.ts` 将 `SessionEventEnvelope.event` 收窄为 `AgentDurableEvent`
- 迁移：`20261122120000_add_session_events`、`20261122130000_session_turn_projection`
- 持久化表面：`sessions.sqlite` 新增 `session_events` 表、turn/step 索引、`session_turns` 实时投影与会话删除触发器
- 导出：`apps/agent/src/index.ts`、`apps/agent/src/composition.ts`
- 测试：`apps/agent/test/core/session/sqliteJournal.test.ts`、`apps/agent/test/core/session/stepExecutor.test.ts`、`apps/agent/test/core/agent/providerStepRunner.test.ts`、`apps/agent/test/conversation/stepBinding.test.ts`、`apps/agent/test/core/transcript/sessionEventsMigration.test.ts`、`apps/agent/test/core/transcript/sessionTurnProjectionMigration.test.ts`、`packages/shared/test/schema.test.ts`
- 相关 Note：
  - [Session/Turn/Step 边界与执行交接](../../proposed/architecture/2026-11-21-session-turn-step-boundaries.md)
  - [用户排队消息与 Bot 交接的 Turn 边界规则](../../proposed/architecture/2026-11-21-turn-boundary-queue-and-handoff.md)

## 决定

- 在 `sessions.sqlite` 新增 append-only `session_events` 表，保存完整 `SessionEventEnvelope` JSON，同时把 `turn_id`、`message_id`、`step_id`、`operation_id` 投影成可索引列。
- `(conversation_id, seq)` 是主键，`(conversation_id, event_id)` 唯一；`seq` 由同一事务内的 `MAX(seq) + 1` 分配，写入使用 `BEGIN IMMEDIATE`，保证单会话单调。
- `SqliteSessionJournal` 实现既有 `SessionJournal` 端口：`append` 返回带 `sequence` 的 envelope，`readAfter` 按 `seq` 升序返回，并在读取时用 `sessionEventEnvelopeSchema` 校验数据库内容。
- `session_events` 与 `session_turns` 都不建 `sessions` 外键。新会话在 transcript 首次落消息前不会写 `sessions` 行，但 `turn-queued` 可能先于该行出现；外键会错误拒绝合法的 Turn。删除/清空会话时由 `sessions_delete_session_events`、`sessions_delete_session_turns` 触发器清理，避免会话 ID 复用时读到旧投影。
- `SqliteSessionJournal.append` 在同一个 `BEGIN IMMEDIATE` 事务里写事件并更新 `session_turns`：`turn-queued` 插入 queued 行，`turn-started`/`turn-handoff` 更新活动 Bot，`turn-finished` 写终态与 finish reason；step 和模型流事件不改 Turn 投影。
- `session_events` 只保存 `AgentDurableEvent`：`turn-*`、`step-*`、`compaction-*`、durable 模型生命周期与工具结果；`text-delta` 等 live-only 增量不进入 journal，由 transcript 草稿和实时流承担。
- `session_turns.seq` 在写入 `turn-queued` 时按会话 `MAX(seq)+1` 分配；投影更新要求目标 Turn 已存在，否则 fail-closed，避免出现无来源的 Turn 行。
- 本阶段交付 adapter、schema、投影与恢复测试；仍不改 `ConversationApplication`、worker/desktop/CLI 注入，应用接线由后续阶段完成。

## 模块边界

- `core/session` 拥有 journal 端口、SQLite 适配器与 Turn 投影写回；适配器只写 `session_events` 和 `session_turns`，不读写 transcript 的消息、上下文状态或会话行内容。
- 适配器复用 `openSessionDatabase` 与会话迁移入口，确保与 `SqliteConversationStore` 使用同一个 `sessions.sqlite` 和同一套 schema；不复制迁移或另建事件数据库。
- `session_events` 是重放真相；`session_turns` 是 journal 在同一事务内维护的最后已知投影，不是第二套执行状态。UI 不应通过 `session_turns` 推导 step/usage。
- `SessionRuntime` 仍只依赖 `SessionJournal` 端口；SQLite 连接生命周期由持有适配器的宿主关闭。

## 后果与防回退

- 重启后可以用 `readAfter(sessionId, 0)` 重放 Turn/Step/压缩事件，`recoverSession` 能收口未完成 Step 与 Turn；事件 `sequence` 在重开后继续递增。
- 同一数据库由 transcript store 与 journal 各持连接，依靠 WAL、`busy_timeout` 与 `BEGIN IMMEDIATE` 串行写；不要在同一进程改用两个非 WAL 连接或关闭 `busy_timeout`。
- 新会话可以先写 journal；删除/清空 transcript 会话会通过触发器删除对应事件与 Turn 投影。不要移除触发器而不补等价的清理逻辑。
- `session_turns` 现在会随 `turn-*` 实时更新，但仍不是 step 活动、usage、队列位置或压缩状态的来源；这些只来自 `session_events` 投影。
- journal 只接收 `AgentDurableEvent`，不持久化 `text-delta`、`reasoning-delta`、`tool-input-delta`、`tool-output-delta` 等高频增量；增量由 transcript 草稿与宿主实时流消费，不落 `session_events`。若未来需要事件压缩，必须保持 `sequence` 连续与旧事件可重放，不能只删中间事件。
- 收窄 schema 之前写进 `session_events` 的增量行不再合法，也不能“读时跳过”（会让 `sequence` 出现空洞而被投影拒绝）。`SqliteSessionJournal` 遇到已知 live-only 类型会报出“请重置本地数据库（pnpm db:reset --yes）”；`session_events` 尚未随发布版交付，重建开发库比迁移历史行更安全。
- 防回退测试至少覆盖：跨重开持久化、重启恢复、Turn 投影生命周期、会话隔离、非法游标、会话删除/清空清理，以及 transcript 尚未落会话行时仍可写事件。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/session/sqliteJournal.test.ts`：9 个测试通过。
- 目标迁移测试：`sessionEventsMigration` 1 个、`sessionTurnProjectionMigration` 1 个通过。
- `pnpm --filter @answra/agent test`：106 个文件、793 个测试通过。
- 覆盖 append/readAfter、跨数据库重开、`recoverSession` 重启恢复、Turn 投影生命周期、会话隔离、非法游标、先写事件后持久化会话、删除/清空会话触发清理，以及迁移表的唯一约束与 FK 移除。
- `pnpm db:generate`：生成 3 个迁移注册项与新 schema 快照；`pnpm db:check` 通过。
- `pnpm notes:check`、`pnpm lint`、`pnpm typecheck`、`pnpm architecture:check` 与完整 `pnpm verify` 通过。

## 曾考虑的替代方案

- **继续只用 `MemorySessionJournal`：** 舍弃。重启后 queued/活动 Turn 与压缩边界没有真相源，恢复能力无法成立。
- **把事件表放进 `core/transcript` 的 SQLite 适配器：** 舍弃。transcript 的职责明确不保存 Agent 事件；把 journal 放进该目录会让消息存储与执行事件重新耦合。
- **给 `session_events` 建 `sessions` 外键：** 舍弃。空会话在首条消息前不落 `sessions` 行，而 `turn-queued` 可能先发生；外键会让合法 Turn 失败。
- **为 journal 单独建数据库文件：** 舍弃。会失去与 transcript 同一会话生命周期、同一删除边界和单文件迁移，增加第二个持久化入口。
- **journal 只写事件，Turn 投影交给应用另写：** 舍弃。应用需要再维护一套事务与顺序，重启恢复时容易和事件真相不一致；由 journal 在同一事务内写投影只有一个写者。
- **保留 `session_turns` 的 `sessions` 外键：** 舍弃。`turn-queued` 可能早于空会话在 transcript 落行；保留外键会让 Turn 投影写入失败，和事件表的前置顺序冲突。
