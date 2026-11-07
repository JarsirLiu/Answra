# Note：共享 transcript 仓储归属

状态：已实施

## 问题

Conversation、Answer 和 Interview 共同保存会话消息、活动回复以及恢复游标。仓储实现仍放在 `conversation/session/`，目录位置把共享数据能力误标成 Conversation 专属能力，也让新领域继续依赖 Conversation 内部目录。

## 涉及范围

- `apps/agent/src/core/transcript/` 的 transcript 端口、内存适配器和用户消息工厂。
- Conversation、Answer、Interview 的组合入口及测试导入路径。
- Agent 包公开入口和仓库结构文档。
- UI/进程/协议/持久化表面：不改变 IPC/worker 契约；当前仍是 Agent 进程内存 transcript，不提供重启恢复。
- 相关 Note：[领域 Agent 注册与运行时底座](../../proposed/architecture/2026-11-07-domain-agent-module-registration.md)、[会话切页恢复游标](2026-11-07-conversation-live-recovery-cursor.md)

## 决定

把现有 `ConversationStore` 及其内存实现移动到 `core/transcript`，名称保持不变以避免重新定义消息事实或仓储语义。它保存 `ConversationSnapshot` 中的消息、活动 run 和 `eventRevision` 恢复游标；不保存 `AgentEventEnvelope`，不实现 UI 投影，也不承担产品领域策略。

`core/transcript` 是进程内共享端口，当前只提供内存适配器。Conversation、Answer 和 Interview 通过同一端口读写 transcript；Answer 的一次性清理仍由 Answer 用例调用 `clear` 完成，不下沉为仓储特殊分支。

## 模块边界

- `core/transcript/store.ts` 定义消息、活动 run 认领、流事件应用和恢复游标端口。
- `core/transcript/memoryStore.ts` 是当前唯一适配器；它只保存 `ConversationSnapshot`，不写入事件日志。
- `core/transcript/message.ts` 只构造已校验的用户消息值，不负责请求校验或领域策略。
- `conversation/turn`、`interview/reply` 和 Answer 入口负责何时调用端口；`core/transcript` 不知道具体产品场景。
- `execution` 仍是 AgentEventEnvelope 和运行状态的唯一事实来源；transcript 只保存消息查询数据及恢复游标。

## 曾考虑的替代方案

- **保留在 `conversation/session/`：** 改动较小，但会继续把共享 transcript 伪装成 Conversation 私有实现，并让 Interview/Answer 反向依赖 Conversation 目录，舍弃。
- **为每个领域复制一个 message store：** 能短期减少跨目录 import，但会产生消息状态、活动 run 和恢复游标的多套写入规则，舍弃。
- **此阶段接入 SQLite/Redis：** 超出当前进程内架构阶段，且会把持久化故障与恢复协议混入目录迁移，舍弃。

## 后果与防回退

- `core/transcript` 只保留共享 transcript 数据能力；领域策略仍在各自 application/runtime。
- `AgentEventEnvelope` 仍是唯一执行事件事实，transcript 不新增事件 journal。
- 新领域不得从 `conversation/session` 深入导入 transcript；新增持久化实现必须实现同一 `ConversationStore` 端口并单独记录恢复语义。

## 验证

- `pnpm notes:check`
- Agent transcript store、Conversation runtime 及全仓 `pnpm verify`
