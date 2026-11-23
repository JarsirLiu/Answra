# 持久化与恢复

本文件回答：哪个域存哪、SQLite 长什么样、启动怎么恢复、凭据放哪。

## 域 × 存储

| 域 | transcript | journal | 启动恢复 |
| --- | --- | --- | --- |
| conversation | `SqliteConversationStore` | `SqliteSessionJournal` | 懒触发 |
| interview（演练/整理） | 同上 | 同上 | 懒触发 |
| coding（CLI / 远程） | 同上 | 同上 | 懒触发 |
| answer | `MemoryConversationStore` | `MemorySessionJournal` | 不恢复、不落盘 |

- desktop：`conversation/workerTransport.ts` 在存在 `sessionsRoot` 时注入 SQLite 实现；answer 走 `workerAnswerTransport.ts` 的独立内存 host。
- CLI：`apps/cli/src/main.ts` 注入 `SqliteConversationStore(resolveDefaultConfigDir()/cli/sessions)` 与 `SqliteSessionJournal`。

## SQLite 六张表

`sessions`、`session_messages`、`session_turns`、`session_events`、`session_message_drafts`、`meta`。

六张表不是按领域拆的：conversation / interview / coding 共用同一份 schema，靠 `sessions.scope` 隔离。

| 表 | 角色 | 写者 | 为什么单独存在 |
| --- | --- | --- | --- |
| `session_events` | 唯一真相（append-only） | `SqliteSessionJournal` | 可重放；`seq` 从这里分配，`lastSeq` 也从这里算 |
| `session_messages` | transcript 投影 | `SessionTranscriptBridge` → `SqliteConversationStore` | 快照与分页读得最多，不能每次重放事件 |
| `session_turns` | Turn 投影 | `sessionTurnProjection`（只由 journal append 调用） | 恢复/调度要按 turn 查状态，不重算全量事件 |
| `sessions` | 会话目录 + 乐观锁 | store 的创建/更新 | 列表按 `(scope, updated_at)` 分页；`revision` 做并发写保护；`state_json` 存快照与上下文状态 |
| `session_message_drafts` | 进行中的流式草稿 | `DraftCheckpointScheduler`（1s 节流） | 流式输出每秒只落一次，避免每个 delta 重写整条消息 |
| `meta` | 基础设施元数据 | 迁移/旧数据导入 | 记录导入标记等一次性状态，与业务数据分开 |

边界与取舍：

- `_migrations` 是第 7 张表，属于迁移账本（`migration/ledger.ts`），不算业务 schema；「六张表」指业务表。
- 理论上只留 `sessions` + `session_events` 也能工作，其余四张都是可重建的物化或写放大优化；拆开的理由是读性能（快照/分页/按 turn 查）与崩溃恢复语义（草稿可丢、事件不可丢）。
- `state_json` 刻意不存 `lastSeq`：游标从 `session_events` 派生，避免第二份游标真相。

## 每张表的使用时机

| 表 | 什么时候写 | 什么时候读 | 平时有数据吗 |
| --- | --- | --- | --- |
| `sessions` | 每次 mutation（建会话、用户消息、turn 结束）；`revision` 条件更新 | 会话列表、打开会话、冲突检测 | 长期保留，一行一会话 |
| `session_messages` | 用户消息、turn 结束定稿；流式期间不写 | 打开会话、向上分页 | 长期保留 |
| `session_message_drafts` | 流式输出中每 1s 一次 upsert | 打开/恢复会话时合并 | 只在活动 turn 期间存在，turn 结束即删 |
| `session_events` | 每条 durable 事实（journal append） | 恢复、UI 补帧、`lastSeq` 计算 | 长期保留，append-only |
| `session_turns` | 每条 turn/step 事实（journal append 顺带投影） | 恢复与调度 | 长期保留 |
| `meta` | 迁移、旧 JSON 导入时一次 | 启动/导入判重 | 长期保留，键值对 |

真实操作序列：

