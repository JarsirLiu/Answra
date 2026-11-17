# Note：会话消息表与消息分页

状态：提案

## 问题

[SQLite 会话 transcript 存储](../../implemented/architecture/2026-11-17-sqlite-transcript-store.md) 已经解决会话级持久化、跨进程写入冲突和会话列表分页，但 transcript 正文仍全部放在 `sessions.record_json`：

- 每次用户消息、run 开始/结束、清空或上下文状态变化，都要重写整份会话 JSON；工具输出越多，写放大越明显。
- 每次加载会话仍把全部消息读入内存，桌面与 CLI 也必须一次拿到完整 `messages`，长会话的恢复和 IPC 都随消息数增长。
- 会话列表虽然已经按摘要列和 keyset 游标分页，`listSessionRows` 仍把 `record_json` 取出并逐行解析做校验，列表成本仍与正文大小相关。
- 会话列表分页只解决“找会话”，没有解决“打开会话后看历史消息”的分页问题。

本次要解决的是 transcript 消息的存储粒度和读取分页，不是执行事件日志。`AgentEventEnvelope` 与运行状态仍只由 `MemoryExecutionStore` 持有，不新增事件表、事件回放或第二套 run 状态。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/transcript/persistence/sqlite/`：schema v3、消息行读写、迁移、分页查询。
  - `apps/agent/src/core/transcript/persistence/sessionRecord.ts`：会话状态与消息的拆分、恢复语义、摘要投影。
  - `apps/agent/src/core/transcript/store.ts`、`catalog.ts`：消息追加/更新与消息页读取端口。
  - `packages/shared/src/schema/`、`packages/shared/src/channels/conversation.ts`、`packages/shared/src/bridge.ts`：消息页 schema 与 IPC。
  - `apps/desktop/src/main/conversation/`、`packages/ui/src/app/`、`apps/cli/src/tui/`：首批分页消费方。
- UI/进程/协议/持久化表面：
  - SQLite 文件仍为 `<sessionsRoot>/sessions.sqlite`，schema 从 v2 升到 v3。
  - 不改变 `AgentCommand`、`AgentFrame` 或事件 envelope。
  - 会话列表的 keyset 分页保持现有契约；新增消息级分页契约。
- 相关 Note：
  - [SQLite 会话 transcript 存储](../../implemented/architecture/2026-11-17-sqlite-transcript-store.md)
  - [会话历史 keyset 分页](../../implemented/architecture/2026-11-17-session-list-cursor-pagination.md)
  - [会话上下文压缩与归档](2026-11-13-conversation-context-compaction-and-archive.md)
  - [可切换的内存与 SQLite 存储边界](2026-11-08-switchable-memory-sqlite-storage.md)

## 提案

采用“会话状态 + 消息行”两层结构，`session_messages` 成为消息正文的唯一可写事实，`sessions` 只保存会话状态和列表摘要。分两阶段实施，先消除整份 `record_json` 重写，再开放消息分页。

### 1. schema v3

```sql
CREATE TABLE session_messages (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE,
  UNIQUE (conversation_id, seq)
);

CREATE INDEX session_messages_seq
  ON session_messages(conversation_id, seq DESC);
