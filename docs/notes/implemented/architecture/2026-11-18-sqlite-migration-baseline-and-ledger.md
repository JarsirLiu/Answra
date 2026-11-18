# Note：SQLite 迁移基线、账本与版本纪律

状态：已实施

## 问题

SQLite 持久化曾把 `SCHEMA_VERSION` 当成开发迭代计数器。开发期每调整一次表结构就提升一次版本，出现 v2、v3、v4，最后又在未发布阶段收回为 v1；版本变化没有带来真实的旧库兼容收益，反而制造了三类问题：

- 打开数据库时只接受一个固定版本，其他版本直接要求删除 `sessions.sqlite`，这不是迁移，而是放弃已有数据。
- `REQUIRED_SCHEMA` 与 `CORE_SCHEMA` 是两份手工维护的结构定义，新增表或列时容易只改一份，运行时才暴露漂移。
- 没有已执行迁移账本、没有升级测试、没有 CI 检查，任何表结构变更都依赖开发者记忆和人工删库。

这套策略只适用于“没有用户、随时可删库”的短暂阶段。公开发布后必须升级已有用户数据库，不能继续用版本号 gate 和删库提示。另一个独立问题是 `state_json.schemaVersion` 表示行内 JSON payload 版本，不能和 SQLite 表结构版本一起升降。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/transcript/persistence/sqlite/schema.ts`
  - `apps/agent/src/core/transcript/persistence/sqlite/sqliteDatabase.ts`
  - `apps/agent/src/core/transcript/persistence/sqlite/transaction.ts`
  - `apps/agent/src/core/transcript/persistence/sqlite/migration/`
  - `apps/agent/scripts/db/check.ts`
  - `apps/agent/scripts/db/generate.ts`
  - `scripts/db/reset.mjs`
  - `apps/agent/test/core/transcript/databaseMigration.test.ts`
  - `apps/agent/test/core/transcript/sqliteConversationStore.test.ts`
  - `package.json`、`apps/agent/package.json`、`.github/workflows/ci.yml`
  - `scripts/architecture/architecture-check.mjs`：允许 `apps/agent/scripts/` 像 desktop/cli 脚本一样使用 Node 内置模块
- UI/进程/协议/持久化表面：CLI 的 `%APPDATA%/Answra/cli/sessions/sessions.sqlite`、桌面端的 `<userData>/desktop-sessions/sessions.sqlite`、数据库启动迁移、旧 JSON 导入和 `state_json` 持久化格式。
- 相关 Note：
  - [会话数据库只保留最新 schema](../simplification/2026-11-18-session-schema-latest-only.md)
  - [SQLite 会话 transcript 存储](2026-11-17-sqlite-transcript-store.md)
  - [会话消息表、流式草稿与退出屏障](2026-11-17-conversation-message-pagination.md)
  - [可切换的内存与 SQLite 存储边界](../../proposed/architecture/2026-11-08-switchable-memory-sqlite-storage.md)

## 决定

采用“单一 schema 来源 + baseline + 迁移账本”的结构，不再用全局 `SCHEMA_VERSION` 决定是否打开数据库。

### 实际文件布局

```text
apps/agent/src/core/transcript/persistence/sqlite/
├─ schema.ts                  # 当前完整 DDL，唯一事实来源
├─ sqliteDatabase.ts          # 连接、PRAGMA、调用迁移 runner
├─ transaction.ts             # BEGIN IMMEDIATE 事务原语
├─ migration/
│  ├─ types.ts                # Migration { id, checksum, up(tx) }
│  ├─ checksum.ts             # 规范化空白后的 SHA-256
│  ├─ policy.ts               # pre-release / released
│  ├─ baseline.ts             # 从 schema.ts 取得 baseline 和 checksum
│  ├─ ledger.ts               # _migrations 表与读写
│  ├─ backup.ts               # VACUUM INTO 备份
│  ├─ runner.ts               # fresh / upgrade / 校验
│  ├─ registry.gen.ts         # 生成的 migration 列表
│  └─ schema.snapshot.json    # 生成的 schema checksum 与迁移快照
└─ sqliteConversationStore.ts # 业务适配器，只读写业务表
```

`registry.gen.ts` 与 `schema.snapshot.json` 由 `pnpm db:generate` 生成；开发期当前没有 migration，registry 为空。

### 启动流程

```text
打开 sessions.sqlite
  → 设置 WAL、synchronous=NORMAL、busy_timeout、foreign_keys
  → 没有 _migrations：
       若已有业务表 → 失败，提示运行 pnpm db:reset --yes（不自动删库）
       否则在同一事务里应用 baseline、创建 _migrations、写入全部已知迁移 id
  → 已有 _migrations：
       校验未知迁移 id 与 checksum
       按 id 顺序逐个执行 pending migration
       每条的 DDL 与账本写入在同一事务
       执行前用 VACUUM INTO 创建带时间戳的备份
