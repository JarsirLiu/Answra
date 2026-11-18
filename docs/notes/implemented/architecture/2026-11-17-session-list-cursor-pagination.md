# Note：会话历史 keyset 分页

状态：已实施

后续变更：消息正文已从 `sessions.record_json` 拆到 `session_messages`，列表不再解析正文；本 Note 中“列表校验 `record_json`”的描述由 [会话消息表、流式草稿与退出屏障](2026-11-17-conversation-message-pagination.md) 取代。开发期表结构已收口为 v1，见 [会话数据库只保留最新 schema](../simplification/2026-11-18-session-schema-latest-only.md)。

## 问题

会话历史接口返回完整数组。CLI `/sessions` 面板和桌面 chat 历史虽然已有本地滚动，但仍一次读取并解析全部 `record_json`；`limit` 也只是查完全部行后在内存里截断。随着会话数量和单会话体积增长，首屏延迟、内存占用和 IPC 载荷都会线性上升，无法支撑后续“历史按页加载”。

## 涉及范围

- `packages/shared/src/schema/session.ts`：新增 `ConversationSessionPage` 及对应 schema。
- `packages/shared/src/channels/conversation.ts`、`packages/shared/src/bridge.ts`：`ListSessions` 请求增加 `cursor`、`limit`，响应改为页对象。
- `apps/agent/src/core/transcript/catalog.ts`：目录端口 `list()` 改为返回 `ConversationSessionPage`，查询增加 `cursor`。
- `apps/agent/src/core/transcript/persistence/sqlite/`：keyset 查询、游标编解码、摘要列读写（摘要列由当前 v1 schema 维护）。
- `apps/cli`：`CodingSession.listSessions()` 返回页对象；`/sessions` 面板按页追加。
- `apps/desktop`：会话历史 IPC / AgentService / preload 类型；`useChatSessions` 与历史面板提供“加载更多”。
- `packages/ui`：历史面板分页加载状态与入口。

## 决定

- 使用 keyset 分页，排序键固定为 `updated_at DESC, conversation_id ASC`。游标是不透明 base64url 字符串，内容为 `{v, u, c}`；服务端校验后转换为 SQL：
  `updated_at < ? OR (updated_at = ? AND conversation_id > ?)`。
- 默认页大小 50，最大 200；非法游标、非法页大小直接失败，不做静默截断。
- 当前 v1 schema 的 `sessions` 包含派生列 `title`、`message_count`，写入时与正文同事务更新；`record_json` 已由 `state_json` 和消息行取代。开发期旧库迁移代码已移除，见 [会话数据库只保留最新 schema](../simplification/2026-11-18-session-schema-latest-only.md)。新增索引
  `(scope, workspace_root, updated_at DESC, conversation_id ASC)`。
- 列表曾对当前页 `record_json` 做 schema 校验并把损坏行写入 `quarantined_sessions`；当前 v1 列表只读摘要列，损坏在打开时显式失败，`quarantined_sessions` 不再创建。
- CLI `/sessions` 首次取一页；焦点在最后一行继续 `↓`/`PgDn` 时按 `nextCursor` 追加下一页，并按 `conversationId` 去重。
- 桌面历史面板保持现有列表交互，在底部提供“加载更多”；加载失败保留已加载页和错误提示。
- `/resume` 的完整 ID 先走 `getSession` 直查，不受最近 200 条限制；前缀搜索仍读取最近 200 条。CLI 面板支持复制完整 ID 与删除，见 [CLI 会话面板按 ID 查删与复制](../feature/2026-11-18-cli-session-panel-delete-copy.md)。

## 模块边界

- `packages/shared` 只拥有页对象 schema、IPC 请求/响应和 bridge 类型；不解析游标，不实现排序。
- `apps/agent/src/core/transcript/catalog.ts` 只声明分页查询与页返回；`persistence/sqlite/` 独占游标编解码、keyset SQL、页大小校验和摘要列维护。
- `apps/cli` 的 `CodingSession` 只转发 `cursor`/`limit` 并返回页对象；TUI 面板只负责追加和去重，不拆解游标。
- `apps/desktop` 的 IPC 只校验来源、scope、游标字符串和页大小，再把请求交给 `AgentService`；`packages/ui` 只维护已加载页和“加载更多”交互。
- 任何宿主都不得自行拼 SQL、按 `updatedAt` 排序或恢复全量列表再截断。

## 曾考虑的替代方案

- **`LIMIT/OFFSET`**：实现简单，但会话 `updated_at` 会变化，翻页时容易重复或跳过；深页仍需扫描偏移量，舍弃。
- **继续在内存里 `slice`**：不减少数据库读取、解析和 IPC 载荷，不能满足分页目标，舍弃。
- **把游标直接暴露为 `updatedAt|conversationId`**：调用方可伪造或误解析排序键；改为不透明游标，由存储层保留格式演进空间，舍弃直接暴露。
- **新增独立摘要表**：能进一步隔离写放大，但会引入另一份需要同步的会话摘要事实源；本次先放在 `sessions` 派生列，保持同一行、同一事务，暂不采用独立表。
- **把 transcript messages 拆表**：这是会话内消息分页的方案，不是会话列表分页；本次不混做，保留为后续独立决策。

## 后果与防回退

- 列表排序仍以 `updated_at` 为准；分页期间某会话被更新会导致该会话在新旧页之间移动，可能重复或漏掉一次。前端按 `conversationId` 去重，重复可见不会造成数据损坏；需要强一致快照时必须另设分页截止时间。
- `title`、`message_count` 是从 transcript 派生的读模型，只能与消息正文在同一事务写入；禁止出现独立可写摘要路径。当前 v1 起由 `state_json` 与 `session_messages` 投影维护。
- 损坏行校验依赖当前页解析；不再全表扫描意味着损坏行只有进入某页时才被发现并隔离。当前 v1 列表不再解析正文，损坏在 `load`/消息页读取时显式失败。
- 游标只允许存储层编解码；UI 与 IPC 不得拆解游标内容。
- `/sessions` 的旧行为是一次展示全部；新行为需要用户继续向下加载。不要恢复“先取全量再内存截断”的兼容路径。
- 桌面和 CLI 都使用同一页对象与同一排序语义；不要各自实现第二套分页规则。

## 验证

- Agent：`pnpm --filter @answra/agent test`；新增 keyset 分页无重复、非法游标、空会话过滤与按 ID 直查测试。
- CLI：`pnpm --filter @answra/cli test`，58 文件 / 372 项通过；`/sessions` 面板新增最后一行触发加载更多测试。
- UI：`pnpm --filter @answra/ui test`，47 文件 / 330 项通过；新增 `useChatSessions` 游标加载和历史面板“加载更多”测试。
- Desktop：`pnpm --filter @answra/desktop test`，53 文件 / 350 项通过。
- 类型与静态检查：Agent/CLI/UI/desktop typecheck、`pnpm lint`、`pnpm notes:check`、`pnpm architecture:check` 通过。
- 实机验收待执行：CLI 与桌面在超过一页历史时连续加载、滚动到最后一页、删除后刷新首屏。
