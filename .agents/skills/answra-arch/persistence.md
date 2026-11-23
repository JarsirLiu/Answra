# 持久化与恢复

本文件回答：哪个域存哪、SQLite 长什么样、启动怎么恢复、凭据放哪。

## 域 × 存储

| 域 | durable 条目 | 内存 transcript | 启动恢复 |
| --- | --- | --- | --- |
| conversation | `SqliteSessionItemStore`（`store.items`） | `SqliteConversationStore` | 懒触发 |
| interview（演练/整理） | 同上 | 同上 | 懒触发 |
| coding（CLI / 远程） | 同上 | 同上 | 懒触发 |
| answer | `MemorySessionItemStore` | `MemoryConversationStore` | 不恢复、不落盘 |

- 条目是 durable 唯一真相；`ConversationStore` 只持有本次进程的消息与活动槽位，`refresh()` 从条目重建，打开历史与崩溃恢复走同一条路。
- desktop：`conversation/workerTransport.ts` 在存在 `sessionsRoot` 时注入 SQLite 的 store 与 `.items`；answer 走 `workerAnswerTransport.ts` 的独立内存 host。
- CLI：`apps/cli/src/main.ts` 注入 `SqliteConversationStore(resolveDefaultConfigDir()/cli/sessions)`，条目端口取同一个 store 的 `.items`。

## SQLite 两张业务表

`sessions`、`session_items`（另有 `_migrations` 迁移账本，不算业务 schema）。

两张表不按领域拆：conversation / interview / coding 共用同一份 schema，靠 `sessions.scope` 隔离。

| 表 | 角色 | 写者 | 为什么单独存在 |
| --- | --- | --- | --- |
| `session_items` | 唯一真相（append-only） | `SqliteSessionItemStore.appendItems` | 一行一个已结算 part/事件；`seq` 从这里分配，`lastSeq` 也从这里算 |
| `sessions` | 会话目录 + 写入游标 | `SqliteConversationStore` 的建会话/更新 | 列表按 `(scope, updated_at)` 分页；同事务维护 `next_seq` / `open_turn_id` / `message_count`；`state_json` 存会话级状态 |

边界与取舍：

- 没有 `session_events`、`session_messages`、`session_turns`、`session_message_drafts`、`meta`；消息由条目折叠，不再有整条消息行，也没有每秒草稿行。
- `lastSeq` 不落库：恒等于 `sessions.next_seq - 1`，避免第二份游标真相。
- `state_json` 不存正文，只存会话级状态（见下节）。
- 理论上只留 `session_items` 也能工作；`sessions` 买的是列表分页、游标与活动指针的原子维护。

## 两张表的形状

`sessions`：`conversation_id`（PK）、`scope`、`workspace_root`、`created_at`、`updated_at`、`title`、`message_count`、`next_seq`（`DEFAULT 1`）、`open_turn_id`、`state_json`。

- `next_seq` 是下一条要分配的 `seq`；空会话为 1。
- `open_turn_id` 只在 `beginTurn` 置位；`finishTurn` 与该 Turn 的 `turn-end` 在同一事务清空。它只用来解释「这个 Turn 为什么没有 `turn-end`」。
- `state_json` = `{ schemaVersion: 1, conversationId, snapshot, contextState?, seed? }`；`snapshot` 已去掉 `messages` / `activeTurnId` / `activeMessageId` / `lastSeq`，剩 `activeAgentId`、参与者、`bots`、压缩/用量/清理状态。

`session_items`：`conversation_id`、`seq`、`item_id`、`kind`、`status`、`turn_id`、`message_id`、`author_agent_id`、`audience_agent_id`、`created_at`、`payload_json`；主键 `(conversation_id, seq)`，唯一约束 `(conversation_id, item_id)`。

- `kind`：`user` / `text` / `reasoning` / `tool-call` / `tool-result` / `turn-end`。
- `status`：`complete` / `interrupted` / `failed`；`tool-call` / `tool-result` 行恒为 `complete`，工具成败由 `payload.outcome` 表达。
- `user` / `turn-end` 不带 `message_id`；`user` 的 `item_id` 就是消息 id。
- 只允许 INSERT；同一 `item_id` 重复写入是 no-op，同一条目多来源只写一次。

## 每张表的使用时机

| 表 | 什么时候写 | 什么时候读 | 平时有数据吗 |
| --- | --- | --- | --- |
| `sessions` | 建会话、每次 mutation 更新 `updated_at`；追加条目后同事务更新 `next_seq` / `message_count` / `open_turn_id` | 会话列表、打开会话、读游标 | 长期保留，一行一会话 |
| `session_items` | 用户消息、`text`/`reasoning` 结算、`tool-call`/`tool-result`、`turn-end` | 打开会话、恢复、补帧、`lastSeq` 计算 | 长期保留，append-only |

