# Note：Bot 目录与会话参与者选择（独立助手 + 多 Bot 协作）

状态：提案

## 问题

多 Bot 的会话持久化与交接已经在
[多 Bot 同会话注册、发现与交接](2026-11-11-multi-bot-session-registry-and-handoff.md)
中落地到应用层：`ConversationApplication` 可以在同一个 `conversationId` 内按顺序运行多个
Bot，`ConversationStore` 保存消息、`activeAgentId`、`participantAgentIds` 和交接记录。

但当前代码把“Bot 定义”和“会话团队装配”写在同一处，导致产品只能表现为一个固定 Bot：

1. `conversation/team.ts` 的 `ConversationBot` 同时携带 `identity`、`discovery`、`executor`
   和 `profile`，`createConversationTeam` 直接把一次会话的成员固化成 team。
2. `ConversationApplication` 构造时只认默认 `conversation` 团队，
   `sendChat` / `replyToLastUser` 通过 `requireDefaultTeam()` 固定到入口 Bot；
   renderer 只能传 `profileId`，不能表达“新建会话时选择哪个 Bot”。
3. `host.ts` 只注册 `conversation.general`、`interview.rehearsal` 和截图答题 Agent，
   没有向 `ConversationApplication` 传入可选择的 Bot 目录。
4. `core/team/directory.ts` 的可见性只在 `team.memberAgentIds` 内计算；跨团队或独立 Bot
   在目录层面不可能被发现，即使 `BotDiscovery.visibleTo` 已经支持 `team` 和 `bots`。
5. `ChatSendCommand.profileId` 把领域内的能力配置暴露到跨进程协议，Bot 选择没有服务端
   可校验的实体，后续新增 Bot 只能继续加 profile 分支。

产品需要同时支持两种形态：

- **独立助手**：用户新建会话时选择一个 Bot，该会话只由它接待；它仍然可以被同一套存储、
  run、事件和恢复链路处理。
- **多 Bot 协作**：用户新建会话时选择一个预置团队，或多个 Bot 被允许参与；会话内按现有
  交接机制切换发言者。

