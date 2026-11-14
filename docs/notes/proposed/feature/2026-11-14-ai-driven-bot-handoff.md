# Note：AI 主动选择 Bot 接管会话

状态：提案

## 问题

多 Bot 的会话持久化、参与者约束、发现 ACL 和交接循环已经在 `ConversationApplication` 中落地，测试替身可以证明“源 Bot 回复 → 写交接记录 → 目标 Bot 回复”的完整链路。但产品侧仍然只有 `conversation.general` 一个 Bot，AI 既不知道当前会话里还有哪些 Bot 可找，也没有真实产出 `{ to, task }` 的路径，因此用户无法在普通对话中让 AI 自动把会话交给另一个 Bot。

本提案要解决的是“AI 在一轮正常回复结束后，基于可见目录选择另一个 Bot 接管当前会话”，不是中途中止 run，也不是长期记忆。长期记忆另立独立能力，不进入本提案。

## 涉及范围

- 代码/模块：`apps/agent/src/core/bot/`、`apps/agent/src/core/team/`、`apps/agent/src/conversation/agent.ts`、`apps/agent/src/conversation/application.ts`、`apps/agent/src/conversation/bots/`、`apps/agent/src/host.ts`
- 协议/桌面/UI：`packages/shared/src/schema/conversation.ts`、`packages/shared/src/channels/conversation.ts`、`apps/desktop/src/main/conversation/conversationIpc.ts`、`apps/desktop/src/preload/index.ts`、`packages/ui/src/app/conversationView.ts`、`packages/ui/src/components/chat/conversationMessage.ts`、`packages/ui/src/components/panels/ChatPanel.tsx`
- 持久化表面：继续使用 `ConversationStore` 保存会话消息和 `activeAgentId`；本提案不新增长期记忆、不改变 transcript 持久化边界。
- 相关 Note：
  - [多 Bot 同会话注册、发现与交接](../architecture/2026-11-11-multi-bot-session-registry-and-handoff.md)
  - [Bot 目录与会话参与者选择](../architecture/2026-11-12-bot-catalog-and-conversation-selection.md)
  - [面试向导、候选人与演练三 Agent 分工](../architecture/2026-11-11-interview-three-agent-boundaries.md)
  - [产品方向与 Agent 底座](../architecture/2026-10-20-product-direction-and-agent-foundation.md)

## 影响表面

- 团队会话中的当前 Bot 在完成一轮回复后，可以选择一个可见参与者接管；用户不换会话，看到一条折叠的交接记录，然后由目标 Bot 继续回复。
- 单 Bot 会话的可见目录为空，不能交接；AI 不会因为“想找 Bot”而绕过参与者约束。
- UI 显示当前 Bot、消息作者和交接提示；单 Bot 会话不显示多余的 Bot 标识。
- 首期只做 Conversation 域内的团队；跨领域 Bot 团队另立提案。
- 不涉及长期记忆：目标 Bot 不继承源 Bot 的私有记忆，交接只传 `task`。

## 提案

### 1. 固定交接时机

交接只允许发生在当前 Bot 的 run 正常 `completed` 之后：

- `AgentRuntime` 只有在 `done === "completed"` 时才读取 `AgentDefinition.result`。
- 交接不是工具，不进入工具授权清单。
- 不在 token 流、工具调用或 step 中途切换。
- 不启动嵌套 run；源 run 结束后才启动目标 run。
- 同一个用户回合允许连续交接，不设交接次数上限。稳定性靠取消、失败收口和可观测性，不靠隐藏的 `MAX_HANDOFFS`。

### 2. 给当前 Bot 注入可见目录

`ConversationApplication` 在启动 Bot 前，用 `visibleBots()` 从当前会话参与者和 `BotDiscovery` 生成可见目录：