```

约束：

- `PRAGMA user_version` 不再作为兼容性开关，也不再写入；保留它只作为人工诊断信息。
- 新库不重放历史 migration；只应用当前 baseline，并把当前已知迁移全部标记为已完成。
- 数据库含有程序不认识的迁移 id 时失败，表示数据库比程序新，禁止降级写入。
- 已应用 migration 的 checksum 变化时失败；发布后只能新增修正 migration。
- 迁移失败只回滚当前 migration 并停止启动；备份文件保留。
- 发布后不再出现“删除数据库后重试”的用户提示；删库只走开发命令 `pnpm db:reset --yes`。

### 发布前策略

- 当前 `MIGRATION_POLICY = "pre-release"`，`MIGRATIONS` 为空。
- schema 改动直接修改 `schema.ts`，然后运行 `pnpm db:generate` 更新 snapshot。
- 不新增 migration，不提升任何全局版本号。
- 现有 v1 开发库没有 `_migrations`，打开时显式失败；运行 `pnpm db:reset --yes` 后重新生成。
- `pnpm db:reset --yes` 只删除 CLI 与桌面开发用户目录下的 `sessions.sqlite`、WAL/SHM 和备份，不删除 `legacy/` 归档，也不触碰打包版 `Answra` 用户目录。

### 发布后策略

首次发布时把 `MIGRATION_POLICY` 改为 `released`，然后：

- 每次 schema 变更新增一个 migration 文件，并运行 `pnpm db:generate`。
- 已发布 migration 不编辑、不删除、不重命名；修正必须新增 migration。
- 新库仍应用 baseline，不重放全部历史 migration。
- `db:check` 在 schema 变化但没有新增 migration、或快照/registry 过期时失败。
- 只做 forward migration；回滚依赖数据库备份。

### 命令

- `pnpm db:check`：校验 registry/snapshot、fresh DB、重复打开无变更；已接入 `pnpm verify` 与 CI。
- `pnpm db:generate`：重建 registry 与 schema 快照；发布后阻止漏迁移和修改已发布 migration。
- `pnpm db:test`：运行迁移 runner 的 fresh、升级、幂等、checksum、未来版本、回滚测试。
- `pnpm db:reset --yes`：删除本地开发数据库文件，保留 legacy 归档。

### 版本分离

以下三种版本不得同时升降：

- 应用版本：产品发布版本。
- 数据库迁移：`_migrations` 中的已执行 id 集合。
- 行内 payload 版本：例如 `state_json.schemaVersion`，只在 JSON 结构需要 upcaster 时变化。

增加列、索引或表只影响 schema/migration，不应自动提升 `state_json.schemaVersion`。

## 模块边界

- `schema.ts`：当前表结构唯一来源；baseline 和 snapshot 从它生成。
- `migration/`：迁移类型、账本、runner、备份和生成物；不 import transcript 业务逻辑。
- `sqliteDatabase.ts`：只负责连接、PRAGMA、调用 runner 和关闭连接。
- `sessionRows.ts`、`sqliteConversationStore.ts`：只读写业务表；不创建表、不判断版本。
- `legacySessionImport.ts`：只做旧 JSON 一次性导入；不承担 schema 升级。
- `apps/cli`、`apps/desktop`：只决定数据库根目录并注入 store；不持有 DDL 或迁移逻辑。
- 当前只有 transcript 一个持久化领域，迁移能力留在 transcript 的 `persistence/sqlite/migration/`；出现第二个共享数据库的领域时，把通用 runner 上提到 `apps/agent/src/core/database/`，领域只保留自己的 schema 和 migrations。
- 同一个宿主配置只保留一个应用数据库文件；不按 feature 新建 `answer.sqlite`、`interview.sqlite` 等分叉数据库。

## 曾考虑的替代方案

- **继续使用单一 `SCHEMA_VERSION`，只更谨慎地提升：** 舍弃。它仍然只能表达“支持或不支持”，无法记录已执行的多个迁移，也无法安全升级旧库。
- **版本不匹配时自动删除并重建数据库：** 舍弃。开发期可接受，发布后会造成静默数据丢失；改为备份、迁移、失败即停。
- **保留“只支持最新 schema”，发布后再补迁移：** 舍弃。发布时一次性补迁移会同时面对未知旧结构、缺失账本和没有升级测试，风险最大。
- **新库也逐条执行全部历史 migration：** 舍弃。历史 SQL 会长期保留并可能依赖旧假设；新库直接应用当前 baseline。
- **只使用 `PRAGMA user_version` 作为迁移记录：** 舍弃。单个整数无法保存多迁移 id、checksum、未知未来版本和部分失败信息，只会再次诱发版本号 churn。
- **强制引入 Drizzle ORM 和 Drizzle Kit：** 未采用。继续使用 `node:sqlite`，用手写 SQL migration 和 `db:generate`/`db:check` 实现等价门禁。
- **提供 down migration：** 舍弃。本地应用优先 forward-only 和备份恢复；维护双向迁移会显著扩大测试面。
- **把数据迁移和 DDL 混在同一条 migration：** 舍弃。DDL 失败和数据回填失败的恢复方式不同，分开账本更容易定位和重试。
- **按领域拆分多个数据库：** 舍弃。跨领域的会话、事件和索引会失去同一事务边界；一个宿主 profile 使用一个应用数据库。

## 验收标准

- 可观察结果：
  - 新建数据库会创建 baseline 和 `_migrations`，不会执行历史 migration。
  - 已是最新库再次启动不执行任何迁移，`_migrations` 不变化。
  - 旧版本 fixture 启动后只执行缺失迁移，数据保留，并产生备份。
  - 数据库包含代码未知的迁移 id 时启动失败。
  - 已应用迁移 checksum 变化时启动失败。
  - 迁移失败时当前迁移回滚，原数据库仍可打开，错误包含备份路径。
  - 发布后不再出现要求用户删除数据库的错误文案。
- 自动化验证：
  - `databaseMigration.test.ts` 覆盖 fresh、升级、幂等、checksum、未知未来 id、失败回滚和 pre-ledger 数据库。
  - `db:check` 覆盖 registry/snapshot、fresh DB schema 与 baseline 一致、重复打开不产生第二次写入。
  - `pnpm db:test` 与全量 `pnpm test` 通过。
- 需要的实机验证：
  - Windows CLI 与桌面端真实数据库路径、WAL 文件、文件锁和备份路径。
  - 迁移过程中进程退出后重新打开的行为。
  - macOS 持久化路径和大小写不敏感文件系统仍缺少实机证据，需在发布前补齐。

## 后果与防回退

- 现有 v1 开发库没有迁移账本，必须运行 `pnpm db:reset --yes` 后重建；这是未发布阶段的一次性代价。
- `PRAGMA user_version` 不再写入 1；依赖该值的开发脚本应改用 `_migrations` 或直接检查表结构。
- 发布前必须保持 `MIGRATIONS` 为空；发布后不得再把 schema 改动直接压在 baseline 上。
- 首次发布时必须把 `MIGRATION_POLICY` 改为 `released` 并运行 `pnpm db:generate`，否则 `db:check` 不会执行发布后的漏迁移检查。
- 不得重新引入 `SCHEMA_VERSION`、`REQUIRED_SCHEMA` 或“版本不匹配就删库”的运行时分支。
- 迁移失败不得吞掉错误继续启动；备份文件不得静默删除。
- 旧 JSON 导入的 `legacy-import:<root>` 标记与 schema 账本相互独立；升级测试不能把两者混为同一个完成状态。

## 验证

- `pnpm db:check`：通过（0 个迁移，策略 pre-release）。
- `pnpm db:test`：7 项迁移 runner 测试通过。
- `pnpm --filter @answra/agent exec vitest run test/core/transcript/databaseMigration.test.ts test/core/transcript/sqliteConversationStore.test.ts test/core/transcript/sqliteConversationMessages.test.ts`：3 文件 / 41 项通过。
- `pnpm --filter @answra/agent test`：88 文件 / 669 项通过。
- `pnpm typecheck`：所有包通过。
- `pnpm lint`：通过。
- `pnpm notes:check`：通过。
- `pnpm verify` 聚合运行被既有 `apps/cli/test/tui/transcript/tui.transcript.test.tsx` 的 `auto-scrolls while a drag selection stays past the viewport edge` 失败阻断（`expected 180 to be less than 172`）；agent、desktop、ui 测试与本次数据库变更通过，CLI 失败为既有问题。

## 风险

- 迁移 runner 增加启动路径复杂度；必须保持“打开失败即停止”，不能在迁移失败后继续提供半可用会话。
- `VACUUM INTO` 备份会暂时增加磁盘占用；需要保留策略和明确的清理命令，不能静默删除备份。
- 多进程同时启动时，进程内状态不足以协调；依赖 SQLite `BEGIN IMMEDIATE` 与 `busy_timeout`，未实现跨进程迁移锁协议。
- 开发期允许改 `schema.ts` 会产生分支合并冲突；这是未发布阶段换取简单性的代价，首次发布后必须停止 squash 已发布迁移。
- 旧 JSON 导入与 schema 迁移是两条独立路径；测试和文档不得把两者混为同一个完成状态。
