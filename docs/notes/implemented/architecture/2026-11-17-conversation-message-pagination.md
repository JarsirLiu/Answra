# Note：会话消息表、流式草稿与退出屏障

状态：已实施

后续变更：阶段 1（消息表、增量写、流式草稿、退出屏障）与阶段 2（agent 内消息分页端口）已交付。阶段 3（renderer/UI 窗口化）仍未实施，另见 [会话 transcript 窗口化提案](../../proposed/architecture/2026-11-18-conversation-transcript-windowing.md)。写失败补写、冲突清理、空会话与 workspace 大小写修复见 [会话持久化写失败补写与冲突残留清理](../bug-fix/2026-11-18-session-persistence-durability-and-conflict-cleanup.md)；开发期旧库迁移已移除，当前 DDL 收口为 v1，见 [会话数据库只保留最新 schema](../simplification/2026-11-18-session-schema-latest-only.md)。

## 问题

[SQLite 会话 transcript 存储](2026-11-17-sqlite-transcript-store.md) 已经解决会话级持久化、跨进程写入冲突和会话列表分页，但 transcript 正文仍全部放在 `sessions.record_json`：

- 每次用户消息、run 开始/结束、清空或上下文状态变化，都要重写整份会话 JSON。实测一个 23 个消息 part 的 coding 会话 `record_json` 已约 96 KB，而其中本次变更只涉及 1 条消息。
- 每次加载会话仍把全部消息读入内存，桌面与 CLI 也必须一次拿到完整 `messages`。
- 会话列表虽然已按摘要列和 keyset 游标分页，`listSessionRows` 仍把当前页的 `record_json` 取出并逐行解析做校验，列表成本仍与正文大小相关。
- 会话列表分页只解决“找会话”，没有解决“打开会话后看历史消息”的分页问题。
- 流式输出只在内存累积，只有 run 结束才写入 assistant 消息；关闭程序、agent 进程被杀或崩溃时，整轮已生成回复会丢失。
- 桌面退出与 CLI 退出没有等待 worker/store 收口；活动 run 的最终消息可能来不及写入。

本次只解决 transcript 存储粒度、写放大、流式 checkpoint、agent 内消息分页端口和退出屏障，不新增执行事件日志。`AgentEventEnvelope` 与运行状态仍只由 `MemoryExecutionStore` 持有。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/transcript/persistence/sqlite/sqliteDatabase.ts`：schema v1、连接 PRAGMA；只接受 v1，非当前版本或结构不匹配的旧库显式失败。
  - `apps/agent/src/core/transcript/persistence/sqlite/sessionRows.ts`：session/message/draft 行读写。
  - `apps/agent/src/core/transcript/persistence/sqlite/sqliteConversationStore.ts`：增量写、草稿恢复、消息页、关闭收口。
  - `apps/agent/src/core/transcript/persistence/sqlite/draftCheckpoint.ts`：1 秒 / 2 KB 流式草稿调度。
  - `apps/agent/src/core/transcript/persistence/sqlite/messageCursor.ts`、`messagePage.ts`：消息游标与内存分页投影。
  - `apps/agent/src/core/transcript/persistence/sessionRecord.ts`：state/消息拆分、v1 schema、草稿合并与摘要投影。
  - `apps/agent/src/core/transcript/store.ts`、`memoryStore.ts`：mutation 携带脏消息 ID、`close()` 生命周期端口。
  - `apps/agent/src/core/transcript/catalog.ts`：`ConversationMessageCatalog` 只读端口。
  - `apps/agent/src/host.ts`、`apps/agent/src/core/agent/runtime.ts`、`apps/agent/src/coding/host.ts`、`apps/agent/src/answer/host.ts`：异步 shutdown 与 store 关闭。
  - `apps/desktop/src/main/index.ts`、`apps/desktop/src/main/agent/agentWorkerHost.ts`：退出屏障与 3 秒超时。
  - `apps/cli/src/main.ts`、`apps/cli/src/cli/codeCommand.ts`：CLI 退出等待 host/store。
- UI/进程/协议/持久化表面：
  - 数据库文件仍为 `<sessionsRoot>/sessions.sqlite`；后续已改为 [baseline + `_migrations` 账本](2026-11-18-sqlite-migration-baseline-and-ledger.md)，不再写 `PRAGMA user_version`。
  - 不修改 `ConversationSnapshot`、`AgentCommand`、`AgentFrame`、IPC 频道或 `packages/shared/src/schema/`。
  - 不改变 `AgentEventEnvelope` 或运行状态来源。
- 相关 Note：
  - [SQLite 会话 transcript 存储](2026-11-17-sqlite-transcript-store.md)
  - [会话历史 keyset 分页](2026-11-17-session-list-cursor-pagination.md)
  - [会话 transcript 窗口化提案](../../proposed/architecture/2026-11-18-conversation-transcript-windowing.md)

## 决定

### 1. schema v1

```sql
CREATE TABLE sessions (
  conversation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  workspace_root TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL
);