两者不能形成两套会话模型：独立助手只是“参与者只有一个”的会话，多 Bot 是“参与者有多个”
的会话。Bot 本身必须是一等实体，可以被多个会话复用，不持有 transcript。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/bot/`（新增）：Bot 契约、静态目录、可见性与交接校验。
  - `apps/agent/src/core/team/`：收缩为团队预置与交接任务校验，不再承载 Bot 定义。
  - `apps/agent/src/core/agent/definition.ts`、`registry.ts`：执行契约与身份/发现职责拆分。
  - `apps/agent/src/conversation/bots/`（新增）：Conversation 的 Bot 工厂。
  - `apps/agent/src/conversation/application.ts`：按 Bot/团队选择创建会话，单 Bot 与团队共用
    同一条 run 与交接链路。
  - `apps/agent/src/conversation/agent.ts`、`team.ts`：迁移或收缩。
  - `apps/agent/src/host.ts`：启动期注册全部 Bot、构建不可变目录、构造预置团队。
- UI/进程/协议/持久化表面：
  - `packages/shared/src/schema/bot.ts`（新增）：稳定 `BotSummary` schema。
  - `packages/shared/src/schema/conversation.ts`：复用 `BotSummary`，不新增会话状态。
  - `packages/shared/src/channels/conversation.ts`：新建会话增加选择；`chat.send` 用 Bot ID
    替代 `profileId`；团队发送保留。
  - `apps/desktop/src/main/conversation/*Ipc.ts`、`apps/desktop/src/main/agent/agentService.ts`、
    `apps/desktop/src/preload/index.ts`：转发选择与团队命令。
  - `packages/ui/src/app/`、`packages/ui/src/components/bots/`：Bot 选择、作者和当前 Bot。
  - 持久化沿用 `ConversationStore`；本提案不新增磁盘存储，也不承诺进程重启恢复。
- 相关 Note：
  - [多 Bot 同会话注册、发现与交接](2026-11-11-multi-bot-session-registry-and-handoff.md)
  - [产品方向与 Agent 底座](2026-10-20-product-direction-and-agent-foundation.md)
  - [面试向导、候选人与演练三 Agent 分工](2026-11-11-interview-three-agent-boundaries.md)
  - [领域 Agent 模块注册与面试链路归属](2026-11-07-domain-agent-module-registration.md)
  - [Conversation 领域布局](../../implemented/architecture/2026-11-06-conversation-domain-layout.md)
  - [core transcript 抽取](../../implemented/architecture/2026-11-08-core-transcript-store.md)
  - [Agent 工具系统基础](../../implemented/architecture/2026-11-09-agent-tool-system-foundation.md)

## 提案

### 1. 三个概念分开

```text
Bot                 静态实体：身份、发现策略、执行器、领域策略；可被多个会话复用
BotCatalog          启动期构建的不可变目录：注册、require、list、可见性校验
Conversation        会话实例：消息、activeRunId、participantAgentIds、activeAgentId
```

- Bot 是静态注册的；运行期不动态增删。新增 Bot 或调整可见性需要重启 Agent 进程。
- Conversation 只保存“这个会话允许哪些 Bot 参与”和“当前由谁接待”，不保存 Bot 定义。
- 独立助手与协作会话的差异只在 `participantAgentIds` 的长度和来源，不在存储或 run 语义。

### 2. `core/bot`

新增跨领域模块，只放纯契约与目录策略，不 import 任何领域：

```ts
// core/bot/contracts.ts
export interface BotIdentity {
  name: string;
  role: string;
  responsibility: string;
  owns: readonly string[];
}

export type BotVisibility =
  | { kind: "team"; teamId: string }
  | { kind: "bots"; agentIds: readonly AgentId[] };

export interface BotDiscovery {
  visibleTo: BotVisibility;
}

export type BotDomain = "conversation" | "interview" | "answer";

/** 给目录、协议和 UI 的只读身份；不含 prompt、工具或执行器。 */
export interface BotSummary {
  id: AgentId;
  name: string;
  role: string;
  responsibility: string;
  owns: readonly string[];
}

/** 领域装配单元：执行器和领域策略由领域提供，目录只负责查找。 */
export interface BotDescriptor<Input, Policy> {
  id: AgentId;
  identity: BotIdentity;
  discovery: BotDiscovery;
  domain: BotDomain;
  executor: AgentExecutor<Input>;
  policy: Policy;
}
```

```ts
// core/bot/catalog.ts
createBotCatalog<Input, Policy>(bots): {
  require(id: AgentId): BotDescriptor<Input, Policy>;
  find(id: AgentId): BotDescriptor<Input, Policy> | undefined;
  list(): readonly BotSummary[];
  ids(): readonly AgentId[];
};
```

- `createBotCatalog` 在构造时校验 ID 唯一、非空、身份完整。
- 目录按领域实例化：Conversation 与 Interview 各自持有自己的 `BotCatalog`，避免用
  `unknown` 执行器做跨领域强制转换。
- 目录不可变；`register` 只发生在 host 启动期。

```ts
// core/bot/directory.ts
visibleBots({ participants, viewer, catalog }): readonly BotDescriptor[];
assertCanHandoff({ participants, from, to, catalog }): void;
```

可见规则：

```text
to 可被 from 发现
  ⇔ to ∈ conversation.participantAgentIds
  ∧ to.discovery.visibleTo 允许 from（同 team 或显式 bots 列表）
