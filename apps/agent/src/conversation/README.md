# Conversation 领域

Conversation 负责用户与 Bot 之间的 transcript，以及本领域 Bot 的上下文和工具策略。模型执行与 run 状态由跨领域的 `core/agent` 提供，Bot 身份与可见性由 `core/bot` 提供。目录按业务事实组织，不按 Event、Status、Store 等技术名词平铺。

```text
conversation/
  application.ts  唯一编排循环：按 Bot/团队选择创建会话、运行当前 Bot、执行交接链
  bots/           每个 Bot 的执行器、身份与 profile 装配
  profiles/       Bot 使用的提示词、上下文策略和工具白名单
  turn/           transcript 回合认领和模型上下文准备
```

## `application.ts`

- 构造时接收不可变 `BotCatalog` 与团队预置；单 Bot 会话就是只有一个参与者的会话。
- `createConversation(conversationId, selection)` 写入 `activeAgentId` 与 `participantAgentIds`；
  `send` 使用当前 `activeAgentId`，`sendTeamMessage` 使用预置入口。
- 交接循环只依赖当前会话参与者与 `core/bot/directory` 的可见性校验，不读取团队定义中的身份。
- 每段 run 启动与交接写入后推送权威 `ConversationSnapshot`。

## `bots/`

- `types.ts`：`ConversationBot = BotDescriptor<ConversationAgentInput, ChatProfile>`。
- `general.ts`：通用对话 Bot 的静态工厂，注册 Agent 执行器并绑定 `general-chat` profile。
- `index.ts`：Conversation 的 Bot 目录入口；新增 Bot 时在这里装配，不修改会话编排。

## `profiles/`

定义 Bot 的提示词、是否读取历史、时间上下文和工具授权。它们是 Agent 内部静态注册，不接受 renderer 动态注入。

- `registry.ts`：通用聊天 profile 类型与静态注册表。
- 截图答题策略在 `apps/agent/src/answer/agent.ts`，不使用通用聊天历史或工具。

## 工具

Conversation 不持有工具实现或工具 registry，只在 profile 中声明 `ToolId[]`。通用 `Read`/`Grep`/`RunCommand`/`WriteStdin` 由 `../core/tool/builtin/` 提供并在 Agent 进程执行；desktop 只注入获准的工作区根目录。工作区是默认根目录而非访问边界，路径规则与 VCS 排除见 `docs/notes/implemented/architecture/2026-11-09-workspace-default-root-not-boundary.md`；shell 的权限范围与会话生命周期见 `docs/notes/implemented/feature/2026-11-09-shell-tools-and-session-runtime.md`。

Answra 只采用按事实拆分的原则，当前仍保持单 Agent 进程和内存仓储，不预建远程服务、SQLite 或插件框架。