- 只包含当前 Bot 可以发现的参与者，不包含自己。
- 注入字段只允许 `id`、`name`、`role`、`responsibility`、`owns`。
- 不注入其他 Bot 的 prompt、工具、执行器、工作区或任何私有内容。
- 目录来自启动期静态注册；运行期不动态增删 Bot。
- 可见目录只是候选集，不是授权；应用层仍要用 `assertCanHandoff()` 再校验。

单 Bot 会话的可见目录为空，prompt 明确告诉模型“当前没有可交接对象”，避免模型编造 Bot ID。

### 3. 真实产出结构化交接结果

`BotTurnResult` 只保留一种控制结果：

```ts
type BotTurnResult = {
  kind: "handoff";
  to: AgentId;
  task: string;
};
```

真实产出分两步验证：

1. 先验证 AI SDK 的 `streamText` + `Output.object` 能否与现有工具循环共存；
2. 若不能稳定共存，则在 run 收尾用一次 `generateObject` 只产出 `{ to, task }`，不产生第二条用户可见回复。

约束：

- `to` 的候选集由当前 Bot 的可见目录生成，例如 `z.enum(visibleBotIds)`。
- 应用层仍要校验目标在 `participantAgentIds` 中且可被发现；模型输出不能直接当授权。
- `task` 非空，且不超过 `MAX_HANDOFF_TASK_CHARS`。
- 没有交接意图时返回 `undefined`，当前 run 就是普通回复。
- 不允许在交接时再补一条 AI 消息；用户可见回复只保留当前 run 已流式写入 store 的 assistant 消息。

### 4. 复用现有应用循环

`ConversationApplication.continueTeamTurn` 继续作为唯一交接循环：

1. 等待当前 run `completed`；
2. 读取 `result`；为空则回合结束；
3. 校验 `task`；
4. 读取 snapshot 的参与者；
5. 校验目标可被发现；
6. 写入 Bot→Bot 交接记录；
7. 切换 `activeAgentId`；
8. 推送 snapshot；
9. 启动目标 Bot 的新 run。

目标 Bot 看到的交接记录仍按现有 projection 规则转成一条带来源前缀的 user 消息；其他 Bot 看不到这条记录；其他 Bot 的 tool/reasoning 不泄露。

交接不产生 `AgentEvent`，不推进 `eventRevision`；`activeRunId` 仍只表示真实模型 run。

### 5. 生产装配

首期至少注册两个真实 Conversation Bot，并建立团队预置：

- 入口 Bot 与目标 Bot 有不同 `identity`、`discovery`、profile、工具授权和职责说明。
- 团队预置的 `entryBotId` 是入口 Bot，`memberBotIds` 包含双方。
- `host.ts` 注册全部 Bot，构造 `BotCatalog` 和团队预置，并传给 `ConversationApplication`。
- 默认 `conversation` 单成员团队继续保留，用于单 Bot 会话。

首期不把 Interview、Coding 等域的执行器直接塞进 Conversation 目录。跨领域团队需要先解决全局目录或域间执行器契约，另立提案。

### 6. 取消、失败与可观测性

不设交接次数上限后，必须补齐：

- **整条链取消**：团队回合持有当前 run，取消时同时处理当前 run、后续交接链和排队消息，不能只记录入口 run。
- **目标启动失败**：交接记录已经写入、`activeAgentId` 已经切换时，明确返回失败并让 UI 显示“交接后启动失败”，不自动重放交接链，不伪造目标回复。
- **通知失败隔离**：`onSnapshot` 回调失败不能把状态机卡在中间；通知失败要显式记录，不能静默吞掉。
- **深度可观测性**：记录本回合经过的 Bot 顺序和失败点，用于排障；这不是次数上限。
- **资源释放**：每次交接结束前释放前一个 run 的 controller 和临时状态。

### 7. UI 与传输