```

- `participantAgentIds` 是会话级授权边界；`discovery` 是 Bot 级授权边界，两者取交集。
- 不维护第二套白名单；交接目标必须同时通过会话与发现校验。
- `viewer` 不出现在自己的可见目录中。
- 独立助手只有一个参与者，因此目录为空，交接必然被拒绝。

### 3. `core/team` 收缩

`TeamDefinition` 改名为 `TeamPreset`，只描述“一次会话预置选择哪些 Bot”：

```ts
export interface TeamPreset {
  teamId: string;
  entryBotId: AgentId;
  memberBotIds: readonly AgentId[];
}
```

- `core/team/` 不再保存 `identity`、`discovery`、`executor` 或 `profile`。
- `assertTeamPreset` 校验团队 ID、入口在成员内、成员不重复、成员都在目录中。
- 交接任务校验保留在 `core/team/handoff.ts`，与目录校验分开，避免 `core/bot` 承担领域
  任务文本策略。

### 4. Conversation 的 Bot 装配

```text
conversation/bots/types.ts       ConversationBot = BotDescriptor<ConversationAgentInput, ChatProfile>
conversation/bots/general.ts     createGeneralBot({ store, tools })
conversation/bots/index.ts       createConversationBots({ store, tools })
conversation/profiles/           每个 Bot 的 prompt、上下文策略与工具授权
```

- `conversation/agent.ts` 收缩为 `createConversationAgentDefinition` 的通用工厂，或直接迁入
  `bots/general.ts`；不再导出 `GENERAL_IDENTITY`/`GENERAL_DISCOVERY` 作为默认团队来源。
- `conversation/team.ts` 删除或收缩为 `presets.ts`，只导出 `ConversationTeamPreset`。
- 每个 Bot 的 profile 仍只声明 `ToolId[]`；不接受 renderer 传入 prompt、工具或 Agent ID。

### 5. 会话创建与发送

`ConversationApplication` 的构造参数改为：

```ts
interface ConversationApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  catalog: BotCatalog<ConversationAgentInput, ChatProfile>;
  presets?: readonly TeamPreset[];
  onSnapshot?: (snapshot: ConversationSnapshot) => void | Promise<void>;
  onTeamError?: (error: unknown) => void;
}
```

选择类型：

```ts
export type ConversationSelection =
  | { kind: "bot"; botId: AgentId }
  | { kind: "team"; teamId: string };
```

两个入口共用同一条链路：

```ts
createConversation(conversationId, selection): Promise<ConversationSnapshot>;

send(conversationId, request, accessToken): Promise<{ runId; snapshot }>;

sendTeam(conversationId, teamId, request, accessToken): Promise<{ runId; snapshot }>;
```

规则：

- `createConversation` 解析选择，写入 seed：
  - `{ kind: "bot" }` → `activeAgentId = botId`，`participantAgentIds = [botId]`。
  - `{ kind: "team" }` → 从预置解析 `entryBotId` 与 `memberBotIds`。
  - 已存在的会话不写入 seed，也不重置消息、`activeRunId`、`activeAgentId` 或 `participantAgentIds`；显式传入不同参与者时明确失败。
- `send` 读取会话快照：
  - 未创建时按默认入口 Bot 创建；已创建时使用 `activeAgentId`，没有则用唯一参与者。
  - 启动入口 Bot 的 run，等待 `done`；`completed` 且存在交接结果时进入现有交接循环。
- `sendTeam` 是显式的团队入口，行为与现有 `sendTeamMessage` 相同：等整条交接链回到 idle 后
  返回最终 snapshot。
- 迁移别名 `sendChat` 保留一个版本周期：接受可选 `botId`，不再接受 `profileId` 语义；
  renderer 迁移完成后删除。
- 单 Bot 会话的参与者只有一个，`visibleBots` 为空，因此不需要额外的“禁止交接”分支。

### 6. 发现与交接

- `assertCanHandoff` 使用 `participantAgentIds` + `catalog`，不再读取团队内成员列表。
- 交接仍然不是工具、不是嵌套 run：run 正常结束后读取 `AgentRunHandle.result`，写一条
  `authorAgentId = 来源`、`audience = bot:目标` 的完整消息，再启动目标 Bot 的新 run。
- 目标 Bot 必须在当前会话参与者和来源 Bot 的可见目录中；`task` 仍受长度上限约束。
- 预置团队只是“批量选择参与者”的快捷方式；后续可以允许用户自定义参与者列表，而不改
  store 或交接逻辑。

### 7. 协议

```ts
// shared/channels/conversation.ts
interface CreateConversationRequest {
  conversationId: string;
  selection?: ConversationSelection; // 缺省 = 默认入口 Bot
}

