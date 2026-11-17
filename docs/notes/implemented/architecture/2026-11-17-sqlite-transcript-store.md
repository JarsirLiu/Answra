# Note：SQLite 会话 transcript 存储

状态：已实施

后续变更：会话列表已改为 keyset 游标分页并增加摘要列，见 [会话历史 keyset 分页](2026-11-17-session-list-cursor-pagination.md)。消息正文仍保存在 `record_json`，拆分消息表与消息分页尚未实施，见 [会话消息表与消息分页](../../proposed/architecture/2026-11-17-conversation-message-pagination.md)。

## 问题

CLI 与桌面的会话历史目前由 `FileConversationStore` 承担：每个会话一个 `<conversationId>.json` 全量快照，写入临时文件后 rename。它能满足单进程恢复，但存在三个边界：

- 跨进程写同一会话没有锁或版本检查，后写者会整文件覆盖先写者；
- 会话列表需要扫描并解析整个目录，无法按 scope/workspace 建索引；
- 每次 transcript 变更都重写整份快照，文件越大写入成本越高。

`2026-11-14-cli-desktop-session-history.md` 当时因 `node:sqlite` 仍偏实验性而没有引入 SQLite。现在 Node 22.14 与 Electron 35 都已内置 `node:sqlite`（`DatabaseSync`），不需要原生依赖或 electron-rebuild，可以重新评估。