```

- `message_json` 保存完整 `ConversationMessage`，包括 parts、工具输出和图片引用；本阶段不把 parts 拆成更多表。
- `seq` 是会话内单调递增的稳定顺序，使用 `SELECT COALESCE(MAX(seq), 0) + 1` 在 `BEGIN IMMEDIATE` 事务内分配。消息不重排，不允许覆盖其他消息的 `seq`。
- `role/status` 是查询辅助列，权威内容仍是 `message_json`；写入时从消息对象派生，不单独维护第二份可写状态。
- `sessions` 保留 `conversation_id`、`scope`、`workspace_root`、`created_at`、`updated_at`、`revision`、`title`、`message_count`，新增 `state_json`。`state_json` 只保存不含 `snapshot.messages` 的会话状态：contextState、seed、activeAgentId 等 per-conversation 字段；不再保留 `record_json.messages`。
- `activeRunId` 仍不持久化；加载时继续把 `streaming` 消息和未完成工具标记为 `interrupted`，把进行中的压缩标记为 `aborted`。

### 2. 写入边界

- `beginRun`：同一事务内插入用户消息、插入 assistant 占位消息、更新 `sessions.revision/updated_at/message_count`。
- run 完成：同一事务内更新 assistant 消息行、更新会话摘要和 revision；不重写其他消息。
- 流式 token 仍只更新内存，不在每个 delta 上写数据库。若未来要持久化 partial，必须另立节流/恢复提案，不能顺手把高频写入塞进当前路径。
- `clear`：同一事务内删除该会话全部 `session_messages`，清空 `state_json` 中的上下文状态并把 `message_count` 归零。
- `delete`：删除 `sessions` 行，外键级联删除消息。
- 每次写入仍使用 `sessions.revision` 做 compare-and-swap；消息行更新与会话 revision 必须在同一事务提交，避免消息已写、会话版本未变的半提交。
- `message_count` 只由同一事务维护，不能靠后台补偿“修正”；如果出现不一致，应视为 bug，而不是允许双写。

### 3. 读取与分页

- 新增消息页契约 `ConversationMessagePage`：

```ts
interface ConversationMessagePage {
  items: ConversationMessage[];
  nextCursor?: string;
}
```

- `listMessages(conversationId, { cursor?, limit? })` 默认返回最近 50 条，最大 200 条；游标为不透明字符串，内部编码 `(seq)` 或 `(updated_at, message_id)`，不把 SQLite 行号暴露给 UI。
- 查询按 `seq DESC` 取 `limit + 1` 条，再反转成消息顺序返回；`nextCursor` 指向更早的一页。
- 首批只给“查看历史”用：CLI 会话恢复和桌面历史面板先加载最近一页，向上滚动再取下一页；实时 run 仍只更新当前活动消息，不允许分页结果覆盖本地流式尾部。
- Agent 运行模型所需的完整上下文仍由 transcript store 在内部读取，不把“UI 分页”误当成“模型上下文只加载一页”。压缩边界、checkpoint 和 `messageCount` 仍按完整会话计算。
- 会话列表查询改为只读 `title/message_count` 等摘要列，不再把 `record_json` 取出并解析；损坏记录校验移到加载路径或显式维护命令，避免列表成本与正文大小挂钩。

### 4. 迁移

`PRAGMA user_version` 升到 3，在单个 `BEGIN IMMEDIATE` 事务中完成：

1. 创建 `session_messages` 与索引，给 `sessions` 增加 `state_json`。
2. 逐行读取 v2 `record_json`，校验 `SessionRecordPayload`。
3. 将 `snapshot.messages` 按原顺序写入消息行，`seq` 从 1 开始。
4. 将不含 `snapshot.messages` 的状态写入 `state_json`，保留原 `revision/title/message_count/created_at/updated_at`。
5. 删除或停止读取 `record_json` 中的消息正文，不能迁移后继续保留两份可写正文。
6. 解析失败的行进入 `quarantined_sessions`，不阻塞其他会话迁移；迁移失败整体回滚，不允许半迁移状态。
7. 迁移完成后写 `PRAGMA user_version = 3`，重启再次打开只读新结构。

旧 JSON 文件导入仍只负责生成 v2 记录，随后立即走同一 v3 迁移，不新增第三套格式。

### 5. 实施顺序（下一步）

1. **先做 v3 消息表与写路径，不改 UI 契约。** 保持现有 `ConversationSnapshot` 全量消息读取，让现有 CLI/桌面行为不变；只把写入从整份 `record_json` 改为消息行。用契约测试证明往返、排序、清空、删除、恢复、contextState 与旧实现一致。
2. **把会话列表从正文解耦。** `listSessionRows` 不再查询 `record_json`，只读摘要列；补损坏行隔离和列表测试。
3. **再加消息分页端口与 IPC。** 引入 `ConversationMessagePage`，CLI 恢复与桌面历史面板先消费最近一页；保留内部完整上下文读取，避免模型侧行为变化。
4. **最后评估按页水合。** 如果长会话内存仍是瓶颈，再讨论“只加载尾部 + 按需加载旧页”的模型上下文策略；在压缩 checkpoint 和工具调用恢复语义没有验证前，不先改内部上下文加载。
5. **性能验证。** 记录 1 万条消息会话的写入字节数、恢复耗时和内存占用，确认写放大从“整份会话”降到“单条消息 + 会话摘要”。

## 模块边界

- `core/transcript/persistence/sqlite/`：只负责连接、schema、消息行 CRUD、分页 SQL 和迁移；不 import CLI、Electron、React 或领域模块。
- `core/transcript/persistence/sessionRecord.ts`：只负责会话状态 schema、消息/状态拆分和恢复归一化；不执行 SQL。
- `core/transcript/store.ts`：只声明 transcript 端口；消息分页是读取端口，不是第二套 transcript 状态机。
- `packages/shared/src/schema/`：消息页与游标类型；不出现 SQLite 表名、行号或连接信息。
- `apps/desktop/src/main/conversation/`、`packages/ui/src/app/`、`apps/cli/src/tui/`：只消费分页端口和事件；不直接读数据库，不自行推断消息顺序。
- `execution/`：继续是 `AgentEventEnvelope` 与运行状态的唯一事实来源；消息表不保存事件，也不驱动 run 状态。

## 曾考虑的替代方案

- **继续用单个 `record_json`，用 SQLite JSON 函数做消息分页：** 舍弃。读取可以分页，但每次变更仍重写整份 JSON，写放大和恢复内存问题没有解决。
- **保留 `record_json` 全量正文，只在 UI 侧缓存分页：** 舍弃。数据库仍随消息增长，跨进程/重启后仍要全量加载，只是把成本藏到客户端。
- **改成 append-only 事件日志或 JSONL：** 舍弃。会重新引入事件回放、半行、compact 截断和损坏恢复，并容易与 `AgentEventEnvelope` 混淆成第二套事实。
- **每条消息一个文件：** 舍弃。目录规模、事务边界、清理和跨进程并发都比 SQLite 行更差，无法获得原子会话更新。
- **把 parts、工具调用、图片全部拆成关系表：** 舍弃（本阶段）。当前需要的是消息级写入和分页，不是分析型查询；过早规范化会把流式 part 生命周期复制到更多表。
- **保留 `record_json.messages` 同时写消息表，做“双写兼容”：** 舍弃。两份可写正文必然产生恢复优先级和漂移问题；迁移必须在同一事务中完成切换。

## 验收标准

- 可观察结果：
  - 用户消息和 run 完成只更新对应消息行，不再重写整份会话 JSON。
  - 打开长会话先返回最近一页消息，向上翻页顺序稳定，不重复、不丢消息。
  - 会话列表查询不再读取/解析 `record_json`。
  - `clear` 后消息页为空、`message_count` 为 0；`delete` 后消息行级联删除。
  - 重启后未完成 run 仍恢复为 `interrupted`，历史消息顺序与关闭前一致。
- 自动化验证：
  - v2→v3 迁移往返、空会话、单条消息、长会话、损坏行隔离、重复迁移幂等。
  - 消息追加/更新/清空/删除的 revision 与会话摘要一致性；同一会话跨进程冲突仍显式失败。
  - 消息分页边界：默认 50、上限 200、`limit + 1` 探测、无更多数据、非法游标。
  - CLI/desktop 现有 transcript、恢复、压缩、工具 part 测试保持通过；新增分页消费测试。
  - `pnpm verify`、`pnpm notes:check`、架构检查。
- 需要的实机验证：
  - Windows 11 CLI 长会话向上翻页、运行中切换会话后回到活动尾部。
  - 桌面历史面板加载最近一页、滚动加载旧页、恢复后发送新消息。
  - 旧数据库首次升级后重启仍可列会话、读消息、删除和压缩。

## 风险

- 消息行与 `sessions.message_count/revision` 若不在同一事务更新，会出现列表数量和正文不一致；必须用单一事务边界。
- 流式消息只在 run 完成时落最终状态，进程崩溃仍可能丢失 partial 文本；这是当前“不逐 token 持久化”的有意代价，恢复时只能标记 `interrupted`。
- 分页与实时事件并发时，旧页结果可能晚于本地流式更新到达；客户端必须只把分页结果插入历史区，不能覆盖活动消息尾部。
- 压缩 checkpoint 引用 `throughMessageId` 和消息数；拆表后必须保证消息 ID、顺序和计数稳定，否则压缩边界会指向错误位置。
- 大数据库迁移会长时间持有写事务并产生 WAL 增长；需要在迁移前后验证磁盘空间、busy timeout 和失败回滚。
- 先拆表但不改内部全量加载，能解决写放大但不解决内存；不要把阶段一误称为“消息分页已完成”。
- 如果未来需要保留 `record_json` 做导出，只能作为一次性导出产物，不能重新变成可写事实。
