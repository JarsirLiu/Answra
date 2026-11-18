# Note：会话数据库只保留最新 schema

状态：已实施

后续变更：本文描述的“只支持最新 schema、版本不匹配就删库”已由 [SQLite 迁移基线、账本与版本纪律](../architecture/2026-11-18-sqlite-migration-baseline-and-ledger.md) 取代。当前代码使用 `_migrations` 账本，保留本文作为禁止版本号 churn 的决策背景；不要再按本文实现运行时版本 gate。

## 问题

SQLite transcript 尚未公开发布，开发期曾因连续调整表结构出现过多个中间版本号。版本号被当成迭代计数器，导致同一个未提交改动里反复提升版本，既误导文档，也没有真实的旧库兼容收益。开发期没有外部用户，版本号应只表达当前唯一的 DDL，而不是开发轮次。

`sqliteDatabase.ts` 还维护过开发期版本的行迁移、外键切换、损坏行隔离与对应测试。每次改表都要继续兼容这些中间版本，成本已经高于收益，也让“最新 schema 是唯一事实”变得不清晰。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/transcript/persistence/sqlite/sqliteDatabase.ts`
  - `apps/agent/src/core/transcript/persistence/sqlite/sessionRows.ts`
  - `apps/agent/src/core/transcript/persistence/sessionRecord.ts`
  - `apps/agent/test/core/transcript/sqliteConversationStore.test.ts`
- UI/进程/协议/持久化表面：SQLite schema 为 v1；不再创建仅用于旧版迁移的 `quarantined_sessions` 表；草稿表带 `base_revision`；`state_json` 使用 `schemaVersion: 1`。
- 相关 Note：
  - [SQLite 会话 transcript 存储](../architecture/2026-11-17-sqlite-transcript-store.md)
  - [会话消息表、流式草稿与退出屏障](../architecture/2026-11-17-conversation-message-pagination.md)

## 决定

- 当前最终 DDL 定为 v1；打开数据库时只接受 `user_version = 0`（新建）或 `1`（当前结构）。
- `user_version` 为其它值时直接失败并提示删除数据库文件：`会话数据库版本不兼容：<version>（当前只支持 1）。请删除 <path> 后重试。`
- 因为开发机上的历史库也可能标记为 v1，打开 v1 数据库时额外校验当前表和列；缺表或缺列直接失败并提示删除，不尝试迁移或读写半成品结构。
- 删除开发期行迁移、`sessionRecord` 迁移解析、`quarantined_sessions` 表与 `quarantineSessionRow()`。
- 旧 `<conversationId>.json` 文件导入继续保留；它不属于 schema 版本迁移，且已有一次性 marker 与归档行为。

## 移除内容

- 开发期数据库行迁移与外键切换逻辑。
- `quarantined_sessions` 表与对应测试断言。
- 迁移期逐行解析、snapshot 一致性校验和损坏行隔离代码。

## 重新引入条件

- 公开发布后，任何 schema 变更必须重新引入版本迁移或显式升级流程；不能继续沿用“只支持最新版本”的开发期策略。
- 需要恢复历史开发库时，必须先从版本控制/备份中找回旧代码完成一次性导出，再写入当前 schema；不得把迁移逻辑重新塞回运行时。
- 发布前不得再为中间改动提升 schema 版本；表结构定稿后只保留一个未发布版本号。

## 曾考虑的替代方案

- **保留开发期多个版本号直到发布：** 舍弃。没有外部用户，继续维护只会扩大测试面并掩盖 schema 演进成本。
- **旧版本自动删除并重建：** 舍弃。静默丢数据比显式失败更难排查；当前选择让用户明确删除文件。
- **把旧版迁移移出运行时、放进一次性脚本：** 舍弃。仓库目前没有需要保留的旧数据库集合，脚本没有实际消费者。
- **彻底移除旧 JSON 导入：** 舍弃。它独立于 schema 版本，且已有一次性导入测试；本次只收敛数据库版本路径。
- **为复用 v1 的历史库加自动迁移：** 舍弃。版本号复用只发生在开发期，结构校验 + 显式删库足够，不值得恢复迁移代码。

## 验收标准

- 可观察结果：
  - 新建数据库为 v1，包含 `sessions`、`session_messages`、`session_message_drafts`、`meta`，草稿表带 `base_revision`。
  - 非当前版本数据库启动时显式失败；复用 v1 但缺少当前表/列的旧库也显式失败。
  - 旧 JSON 文件仍可导入并归档。
- 自动化验证：
  - `initializes a new database with the current schema version`。
  - `rejects a database with a different schema version instead of migrating it`。
  - `rejects a v1 database whose tables predate the current schema`。
  - 现有往返、legacy 导入、冲突与分页测试通过。

## 后果与防回退

- 开发机上的历史 `sessions.sqlite` 需要手动删除；启动错误会给出路径。
- 发布前必须补回迁移策略；不能用“只支持最新版本”处理真实用户升级。
- 不得在没有版本迁移的情况下修改已有列语义；发布后需要改表时提升 `user_version` 并新增迁移 Note。
- 未发布期间不得把版本号当迭代计数器；表结构未定稿前不要反复提升版本号。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/transcript/sqliteConversationStore.test.ts test/core/transcript/sqliteConversationMessages.test.ts test/core/transcript/persistence/workspaceKey.test.ts`：35 项通过。
- `pnpm --filter @answra/agent test`：87 文件 / 662 项通过。
- `pnpm --filter @answra/agent typecheck` 通过。

## 风险

- 开发者若不阅读错误直接删库，会失去本地开发会话；这是有意的显式失败代价。
- v1 在开发期被复用，结构校验是最后防线；若未来新增表/列但忘记更新 `REQUIRED_SCHEMA`，可能出现运行期错误。
