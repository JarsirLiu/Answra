# Note：CLI 与桌面独立会话历史：新建、恢复、列表与删除

状态：已实施

当前阶段：CLI 与桌面各自使用独立文件根目录；CLI 已提供 `/new`、`/sessions`、`/resume`、`/delete`，桌面 chat 已提供“新对话”和历史列表。`answer` 会话只保留在 worker 内存，不读盘、不落盘，也不进入历史。

## 问题

CLI coding 和桌面 conversation 目前都只有进程内 transcript：

- CLI 的 `CodingSession` 在启动时生成一个 `conversationId`，`/clear` 只清空当前会话；没有“新建会话”，没有历史列表，进程退出后消息全部丢失。
- 桌面 chat 使用固定 `ActiveChatConversationId`，没有“会话”这一层身份，也没有历史列表；worker 重启后 transcript 丢失。
- 截图答题和面试也各自使用固定 conversation ID，但 v1 不需要历史入口；它们仍必须按 scope 隔离，不能被 chat 历史列表读到。
- `ConversationStore` 已经是 transcript 的唯一端口（`apps/agent/src/core/transcript/store.ts`），但当前只有 `MemoryConversationStore`，没有磁盘适配器，也没有“列出/删除会话”的独立端口。
- CLI 和桌面暂时不共用一份历史。不能把两者接到同一个文件目录，也不能让 TUI 或 renderer 直接写消息。

