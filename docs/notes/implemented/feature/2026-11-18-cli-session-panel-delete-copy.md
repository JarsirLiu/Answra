# Note：CLI 会话面板按 ID 查删与复制

状态：已实施

## 问题

CLI `/resume` 与 `/delete` 都先用 `listSessions({ limit: 200 })` 在最近 200 条中查找。早于 200 条的会话即使输入完整 ID 也提示“没有匹配的会话”；`/sessions` 面板只显示 8 位 ID，损坏或旧会话无法在面板内删除，也不能直接复制完整 ID。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/transcript/catalog.ts`、`persistence/sqlite/sessionRows.ts`：按 ID 读取摘要。
  - `apps/cli/src/session/codingSession.ts`、`adapters/agentCodingHost.ts`：暴露 `findSession`。
  - `apps/cli/src/tui/commands/handlers/session.ts`：`/resume`、`/delete` 优先按完整 ID 直查。
  - `apps/cli/src/tui/panels/SessionsPanel.tsx`、`panelHandlers.ts`、`app/App.tsx`：`Ctrl+Y` 复制 ID、`Ctrl+D` 二次确认删除。
- UI/进程/协议/持久化表面：CLI TUI 键位与面板文案；不改变 IPC、worker 协议或桌面历史入口。
- 相关 Note：
  - [会话历史 keyset 分页](../architecture/2026-11-17-session-list-cursor-pagination.md)
  - [会话持久化写失败补写与冲突残留清理](../bug-fix/2026-11-18-session-persistence-durability-and-conflict-cleanup.md)

## 决定

- `ConversationSessionCatalog` 增加 `getSession(conversationId, workspaceRoot?)`；SQLite 按主键读取摘要，不解析正文，也不受分页窗口限制。CLI 适配器只接受 `scope = "coding"` 且 workspace 匹配的结果。
- `CodingSession.findSession()` 在宿主不提供直查时返回 `undefined`，`/resume` 继续回退到最近 200 条的前缀搜索；`/delete` 回退到列表存在性校验。
- `/resume <完整 ID>` 先直查，命中即恢复；前缀仍只搜索最近 200 条，避免无条件全表扫描。
- `/sessions` 面板新增：
  - `Ctrl+Y` 复制当前选中会话的完整 ID。
  - `Ctrl+D` 第一次进入确认态，第二次才调用删除；删除当前会话后关闭面板，删除其他会话后从本地列表移除。
  - 复制/确认/删除结果在面板内以提示行显示；失败保留列表与选择。
- 面板删除复用 `TuiRunController.delete()` 的忙状态检查与当前会话重建逻辑，不新增第二套删除规则。

## 影响表面

- 用户可在面板内完成“找到旧会话、复制 ID、删除”的闭环，不再需要手抄 8 位前缀或用 `/delete` 反复试。
- 超过 200 条的精确 ID 恢复/删除可用；前缀搜索仍受最近 200 条限制，这是明确保留的折中。

## 曾考虑的替代方案

- **把列表上限提高到 1000/全量：** 舍弃。仍不能保证旧会话可达，且放大首屏查询和 IPC 载荷。
- **面板内输入搜索：** 可作为后续增强；本次先复用现有方向键/翻页与直查，避免引入第二套筛选状态。
- **删除只输入 ID、不提供面板入口：** 舍弃。用户需要先复制完整 ID，而面板原先只显示 8 位。
- **删除当前会话时只删除不重建：** 舍弃。`CodingSession` 的运行态要求始终有活动会话；重建空会话且不落库已经由持久化修复覆盖。

## 验收标准

- 可观察结果：
  - `/resume <完整 ID>` 能恢复不在最近 200 条中的会话。
  - `/delete <完整 ID>` 能删除不在最近 200 条中的会话。
  - `Ctrl+Y` 写入完整 ID；`Ctrl+D` 二次确认后才删除；删除失败显示错误且不丢列表。
- 自动化验证：
  - `sessionsPanel.test.tsx` 覆盖复制、二次确认删除、当前列表更新。
  - `sqliteConversationStore.test.ts` 覆盖按 ID 直查。
- 需要的实机验证：Windows 11 终端上 Ctrl+Y/Ctrl+D 不会被终端或输入法截获。

## 后果与防回退

- 精确 ID 操作必须走 `getSession` 直查；不得恢复“先列最近 200 条再查找”的唯一路径。
- 面板删除必须二次确认，且只能通过 `TuiRunController.delete()`；不得在面板内直接调用 catalog 绕过忙状态检查。
- 前缀搜索的 200 条上限是已知限制；提高或移除时需更新本 Note 与命令帮助。
- 直查结果必须按 scope 过滤，CLI 不得恢复非 coding 会话。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/panels/sessionsPanel.test.tsx test/tui/runTui.test.ts test/session/codingSession.test.ts`：55 项通过。
- `pnpm --filter @answra/agent exec vitest run test/core/transcript/sqliteConversationStore.test.ts`：按 ID 直查用例通过。
- `pnpm --filter @answra/cli typecheck` 通过。

## 风险

- 面板只在已加载页内删除；删除后不会自动补拉一页，必要时用户继续向下加载。
- 剪贴板写入失败由现有 `ClipboardWriter` 兜底处理，面板不感知具体失败原因。
- 前缀搜索仍可能因会话过多而找不到旧前缀；用户可改用完整 ID。