interface ChatSendCommand {
  operation: "chat.send";
  conversationId: string;
  botId?: string;       // 缺省使用会话 activeAgentId / 默认入口
  request: ConversationSendRequest;
}

interface TeamSendCommand {
  operation: "team.send";
  conversationId: string;
  teamId: string;
  request: ConversationSendRequest;
}
```

- renderer 只传 `botId`、`teamId`、用户输入；不传 prompt、工具、发现关系或 `profileId`。
- main 侧在转发前校验 `conversationId`、selection 形状和请求长度；agent 侧在 catalog 边界
  再次校验未知 Bot / 团队。
- `team-send` 在整条交接链回到 idle 后响应；中途继续通过 `conversation-snapshot` 和
  `AgentEventEnvelope` 推送。

### 8. UI 投影

- 新建会话：`BotPicker` 读取 `bot.list`（或 `ConversationSnapshot.bots` 的会话内身份），
  传 `selection`；独立助手与团队使用同一个选择控件。
- 会话内：显示 `activeAgentId` 对应的 Bot 名称；消息按 `authorAgentId` 显示作者；交接记录
  折叠，默认不展开正文。
- 单 Bot 会话不显示多余 Bot 标识，但仍读取同一 `bots` 字段。
- UI 不推导交接、不补造消息、不根据自然语言猜测当前 Bot。

### 9. 明确不做

- 不新增第二套 transcript、消息 store、snapshot 或 revision。
- 不把 Bot 做成独立进程或 sidecar。
- 不让 renderer 传入 Agent ID、system prompt、工具实现或发现关系。
- 不把交接做成工具、嵌套 run 或第二条 AI 消息。
- 不为“独立助手”新增一套会话模型；单 Bot 只是参与者只有一个。
- 不实现 Bot 跨会话共享记忆；当前 transcript 仍按 `conversationId` 隔离。
- 不实现磁盘持久化或进程重启恢复。
- 不在本提案内改动 Interview 的 VAD、ASR、turn settle 路径。
- 不把预置团队做成运行期可变注册表；新增预置仍需重启 Agent 进程。

## 模块边界

```text
core/bot        Bot 契约、静态目录、可见性与交接目标校验；不持有 store、不创建 run、
                不 import 领域、不定义 prompt