CREATE TABLE session_messages (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

CREATE TABLE session_message_drafts (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
```

- `seq` 是会话内稳定顺序，从 1 开始；插入时在同一事务内分配，不覆盖其他消息。
- `role`、`status` 是从 `message_json` 派生的查询辅助列，权威内容仍是 `message_json`。
- `state_json` 保存 `schemaVersion: 1`、`conversationId`、去掉 messages/activeRunId/eventRevision 的 snapshot、`contextState` 与 `seed`。
- `activeRunId`、`eventRevision` 不持久化；加载时归零并按 `restoreConversationSnapshot` 标为 `interrupted`。
- `title` 非空，由显式标题或首条用户消息生成；列表不再解析正文。
- 不新增消息时间戳列；当前消息没有权威时间字段。

### 2. 增量写

`ConversationStoreMutation` 显式携带 `dirtyMessageIds`：

- `beginRun` / `beginReplyRun` / `beginHandoffRun` / `beginEphemeralRun` 传新增消息 ID。
- `appendUserMessage` / `appendHandoffMessage` 传新增消息 ID。
- `run-finished` 传 assistant 消息 ID，并在同一事务更新最终消息、删除草稿。
- `setActiveAgent` / `saveContextState` 只更新 `state_json`。
- `clear` 使用 `cleared` 删除全部消息与草稿。
- `stream-checkpoint` 只写草稿，不更新 `sessions` 行、`revision`、`updated_at`。

`SqliteConversationStore.afterMutation` 对每个会话串行执行事务；普通 mutation 用 `expectedRevision` 更新摘要行，冲突抛 `ConversationSessionConflictError` 并丢弃本地未提交工作集。写失败后的下一次会话级 mutation 会把 `dirtyMessageIds` 与所有未持久化消息的并集一起补写，避免瞬时失败造成永久漏写；冲突时还会删除本进程插入消息的草稿与仍为 `streaming` 的占位行，并阻止迟到 checkpoint 写入。没有消息的新会话不落库；`clear` 用 revision CAS 删除空会话行，列表过滤 `message_count = 0`。

### 3. 流式草稿 checkpoint

- `DraftCheckpointScheduler` 只服务 `conversation`/`coding`/`interview` 等非 `answer` scope。
- 距上次 checkpoint 满 1 秒，或新增文本/推理/工具输入达到 2 KB 时触发；同一会话最多一个 pending timer。
- 文本/推理 part 完成、工具输入/执行完成、`step-finished` 等边界立即 flush。
- timer 触发时重新确认消息仍是活动 run 的 streaming assistant；已结束则丢弃。
- `run-finished` 先取消 timer、等待已入队 checkpoint，再写最终消息并删除草稿。
- checkpoint 失败只记录并保留内存脏标记，不中断模型流；`close()` 会 flush 脏草稿、等待写队列后关闭数据库。
- 崩溃后冷加载合并草稿，把 assistant 标为 `interrupted`，在同一事务写回并删除草稿。

### 4. 读取与列表

- `load` 仍全量读取该会话消息和草稿；草稿只覆盖同 ID assistant 的内容/parts/status，不改变顺序。
- 草稿非法时抛 `ConversationSessionCorruptError`，不静默丢弃。
- 列表只查摘要列，不读取 `message_json`/`state_json`；损坏会话仍能出现在列表，打开时才失败。
- `delete` 显式删除草稿、消息行和 session 行；`clear` 同步删除草稿。
- 旧 JSON 导入直接写 v1；开发期旧数据库不再迁移，启动时显式失败并要求删除，见 [会话数据库只保留最新 schema](../simplification/2026-11-18-session-schema-latest-only.md)。

### 5. 消息分页只读端口

`ConversationMessageCatalog.listMessages` 返回 `{ items, nextCursor? }`：

- 默认 50、上限 200。
- 会话在内存时直接按内存 snapshot 取页，保证活动 assistant 是当前流式内容；冷会话先走 `load` 合并草稿。
- 游标为不透明 base64url `{ v: 1, c, s }`，长度上限 512；`c` 必须与请求会话一致。
- 取最新 `limit + 1` 条，按 `seq ASC` 返回本页；`nextCursor` 指向本页最旧 `seq`，下一页取更旧消息。
- `answer` scope 不落盘，直接从内存取页。
- 本阶段不新增 shared schema、IPC、worker 命令或 UI；renderer 仍拿完整 snapshot。

### 6. 退出屏障

- `AgentRuntime.shutdown()` 先 abort 所有活动 run，等待其最终消息落账，再释放事件订阅。
- `ConversationStore.close()` 是内部生命周期端口：Memory 为 no-op；SQLite 取消 timer、flush 脏草稿、等待写队列、关闭数据库，可重复调用。
- Agent worker 收到 `shutdown` 后等待 run/store 收口，再关闭 transport。
- 桌面 `before-quit` 阻止默认退出，先向 worker 发 `shutdown` 并等待退出或 3 秒超时；超时才 kill，完成后只调用一次最终 `app.quit()`。
- CLI TUI/单次运行退出时等待 host shutdown 与 `sessionStore.close()`；SIGINT 仍先取消活动 run。

## 模块边界

- `core/transcript/store.ts`：只定义 transcript mutation 与生命周期端口；`dirtyMessageIds` 是消息身份，不是 SQL。
- `core/transcript/memoryStore.ts`：仍是消息顺序、活动 run 和 `eventRevision` 的唯一内存事实；不持有 timer。
- `core/transcript/persistence/sessionRecord.ts`：只负责 schema、拆分/合并、摘要；不执行 SQL。
- `core/transcript/persistence/sqlite/`：独占连接、DDL、schema 初始化、行 CRUD、checkpoint timer、游标和事务；不 import CLI/Electron/React/领域。
- `execution/`：继续是 Agent 事件和运行状态唯一事实来源；草稿表不保存事件，也不驱动 run 状态。
- `packages/shared`：本阶段不变。

## 曾考虑的替代方案

- **只在 run 边界持久化 assistant：** 舍弃。关闭程序或 worker 崩溃会丢整轮。
- **每个 token/delta 都写 SQLite：** 舍弃。写频率、WAL 增长和事件循环阻塞不可接受。
- **固定 300ms 批写 AgentEvent：** 舍弃。需要事件日志与回放，退出时仍可能留下未 flush 队列。
- **checkpoint 直接重写 `session_messages.message_json`：** 舍弃。活动消息越长越贵，并让未完成消息进入历史表。
- **checkpoint 更新 `sessions.updated_at/revision`：** 舍弃。列表排序抖动和无意义 revision 冲突。
- **append-only 事件 journal 做逐 delta 精确恢复：** 延后。需要 canonical 日志、flush barrier 和截断策略；当前目标是“不丢整轮”。
- **保留 `record_json` 双写：** 舍弃。两份可写正文必然产生恢复优先级和漂移。
- **每次写入对比全部消息或哈希：** 舍弃。CPU/内存随会话增长；改为显式脏 ID。
- **新增消息级写端口给 renderer/领域：** 舍弃。会绕开 run 生命周期。
- **把 parts、工具调用、图片拆成关系表：** 本阶段舍弃。当前需要消息级写入和分页，不是分析查询。
- **给消息加速度时间戳：** 舍弃。当前没有权威消息时间。
- **迁移前自动备份：** 延后到公开发布后重新引入版本迁移时决定；当前只支持最新 schema，不产生迁移窗口。
- **本阶段新增消息页 IPC/UI：** 延后到窗口化契约确定后。

## 验收标准

- 可观察结果：
  - 追加消息或完成 run 只新增/更新对应消息行和会话摘要，不再重写其他消息。
  - 列表不解析正文；损坏 `message_json` 的会话仍能列出，打开时显式失败。
  - 重启后标题、消息数、顺序、工具 part、压缩边界与关闭前一致；未完成 run 恢复为 `interrupted`。
  - 流式运行中正常关闭/SIGINT 会等待最终消息；强杀最多丢最后一次 checkpoint 之后的增量。
  - `clear`/`delete` 同时清理消息与草稿。
  - 旧 JSON 首次导入后归档，`answer` 仍不落盘。
- 自动化验证：
  - v1 往返、非当前版本与结构不匹配的旧库显式拒绝、增量写、`clear`/`delete`、checkpoint 定时/2 KB/边界 flush、checkpoint 不改 revision。
  - 崩溃恢复合并草稿并删除；草稿损坏显式失败。
  - 消息分页默认/游标/跨会话/跨 scope/冷草稿页/内存活动消息。
  - desktop worker 收到 `shutdown` 后等待退出；Agent host shutdown 等待 run/store。
  - `pnpm --filter @answra/agent typecheck`、CLI/desktop typecheck、`pnpm notes:check`、`pnpm architecture:check`。

## 后果与防回退

- `session_messages` 是已完成消息的唯一可写事实；`sessions` 只保存状态与摘要；草稿只保存活动 assistant 的最新快照。
- 不得为 renderer 或领域新增旁路消息写端口；消息只能经 run/clear 与内部 checkpoint 写入。
- 草稿不得更新 `sessions` 摘要行，也不得作为跨进程续流依据；冷启动只能得到 `interrupted`。
- 活动会话在内存期间是唯一权威；任何分页/读取不得用数据库占位覆盖内存流式消息。
- `run-finished` 必须先清理草稿再返回；最终消息与草稿不能长期并存。
- 退出路径不得直接 kill worker 或跳过 `store.close()`；桌面超时上限固定为 3 秒。
- 阶段 3 改变 renderer 可见事实边界时必须另立 Note，不得在本 Note 上直接扩写。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/transcript/sqliteConversationStore.test.ts test/core/transcript/sqliteConversationMessages.test.ts test/core/transcript/persistence/workspaceKey.test.ts`：35 项通过。
- `pnpm --filter @answra/agent test`：87 文件 / 662 项通过。
- `pnpm --filter @answra/agent exec vitest run test/core/transcript test/worker/host.test.ts`：6 文件 / 68 项通过。
- `pnpm --filter @answra/desktop exec vitest run test/agentService.test.ts`：3 项通过。
- `pnpm --filter @answra/cli exec vitest run test/cli/runCli.test.ts test/session/codingSession.test.ts test/tui/runTui.test.ts test/tui/runController.test.ts`：66 项通过。
- `pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/cli typecheck`、`pnpm --filter @answra/desktop typecheck` 通过。
- `pnpm verify` 的 lint/typecheck/Agent/desktop 测试通过；CLI 全量测试中 `tui.transcript.test.tsx` 的拖拽自动滚动既有用例失败（`expected 180 to be less than 172`），与本次存储/退出改动无调用关系，需单独修复或确认基线。
- 实机验收（Windows 11 关闭窗口/SIGINT、4 MB 级数据库升级、旧 legacy 数据）尚未执行。
- 5 分钟流式输出与 1 万条消息的性能回归尚未执行；当前只由自动化测试证明行为，不作为写放大/耗时的实测结论。

## 风险

- 开发期旧数据库会显式失败并要求删除；发布前必须重新引入迁移策略。`clear` 删除空会话行；旧空行可能仍留在开发库中，但不会进入列表。
- `title`、`message_count` 与消息行必须同一事务维护；绕过 `afterMutation` 会漂移。
- 阶段 1 仍全量读取 snapshot，长会话内存/加载耗时未改善；阶段 2 的冷会话分页也先 `load` 收口草稿，再按内存 snapshot 取页，直接 SQL 分页留给阶段 3。
- 分页若绕过“内存优先”，活动 run 会回退为数据库占位；必须用测试锁住。
- 1 秒/2 KB 是延迟与写放大折中；长回复草稿序列化和多会话并发写仍可能争用 SQLite 写锁。
- timer 必须随 run 结束、clear/delete 与 `close()` 取消；否则会在数据库关闭后写入。
- checkpoint 写入失败保留内存脏标记，但最终写失败仍按显式错误处理。
- 桌面退出屏障必须防重入和无限等待；超时后接受最多丢最后一次 checkpoint 之后的增量。
- WAL `synchronous = NORMAL` 下突然断电可能丢最后一次已提交 checkpoint；不能承诺逐字恢复。
- 同一会话跨进程仍是显式冲突，不引入租约/合并。
- `clear` 重置 `seq`；旧消息游标在清空后可能返回空页，客户端必须在 clear 后重置游标。
- `legacy/` 归档不会自动清理；空会话行不再创建，旧库中的 `quarantined_sessions` 表不再读写。
