# Note：后端拥有会话与内存仓储

状态：已实施

## 问题

当前截图对话由 UI 的 `useChat` 暂存消息，模型事件以 `{ runId, chunk }` 送到 renderer。没有稳定会话 ID、事件位置号、统一的会话仓储或断线补发接口。把完整对话面板、会话切换和重连直接叠在现有 hook 上，会让窗口成为状态所有者，并在后续持久化时迫使 UI 和流协议一起重写。

流式 delta 与最终消息也有不同生命周期：delta 需要支持当前进程内的订阅恢复；结束后的完整 transcript 需要支持会话历史加载。若把两者混成“每次更新都重新读取、排序所有消息”，会增加重复应用、顺序抖动和无谓重渲染风险。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`、`packages/ui/src/app/useConversationChat.ts`、`packages/ui/src/app/useReplyWorkflow.ts`、`apps/desktop/src/main/conversation/appService.ts`、未来的 `apps/app` 会话类型与仓储接口。
- UI/进程/协议/持久化表面：utility worker 持有会话状态；renderer 订阅快照和有序增量；首版仅在 worker 进程内存保存，后续可替换 SQLite adapter。
- 相关 Note：[笔试截图一次性图片对话 V1](../../implemented/feature/2026-10-11-ephemeral-exam-image-chat-v1.md)、[回复工作流边界](../../implemented/architecture/2026-10-11-reply-workflow-boundary.md)、[回复条展示标准消息活动](../../implemented/feature/2026-10-12-reply-bar-stream-activities.md)。

## 决定

utility worker 内的会话 runtime 是当前进程内会话、消息顺序、模型调用和运行生命周期的唯一所有者。它接收发送/取消/快照/补发命令，调用 AI SDK，记录标准 `UIMessageChunk` 并生成有序 change。renderer 通过 preload 发命令，消费后端 snapshot/change；AI SDK `useChat` 与自定义 `ChatTransport` 将后端数据投影为前端 `UIMessage`，只用于展示和交互，不拥有权威 transcript。

定义 UI 无关的异步 `ConversationStore` 仓储端口。首个实现 `MemoryConversationStore` 在 utility worker 启动时创建；所有操作均返回 Promise，为未来 SQLite adapter 保持一致的调用契约。SQLite adapter 尚未实现。

会话有稳定 `conversationId`；每次模型请求有 `runId`。每个会话有从 1 单调递增的 `revision`，所有被仓储接受的消息/运行状态变更和流事件共用该顺序空间。流事件信封为 `{ conversationId, runId, revision, chunk }`，AI SDK `UIMessageChunk` 保持原样。时间戳只用于显示和诊断，不参与排序；revision 才是恢复、去重和检测缺号的依据。

当前仓储端口：

```ts
interface ConversationStore {
  create(conversationId: string): Promise<ConversationSnapshot>;
  load(conversationId: string): Promise<ConversationSnapshot>;
  beginRun(conversationId: string, runId: string, userMessage: ConversationMessage): Promise<void>;
  appendEvent(event: Omit<ConversationEvent, "revision">): Promise<ConversationChange>;
  finishRun(conversationId: string, runId: string, status: "complete" | "interrupted"): Promise<void>;
  readAfter(conversationId: string, revision: number): Promise<ConversationChange[]>;
  subscribe(listener: (change: ConversationChange) => void): () => void;
}
```

`ConversationSnapshot` 包含按追加顺序排列的轻量 `ConversationMessage[]`、活动 run ID 与当前 revision。消息记录保存角色、文本、图片 data URL 和状态；AI SDK chunk 作为活动 journal 中的标准事件保存。新增消息按数组尾部追加，text delta 增量更新对应 assistant message。时间戳不参与排序，也不在 chunk 到达后重新读取或排序 transcript。

`beginRun` 原子地检查当前会话没有活动 run、追加 user message、建立 assistant 占位消息，并发布 `messages-appended` 增量；并发发送不会留下孤立用户消息。transport 为每个 chunk 串行调用 `appendEvent`；仓储分配 revision、增量更新文本，并发布只含 chunk 的轻量 change。`run-finished` 只携带终态 assistant message，不重复发送全量 transcript。全量 snapshot 仅在初始化或游标过期恢复时传送。UI 按 revision 应用增量，发现缺号时请求 `readAfter`；重复 revision 被忽略。

模型流完成时，后端沿用已增量更新的 assistant message 标记完成并发布终态 snapshot。UI 不在结束时拉取或重排 transcript。回复条和聊天面板读取同一份后端会话；表面切换不取消 run 或清空历史。

内存仓储为每个会话保留最多 2048 条 snapshot/event change。renderer 重载后加载快照；检测到 revision 缺口时请求补发。若 journal 已淘汰游标所需事件，仓储返回最新 snapshot。首版终态后仍在有界 journal 内保留事件；历史消息文本与图片留在该 worker 的内存中。

renderer 断线但 utility worker 仍运行时，runtime 继续接收、编号和缓冲事件，renderer 可加载快照或补发恢复。当前 worker 退出会丢弃全部内存会话；没有磁盘记录，首版不承诺应用重启后恢复历史或标记活动 run。未来 SQLite 接入后仍不能假定上游请求可跨进程恢复，启动时需显式恢复中断状态。

首阶段仍不把历史消息自动发送给模型，每次请求仍为单轮。历史存储与多轮上下文策略分离；图片 data URL 暂时驻留 worker 内存，未来持久化前需定义媒体引用与 blob 生命周期。

## 模块边界

- `packages/shared`：会话 ID、事件信封、snapshot/change、revision 和 IPC 输入/输出纯类型；不依赖存储实现。
- `apps/app`：utility worker 中的 `ConversationRuntime`、`ConversationStore` 与 `MemoryConversationStore`，负责模型 transport、会话消息、chunk revision、消息投影与补发。
- `apps/desktop/src/main/conversation`：`AppService` 负责 worker 命令和 change 转发；`conversationIpc.ts` 校验 sender 并提供 renderer 唯一入口。
- `packages/ui`：通过 `useChat` 和自定义 `ChatTransport` 消费后端 snapshot/change，渲染回复条和完整面板；不持有权威 transcript，不直接选择内存或 SQLite。
- 回复条窗口与主窗口：当前回复条仍由主 renderer 同步显示状态；未来独立窗口应订阅相同 conversation snapshot/change，不互相广播模型 chunk。

## 曾考虑的替代方案

- **让 renderer 的 `useChat` 成为会话权威状态来源：** 初期实现较少，但 renderer 重载会丢失状态，多个窗口需要同步独立状态，SQLite 接入也必须改变 UI；因此会话后端作为唯一状态所有者，`useChat` 只承担前端 UI 投影。
- **每个 chunk 到达后重读完整会话并按时间戳排序：** 容易实现历史回放，但会让增量更新成为重复重建，时间戳并不保证唯一或稳定顺序，且无法稳妥区分重复与缺失事件，因此舍弃。
- **每个 token 都携带完整 transcript：** 写法直接，但会令 IPC 与复制成本随消息长度增长；因此事件 change 只携带标准 chunk，snapshot 仅用于初始化、消息结构变化和恢复回退。
- **renderer 持有 transport 和 transcript：** 初始实现简单，但窗口重载或多个视图会形成多个状态所有者；因此 transport、revision 与 memory store 放在 utility worker。

## 验收标准

- 可观察结果：utility worker 存活时 renderer 重载可恢复 transcript；流结束不触发全量历史重读；流式 change 不携带全量 transcript；模型上下文仍保持一次请求一轮。
- 流式处理：每会话 revision 单调；重复 revision 忽略；缺号补发或回退最新 snapshot。
- 并发：同一会话只允许一个活动 run，beginRun 原子拒绝并发写入。
- 存储可替换：异步 `ConversationStore` 端口和 Memory adapter 已建立；SQLite adapter、应用重启恢复与媒体 blob 持久化尚未实施。

## 风险

- 活动 run 的 journal 是有界的，过旧游标必须回退到 snapshot；不能承诺保留完整 token 级轨迹。
- 只有仍存活的模型 runtime 才能继续产生事件。进程退出后的 provider 请求通常不可恢复，SQLite 只能恢复已提交记录和中断状态。
- AI SDK `UIMessage`/chunk 升级可能需要持久化格式版本和迁移；仓储记录应有 schema version，IPC 继续使用官方 chunk schema 校验。
- 图片 data URL 目前驻留内存；未来持久化前需设计媒体引用和清理语义。

## 后果与防回退

- 内存会话只在 utility worker 生命周期内有效；不得称为磁盘持久化或应用重启恢复。
- renderer 可以使用 `useChat` 作为标准消息 UI 投影，但其消息必须从后端 snapshot/change 恢复；不得把 `useChat` 消息列表作为权威 transcript 或模型上下文。
- revision 是排序与恢复依据，不得用时间戳替代；流事件 change 不携带全量消息快照。
- SQLite adapter 必须实现相同异步端口，并通过相同仓储契约测试覆盖原子 begin、追加顺序、revision、补发和游标淘汰。
- 多轮上下文、会话列表、SQLite、应用重启恢复及图片 blob 生命周期需单独设计和验证。

## 验证

- Memory store 测试覆盖 revision、消息追加、文本增量、终态和 journal 游标淘汰回退。
- Runtime 测试覆盖模型流、取消、错误、图片请求和消息顺序。
- UI 测试覆盖标准 chunk 展示、错误保留附件、取消竞态和既有回复条交互。
- `pnpm typecheck`、`pnpm test`、`pnpm notes:check`、`pnpm architecture:check` 与 `git diff --check` 通过；UI 54 项、app 7 项、desktop 54 项测试通过。
- 本次修改文件的 Biome 检查通过。完整 `pnpm verify` 被既有 `packages/ui/test/setup.ts:8` 空构造器 `noUselessConstructor` 规则阻断；该文件不属于本次变更。