core/team       团队预置与交接任务校验；不持有 Bot 身份或执行器
core/agent      执行契约、run 生命周期、模型调用；不保存会话参与者选择
core/transcript 消息、快照、run 认领、交接记录；不保存 Bot 身份或发现关系
conversation    会话编排与 Conversation Bot 装配；不复制 store/run 语义
conversation/bots 每个 Bot 的执行器、profile 与身份；不接受 renderer 注入
host            启动期注册 Bot、构建目录与预置、注入应用；不承载路由策略
desktop         命令转发与 snapshot 推送；不决定 Bot 身份或交接目标
packages/ui     选择、作者、当前 Bot 的投影；不推导交接
packages/shared 跨进程 schema 与频道；不放团队或发现策略
```

依赖方向：

```text
conversation ──> core/bot ──> core/agent
conversation ──> core/team ──> core/bot
conversation ──> core/transcript
interview    ──> core/bot + core/team
host         ──> 所有领域（只接线）
```

## 曾考虑的替代方案

- **继续让 `conversation/team.ts` 同时持有 Bot 定义和会话成员：** 舍弃。独立助手无法从目录
  选择，新增 Bot 必须改团队装配；`profileId` 会继续作为跨进程 Bot 标识。
- **每个 Bot 独立一个 conversation，切换 Bot 时切 conversation：** 舍弃。协作形态会丢失
  同一会话的共享上下文，用户看到的对话会断裂；独立助手可以用单参与者会话表达，不需要
  第二套模型。
- **建立运行期可变的全局 Bot 注册表：** 舍弃。首期需要的是启动期确定、可测试的目录；
  动态增删会引入并发、权限和恢复问题，当前没有对应需求。
- **每个 Bot 独立进程或 sidecar：** 舍弃。现有单 Agent 进程的 `RunRegistry`、取消、事件
  流已经覆盖同会话串行 run；多进程会重复连接、授权与恢复语义。
- **把 Bot 记忆塞进 `ConversationStore`：** 舍弃。当前会话记忆按 `conversationId` 隔离；
  跨会话的 Bot 记忆是独立持久化能力，不应污染 transcript。
- **继续用 `profileId` 作为 Bot 选择：** 舍弃。profile 是领域内 prompt/工具策略，不是
  可发现、可授权、可展示的实体；协议必须传服务端可校验的 Bot ID。
- **让 `core/bot` 直接保存 `identity`、`discovery`、`executor` 并跨领域复用同一个目录：**
  舍弃。不同领域的输入类型和策略不同，强行使用 `unknown` 执行器会丢失类型安全；按领域
  实例化目录，共享契约与纯函数即可。

## 实施阶段

1. **目录契约**：新增 `core/bot`，把 `BotIdentity`/`BotDiscovery` 从
   `core/agent/definition.ts` 迁移或重导出；补唯一性、未知 ID、可见性测试。
2. **Conversation Bot 装配**：新增 `conversation/bots/`，把 `conversation.general` 从
   `conversation/agent.ts` 迁入；保留 `ChatProfile` 作为 Bot policy。
3. **应用选择**：`ConversationApplication` 接受 catalog 与预置，新增
   `createConversation(selection)`，`send` 读取会话 active Bot；单 Bot 与团队共用交接循环。
4. **Host 接线**：注册全部 Conversation Bot、构建 catalog 与预置，`create-conversation`
   与 `chat-send` 支持选择；补启动期失败测试。
5. **协议与桌面**：shared channel、worker 协议、desktop IPC、preload 全部改为 Bot/团队
   选择；保留 `chat-send` 迁移别名。
6. **UI**：Bot 选择、作者、当前 Bot、交接折叠；补 UI 测试。
7. **文档**：实施完成后把本 Note 迁入 `implemented/`，同步
   `2026-11-11-multi-bot-session-registry-and-handoff.md` 中“团队装配在 conversation/team.ts”
   的差异说明和 `AGENTS.md` 的 Agent 运行时边界。

## 实施进度（2026-11-12）

### 已完成

- `core/bot/`：`contracts.ts`、`catalog.ts`、`directory.ts`；目录按领域实例化，可见性同时要求会话参与者与
  `BotDiscovery` 允许。
- `core/team/`：收缩为 `preset.ts` 与 `handoff.ts`；删除 `types.ts`、`directory.ts`。
- `conversation/bots/`：`types.ts`、`general.ts`、`index.ts`；`conversation.general` 迁入 Bot 工厂。
- `ConversationApplication`：接受 `catalog` 与 `presets`；新增 `createConversation(selection)`、`send(botId, ...)`、
  `listBots()`；单 Bot 与团队共用同一条 run/交接循环；`sendChat(profileId)` 仅保留为迁移别名。
- `host.ts`：启动期构造 `BotCatalog` 与 `conversation` 单成员预置，接入 `bot-list`、`create-conversation.selection`、
  `chat-send.botId`、`team-send`。
- 协议与桌面：shared 增加 `ConversationSelection`、`TeamSendCommand`、`ListBots`；worker 增加 `team-send`、
  `bot-list`；desktop IPC/preload 转发选择。
- 测试：`test/core/team/directory.test.ts` 重写为 Bot 目录测试；新增
  `test/conversation/botSelection.test.ts`；`teamHandoff.test.ts` 改用 catalog + preset；worker host 覆盖
  `bot-list` 与 `create-conversation.selection`。
- UI 契约测试：`FloatingBarApp.conversation.test.tsx` 的 `chat.send` 断言移除 `profileId`，与协议
  “默认 Bot 由服务端解析”保持一致。

### 跨客户端组装入口（2026-11-12）

- 新增 `conversation/bots/create.ts`：`createConversationBot` 由领域自己装配 identity、executor 与
  profile；默认参数仍生成 `conversation.general`，客户端可传入自己的 `id`/`identity`/`discovery`。
- 新增 `apps/agent/src/composition.ts` 与包入口 `@answra/agent/composition`：暴露 `AgentRuntime`、
  transcript/execution store、工具注册表、Bot 契约/目录/可见性、团队预置、Conversation Bot 工厂与
  `ConversationApplication`，让 CLI 或其他客户端按领域组装自己的 Bot，不需要深导入或依赖 worker 协议。
- 入口不包含 `worker/protocol.ts`、Electron 或 CLI 传输层；worker 线协议仍只服务 desktop 宿主。
  舍弃“让 CLI 直接复用 worker 协议”的方案：命令/帧类型绑定 desktop utility process，复用会把 CLI
  传输层和 Electron 宿主生命周期绑在一起。
- 新增 `test/composition.test.ts`：用公开入口组装内置 Bot 和客户端自定义 Bot，证明目录、会话 seed
  与 application 可直接复用。

### 修复：单一 Bot 身份源与会话 seed 不可改写（2026-11-12）

- **问题**：`AgentRuntime` 的 `AgentRegistry` 与 `BotCatalog` 各存一份 `identity`/`discovery`；`createLegacyCatalog` 还会用默认身份包装任意 executor。与此同时，`MemoryConversationStore.create` 对已存在会话重新应用 seed，`ConversationApplication.send` 每次发送都调用 `create`，导致 Bot 归属、participants 与后续 `clear` 可能被第二个 selection 改写。
- **决定**：`AgentRegistry` 只保留可执行 Agent ID，`BotCatalog` 成为 Bot 身份与发现的唯一来源；删除 `conversationAgent`/`createLegacyCatalog` 兼容入口，目录必填；启动期校验全目录 discovery 引用和 runtime 注册。`ConversationStore.create` 对已存在会话只读取不写入；显式 Bot/团队选择与既有参与者冲突时抛出错误，禁止静默改写。
- **替代方案**：保留 `AgentRegistry` 的 identity/discovery 作为并行源（舍弃：两份描述符必须人工同步，外部客户端可绕过，`listBots`/handoff/runtime 可能读到不同身份）；冲突 selection 静默忽略（舍弃：调用方无法判断选择是否生效）；继续在已存在会话上覆盖 seed（舍弃：会改变 clear 后的 Bot 与下一次 run 的 participants）。
- **后果**：同一会话的 Bot 归属只在创建时确定；已有会话重复 `create` 是幂等读取；`send` 的显式 `botId` 必须等于当前 `activeAgentId`；`chat-send` 缺省仍沿用当前 Bot。
- **验证**：`AgentRegistry` 只测 ID 注册与团队入口/成员；Bot 目录测试覆盖全目录 discovery 悬空引用；store 测试覆盖重复 `create` 不覆盖 seed 且 `clear` 保留原 seed；会话测试覆盖不同 Bot selection、显式 `send(botId)` 与团队 send 的冲突拒绝。

### 验证（2026-11-12）

- 通过：`pnpm lint`、四包 `typecheck`、`pnpm architecture:check`、`pnpm tokens:check`、
  `pnpm notes:check`。
- 通过：`@answra/ui` 297 项；`@answra/agent` 单包 439 项（含 Bot 目录、单 Bot 选择、团队交接、
  跨客户端组装和 worker host 新用例）。
- 通过：`pnpm --workspace-concurrency=1 -r --if-present test` 四包顺序执行全绿：shared 2、
  agent 439、ui 297、desktop 317。
- `pnpm verify` 在整仓并发执行时，未改动的
  `apps/agent/test/core/tool/shell/sessions.test.ts` 与部分 UI 组件测试偶发超时或找不到元素；
  单包/顺序复跑均通过，判定为并发负载下的既有时序 flaky，不是本变更引入。需要全绿证据时用
  `pnpm --workspace-concurrency=1 -r --if-present test`；若持续出现，应单独修测试等待条件或降低
  workspace 并发，不夹带进本提案。

### 仍未完成

1. **真实交接结果产出**：`AgentDefinition.result` 仍只有测试注入，没有模型产出 `{ to, task }` 的路径。
2. **UI**：尚未加入 Bot 选择器、作者/当前 Bot 标签和交接折叠条；`listBots` 只完成 bridge 与协议。
3. **Interview 文本交接**：Interview 仍用自己的 application，没有复用 `core/bot` 与 `core/team`。
4. **第二个真实 Bot**：当前只注册 `conversation.general`；多 Bot 交接由测试替身证明，产品侧还没有可选团队。
5. `core/team/context.ts` 仍未创建；交接前缀仍在 `core/transcript/projection.ts`。
6. **CLI 应用**：本次只提供 `@answra/agent/composition` 公共组装入口与测试；CLI 的命令解析、
   传输层和领域应用循环尚未创建。

## 验收标准

- 可观察结果：
  - 新建独立助手会话后，只有选中的 Bot 接待；`participantAgentIds` 长度为 1，交接被拒绝。
  - 新建团队会话后，入口 Bot 可以按现有交接机制切到另一个参与者；消息顺序、作者和
    `activeAgentId` 正确。
  - 同一个 Bot 可以出现在多个独立会话中，消息和历史互不串台。
  - 恢复快照后仍由 `activeAgentId` 接待；清空会话后回到入口 Bot。
  - renderer 无法通过协议传入 prompt、工具、发现关系或任意 Agent ID。
- 自动化验证：
  - `core/bot`：重复 ID、空 ID、未知 ID、可见性交集、交接目标越权。
  - `conversation/application`：单 Bot 无交接、团队交接、取消、失败、非法选择、已存在会话
    不重置。
  - `host`：Bot 注册、目录构建、未知 Bot/团队启动或命令失败。
  - shared channel / desktop IPC / preload：选择字段序列化与转发。
  - UI：Bot 选择、作者、当前 Bot、单 Bot 隐藏标识。
- 需要的实机验证：
  - Windows 11 下新建独立助手会话并发送一条消息。
  - 新建团队会话，从入口 Bot 交接给另一个 Bot，检查消息顺序、当前 Bot、取消和恢复。

## 风险

- 把 `BotIdentity`/`BotDiscovery` 从 `core/agent` 移出会触及现有 import；迁移时保留
  re-export 或一次改完，不能出现两份类型定义。
- `createConversation` 对已存在会话的“只补缺失 seed”规则如果不严格，可能重置正在进行的
  会话；必须在 store 边界和测试中固定。
- `chat.send` 从 `profileId` 改为 `botId` 是协议破坏性变更；桌面端与 agent 必须同一变更
  发布，迁移期保留可选别名，不长期维护两套语义。
- 预置团队是启动期静态数据；新增 Bot 或调整成员需要重启 Agent 进程，当前接受这个代价。
- 独立助手会话的 `visibleBots` 为空，交接结果如果被模型产出，应用层必须拒绝并收口，
  不能静默写入越权记录。
- 当前只有内存 transcript；进程退出后 Bot 选择、消息和 `activeAgentId` 都会丢失，不能
  宣称可恢复的独立助手或协作会话。
- UI 如果继续从本地状态推断当前 Bot，会与 snapshot 的 `activeAgentId` 冲突；必须单一来源。