本次要解决的是**会话 transcript 的存储后端**，不是执行事件日志。`AgentEventEnvelope` 与运行状态仍由 `MemoryExecutionStore` 唯一持有；不新增第二套事件表、事件投影或运行状态表，避免把 transcript 快照和事件事实拆成两个真相源。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/transcript/persistence/`：SQLite 适配器、会话记录 schema、旧 JSON 导入；
  - `apps/agent/src/index.ts`、`apps/agent/src/composition.ts`：公开入口换为 SQLite store；
  - `apps/cli/src/main.ts`：CLI 会话根目录注入；
  - `apps/desktop/src/main/conversation/workerTransport.ts`：桌面 worker 注入；
  - `apps/agent/test/core/transcript/`：存储契约、迁移与并发冲突测试。
- UI/进程/协议/持久化表面：
  - CLI `/sessions`、`/resume`、`/delete` 行为不变；
  - 桌面历史列表、恢复、删除行为不变；
  - 数据库文件为 `<sessionsRoot>/sessions.sqlite`，CLI 与桌面仍各自独立；
  - 不修改 `AgentCommand`、`AgentFrame`、IPC 频道或 `packages/shared/src/schema/`。
- 相关 Note：
  - [共享 transcript 仓储归属](2026-11-08-core-transcript-store.md)
  - [CLI 与桌面独立会话历史](2026-11-14-cli-desktop-session-history.md)
  - [可切换的内存与 SQLite 存储边界](../../proposed/architecture/2026-11-08-switchable-memory-sqlite-storage.md)

## 决定

### 1. 只保留 SQLite 一个活跃后端

`SqliteConversationStore` 继承 `MemoryConversationStore`，与现有 `FileConversationStore` 保持相同的端口语义：内存工作集负责消息、活动 run、Bot 归属和 `eventRevision`；`afterMutation` 把 `ConversationSessionRecord` 写进数据库。

不实现 JSONL 第二后端。JSONL 的“并行”来自每会话独立文件和每进程独立 session，同会话多写仍需要锁；同时要额外维护 append 顺序、partial line、compact 截断和损坏恢复。可读/导出需求后续用 `sessions export` 生成 JSON 或 JSONL，不把导出格式变成运行时存储。

### 2. 数据库结构

数据库文件固定为 `join(resolve(sessionsRoot), "sessions.sqlite")`。打开时设置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

业务表只保存会话记录与索引，不保存 Agent 事件：

```sql
CREATE TABLE sessions (
  conversation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  workspace_root TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL
);
CREATE INDEX sessions_scope_updated ON sessions(scope, updated_at DESC);
CREATE INDEX sessions_scope_workspace_updated
  ON sessions(scope, workspace_root, updated_at DESC, conversation_id ASC);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE quarantined_sessions (
  conversation_id TEXT NOT NULL,
  record_json TEXT,
  reason TEXT NOT NULL,
  quarantined_at TEXT NOT NULL
);
```

`record_json` 复用现有 `SessionRecordPayload` schema：snapshot、contextState、seed 和 metadata 是唯一 transcript 事实。`revision` 只是存储层的 compare-and-swap 版本，不是会话状态；不写 `activeRunId`，加载时仍按 `restoreConversationSnapshot` 移除活动 run、把未完成内容标为 `interrupted`、把 `eventRevision` 归零。

### 3. 并发语义

- 不同会话：同一数据库的不同 `conversation_id`，WAL 下可并行读写。
- 同一进程同一会话：沿用内存 store 的 `activeRunId` 单活动 run 约束；数据库写按会话串行。
- 同一会话跨进程：每次写入带 `expectedRevision`，使用
  `UPDATE sessions SET ... revision = revision + 1 WHERE conversation_id = ? AND revision = ?`；
  版本不匹配时抛 `ConversationSessionConflictError`，不静默覆盖。
- 本次不引入租约/心跳；需要同一会话多窗口同时写入时，再单独立 Note 增加 lease 或合并协议。当前明确是“显式失败”，不是“假装支持”。

### 4. 旧数据迁移

首次打开数据库时扫描 `sessionsRoot` 下旧 `<conversationId>.json`：

1. 用现有 `parseSessionRecord` 校验；
2. 在事务中 `INSERT OR IGNORE` 到 `sessions`，`revision = 0`；
3. 成功和损坏文件都移动到 `sessionsRoot/legacy/`，损坏文件保留 `.corrupt-<timestamp>` 后缀；
4. 在 `meta` 写入 `legacy-import:<root>` 标记，避免重复导入；
5. `answer` scope 的旧文件不导入，保持“答题只在内存、不落盘”的既有边界。

### 5. 列表与删除

- `list` 用 SQL 按 `scope`、`workspace_root` 过滤，按 `updated_at DESC, conversation_id ASC` 排序，使用 keyset 游标分页；标题和消息数来自写入时维护的 `title`、`message_count` 摘要列，不解析 `record_json`。
- 列表行仍会校验 `record_json` 可解析；损坏的行移入 `quarantined_sessions`，从 `sessions` 删除，并跳过该行；不静默吞掉用户数据。后续消息表提案会把正文校验从列表查询中拆出。
- `delete` 先检查内存中是否有活动 run；有则拒绝。数据库删除与内存删除在同一调用内完成。
- `answer` scope 的 create/load/delete 全部走内存，不产生数据库行。

### 6. 组合根

- CLI：`new SqliteConversationStore(join(resolveDefaultConfigDir(), "cli", "sessions"))`。
- 桌面：`new SqliteConversationStore(options.sessionsRoot)`，`sessionsRoot` 仍由 `agentWorkerHost` 解析为 `userData/desktop-sessions`。
- `FileConversationStore` 从公开入口移除；文件解析和恢复 helper 保留给旧数据导入。
- 数据库连接在 store 构造时打开；测试通过 `close()` 释放，进程退出由 OS 回收。

## 模块边界

- `core/transcript/store.ts`：只定义 transcript 端口，不出现 SQLite 或文件路径。
- `core/transcript/catalog.ts`：只定义列表/删除端口。
- `core/transcript/persistence/sessionRecord.ts`：会话记录 schema、序列化/恢复和摘要；不依赖 SQLite。
- `core/transcript/persistence/sqlite/`：只实现 SQLite 连接、建表、读写和冲突检测；不 import CLI、Electron、React 或领域模块。
- `core/transcript/persistence/legacy/`：只处理旧 JSON 文件扫描和迁移。
- `execution/`：继续是 `AgentEventEnvelope` 与运行状态的唯一事实来源；本次不新增事件表、事件回放或运行状态表。
- 宿主（CLI、desktop worker）：只解析根目录、注入 store；不直接执行 SQL。

## 曾考虑的替代方案

- **继续使用 JSON 文件快照：** 舍弃。单进程简单，但跨进程同一会话会整文件覆盖，列表需要全目录解析，无法提供索引和版本冲突检测。
- **JSONL 事件日志 + 单写者锁：** 舍弃。需要自行维护 append 顺序、尾部半行、compact 截断、损坏恢复和锁租约；与 SQLite 解决同一问题时多出一套存储状态机，且容易与 `AgentEventEnvelope` 混淆成第二套事件事实。
- **SQLite 只存索引、消息仍写 JSON 文件：** 舍弃。两处写入无法原子提交，删除/恢复会出现索引与正文不一致。
- **同时保留 SQLite 与 JSONL 两个运行时后端：** 舍弃。需要两套契约测试、迁移、备份、损坏处理和并发语义；用户需要的是并行与可靠性，不是格式选择。
- **把 `AgentEventEnvelope` 也持久化到 SQLite：** 舍弃。本次目标是 transcript；事件事实仍只由 execution store 持有，避免出现第二套事件来源和状态投影。
- **直接使用 `better-sqlite3`：** 舍弃。需要原生模块和 Electron rebuild；`node:sqlite` 已在目标运行时可用，先使用内置能力。

## 验收标准

- 可观察结果：
  - CLI 与桌面重启后仍能列出、恢复、删除原会话；
  - 数据库文件位于各自 `sessionsRoot`，两端不共享；
  - 旧 `<id>.json` 首次启动后导入并归档到 `legacy/`；
  - 同一会话两个 store 的并发写入产生显式冲突错误，而不是静默覆盖。
- 自动化验证：
  - SQLite store 通过现有文件 store 的往返、列表、删除、恢复、contextState、scope、`answer` 内存隔离测试；
  - 旧 JSON 导入、损坏行隔离、版本冲突、不同会话并行写入测试；
  - `pnpm --filter @answra/agent test`、CLI/desktop 类型检查、`pnpm architecture:check`、`pnpm notes:check`。
- 需要的实机验证：
  - Windows 11 上 CLI `/sessions`、`/resume`、`/delete` 与桌面历史恢复/删除；
  - 旧 JSON 数据首次迁移后重启仍可读取；
  - 数据库不可写或 schema 版本不匹配时显式失败，不回退静默内存。

## 后果与防回退

- 运行时只有一个活跃 transcript 后端：`SqliteConversationStore`。不要再引入 `FileConversationStore` 或 JSONL 运行时适配器；旧 JSON 只作为一次性迁移输入。
- `AgentEventEnvelope`、运行状态和消息状态仍只来自现有 `execution` 与 `packages/shared/src/schema/`；数据库不新增事件表、事件回放表或第二套运行状态表。
- `answer` scope 必须继续只走内存，不能因为换成 SQLite 就被写入历史。
- 同一会话跨进程写入失败时不得静默覆盖；当前版本会丢弃本地未提交工作集，要求重新加载。需要真正并行写同一会话时必须另立租约/合并 Note。
- 数据库 schema 变更必须提升 `PRAGMA user_version` 并在同一变更中提供迁移；不得在未知版本上继续读写。
- `record_json` 是唯一 transcript 正文；如果未来拆 messages 表，必须保持同一事实来源和恢复语义，不能并行保留两份可写正文。

## 验证

- 聚焦测试：`pnpm --filter @answra/agent exec vitest run test/core/transcript/sqliteConversationStore.test.ts`，10 项通过；覆盖往返、列表、删除、未完成 run 恢复、contextState、损坏行隔离、`answer` 内存隔离、scope 校验、旧 JSON 导入、跨 store 冲突和不同会话并行。
- 全量测试：`pnpm --filter @answra/agent test` 85 文件 / 636 项通过；`pnpm --filter @answra/cli test` 59 文件 / 378 项通过；`pnpm --filter @answra/desktop test` 53 文件 / 350 项通过。
- 门禁：`pnpm verify`、`pnpm notes:check`、`pnpm architecture:check`、Agent/CLI/desktop typecheck 均通过；`pnpm verify` 在 Windows 11 上完成全仓 lint、测试、架构检查和设计令牌检查。
- 运行时探测：Node 22.14 与 Electron 35（`ELECTRON_RUN_AS_NODE=1`）均可加载 `node:sqlite` 的 `DatabaseSync`。
- 实机验证待执行：Windows 11 上 CLI `/sessions`、`/resume`、`/delete`，桌面历史恢复/删除，以及旧 JSON 首次迁移后重启读取。自动化测试不等同于实机验收。

## 风险

- `node:sqlite` 在 Node 22.14 仍是 experimental，API 可能变化；适配器隔离在 persistence 层，升级运行时需重跑契约测试。Electron 35 的 Node 22.14 已实测可加载 `DatabaseSync`。
- 全量 `record_json` 写入仍会随消息增长放大写放大；当前与文件 store 等价，后续若要优化可把 messages 拆表，但不能因此新增第二套消息事实。
- WAL 会产生 `-wal`/`-shm` 文件；备份和清理策略需要后续单独决定。
- 跨进程同一会话目前是显式冲突，不是可用功能；需要多窗口写同一会话时必须另立租约/合并 Note。
- 旧数据归档到 `legacy/` 后不会自动清理；磁盘占用需要后续清理策略。
