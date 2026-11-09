# Conversation 领域

Conversation 负责用户与 Agent 之间的 transcript，以及本领域 Agent 的上下文和工具策略。模型执行与 run 状态由跨领域的 `core/agent` 提供。目录按业务事实组织，不按 Event、Status、Store 等技术名词平铺。

```text
conversation/
  turn/          Conversation application、transcript 回合认领和模型上下文准备
  agent.ts       静态注册的 Conversation Agent 定义
  profiles/      Chat Agent 使用的提示词、上下文策略和工具白名单
```

## `turn/`

- `application.ts`：Conversation application。暴露创建会话、发送、回复、取消和等待；通过共享 `core/transcript` 仓储原子认领 transcript 回合，并调用注册 executor。Answer 和 Interview 用例不在此目录。
- `modelMessages.ts`：按 profile 选择 transcript 历史、把图片输入转换成 AI SDK 消息，并注入已授权的时间提醒。
- `workspaceContext.ts`：把本回合快照的工作区根目录或「未选择目录」事实压成系统提示片段；工作区是默认根目录而非访问边界，不读取内容。
- `timeReminder.ts`：只供显式开启时间上下文的 profile 使用的系统提醒。

`agent.ts` 通过 `AgentDefinition.prepare` 组装 profile、transcript 历史和白名单工具；`core/agent` 消费 AI SDK `result.fullStream` 并写入唯一 `ExecutionStore`。Conversation application 按序消费同一 `AgentEventEnvelope` 更新 transcript；不消费 `toUIMessageStream()`，不创建领域事件副本。

## `profiles/`

定义场景策略：提示词、是否读取历史、时间上下文和工具授权。它们是 Agent 内部静态注册，不接受 renderer 动态注入。

- `registry.ts`：通用聊天 profile 类型与静态注册表。
- 截图答题策略已经迁入 `apps/agent/src/answer/agent.ts`，不使用通用聊天历史或工具。

## 工具

Conversation 不持有工具实现或工具 registry，只在 profile 中声明 `ToolId[]`。通用 `Read`/`Grep`/`RunCommand`/`WriteStdin` 由 `../core/tool/builtin/` 提供并在 Agent 进程执行；desktop 只注入获准的工作区根目录。工作区是默认根目录而非访问边界，路径规则与 VCS 排除见 `docs/notes/implemented/architecture/2026-11-09-workspace-default-root-not-boundary.md`；shell 的权限范围与会话生命周期见 `docs/notes/implemented/feature/2026-11-09-shell-tools-and-session-runtime.md`。

Answra 只采用按事实拆分的原则，当前仍保持单 Agent 进程和内存仓储，不预建远程服务、SQLite 或插件框架。
