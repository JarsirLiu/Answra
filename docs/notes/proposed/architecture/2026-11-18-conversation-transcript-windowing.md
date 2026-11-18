# Note：会话 transcript 窗口化与消息页协议

状态：提案

## 问题

[会话消息表、流式草稿与退出屏障](../../implemented/architecture/2026-11-17-conversation-message-pagination.md) 已完成消息行、流式草稿与 agent 内消息分页端口，但 `ConversationSnapshot.messages` 仍是完整数组：

- renderer、CLI TUI 和桌面 IPC 仍一次拿到全部历史消息；长会话的首屏与 IPC 成本没有下降。
- agent 内部已有 `ConversationMessageCatalog.listMessages`，但没有 shared schema、IPC 或 worker 命令，UI 无法按页读取。
- 若直接把 `messages` 改成最近一页，会让模型上下文、压缩边界和 UI 事实边界混淆；必须先决定 snapshot 的窗口化语义。

## 涉及范围

- 代码/模块（待实施）：
  - `packages/shared/src/schema/conversation.ts`：消息页 schema 或窗口字段。
  - `packages/shared/src/channels/conversation.ts`、preload bridge、desktop IPC：消息页命令。
  - `apps/agent/src/worker/protocol.ts`、`apps/agent/src/host.ts`：消息页 worker 命令。
  - `apps/cli/src/tui/transcript`、`packages/ui`、桌面渲染层：历史分页与流式尾部合并。
- UI/进程/协议/持久化表面：
  - 可能改变 `ConversationSnapshot` 的可见事实边界；必须先定契约。
  - 不改变 transcript 存储格式、草稿 checkpoint 或运行状态来源。
- 相关 Note：
  - [会话消息表、流式草稿与退出屏障](../../implemented/architecture/2026-11-17-conversation-message-pagination.md)
  - [统一会话视图投影](../../implemented/architecture/2026-11-06-unified-conversation-view-projection.md)

## 提案

必须先二选一，不能同时保留两套窗口事实：

1. **扩展 snapshot**：`messages` 变成最近一页，增加 `messagesCursor` / `omittedMessageCount`，并明确旧字段不再代表全量。
2. **独立读取视图**：新增 `ConversationTranscriptView` 承担窗口，`ConversationSnapshot` 继续保持权威全量，UI 自行合并历史页与流式尾部。

无论选哪种：

- agent 模型上下文仍读取完整 transcript；UI 分页不是模型上下文分页。
- 压缩边界、`message_count`、checkpoint 都按完整会话计算。
- 活动 run 仍在内存时，任何历史页都不得覆盖同 ID 的流式 assistant 消息。
- 冷会话分页必须复用 `load` 的草稿合并/收口，不能绕过最后 checkpoint。
- 分页只补历史，不改变 `seq` 顺序，也不在 renderer 重建 run 状态。

## 模块边界

- `packages/shared`：只定义消息页/窗口化 schema 与 IPC 契约，不出现 SQLite 表名或游标内部字段。
- `apps/agent`：消息页读取复用 `ConversationMessageCatalog`，不新增第二套消息事实或 run 状态。
- `apps/desktop`：只做 IPC 校验与转发；不解析游标、不自行合并历史与流式尾部。
- `apps/cli`、`packages/ui`：只消费窗口化视图；模型上下文仍由 agent 读取完整 transcript。

## 曾考虑的替代方案

- **直接把 snapshot.messages 截断：** 舍弃。模型上下文、压缩与 UI 会失去全量事实，且没有恢复游标。
- **只加 agent 内分页、不改 UI：** 可作为阶段 2 的已完成部分，但不能解决 renderer/IPC 成本。
- **保留全量 snapshot 同时再发一份消息页：** 舍弃。两份可消费正文会漂移，且没有减少首屏载荷。

## 验收标准

- 明确 snapshot 与消息页的唯一事实边界，并有类型/协议测试。
- 活动 run 切走再切回、冷启动恢复、分页与流式尾部合并各有一条回归测试。
- 模型上下文仍能读取完整历史；压缩边界与消息数不受 UI 分页影响。
- `pnpm verify`、`pnpm notes:check` 通过。

## 风险

- 若把 UI 分页误当成模型上下文分页，会静默丢失历史上下文。
- 数据库历史页与内存流式尾部按 `message_id` 合并错误时，会显示重复或回退内容。
- snapshot 契约变更会影响桌面、CLI、远程 host/controller 和测试 fake，必须一次同步。
