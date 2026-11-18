# Note：会话持久化写失败补写与冲突残留清理

状态：已实施

## 问题

SQLite transcript 适配器在四个边界上会留下不一致状态：

- `persist()` 只写本次 mutation 的 `dirtyMessageIds`。事务因 `SQLITE_BUSY`、磁盘满或权限失败回滚后，`persistedMessageIds` 不前进，但之前的消息也不会进入下一次 dirty 集合，重启后出现 assistant 消息存在而对应 user 消息缺失。
- 冲突处理按“本进程插入 + `status = 'streaming'`”删除占位行。胜方可能已经 `load` 并把这些行纳入自己的消息集合，败方清理后胜方的 `message_count` 仍包含该行，但 `session_messages` 已少一条；冷加载出现历史缺失与列表计数不一致。
- `delete` 直接按 ID 删行，不看 `revision` 与 `conflicted`；`clear`/`delete` 的 CAS 删除在版本不匹配时仍会继续删除 `session_messages` 与草稿。冲突后或另一个进程刚写完后，旧进程可以删掉胜方数据。
- 草稿没有记录基于哪个 `revision`；迟到的 checkpoint 不校验数据库版本，冷加载又无条件合并草稿。两个进程同会话时，旧草稿可以覆盖胜方较新的正文。
- `beginRun`/`beginReplyRun`/`beginHandoffRun` 先改内存再持久化；SQLite 写失败后内存里的 `activeRunId` 残留，后续 `send`、`clear`、`delete` 一律被“当前回复尚未完成”拒绝，只能重启进程。
- `create()` 立即落库，`/new`、删除当前会话后的重建也会创建空会话；列表出现大量 `messageCount = 0` 的“未命名会话”。
- `workspace_root` 使用精确字符串比较；Windows 下同一目录以不同大小写启动会看到两套互不可见的历史。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/transcript/persistence/sqlite/sqliteConversationStore.ts`
  - `apps/agent/src/core/transcript/persistence/sqlite/sessionMessageMap.ts`
  - `apps/agent/src/core/transcript/persistence/sqlite/sessionRows.ts`
  - `apps/agent/src/core/transcript/persistence/workspaceKey.ts`
  - `apps/agent/test/core/transcript/`
- UI/进程/协议/持久化表面：数据库 schema 收口为 v1，`session_message_drafts` 增加 `base_revision`；列表不再显示空会话；Windows workspace 比较不区分大小写；冲突败方保留已提交占位行并标记 `interrupted`。
- 相关 Note：
  - [SQLite 会话 transcript 存储](../architecture/2026-11-17-sqlite-transcript-store.md)
  - [会话消息表、流式草稿与退出屏障](../architecture/2026-11-17-conversation-message-pagination.md)

## 决定

保留 SQLite 单活跃后端；在现有消息/草稿表上补 `base_revision`，修正写入集合、冲突清理、删除 CAS、内存回滚、空会话和 workspace 比较。不引入租约、owner 列或第二套消息事实；跨进程同一会话仍只保证显式冲突，不提供合并语义。

## 根因

- 增量写把“本次变更消息”当成“全部待写消息”，没有把上次失败后仍未持久化的消息并回写队列。
- 冲突路径把“本进程插入的 streaming 占位行”当作可删除的未提交数据，但消息行在事务提交后已属于会话历史；胜方可能在败方清理前已读取它。
- 删除与 CAS 删除没有把版本校验作为子行清理的前置条件；`delete` 也没有把 `conflicted` 当作拒绝条件。
- 草稿只保存正文，没有保存写入时看到的 session revision；加载侧因此无法区分“当前草稿”与“迟到草稿”。
- 内存先变更、持久化后失败缺少回滚；`activeRunId` 是唯一会让后续所有 mutation 都拒绝的状态，所以失败代价被放大。
- 会话行创建与首条消息写入解耦，空会话被视为有效历史。
- 工作区键直接使用展示路径；Windows 大小写不敏感的事实没有进入比较键。

## 修复

- `dirtyMessages()` 接收 `persistedMessageIds`，返回 `mutation.dirtyMessageIds` 与所有未持久化消息的并集，并按当前消息顺序排列；写失败后的下一次会话级 mutation 会补写之前漏掉的消息。
- 记录 `ownedMessageIds`：仅本进程成功插入的消息进入集合。冲突时只删除这些消息的草稿，把仍为 `streaming` 的已提交占位行标记为 `interrupted`，不删除消息行；已完成的本地回复保持不变。冲突会话加入 `conflicted` 集合，后续 checkpoint 与持久化任务在入队前后都跳过。
- `delete` 拒绝 `conflicted` 会话，等待未完成的写入后按当前/本地 `revision` 做 CAS；版本不匹配抛 `ConversationSessionConflictError`。`deleteSessionRowWithRevision` 只有删除会话行成功时才清理消息与草稿，CAS 失败不得触碰胜方数据。
- 草稿表增加 `base_revision`。checkpoint 在事务内校验数据库 revision 等于本地 revision 才写入；冷加载只合并 `base_revision === stored.revision` 的草稿，其余草稿直接删除。有效草稿合并后递增 session revision，避免迟到写者继续覆盖。
- `beginRun`、`beginReplyRun`、`beginHandoffRun`、`beginEphemeralRun` 在持久化失败时恢复调用前的内存会话；若冲突处理已经 `forgetSession`，则不复活会话。
- 没有消息且没有已存行时跳过持久化；`clear` 用 `revision` CAS 删除会话行与消息/草稿，保留内存会话供继续输入；列表增加 `message_count > 0` 过滤。
- 新增 `workspaceStorageKey()`：Windows 折叠大小写；`listSessionRows()` 在 Windows 用 `LOWER(workspace_root)` 比较，展示值保持原样。

## 曾考虑的替代方案

- **失败后清空内存并强制重新加载：** 舍弃。瞬时写失败不应丢弃用户当前输入，补写是更小的恢复代价。
- **给草稿表增加 `base_revision`：** 采用。只需在现有草稿表加一列，就能让加载与 checkpoint 判断草稿是否基于当前会话版本；真正支持同会话多写仍需另立租约/合并 Note。
- **冲突时删除本进程插入的 streaming 占位行：** 舍弃。消息行在事务提交后已属于会话历史，胜方可能已读取；删除会把“败方清理”变成“胜方丢消息”。
- **冲突时删除整个会话的草稿：** 舍弃。可能删掉胜方仍在写的草稿；只删除本进程插入消息的草稿。
- **CAS 失败后仍清理消息/草稿：** 舍弃。删除会话行失败说明版本已变化，继续删子行会直接破坏胜方数据。
- **所有空会话都保留但列表过滤：** 舍弃。旧空行会持续占用数据库；直接不创建并在 clear 时删除。
- **大小写统一小写后落库：** 舍弃。会让桌面/CLI 展示路径被改写；比较时折叠大小写即可。
- **解析 `message_json` 判断占位行是否为空：** 舍弃。多一次正文解析；利用 `status = 'streaming'` 即可区分未完成占位与已提交回复。

## 验收标准

- 可观察结果：
  - 模拟写失败后继续发消息，失败前已进入内存的消息在重启后仍存在；`beginRun` 写失败后可以继续发消息而不是被 active run 卡死。
  - 冲突败方的草稿被删除，已提交占位行保留并标记 `interrupted`；胜方下次冷加载仍能看到完整消息集合，列表计数与行数一致。
  - 冲突后旧进程的 `delete` 被拒绝；版本不匹配的 `delete`/`clear` 不删除胜方的消息与草稿。
  - 基于旧 revision 的草稿在加载时被忽略并删除，不会覆盖较新正文。
  - 新建/清空后没有消息的会话不出现在列表中。
  - Windows 下 `D:\WorkSpace` 与 `d:\workspace` 命中同一历史。
- 自动化验证：
  - `sqliteConversationMessages.test.ts` 新增写失败补写、冲突清理、`beginRun` 回滚、过期草稿加载/写入用例。
  - `sqliteConversationStore.test.ts` 新增空会话、按 ID 直查、Windows 大小写、旧 schema 拒绝、重复 legacy 文件、`clear`/`delete` CAS 失败保护用例。
  - `workspaceKey.test.ts` 覆盖 win32/linux 归一化。
- 需要的实机验证：Windows 11 上 CLI 以不同大小写目录启动后能看到同一批历史。

## 后果与防回退

- 会话级写失败后必须保留未持久化消息，直到下一次成功事务补齐；禁止回到只写 `dirtyMessageIds` 的路径。
- 冲突清理只能删除本进程未提交的草稿；已提交消息行只能标记 `interrupted`，不得删除。不得删除胜方数据，也不得把冲突失败降级为静默覆盖。
- `delete` 必须拒绝 `conflicted` 会话并做 revision CAS；CAS 删除失败时不得清理子行。
- 草稿必须携带 `base_revision`；加载与 checkpoint 都必须按 revision 过滤，禁止无条件合并旧草稿。
- 活动 run 的持久化失败必须恢复内存会话；冲突已丢弃会话时不得复活。
- `message_count = 0` 不得作为可恢复历史展示；空会话不能产生 `sessions` 行。
- Windows workspace 比较必须使用同一 `workspaceStorageKey`；不得在调用方各自拼大小写。
- 跨进程同一会话仍不是可用功能；本次只保证冲突失败时本地残留可控。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/transcript/sqliteConversationStore.test.ts test/core/transcript/sqliteConversationMessages.test.ts test/core/transcript/persistence/workspaceKey.test.ts`：35 项通过。
- `pnpm --filter @answra/agent test`：87 文件 / 662 项通过；`pnpm --filter @answra/desktop test`：53 文件 / 350 项通过。
- `pnpm --filter @answra/cli test`：381 项通过，1 项既有失败 `tui.transcript.test.tsx > auto-scrolls while a drag selection stays past the viewport edge`（`expected 180 to be less than 172`），与本次持久化/面板改动无调用关系，隔离重跑仍复现。
- `pnpm lint`、全包 `pnpm typecheck`、`pnpm architecture:check`、`pnpm tokens:check`、`pnpm notes:check` 通过。

## 风险

- 跨进程写仍用整数 `revision` CAS；两个进程从不同快照分支写入时可能出现同版本号。本次只清理失败方残留，不提供合并语义。
- 冲突清理现在不吞异常：清理失败会向上抛出并仍执行 `forgetSession`/`conflicted` 标记；极端磁盘错误下的用户可见错误会从“会话冲突”变成“清理失败”，但不会留下被静默删除的已提交行。
- 草稿 `base_revision` 只阻止旧草稿覆盖，不提供同会话并发合并；两个进程同时运行仍需显式冲突。
- Windows `LOWER()` 只处理 ASCII 大小写；非 ASCII 目录名的大小写差异仍需后续统一。
- `SqliteConversationStore` 已超过 400 行预算，本次先保证写入/冲突/恢复正确，文件拆分需另立结构 Note。