真实操作序列：

1. 打开会话列表 → 只读 `sessions`（走 `(scope, updated_at)` 索引）。
2. 点进历史会话 → `sessions` → `session_items`（按 `seq` 升序）→ 折叠成消息；活动 Turn 从 `open_turn_id` 判断。
3. 发一条消息 → 追加 `user` 条目（`turn_id` 用消息 id）；排队中不置 `open_turn_id`。
4. Turn 真正开始 → `beginTurn` 置 `open_turn_id`，推送快照。
5. 流式输出 → 见下节。
6. Turn 结束 → 先补未结算 part，再追加 `turn-end`，同事务清 `open_turn_id` 并推进 `next_seq`。
7. 崩溃重启 → `readItems` → `planSessionRecovery` 补收口条目 → `refresh` 重建视图 → 续跑 queued Turn。
8. 删除会话 → 删 `sessions` 一行；外键 `ON DELETE CASCADE` 清 `session_items`。
9. 旧 JSON 首次导入 → 折叠成条目写入两张表，文件移入 `legacy/`。

## 流式期间到底写了什么

「流式」不是单一动作，落盘只有两类：

| 内容 | 载体 | 时机 | 丢了会怎样 |
| --- | --- | --- | --- |
| 单个 delta（逐字） | 仅内存 snapshot + `LiveFrame` | 每个 delta | 无影响，条目兜底 |
| `tool-call` / `tool-result` | `session_items` | 事件发生即写 | 不可接受，属事实丢失 |
| `text` / `reasoning` | `session_items` | `text-end` / `reasoning-end` 结算时写完整正文 | 未结算的那一段随内存消失（已接受） |
| `turn-end` | `session_items` | Turn 终态，与清 `open_turn_id` 同事务 | 不可接受：终态归因与恢复都靠它 |

- 顺序是硬约束：先应用内存视图，再从结算后的 part 生成条目。`text-end` / `reasoning-end` 的事件不带正文，正文只存在于内存 part，反过来会写出空文本。
- 没有「进行中消息」行，也没有节流整行重写；崩溃最多丢最后一个未结算 part。
- 点停止或崩溃：`finishTurn` 先补写未结算 part（正文 `text{interrupted}`）、给已落库的 `tool-call` 补 `tool-result{error}`，再写 `turn-end`，所以停止不丢正文。
- 折叠容忍缺失 `turn-end`：`open_turn_id` 指向的按 `running`，其余按 `interrupted`。

## 迁移

- baseline 在 `schema.ts`；升级走 `_migrations` 账本 + append-only migration，禁止用全局 `SCHEMA_VERSION` 或删库。
- 旧六表在 `20261123130000_drop_legacy_session_tables` 中删除，顺序固定 trigger → table → column；升级测试用「删会话清空条目」验证外键仍生效。
- 旧 JSON 导入与表迁移分成两步：先 `openSessionDatabase`（跑迁移），再 `importLegacySessionFiles`。
- `MIGRATION_POLICY` 当前为 `pre-release`，正式发布前必须翻转。

## 恢复顺序

固定三步（`core/session/recoveryCoordinator.ts`）：

```text
recoverFacts(sessionId)         补写崩溃遗留的收口条目
  → refreshTranscript(...)      用条目重建内存消息视图
  → resumeQueued(...)           才允许 Scheduler 消费 queued Turn
```

`recoverFacts` 只调用纯函数 `planSessionRecovery`（`core/session/sessionTurns.ts`）：

- 有内容但没有 `turn-end` → 补缺失的 `tool-result{error}` 与 `turn-end{interrupted, process-exit}`；
- 只有 `user` 条目 → 重新入队，不重复写 `user`；
- 同一份条目重复恢复必须幂等（第二次不再产出收口条目）。

顺序颠倒会让 Scheduler 早于视图重建读 transcript，用户消息整条丢失。恢复只由会话所属领域懒触发，不做全局扫描。

## 配置与凭据

| 内容 | 位置 | 约束 |
| --- | --- | --- |
| 本地模型地址/模型 ID | `@answra/config` 的 `config.json` | 只存非 secret |
| 本地模型 API Key | OS keychain（`@answra/credentials`） | keychain 不可用即 fail-closed，不回退明文 |
| 登录态 | 桌面 `safeStorage` | CLI 不得解密桌面 safeStorage 文件 |

相关：`state.md`（恢复后谁持有活动槽位）、`events.md`（条目怎么产生）。