本提案要解决四件事：**宿主各自拥有可新建、可恢复、可列出、可删除的会话**；**消息仍由 Agent 的 transcript store 唯一持有**；**历史按 scope 隔离**；**CLI 与桌面数据根目录隔离**。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/transcript/store.ts`、`catalog.ts`（新增）、`persistence/*`（新增）：共享端口、目录端口与文件适配器。
  - `apps/agent/src/coding/host.ts`、`apps/agent/src/host.ts`：宿主注入 store 与 catalog，不再默认只创建内存 store。
  - `apps/cli/src/session/codingSession.ts`：可变 conversation ID、新建/恢复/列表/删除、host 生命周期。
  - `apps/cli/src/cli/codeCommand.ts`、`apps/cli/src/main.ts`：CLI host/store/catalog 装配。
  - `apps/cli/src/tui/commands/*`、`apps/cli/src/tui/runTui.tsx`：`/new`、`/sessions`、`/resume`、`/delete` 与视图重置。
  - `apps/desktop/src/main/conversation/sessionIpc.ts`（新增）：会话历史 IPC handler，避免与发送/压缩 handler 并行冲突。
  - `apps/desktop/src/main/agent/agentService.ts`、`agentWorkerHost.ts`、`worker.ts`、`workerTransport.ts`：worker 命令、启动参数与文件 store 注入。
  - `packages/ui/src/app/useChatSessions.ts`（新增）、`ChatFeaturePanel.tsx`、`ChatPanel.tsx`、`ChatHistoryPanel.tsx`（新增）：动态 chat 会话、历史列表与新建/恢复/删除入口。
- UI/进程/协议/持久化表面：
  - CLI：新增 `/new`、`/sessions`、`/resume <id>`、`/delete <id>`；`/clear` 语义不变。
  - 桌面：chat 新增“历史”“新对话”，历史列表支持恢复和删除；截图答题与面试在 v1 不新增历史入口。
  - 持久化：CLI 与桌面使用不同数据根目录，不共享索引或文件。
  - 进程：桌面仍由 utility process 持有 transcript；主进程只传 store 根路径和 IPC。
  - 协议：新增两个 `AgentCommand` 和两个 IPC 频道；不新增第二套消息协议。
- 相关 Note：
  - [共享 transcript 仓储归属](../../implemented/architecture/2026-11-08-core-transcript-store.md)
  - [后端拥有会话与内存仓储](../../implemented/architecture/2026-10-12-conversation-memory-store-port.md)
  - [CLI Coding 模式与 TUI 移植](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [多 Bot 同会话注册、发现与交接](../../proposed/architecture/2026-11-11-multi-bot-session-registry-and-handoff.md)
  - [产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)

## 决定

以下契约冻结后，CLI、桌面和 Agent 可以并行实现；任何字段或语义变更必须同时更新本文与共享类型。

### 1. 会话身份与 scope

`conversationId` 继续作为会话主键；不新增第二套 `SessionId` 字段。

```ts
type ConversationSessionScope = "coding" | "conversation" | "answer" | "interview";
```

- `scope` 由宿主在创建会话时显式写入，不由 `conversationId` 前缀推断。
- CLI 只创建和列出 `coding`；桌面 chat 只创建和列出 `conversation`；截图答题为 `answer`，只在当前 worker 内存中存活，不读盘、不落盘；面试为 `interview`。
- 历史列表必须按 scope 过滤；删除也必须校验目标 scope，禁止 renderer 通过 chat IPC 删除 coding/answer/interview 会话。
- `FileConversationStore` 对 `answer` scope 直接走内存，不创建、读取、列出或删除任何会话文件；worker 重启即丢失。
- `/clear` 清空当前 conversation，`conversationId` 不变。
- `/new` 和桌面“新对话”生成新 `conversationId`，旧 conversation 保留在磁盘。
- 新建、恢复、删除都只允许在目标会话空闲时执行；活动 run 中拒绝并提示先取消。

### 2. 会话摘要

```ts
interface ConversationSessionSummary {
  conversationId: string;
  scope: ConversationSessionScope;
  title: string;
  messageCount: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  workspaceRoot?: string;
}
```

- `title` 优先取显式 metadata.title；否则取第一条用户消息的纯文本，截断到 80 字符；仍为空则用“未命名会话”。
- `messageCount` 统计已持久化的消息数量，包括 `interrupted` 消息；不包含未落盘的流式增量。
- `createdAt` / `updatedAt` 由 store 管理，调用方不得伪造。
- 摘要不包含消息正文、工具输出、摘要正文、`activeRunId` 或事件 journal。
- 列表按 `updatedAt` 降序；同时间按 `conversationId` 升序，保证结果稳定。

### 3. ConversationStore 扩展

```ts
interface ConversationSessionMetadata {
  scope: ConversationSessionScope;
  workspaceRoot?: string;
  title?: string;
}

create(
  conversationId: string,
  seed?: ConversationSessionSeed,
  metadata?: ConversationSessionMetadata,
): Promise<ConversationSnapshot>;
```

- `metadata` 在端口上保持可选，兼容现有内存调用；所有领域创建入口必须传。
- `FileConversationStore` 在缺少 `metadata.scope` 时 fail-closed，拒绝创建，不做默认猜测。
- `create` 命中已存在 ID 时只加载现有会话，不覆盖 seed、metadata 或消息。
- `seed` 继续保存 `activeAgentId`、`participantAgentIds`、`bots`；不把 Bot 身份写进消息正文。

### 4. 会话目录端口

```ts
interface ConversationSessionQuery {
  scope?: ConversationSessionScope;
  workspaceRoot?: string;
  limit?: number;
}

interface ConversationSessionCatalog {
  list(query?: ConversationSessionQuery): Promise<readonly ConversationSessionSummary[]>;
  delete(conversationId: string): Promise<void>;
}
```

- `list` 只读文件，不创建会话、不加载消息正文；损坏文件被隔离并跳过。
- `delete` 对不存在的 ID 幂等 no-op；对活动 run 中的会话抛错，不删除文件。
- `delete` 只按 ID 删除；scope/workspace 归属校验由调用方（CLI 用例或桌面 IPC）完成。
- `ConversationStore` 不兼列表/删除；目录端口独立，避免 transcript 写入语义被历史查询污染。

### 5. IPC 与 bridge

新增频道：

```ts
ListSessions: "answra:conversation:list-sessions";
DeleteSession: "answra:conversation:delete-session";
```

请求/响应：

```ts
ListSessions: {
  request: { scope?: ConversationSessionScope } | undefined;
  response: readonly ConversationSessionSummary[];
};
DeleteSession: {
  request: { conversationId: string };
  response: undefined;
};
```

- `DesktopBridge` 增加可选方法：
  - `listConversationSessions(query?: { scope?: ConversationSessionScope }): Promise<readonly ConversationSessionSummary[]>`
  - `deleteConversationSession(conversationId: string): Promise<void>`
- 主进程 handler 必须校验 `isWindowFromSender` 和 `conversationId` 格式；v1 桌面只允许 `scope: "conversation"`。
- 删除前主进程必须确认目标摘要的 scope 是 `conversation`；不能只信 renderer 传的 ID。
- preload 只转发，不做过滤或业务判断。

### 6. worker 线协议

在 `AgentCommand` 增加：

```ts
| { id: string; type: "session-list"; query?: ConversationSessionQuery }
| { id: string; type: "session-delete"; conversationId: string }
```

- 复用现有 `AgentFrame` 的 `response` 帧；`value` 分别为 `ConversationSessionSummary[]` 与 `undefined`。
- 不新增 `AgentFrame` 类型，不新增事件 journal。
- `startAgentHost` / `startCodingHost` 增加可选 `catalog`；`session-list`/`session-delete` 在 catalog 缺失时 fail-closed 返回错误，不静默返回空列表。
- 桌面 worker 启动参数增加 sessions 根路径；具体位置由 `agentWorkerHost` 与 `worker.ts` 同步，避免 argv 错位。

### 7. 数据根目录

- CLI：`resolveDefaultConfigDir()/cli/sessions`。
- 桌面：`app.getPath("userData")/desktop-sessions`。
- 两个宿主复用同一个文件适配器实现，但不共享数据根目录、索引或文件；不存在跨宿主读取或同步。
- CLI 的 `answra remote host` 是另一个进程，v1 继续使用内存 store 或独立根目录，避免两个进程同时写同一会话文件。多进程持久化留到单写者或 SQLite 方案。

### 8. 文件格式与写入策略

每个 conversation 一个文件，文件名使用经过校验的 `conversationId`；文件内容为带版本的记录：

```text
schemaVersion: 1
conversationId
scope
workspaceRoot?
title?
createdAt
updatedAt
snapshot: ConversationSnapshot
contextState?: ContextState
seed?: ConversationSessionSeed
```

- `ConversationSnapshot` 是消息、parts、状态、Bot 归属和 context 压缩/占用信息的唯一来源。
- `ContextState` 单独保存，避免把摘要正文塞进 UI snapshot；恢复压缩检查点和 usage anchor。
- `seed` 保存 activeAgentId、participantAgentIds 和 bots。
- 不保存 `activeRunId`、TUI 队列、`AbortController`、`readFileState` 和工具实例。
- `conversationId` 只允许 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`；拒绝 `.`、`..` 和路径分隔符，避免路径穿越。
- 写入采用临时文件 + rename 原子替换；同一 conversation 的写入串行化。
- v1 在 run 边界落盘，不逐 token 重写整个文件：`create`、`beginRun`、run 终态、`clear`、删除和正常退出强制 flush。
- 启动加载时使用 zod 校验记录与 `ConversationSnapshot`；损坏文件重命名为 `.corrupt-<timestamp>` 并报告，不静默删除用户数据。

### 9. 恢复语义

- 加载时移除 `activeRunId`；没有活动 run。
- `streaming` 消息、`running`/`pending` 工具调用和未完成 parts 统一标为 `interrupted`，保留已有文本和工具输出。
- `eventRevision` 在加载时归零，因为 v1 不持久化 `AgentEventEnvelope` journal。否则新的 `MemoryExecutionStore` 从 0 开始产生事件，会被旧 revision 过滤掉。
- 如果未来需要精确回放或审计，再单独持久化事件 journal，并给 `ExecutionStore` 注入初始 revision；本提案不把事件 journal 作为消息事实来源。

## 目录架构

```text
apps/agent/src/core/transcript/
  store.ts                         # 只定义 transcript 端口
  catalog.ts                       # 只定义会话目录端口与查询
  persistence/
    fileConversationStore.ts       # 组合文件记录、恢复、原子写；实现 Store + Catalog
    fileSessionRecord.ts           # 文件记录 schema、序列化、标题/计数投影
    restore.ts                     # 加载归一化：清 activeRunId、interrupted、revision=0
    atomicFile.ts                  # 临时文件 + rename、串行写
    sessionFilePaths.ts            # 根目录、ID 校验、文件路径、损坏文件隔离

apps/cli/src/
  session/codingSession.ts         # 当前会话生命周期：新建/恢复/列表/删除
  tui/commands/*                   # 只做命令解析、分派、帮助与提示
  main.ts                          # 组合根：CLI 根目录、store/catalog 注入

apps/desktop/src/main/
  conversation/sessionIpc.ts       # 历史列表/删除 IPC；只做来源与 scope 校验
  agent/agentService.ts            # worker 命令转发与会话历史方法
  conversation/workerTransport.ts  # 构造桌面 FileConversationStore
  conversation/worker.ts           # 读取 sessions 根参数

packages/ui/src/
  app/useChatSessions.ts           # 唯一 chat 会话状态 owner：列表、active ID、新建/恢复/删除
  components/panels/ChatHistoryPanel.tsx  # 纯列表展示
  components/panels/ChatPanel.tsx  # 只切换 chat/history 视图，不直接读写文件
```

- `core/transcript/persistence/*` 不 import CLI、Electron、React、TUI 或领域模块。
- CLI/桌面宿主负责解析各自数据根目录、注入 store/catalog、处理命令和视图重置。
- `CodingApplication` / `ConversationApplication` 继续是会话编排唯一入口；不直接读写文件。
- TUI/renderer 只消费 snapshot/event 投影，不拥有 transcript，不写消息文件。

## 实现

### 1. CLI 落地

- `CodingSession` 注入 `createConversationId` 和 catalog，新增：
  - `startNewConversation()`：空闲时生成新 ID，调用 `host.createConversation(newId)`，更新当前 snapshot。
  - `resume(conversationId)`：加载 snapshot，切换到该 ID；只允许同 scope、同 workspace 的 coding 会话。
  - `listSessions()`：按当前 workspace 列出 coding 会话摘要。
  - `deleteSession(conversationId)`：删除指定 coding 会话；删除当前会话后自动新建。
- TUI 进程只创建一个 `CodingHost`；`CodingSession` 只切换 conversation，不再每个 session 新建 runtime/工具。`close()` 只关闭会话，host 由 `runInteractive` 在 finally 中统一 dispose。
- `/new` 无参数；`/sessions` 无参数；`/resume <id-or-unique-prefix>`；`/delete <exact-id>`。
- `/resume` 支持唯一前缀，歧义时报错并列出候选；`/delete` 要求完整 ID，避免误删。
- `/new`、`/resume`、`/delete` 成功后调用 `viewStore.reset(snapshot)`（`apps/cli/src/tui/app/viewStore.ts`），清空选区；模型、token、workspace 不变。
- `/clear` 保持“清空当前会话”，不生成新 ID。
- 忙时拒绝切换/新建/删除；命令 handler 不直接操作文件，只调用 `CodingSession`。

### 2. 桌面落地

- `useChatSessions` 是 chat 会话状态的唯一 owner：
  - 首次迁移继续使用 `ActiveChatConversationId`。
  - 新会话生成 `chat-<uuid>`。
  - active ID 存 renderer localStorage；启动时优先恢复存储值。
  - 列表、新建、恢复、删除都通过 bridge，不直接访问 worker 或文件。
- `ChatFeaturePanel` 通过 `useChatSessions` 获取 active `conversationId`，不再内部固定 `ActiveChatConversationId`；`ChatPanel` 只负责 chat/history 视图切换。
- `ChatPanel` 增加内部视图状态 `chat | history`，不新增 `OverlayMode`，不改窗口路由。
- 历史列表展示 title、updatedAt、messageCount，标记 active；恢复和删除都只在当前 chat 空闲时可用。
- 删除当前会话时，先删除文件，再生成新的 `chat-<uuid>` 并清空投影；删除非当前会话只刷新列表。
- `conversationIpc` 的 clear/compact 白名单增加 `ActiveChatConversationId` 和 `chat-` 前缀；其他 ID 仍拒绝。主窗口仍接收全部事件，renderer 按 active ID 过滤，不需要改事件路由。
- 截图答题保持一次性会话，并且只在 worker 内存中存活，不读盘、不落盘；面试保持现有领域会话。两者在 v1 不提供“新对话”和历史列表。

### 3. 并行改动纪律

- 本次实现触碰了与并行压缩/登录/远程改动相同的共享文件：`packages/shared/src/schema/index.ts`、`packages/shared/src/index.ts`、`packages/shared/src/channels/conversation.ts`、`packages/shared/src/bridge.ts`、`ChatPanel.tsx`、`ChatFeaturePanel.tsx`。
- 实现时按文件保留增量，不覆盖并行改动；提交时只暂存会话历史相关 hunk。
- 曾回滚此前未完成的 shared/agent 半成品，只保留本文契约，避免 `MemoryConversationStore` 处于不可编译状态；本次实现已重新落地。

## 模块边界

- `core/transcript/store.ts`：只定义 transcript 端口；不包含文件路径、产品策略或会话列表 UI。
- `core/transcript/catalog.ts`：只定义列表/删除端口；不包含文件实现。
- `core/transcript/persistence/*`：只实现端口、文件格式和恢复；不 import CLI、Electron、React、TUI 或领域模块。
- CLI/桌面宿主：负责解析各自数据根目录、注入 store/catalog、处理新会话命令和视图重置。
- `CodingApplication` / `ConversationApplication`：继续是会话编排唯一入口；不直接读写文件。
- TUI/renderer：只消费 snapshot/event 投影，不拥有 transcript，不写消息文件。

## 曾考虑的替代方案

- **CLI 与桌面共享同一份历史：** 用户明确要求暂时不共用；会引入跨宿主同步、并发写入和权限边界，舍弃。
- **在 TUI/renderer 直接持久化消息：** 会形成第二套 transcript 所有权，且 UI 重载、多个窗口和恢复语义会分叉，舍弃。
- **继续使用固定桌面 conversation ID：** 无法表达多个 chat 会话，也无法区分“新对话”和“清空当前对话”，舍弃。
- **v1 直接上 SQLite：** 查询和并发更好，但当前 Node 22.14/Electron 35 下 `node:sqlite` 仍偏实验性，原生 SQLite 依赖还要处理打包和 rebuild；先用文件快照验证恢复语义，舍弃立即引入。
- **每个 token 都重写完整 snapshot：** 实现简单但会随工具输出放大写放大，且阻塞事件处理，舍弃。
- **持久化完整 Agent 事件 journal：** 能精确回放，但会与 transcript 形成两套事实，并需要处理 revision 恢复和事件清理，超出本阶段，舍弃。
- **把列表/删除塞进 `ConversationStore`：** 会让 transcript 写端口承担查询与文件生命周期，增加实现负担和跨宿主耦合；拆成 `ConversationSessionCatalog`，舍弃合并。

## 验收标准

- CLI `/new` 在空闲时生成新 ID、清空 TUI、保留旧文件；`/sessions` 只列当前 workspace 的 coding 会话；`/resume` 能继续旧会话；`/delete` 删除指定会话，删除当前会话后自动新建；忙时全部拒绝。
- 桌面“新对话”生成 `chat-` 会话、清空 chat 投影、保留旧文件；历史列表能恢复旧 chat；删除当前 chat 后生成新会话；运行中拒绝。
- 桌面重启后按保存的 active ID 加载当前会话；历史列表按 scope 过滤，不显示 answer/interview。
- 文件 store：snapshot/contextState/seed 往返一致；损坏文件被隔离；加载后无 `activeRunId`，未完成消息为 `interrupted`，`eventRevision` 为 0。
- 删除活动 run 的会话被拒绝；删除不存在会话为 no-op；删除其他 scope 的会话被 IPC 拒绝。
- CLI 与桌面使用不同根目录；互不读取、互不覆盖。
- 自动化：`pnpm notes:check`、CLI/agent/desktop 相关测试、全仓 `pnpm verify`。
- 实机：Windows 11 上 CLI `/new`、`/sessions`、`/resume`、`/delete`，桌面“新对话”、历史恢复/删除、重启后加载、异常退出后的 interrupted 展示。

## 后果与防回退

- CLI 与桌面各自拥有文件根目录；新增宿主不得复用另一宿主的目录，也不得让 TUI/renderer 直接写文件。
- 历史列表和删除必须经过 `ConversationSessionCatalog`；IPC 只暴露 `conversation` scope，删除前必须校验摘要 scope。
- `answer` scope 永远不落盘；`FileConversationStore` 的写穿、加载和删除路径都必须保持该豁免，防止把一次性答题内容写进用户历史。
- 恢复只以 snapshot 为事实来源，不引入 Agent 事件 journal；若未来需要精确回放，必须另立 Note。
- 新增会话字段或命令必须同时更新 `packages/shared/src/schema/session.ts`、worker 协议、bridge 和对应测试。

## 风险

- transcript 可能包含代码、路径和工具输出中的敏感信息；v1 只依赖用户目录权限，不加密。文件权限和清理策略需要后续单独决策。
- run 边界落盘意味着进程在 run 中途崩溃时可能丢失部分 assistant/tool 输出；用户消息和终态消息优先保证。
- `eventRevision` 归零后不能回放旧事件；恢复依赖 snapshot。若未来需要精确恢复，必须重新设计事件 journal。
- 桌面 `chat-` ID 白名单扩大了可清空/压缩范围，必须严格校验 ID 格式，避免路径穿越或跨会话操作。
- CLI remote host 与本地 TUI 若共用文件根会并发写坏数据；v1 明确隔离或保持内存。
- 历史列表会让用户看到旧会话；删除是破坏性操作，必须二次确认，并明确“删除当前会话后新建”的行为。
- 共享文件与并行改动重叠，后续修改必须先逐文件 rebase；否则容易覆盖压缩/登录/远程功能。

## 验证

1. 共享类型、频道、bridge、worker 命令已落地。
2. `FileConversationStore`、文件格式、恢复归一化与 catalog 测试已落地；`answer` scope 不落盘。
3. CLI 单 host 生命周期、`CodingSession` 新建/恢复/列表/删除与 TUI 命令已落地。
4. 桌面动态 chat conversation ID、worker 独立 store、历史列表 UI 与 IPC 已落地。
5. `AGENTS.md`、README 与本文已同步；完整 `pnpm verify` 和 Windows 11 实机验收待执行。

验证证据：

- `pnpm --filter @answra/agent test -- fileConversationStore.test.ts`：5 项通过。
- `pnpm --filter @answra/cli test -- test/session/codingSession.test.ts test/tui/commands/commands.test.ts`：24 项通过。
- `pnpm --filter @answra/desktop test -- conversationIpc.test.ts`：15 项通过。
- `pnpm --filter @answra/ui test -- ChatHistoryPanel.test.tsx useChatSessions.test.tsx`：5 项通过。
- `@answra/agent`、`@answra/shared`、`@answra/cli`、`@answra/ui`、`@answra/desktop` typecheck 已通过。