1. 打开会话列表 → 只读 `sessions`（走 `(scope, updated_at)` 索引）。
2. 点进历史会话 → `sessions` → `session_messages`（分页）→ `session_message_drafts`（合并半截消息）→ `session_events`（算 `lastSeq`）→ `session_turns`（恢复调度）。若合并了草稿：写回 `session_messages`、删 drafts、`sessions.revision + 1`。
3. 发一条消息 → `session_events`（`turn-queued`）+ `session_turns` + `sessions` + 插入 `session_messages`。
4. 流式输出 → 每条 durable 事实写 `session_events` + `session_turns`；live delta 只改内存快照并推给 UI，不逐条落盘；整条消息快照按节流写 `session_message_drafts`（见下节）。
5. Turn 结束 → `session_events`（`turn-finished`）+ `session_turns` 终态 + `session_messages` 定稿 + 删除该消息的 draft + `sessions` 更新。
6. 崩溃重启 → `session_events` 找未完成 turn（`recoverFacts`）→ `session_messages` + drafts 写回（`restoreTranscript`）→ `session_turns` 续跑 queued。
7. 删除会话 → 删 `sessions` 一行；触发器删 `session_turns`、`session_events`；CASCADE 删 `session_messages`、`session_message_drafts`。
8. 旧 JSON 首次导入 → 写 `sessions`/`session_messages`，`meta` 记导入标记，避免重复导入。

## 流式期间到底写了什么

「流式」不是单一动作，落盘分三条：

| 内容 | 载体 | 时机 | 丢了会怎样 |
| --- | --- | --- | --- |
| 单个 delta（逐字） | 仅内存 snapshot + `LiveFrame` | 每个 delta | 无影响，durable 终值兜底 |
| durable 事实（`text-start`/`text-end`/`tool-call`/`tool-result`/`error` 等） | `session_events` + `session_turns` | 事件发生即写 | 不可接受，属事实丢失 |
| 整条消息快照 | `session_message_drafts` | 节流：边界事件、累计 ≥ 2048 字符、或距上次 ≥ 1s | 最多丢最后一秒的显示进度 |

- 写草稿时不是追加 delta，而是 `structuredClone` 当前内存消息整体 upsert（`persistCheckpoint`），并校验 `sessions.revision`；冲突则放弃本次草稿。
- `isCheckpointTarget` 只允许「活动 assistant 消息 + `status === "streaming"`」；answer 域（`scope === "answer"`）直接返回 false，全程纯内存、不落盘。
- Turn 结束的 `run-finished` 会删掉该消息的 draft，把定稿写进 `session_messages`；恢复时先合并 draft 回 messages，再删 draft 行。

## 迁移

- baseline 在 `schema.ts`；升级走 `_migrations` 账本 + append-only migration，禁止用全局 `SCHEMA_VERSION` 或删库。
- 会话行带 revision 乐观锁；删除由触发器收口。
- `MIGRATION_POLICY` 当前为 `pre-release`，正式发布前必须翻转。

## 恢复顺序

固定三步（`core/session/recoveryCoordinator.ts:56`）：

```text
recoverFacts(sessionId)     只写回崩溃遗留事实
  → restoreTranscript(...)  写回 assistant 消息与活动槽位
  → resumeQueued(...)       才允许 Scheduler 消费 queued Turn
```

顺序颠倒会让 Scheduler 早于 bridge 读 transcript，用户消息整条丢失。恢复懒触发，不做全局扫描；跨领域 scope 有守卫。

## 配置与凭据

| 内容 | 位置 | 约束 |
| --- | --- | --- |
| 本地模型地址/模型 ID | `@answra/config` 的 `config.json` | 只存非 secret |
| 本地模型 API Key | OS keychain（`@answra/credentials`） | keychain 不可用即 fail-closed，不回退明文 |
| 登录态 | 桌面 `safeStorage` | CLI 不得解密桌面 safeStorage 文件 |

相关：`state.md`（恢复后谁持有活动槽位）。