- 新建会话支持选择单 Bot 或团队预置；协议继续使用 `ConversationSelection`。
- 团队发送使用现有 `team-send`；单 Bot 继续使用 `chat-send` 迁移入口。
- `ConversationView` 增加 `activeAgentId`、`bots` 和消息作者字段。
- 消息列表显示作者；顶部显示当前 Bot；交接记录折叠，默认不展开正文；单 Bot 不显示多余标识。
- renderer 不推导交接、不补造消息、不根据自然语言猜测当前 Bot。
- snapshot 仍包含 Bot→Bot 记录，但 UI 必须按 audience 处理，不能把“模型看不到”当成“用户看不到”。

### 8. 实施阶段

1. **第二个真实 Bot**：在 `conversation/bots/` 注册第二个 Bot，补 identity、discovery、profile 和 executor。
2. **团队预置与 host 接线**：在 `host.ts` 构造含两个成员的团队，启动期校验注册、成员和发现引用。
3. **可见目录注入**：把 `visibleBots` 的结果注入当前 Bot 的 prepare 输入；单 Bot 传空目录；补泄露测试。
4. **真实 result 产出**：验证 `Output.object` 与工具循环；必要时改为 run 收尾 `generateObject`；补正常回复、合法交接、非法目标、非法任务测试。
5. **应用硬化**：整链取消、目标启动失败、snapshot 通知失败；补并发和失败测试。
6. **UI 与传输**：团队选择、当前 Bot、作者、交接折叠；补 UI 测试。
7. **文档与验收**：更新多 Bot Note 和 AGENTS 边界；完成 Windows 实机交接后迁入 `implemented/feature/`。

## 模块边界

- `core/bot`：Bot 身份、目录、可见性、交接目标校验；不持有 store、不创建 run、不定义 prompt。
- `core/team`：团队预置和交接任务校验；不持有 Bot 身份或执行器。
- `core/agent`：模型执行、run 生命周期和结构化结果端口；不保存会话参与者。
- `core/transcript`：消息、快照、run 认领和交接记录；不保存 Bot 目录或长期记忆。
- `conversation`：唯一会话编排循环；不复制 store/run 语义。
- `conversation/bots`：每个 Bot 的执行器、profile、身份和可见性；不接受 renderer 注入。
- `host`：启动期注册与接线；不承载路由策略。
- `packages/ui`：作者、当前 Bot、交接提示的投影；不推导交接。
- `packages/shared`：跨进程 schema 与频道；不放团队或发现策略。
- 长期记忆：本提案不定义、不存储、不注入；另立独立 Note。

## 当前实现状态（2026-11-14）

### 已完成

- `core/bot/`：`contracts.ts`、`catalog.ts`、`directory.ts`；可见性同时要求会话参与者和 `BotDiscovery`。
- `core/team/`：`preset.ts`、`handoff.ts`；团队预置与交接任务长度校验。
- `ConversationApplication`：单 Bot/团队发送、`activeAgentId`、交接循环、snapshot 推送、队列串行。
- `ConversationStore`：交接记录、`beginHandoffRun`、`activeAgentId`、参与者 seed、清空后恢复。
- `projection.ts`：目标视角、作者视角、其他 Bot 隐藏、工具/reasoning 不泄露。
- `team-send`：shared channel、worker protocol、agent host、desktop IPC、preload 已通。
- 测试：`teamHandoff.test.ts`、`botSelection.test.ts`、`projection.test.ts`、`directory.test.ts`、`store.test.ts`。
- 当前相关测试：5 个文件、40 项通过。

### 仍未完成

1. 生产仍只有 `conversation.general`；没有第二个真实 Bot，也没有双成员团队预置。
2. 当前 Bot 的 prompt 没有注入可见 Bot 目录；模型不知道可以找谁。
3. `AgentDefinition.result` 只有测试注入，没有真实模型产出 `{ to, task }` 的路径。
4. UI 没有团队选择、作者、当前 Bot 和交接折叠；`listBots` 只到 bridge 与协议。
5. 取消只覆盖入口 run，目标 run 的整链取消未统一。
6. 目标启动失败后的用户可见状态和重试入口未定义。
7. 只有内存 transcript；进程退出后无法恢复，不能宣称可恢复的多 Bot 会话。

## 曾考虑的替代方案

- **把交接做成工具调用：** 舍弃。工具调用不能直接表达“结束当前 run 并转移会话所有权”，容易引入嵌套 run、重复 AI 消息和工具授权污染。
- **让模型输出自然语言“请找 X”，应用层解析：** 舍弃。会引入第二套解析器、无法保证目标 ID 合法，也更容易被 prompt injection 利用。
- **每次交接新建 conversation：** 舍弃。用户要求停留在同一个会话；新建会话会断开共享上下文，也会让 UI 出现两段对话。
- **给交接设置固定次数上限：** 舍弃。用户明确要求不限制交接次数；稳定性应通过取消、失败收口和可观测性解决，而不是隐藏 cap。
- **让 renderer 选择目标 Bot：** 舍弃。目标必须由 Agent 在可见目录内选择，应用层再校验；renderer 只负责展示和发起团队会话。
- **每个 Bot 独立进程或 sidecar：** 舍弃。现有单 Agent 进程的 `RunRegistry`、取消和事件流已经覆盖同会话串行 run；多进程会重复生命周期与恢复语义。
- **把长期记忆塞进 `ConversationStore`：** 舍弃。长期记忆是跨会话独立能力，不应污染 transcript；本提案不处理长期记忆。
- **首期直接做跨领域团队：** 舍弃。当前 `ConversationBotCatalog` 只覆盖 Conversation 域，Interview 执行器单独注册；先做同域双 Bot，跨域另立提案。

## 验收标准

- 可观察结果：
  - 双成员团队会话中，入口 Bot 正常回复后可以选择目标 Bot 接管；消息顺序是“用户 → 入口 Bot 回复 → 交接记录 → 目标 Bot 回复”，没有重复 AI 消息。
  - 单 Bot 会话没有可见目标，AI 不会交接。
  - 目标不可见或不属于参与者时，不写交接记录，当前 Bot 保持不变。
  - 连续交接可以发生；用户可以取消当前团队回合。
  - 交接记录在 UI 中折叠，默认不展开正文；单 Bot 不显示多余 Bot 标识。
  - 恢复快照后由 `activeAgentId` 对应 Bot 接待；本提案不承诺进程重启恢复。
- 自动化验证：
  - 可见目录注入只包含可见参与者，不含 prompt、工具或执行器。
  - `result` 正常回复、合法交接、非法目标、非法任务、目标启动失败。
  - 交接链取消、排队消息、snapshot 通知失败。
  - 单 Bot 无交接、双 Bot 交接、连续交接、参与者冲突拒绝。
  - UI 作者、当前 Bot、交接折叠、单 Bot 隐藏。
- 需要的实机验证：
  - Windows 11 下新建双成员团队会话，发送消息，确认 AI 自动交接、当前 Bot、消息顺序和取消行为。
  - 关闭并重新打开面板，确认 snapshot 中 `activeAgentId` 正确；不宣称进程重启恢复。

## 风险

- 模型可能选错目标或编造 Bot ID；目录注入只提供候选，应用层必须继续用 `participantAgentIds` 和 discovery 双重校验。
- 不设次数上限意味着模型可能来回交接；没有 cap 时，必须保留明确取消、失败收口和日志，不能靠 UI 猜测停止。
- 交接任务进入目标 Bot 的 user 内容，可能包含诱导性文本；任务长度有上限，目标/工具授权不能由任务文本改变。
- 目标启动失败会留下“交接记录已写入、activeAgentId 已切换、没有目标回复”的恢复点；必须有明确错误展示，不自动重放。
- snapshot 包含 Bot→Bot 记录；UI 过滤不严会泄露本应折叠的交接内容。
- 首期只支持 Conversation 域；跨领域团队需要新的目录/执行器契约，不能在本提案里假装通用。
- 当前只有内存 store；本提案完成后仍不能宣称重启恢复或长期记忆。
