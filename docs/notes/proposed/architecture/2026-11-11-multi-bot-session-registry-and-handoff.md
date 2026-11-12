# Note：多 Bot 同会话注册、发现与交接（统一会话持久化）

状态：提案

修订于 2026-11-11：初版把团队会话做成独立的 `TeamSession`、`TeamEntry` 与 `TeamSessionRuntime`，会与 `ConversationStore` 形成两套 AI 消息，并重复 `activeRunId`、`eventRevision`、取消与恢复语义。本版删除该设计，统一为“`ConversationStore` 唯一持久化 + 应用层交接循环 + team 纯策略”；单 Bot 会话也走同一条路径。初版方案保留在“曾考虑的替代方案”中作为反例。

## 问题

当前 `conversation` 域只有一个静态 Agent（`conversation.general`），一次会话从始至终由同一个 system prompt 和同一套工具处理。产品接下来需要同一会话内出现多个定位不同的 Bot：

- 每个 Bot 有自己的身份、职责说明、system prompt、工具集、模型路由和资源授权。
- 用户始终停留在同一个会话里；Bot 切换不等于新建会话。
- 一个 Bot 判断当前事项应由另一个 Bot 负责时，终止本轮 run，向目标 Bot 发一条“要你做什么”的消息，由目标 Bot 接管后续发言。
- Bot 的发现关系由注册身份决定：一个 Bot 只应该发现它被允许发现的其他 Bot。
- 只有一个 Bot 的会话也必须走标准的会话持久化和 run 路径，不能因为“只有一个 Bot”而回到另一套内存会话。

初版实现把团队会话做成独立模型后，出现四个不可接受的后果：

1. 同一轮 AI 回复在 `TeamSession.entries` 和 `ConversationStore` 中各有一份，持久化后就是两条 AI 消息。
2. `activeRunId`、`eventRevision`、取消、恢复各有两套来源，UI 与事件流无法判断哪一套是事实。
3. 单 Bot 继续走旧 `chat-send`，多 Bot 走新团队路径，会形成两套会话语义，后续每个功能都要判断“这是哪种会话”。
4. `BotTurnResult.reply` 会在流式 assistant 消息之外再补一条 AI 消息，交接时用户看到重复回复。

因此本提案的硬约束是：

1. `ConversationStore` 是唯一消息与会话持久化；`ConversationMessage` 是唯一消息模型。
2. 单 Bot 会话与多 Bot 会话共用同一条持久化与 run 路径；单 Bot 只是 team 只有一个成员。
3. Bot/team 不持有 transcript、不持有会话状态、不生成 snapshot；团队只回答“下一个由谁发言”。
4. 交接是当前 run 正常结束后的控制结果，不是工具、不是嵌套 run、不是第二个会话。
5. 原有 user/assistant 消息的写入、事件应用、revision、取消、恢复语义不变；只增加作者与受众归属。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/schema/conversation.ts`：消息归属、会话激活 Bot、参与者；导出 `MessageAudience`。
  - `packages/shared/src/schema/index.ts`、`packages/shared/src/index.ts`：稳定导出新的消息受众类型。
  - `apps/agent/src/core/transcript/store.ts`、`memoryStore.ts`、`message.ts`：唯一消息与会话持久化、run 认领、交接记录。
  - `apps/agent/src/core/transcript/projection.ts`（新增）：`ConversationMessage` 到模型消息的纯投影，Conversation 与 Team 共用。
  - `apps/agent/src/core/agent/definition.ts`、`registry.ts`、`runtime.ts`、`executeRun.ts`：Bot 身份、发现策略、结构化工件结果与 run 结果端口。
  - `apps/agent/src/core/team/`（新增）：团队定义、目录、可见性、交接校验、目录渲染；只放纯策略，不放 runtime/store/snapshot。
  - `apps/agent/src/conversation/application.ts`、`agent.ts`、`profiles/`：唯一会话编排循环、单 Bot 别名、每个 Bot 的 profile 与工具授权。
  - `apps/agent/src/answer/`、`apps/agent/src/interview/`：补充消息作者归属；Answer 保持一次性，实时音频路径不接入团队循环。
  - `apps/agent/src/host.ts`：启动期注册 Bot 与团队、装配会话运行时、推送 snapshot。
  - `apps/agent/src/worker/protocol.ts`：显式团队会话命令与响应时机。
- UI/进程/协议/持久化表面：
  - `packages/shared/src/channels/conversation.ts`、`packages/shared/src/bridge.ts`：团队会话命令。
  - `apps/desktop/src/main/conversation/`、`apps/desktop/src/main/agent/`：命令转发与 snapshot 推送。
  - `packages/ui/src/app/`：消息作者、当前 Bot、交接提示的投影。
  - transcript 持久化沿用现有 `ConversationStore`；当前只有内存实现，不承诺进程重启恢复。
- 当前原型：
  - `apps/agent/src/team/` 已有 `TeamSessionRuntime`、`TeamEntry` 和独立 snapshot，仅用于验证行为。它违反本提案，第一阶段删除；`apps/agent/test/team/handoff.test.ts` 重写为 store/application 级测试。不要在原型上继续接线。
- 相关 Note：
  - [产品方向与 Agent 底座](2026-10-20-product-direction-and-agent-foundation.md)
  - [面试向导、候选人与演练三 Agent 分工](2026-11-11-interview-three-agent-boundaries.md)
  - [领域 Agent 模块注册与面试链路归属](2026-11-07-domain-agent-module-registration.md)
  - [Agent host 组装与传输](../../implemented/architecture/2026-10-17-agent-host-composition-and-transport.md)
  - [Agent Runtime 命名与分层](../../implemented/architecture/2026-10-17-agent-runtime-rename-and-layering.md)
  - [对话领域布局](../../implemented/architecture/2026-11-06-conversation-domain-layout.md)
  - [单一 Agent 事件流](../../implemented/architecture/2026-11-07-single-agent-event-stream.md)
  - [core transcript 抽取](../../implemented/architecture/2026-11-08-core-transcript-store.md)
  - [Agent 工具系统基础](../../implemented/architecture/2026-11-09-agent-tool-system-foundation.md)
  - [执行生命周期运行时集成](../../implemented/architecture/2026-11-07-execution-lifecycle-runtime-integration.md)
  - [事件与状态词汇归属](../../implemented/architecture/2026-11-06-agent-event-status-domain-ownership.md)
  - [面试演练与面试记忆](../../implemented/feature/2026-11-10-interview-rehearsal-and-memory.md)

## 提案

### 1. 一条持久化链

```text
ConversationApplication   唯一会话编排：跑当前 Bot → 读结果 → 写交接 → 启动下一个 Bot
core/transcript           唯一消息与会话持久化：消息、activeAgentId、participants、run 认领、交接记录
core/agent                唯一 run 生命周期：runId、cancel、result、事件写入
core/team                 纯策略：团队定义、目录、可见性、交接校验、目录渲染
```

- `ConversationMessage` 是唯一消息模型；user 输入、Bot 回复、Bot 交接都是它，不新增 `TeamEntry`。
- `ConversationSnapshot` 是唯一会话快照；`activeAgentId`、`participantAgentIds`、消息归属全部由 `ConversationStore` 维护。
- 交接循环放在 `ConversationApplication`，使用现有的 `AgentExecutor.startRun`、`ConversationStore.begin*`、`AgentRuntime.cancel`；不新建 `TeamSessionRuntime`，不新建团队 controller，不新建团队 snapshot。
- `core/team` 只提供类型和纯函数；它不 import 任何领域，也不持有 `ConversationStore` 或 AI SDK。
- 单 Bot 是一个只有一个成员的 team，仍走 `beginRun` → `applyAgentEvent` → `load` 的同一链路，不会产生 handoff。

### 2. 会话状态与 store 契约

`ConversationSnapshot` 保留现有字段，增加：

```ts
interface ConversationSnapshot {
  conversationId: string;
  eventRevision: number;
  messages: ConversationMessage[];
  activeRunId?: string;
  activeAgentId?: string;
  participantAgentIds?: string[];
}
```

`activeAgentId` 表示“当前由哪个 Bot 拥有会话”，`participantAgentIds` 表示“这个会话允许参与哪些 Bot”。两者是会话元数据，不是第二套消息，也不替代 `activeRunId`。

`ConversationMessage` 增加：

```ts
interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  authorAgentId?: string;
  audience?: MessageAudience;
  text: string;
  images: { name: string; dataUrl: string }[];
  status: AgentMessageState;
  parts?: ConversationMessagePart[];
  reasoning?: string;
}

type MessageAudience =
  | { kind: "user" }
  | { kind: "bot"; agentId: string };
```

兼容规则：`audience` 缺省等于用户可见，`authorAgentId` 缺省等于单 Agent/历史消息。新写入必须显式设置：用户消息 `audience = user`，Bot 回复 `authorAgentId = 发言 Bot`、`audience = user`，交接记录 `authorAgentId = 来源 Bot`、`audience = bot:目标 Bot`。`beginHandoffRun` 在 store 边界强制校验这个不变量。

`ConversationStore` 扩展：

```ts
interface ConversationSessionSeed {
  activeAgentId: string;
  participantAgentIds: readonly string[];
}

create(conversationId: string, seed?: ConversationSessionSeed): Promise<ConversationSnapshot>;

beginRun(
  conversationId: string,
  runId: string,
  userMessage: ConversationMessage,
  eventRevision?: number,
  authorAgentId?: string,
): Promise<void>;

beginReplyRun(
  conversationId: string,
  runId: string,
  eventRevision?: number,
  authorAgentId?: string,
): Promise<ConversationMessage>;

beginHandoffRun(
  conversationId: string,
  runId: string,
  targetAgentId: string,
  eventRevision?: number,
): Promise<ConversationMessage>;

appendHandoffMessage(
  conversationId: string,
  handoff: {
    id: string;
    fromAgentId: string;
    toAgentId: string;
    task: string;
  },
): Promise<ConversationSnapshot>;

setActiveAgent(conversationId: string, agentId: string): Promise<void>;
```

关键语义：

- `create` 是幂等的。会话已存在时只补齐缺失的 `activeAgentId`/`participantAgentIds`，绝不重置正在进行的会话；新会话写入 seed。
- `beginRun` 追加用户消息和带 `authorAgentId` 的 assistant 占位；`beginReplyRun` 认领最后一条完整用户消息并创建占位；两者都把 `activeAgentId` 设为 `authorAgentId`。
- `beginHandoffRun` 认领最后一条“完成、`audience = bot:target`”的交接消息，创建 `authorAgentId = target` 的 assistant 占位，并把 `activeAgentId` 设为 target。最后一条不是发给 target 的交接时抛出稳定错误。
- `appendHandoffMessage` 写入一条完整的 `ConversationMessage`：`role = assistant`、`authorAgentId = from`、`audience = bot:to`、`status = complete`、`parts = []`。它不创建 assistant 占位、不产生 `AgentEvent`、不推进 `eventRevision`；写入后 `activeAgentId = to`。
- `clear` 只在空闲会话执行；清空消息后把 `activeAgentId` 恢复为 seed 的入口 Bot，保留 `participantAgentIds`。没有 seed 的一次性会话（Answer）保持无团队字段。
- `beginEphemeralRun` 仍用于 Answer 一次性会话，但 assistant 占位也记录 `authorAgentId = answer agent`；会话结束清空行为不变。
- 所有 `begin*` 仍以 `activeRunId` 为唯一并发认领凭据；删除团队侧的 `running` Set 与独立 controller。
- `applyAgentEvent` 不变：assistant 占位通过现有事件流更新文本、part 和状态；交接记录没有事件，只存在于 snapshot 的 messages 中。

### 3. Bot 注册与发现目录

沿用 `AgentDefinition` 作为 Bot 的注册单元，把身份和发现策略提升为一级字段：

```ts
interface BotIdentity {
  /** 展示名，例如“面试向导”。 */
  name: string;
  /** 稳定角色名，例如 "intake"。 */
  role: string;
  /** 给其他 Bot 和用户看的职责说明。 */
  responsibility: string;
  /** 职责拥有的领域标签，用于交接目标匹配。 */
  owns: readonly string[];
}

type BotVisibility =
  | { kind: "team"; teamId: string }
  | { kind: "bots"; agentIds: readonly AgentId[] };

interface BotDiscovery {
  /** 哪些 Bot 可以发现我；同时决定谁可以向我发起交接。 */
  visibleTo: BotVisibility;
}

interface AgentDefinition<Input> {
  readonly id: AgentId;
  readonly identity: BotIdentity;
  readonly discovery: BotDiscovery;
  readonly modelRoute: AgentModelRoute;
  prepare(input: Input, signal: AbortSignal, emitter?: AgentToolOutputEmitter): Promise<AgentModelRequest>;
}
```

`AgentRegistry` 从“只存 ID”升级为“存定义并做启动期校验”：

- ID 唯一；
- `discovery.visibleTo` 引用的 team 或 Bot 已注册；
- 团队定义的入口与成员都已注册；
- 团队成员的可见性至少允许入口/当前交互方发现（具体规则由 `core/team` 校验）。

`TeamDefinition` 只引用 ID，不再复制展示名：

```ts
interface TeamDefinition {
  teamId: string;
  entryAgentId: AgentId;
  memberAgentIds: readonly AgentId[];
}
```

`core/team/directory.ts` 负责：

```text
A 能发现 B ⇔ B.discovery.visibleTo 包含 A 或 A 所属的 team
```

- `{ kind: "team", teamId }`：该 team 的所有成员互相可见。
- `{ kind: "bots", agentIds }`：只对显式列出的 Bot 可见。
- 发现 ACL 和交接权限是同一份规则，不维护第二套白名单。
- 目录在启动期构建后不可变；运行期不按消息内容动态增删。
- 目录以结构化数据注入 Bot 的 `prepare`，由各领域 profile 决定如何渲染进提示词；`core/team` 提供默认渲染函数，不定义领域 prompt。

团队组成：

- `conversation` 团队：入口 `conversation.general`；第一阶段只有一个成员，后续加入写作、资料整理等 Bot。所有 Conversation 会话都创建这个团队，单 Bot 是多 Bot 的特例。
- `interview` 团队：入口与成员对应 `interview.intake`、`interview.candidate`、`interview.rehearsal`；文本场景复用本提案的循环，实时音频路径仍由 `interview/runtime.ts` 持有。
- `Answer` 不建团队：它是一次性截图问答，没有交接语义，继续走自己的 ephemeral 路径。

### 4. 回合结果与交接

交接不是工具调用，也不进入工具授权清单。每个 Bot 的 run 可以产出结构化回合结果：

```ts
type BotTurnResult = {
  kind: "handoff";
  /** 目标 Bot；必须出现在当前 Bot 的可见目录中。 */
  to: AgentId;
  /** 给目标 Bot 的交接说明；在目标视角是一条 user 消息。 */
  task: string;
};
```

`AgentRunHandle` 增加结果端口：

```ts
interface AgentRunHandle<Prepared> {
  runId: string;
  eventRevision: number;
  prepared: Prepared;
  /** 未声明回合结果的 Agent 为 undefined。 */
  result: Promise<BotTurnResult | undefined>;
  done: Promise<RunOutcome>;
}
```

- 不保留 `BotTurnResult.reply`。用户看到的离开前回复就是本次 run 流式写入 `ConversationStore` 的那条 assistant 消息；再补一条会造成重复 AI 消息。
- 结构化结果与工具循环的组合方式依赖 AI SDK 6 的实际行为。实现前用最小样例核对 `streamText` + `Output.object`；若同一次运行受限，则在 run 末尾用 `generateObject` 只产出 `{ to, task }` 控制结果，不产出用户可见回复。两种方式对上层接口一致。
- 模型输出不是授权来源：`to` 必须重新按 `visibleMembers` 校验；`task` 必须非空并受长度上限约束；`from` 永远是当前 `activeAgentId`，不由模型填写。

交接三步：

1. 当前 run 以 `handoff` 结果正常完成（`outcome = completed`），不使用 abort；用户取消仍走现有 `AbortController`。
2. `ConversationStore` 追加一条 `{ author: A, audience: bot:B, task }` 记录；交接记录不产生事件，不推进 revision。
3. `activeAgentId = B`，启动 B 的新 run；`beginHandoffRun` 认领这条记录并创建 B 的 assistant 占位。

循环终止条件：

- 结果为 `undefined` 或 `reply`：当前 Bot 已把回复写入 assistant 消息，会话回到 idle。
- `done` 不是 `completed`（`aborted`、`failed`、`superseded` 等）：不启动下一段 run；当前 run 的消息状态由现有 store 逻辑收口。
- 交接目标不可见或 `task` 非法：不写交接、不启动下一段 run，错误返回给调用方。
- 不设置 `MAX_HANDOFFS`；由各 Bot 的 `owns`/`responsibility` 约束交接链。

### 5. 消息投影

消息投影上提到 `core`，由 Conversation 与 Team 共用；这是第二个消费者出现后的合理抽象，不复制第二份模型消息构建逻辑：

```text
core/transcript/projection.ts   按 audience/author 过滤并映射角色与内容
conversation/turn/modelMessages.ts  只保留请求构建、时间提醒等对话领域输入
core/team/context.ts            提供 Bot 展示名与交接前缀渲染
```

投影规则：

| 会话记录 | 对用户 | 对作者 A | 对接管者 B | 对其他 Bot |
| --- | --- | --- | --- | --- |
| 用户输入 | user | user | user | user |
| A → 用户回复 | assistant | assistant | assistant | assistant |
| A → B 交接 | 不显示正文 | assistant | user | 隐藏 |
| B → 用户回复 | assistant | assistant | assistant | assistant |

- `author = 我`：assistant，保留文本、图片和工具调用回放，保证作者自己的多步上下文连续。
- `audience = 我`：user；交接消息渲染为 `【来自<名称>的交接】\n<task>`。
- `audience = user`：按原角色；其他 Bot 的回复只保留文本，不泄露其 tool part 与 reasoning。
- 其他：不进入当前 Bot 的上下文。
- `audience`/`authorAgentId` 缺省：按用户可见的单 Agent 历史处理，继续使用现有 assistant 工具回放逻辑。
- 投影不注入任何 Bot 的 system prompt、工具实现或内部推理；目标 Bot 只看到会话事实与交接要求。

### 6. 会话编排循环

`ConversationApplication` 增加 `sendTeamMessage`，它是唯一的会话编排入口：

```ts
async sendTeamMessage(conversationId, teamId, text) {
  const team = this.teams.require(teamId);
  await this.store.create(conversationId, {
    activeAgentId: team.entryAgentId,
    participantAgentIds: team.memberAgentIds,
  });

  let handle = await this.startBot(conversationId, team.entryAgentId, { kind: "user", text });

  for (;;) {
    const outcome = await handle.done;
    if (outcome !== "completed") return this.store.load(conversationId);

    const result = await handle.result;
    if (!result || result.kind !== "handoff") return this.store.load(conversationId);

    const from = this.requireActiveAgent(team, conversationId);
    assertCanHandoff(team, from, result.to);
    await this.store.appendHandoffMessage(conversationId, {
      id: randomUUID(),
      fromAgentId: from,
      toAgentId: result.to,
      task: result.task,
    });
    await this.pushSnapshot(conversationId);

    handle = await this.startBot(conversationId, result.to, { kind: "handoff" });
  }
}
```

`startBot` 复用现有执行链：

```ts
this.executor(agentId).startRun({
  conversationId,
  getAccessToken,
  prepareRun: async ({ runId, eventRevision }) => {
    const trigger =
      input.kind === "user"
        ? await this.store.beginRun(conversationId, runId, createUserMessage(...), eventRevision, agentId)
        : await this.store.beginHandoffRun(conversationId, runId, agentId, eventRevision);
    const snapshot = await this.store.load(conversationId);
    await this.onSnapshot?.(snapshot);
    return { input: { conversationId, runId, viewerAgentId: agentId, team, trigger }, prepared: snapshot };
  },
  onEvent: (event) => this.applyRunEvent(conversationId, event),
});
```

关键性质：

- 同一时刻只有一个活动 run；并发认领只由 `ConversationStore.activeRunId` 承担。
- 前一个 run 完全结束后才启动下一个 run，不存在两条流同时写同一个 assistant 占位。
- 取消复用现有 `cancel(runId)`；循环看到 `done` 不是 `completed` 就停止，不创建第二套取消机制。
- `team-send` 在整条交接链回到 idle 后响应；中途每次 run 启动、交接写入都推送 `conversation-snapshot`，renderer 用 snapshot 中的 `activeRunId` 调用现有 `cancel(runId)`。
- `chat-send` 保留为迁移别名：内部使用 `conversation` 默认团队，renderer 不再通过 `profileId` 选择 Bot；迁移完成后删除该选择语义。
- `Answer` 与 Interview 实时音频不进入这个循环；Interview 文本交接在接入时复用 `core/team` 的校验与投影，仍由 Interview 自己的应用发起。

### 7. 协议与 UI

- 新增显式团队会话命令，例如 `team-send`：载荷为 `conversationId`、`teamId`、用户输入。renderer 不传 Agent ID、prompt、工具或发现关系。
- `team-send` 在整条交接链回到 idle 后响应；中途通过 `conversation-snapshot` 与现有 `AgentFrame.event` 推送。
- `ConversationSnapshot` 增加 `activeAgentId`、`participantAgentIds`、`bots: { id, name, role }[]`，消息上增加 `authorAgentId` 与 `audience`。
- UI：
  - 每条 Bot 回复显示作者；
  - 交接记录渲染为折叠条，默认不展示正文；
  - 顶部显示当前接管 Bot；
  - 恢复会话时以 `activeAgentId` 与 transcript 重建，继续由当前 Bot 接待；
  - 单 Bot 会话不显示多余 Bot 标识，但仍使用同一 snapshot 字段。
- 现有 `chat-send` 在迁移期保留；团队入口稳定后评估是否收敛。任何阶段都不允许 renderer 注入 Bot 选择。

### 8. 事件与状态机

结论：`AgentEvent` 契约不变，`AgentRunState`、`AgentMessageState`、`AgentPartState`、`AgentToolCallState` 都不新增状态；新增的是会话层的 Bot 归属、交接消息和 snapshot 字段。

- 不新增 AgentEvent 类型。交接不是执行事件：它是一次 run 的正常结束 + 一条 `ConversationMessage` + `activeAgentId` 转移。
- 交接消息通过 `ConversationStore` 写入，由 `conversation-snapshot` 推送；现有 `AgentEventEnvelope` 仍是唯一执行事件流。
- 下一段 run 的 envelope 用现有 `causationId` 指向上一个 runId，`correlationId` 标识一条用户回合内的交接链；两者都是可选字段，不改 schema。
- `producerId` 继续由运行时统一填写；Bot 身份放在消息的 `authorAgentId` 与 run 的 `AgentDefinition.id`，不塞进事件 payload。
- 交接目标的 `to` 由当前 Bot 的目录生成枚举 schema（`z.enum(visibleBotIds)`），模型只能选择可见目标；运行时仍按目录断言。

Run 状态机：

- 沿用 `queued → claimed → running → retry-wait → completed/failed/aborted/superseded/orphaned`。
- 带交接的 run 正常结束为 `completed`；不新增 `handed-off` 状态。
- 用户取消仍是 `aborted`；会话循环看到终态后不再启动下一段 run。

消息与 part 状态机：

- `AgentMessageState` 不新增状态。交接记录一次写入，状态为 `complete`，不做流式占位。
- `AgentPartState`、`AgentToolCallState` 不变；交接记录不产生 tool part。
- `ConversationMessage` 的 `authorAgentId`/`audience` 是数据字段，不是状态词汇。

会话状态：

- 不新增共享会话状态词汇，也不新增 `TeamSession.state`；`activeRunId` 继续表示“是否有活动 run”，`activeAgentId` 表示“当前由谁拥有会话”。
- 循环本身只有局部变量（当前 handle、当前 Bot），不持久化；进程重启后的恢复依据是 `messages` + `activeAgentId` + `activeRunId`，不是另一套会话状态机。
- 交接写入不推进 `aggregateRevision`；snapshot 的 `eventRevision` 保持上一 run 终态 revision，下一 run 的首个事件从其后继续。
- 交接记录本身已在 snapshot 的 messages 中，恢复时无需从事件重建。

### 9. 代码落位

```text
packages/shared/src/schema/
  conversation.ts        authorAgentId / audience / activeAgentId / participantAgentIds / MessageAudience
  index.ts               稳定导出消息受众 schema 与类型

apps/agent/src/core/transcript/
  store.ts               seed、beginRun/beginReplyRun/beginHandoffRun、appendHandoffMessage、setActiveAgent
  memoryStore.ts         唯一内存实现
  message.ts             用户消息与 assistant 占位工厂，写入归属
  projection.ts          按 author/audience 投影模型消息

apps/agent/src/core/agent/
  definition.ts          BotIdentity / BotDiscovery / BotTurnResult / AgentRunHandle.result
  registry.ts            定义注册、唯一性与可见性引用校验
  runtime.ts             静态注册、run 执行、结果端口
  executeRun.ts          结构化回合结果产出与 run 终态

apps/agent/src/core/team/
  types.ts               TeamDefinition、目录项、交接输入
  registry.ts            团队注册与成员解析
  directory.ts           visibleMembers、assertCanHandoff、断言
  context.ts             目录渲染与交接前缀

apps/agent/src/conversation/
  application.ts         sendTeamMessage 唯一编排循环；chat-send 迁移别名
  agent.ts               每个 Bot 的静态定义与 prepare
  profiles/              各 Bot 的 prompt、上下文策略与工具授权

apps/agent/src/host.ts   注册 Bot/团队、装配会话、推送 snapshot
apps/agent/src/worker/protocol.ts  team-send
```

删除 `apps/agent/src/team/` 原型目录；纯函数迁入 `apps/agent/src/core/team/`，`TeamSession`、`TeamEntry`、`TeamSessionRuntime`、独立 snapshot 不保留。

依赖方向：

```text
conversation ──> core/team ──> core/agent + core/transcript
conversation ──> core/agent + core/transcript
interview    ──> core/team（文本交接接入时）
core          ──/-> conversation / interview
```

`core/team` 是 core 模块，不是与 conversation 平级的领域目录；这样 Conversation 与 Interview 都能使用，又不会形成领域互导。

### 10. 明确不做

- 不新增第二套 transcript、消息 store、snapshot 或消息 revision。
- 不保留 `TeamSessionRuntime`、`TeamSession`、`TeamEntry` 或团队侧 `activeRunId`。
- 不把交接做成工具调用或嵌套 run。
- 不让 renderer 传入 Agent ID、system prompt、工具实现或发现关系。
- 不为每个 Bot 启动独立进程或 sidecar。
- 不新增事件类型或 run 状态。
- 不在本提案内实现磁盘持久化和进程重启恢复。
- 不改变实时音频会话的 VAD、ASR、turn 结算路径。
- 不用 `BotTurnResult.reply` 再补一条 AI 消息。
- 不把 Answer 强制纳入团队交接循环。

### 11. 实施阶段

1. **Store 统一**：扩展 `ConversationStore`/`MemoryConversationStore` 的 seed、作者、受众、交接写入与 `beginHandoffRun`；删除 `team/transcript.ts`；补 create/clear/claim/revision 测试。
2. **应用循环**：在 `ConversationApplication` 实现 `sendTeamMessage` 与单 Bot 别名；接入 `onSnapshot`；删除 `team/runtime.ts`；重写交接测试为 store/application 级测试。
3. **投影与结果**：把消息投影上提到 `core/transcript/projection.ts`；补 `AgentRunHandle.result` 与 `BotTurnResult` 校验；补作者/目标/其他 Bot 与工具隐私测试。
4. **注册与身份**：给 `AgentDefinition` 增加 `identity`/`discovery`；`AgentRegistry` 存定义并校验；新增 `core/team` 注册表与目录；补启动期失败测试。
5. **协议与 UI**：新增 `team-send`；desktop 转发 snapshot；UI 显示作者、当前 Bot 和交接提示；补 IPC 与 UI 测试。
6. **文档同步**：更新三 Agent Note 的会话表述、`AGENTS.md` 的 Agent 运行时边界和 `answra-vision` 的多 Bot 编排状态；实施完成后把本 Note 迁入 `implemented/`。

每个阶段独立可审查，不一次性重写现有对话域。

## 实施进度与后续步骤（2026-11-11）

### 已完成（可提交的阶段性结果）

- Store 统一：
  - `ConversationSessionSeed`（含 `bots` 展示身份）、`beginRun`/`beginReplyRun`/`beginEphemeralRun` 的 `authorAgentId`、`beginHandoffRun`、`appendHandoffMessage`、`setActiveAgent`、`clear` 恢复 seed。
  - `appendHandoffMessage` 在 store 边界校验：空闲、来源等于当前 `activeAgentId`、`from != to`、目标参与者、任务长度；交接不推进 `eventRevision`。
  - `MemoryConversationStore` 的 seed、clone、恢复；用户消息 `audience=user`，assistant 占位写入 `authorAgentId` 与 `audience=user`。
- 应用循环：
  - `ConversationApplication.sendTeamMessage`、`sendChat` 单 Bot 别名、`startBot`、`continueTeamTurn`、`startReplyRun`、`onSnapshot`、`onTeamError`。
  - 每段 run 启动后推送 snapshot；交接写入后推送 snapshot；`sendTeamMessage` 等整条链 idle 后返回。
  - `continueTeamTurn` 在 `done !== completed` 时停止；`result` 为空时停止；目标不可见或任务非法时把错误交给调用方。
- 结果、身份与注册：
  - `AgentDefinition.identity`/`discovery`/可选 `result`；`AgentRunHandle.result`；`AgentRuntime` 在 `completed` 后取结果。
  - `AgentRegistry` 保存身份/发现策略，提供 `assertTeamMembers`、`assertDiscoveryReferences`；`ConversationApplication` 启动期校验团队成员已在运行时注册。
  - `core/team/types.ts`、`core/team/directory.ts`：可见目录、交接校验、团队定义校验。
- 投影与归属：
  - 新增 `core/transcript/projection.ts`；`conversation/turn/modelMessages.ts` 只保留请求构建与时间提醒。
  - Answer 的 ephemeral assistant 与 Interview 的 reply assistant 都写入 `authorAgentId`。
- Host：
  - Conversation `onSnapshot` 已接到 `conversation-snapshot`。
- 当前工作区验证：
  - `pnpm --filter @answra/agent test`：55 文件、430 测试通过。
  - `pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/shared typecheck`、`pnpm lint` 通过。
  - 已补 `store`、`projection`、`core/team/directory`、`AgentRegistry`、application handoff 测试。

### 仍未完成（按继续实施顺序）

1. **`team-send` 协议与传输**（P0，未开始）
   - `packages/shared/src/channels/conversation.ts`：新增 `TeamSendCommand`，建议 `operation: "team.send"`，载荷 `conversationId`、`teamId`、`request: ConversationSendRequest`；加入 `ConversationSendCommand` 与 `ConversationChannelMap`；在 `packages/shared/src/index.ts` 导出。
   - `apps/agent/src/worker/protocol.ts`：新增 `{ id, type: "team-send", accessToken, ...TeamSendCommand }`。
   - `apps/agent/src/host.ts`：`run` 增加 `team-send`，调用 `runtime.sendTeamMessage(command.teamId, command.conversationId, command.request, command.accessToken)`。
   - `apps/desktop/src/main/agent/agentService.ts`：把 `operation === "team.send"` 映射到 worker 命令；`apps/desktop/src/main/conversation/*Ipc.ts` 增加频道处理；`apps/desktop/src/preload/index.ts` 暴露 bridge 方法。
   - 响应时机：整条交接链回到 idle 后返回最终 snapshot；中途继续推送 snapshot/event。renderer 只传 `conversationId`、`teamId`、`request`，不传 Agent ID、prompt、工具或发现关系。
   - 测试：shared channel 类型/序列化、agent host 路由、desktop IPC 转发、preload bridge。
2. **Host 团队注册**（P0，未开始）
   - 当前 host 只给 `ConversationApplication` 默认单 Bot team；需要在组合根构造并传入 `teams`（首期 `conversation` 单 Bot；后续写作、资料整理 Bot）。
   - 启动期按域校验 `assertTeamMembers` 与 `assertDiscoveryReferences`。注意 `AgentRegistry.assertDiscoveryReferences` 当前遍历所有已注册 Agent；如果 interview agent 的 `visibleTo: team:"interview"` 没有对应团队，host 不能直接全量调用，应改为按域传入团队集合，或先注册 interview 团队。这个取舍必须在接线时明确。
   - 测试：host 启动成功、未知团队、未注册成员失败。
3. **真实交接结果产出**（P1，未开始）
   - 当前只有 `AgentDefinition.result` 端口与测试注入，没有模型产出 `{ to, task }` 的路径。
   - 先做 AI SDK 最小验证：`streamText` + `Output.object` 是否能与工具循环共存；若不可行，按提案在 run 收尾用 `generateObject` 只产出 `{ to, task }`，不产生第二条用户可见回复。
   - 目标枚举由 `visibleMembers(team, currentAgent, catalog)` 生成 `z.enum(ids)`；`to` 仍要在应用层 `assertCanHandoff`；`task` 非空且不超过 `MAX_HANDOFF_TASK_CHARS`。
   - 在 `conversation/agent.ts` / profile 层接 result，只允许 Bot 自己的目录；不要让 renderer 或模型决定授权。
   - 测试：可见/不可见目标、非法任务、模型失败、取消、没有结果的普通回复。
4. **UI 投影**（P1，未开始）
   - `packages/ui/src/app/conversationView.ts`：把 `authorAgentId`、`audience`、`activeAgentId`、`bots` 投到视图模型。
   - `packages/ui/src/components/chat/conversationMessage.ts`、`ChatPanel.tsx`：作者名、当前 Bot、交接折叠条（默认不展开正文）、恢复时按 `activeAgentId`；单 Bot 不显示多余标识。
   - `packages/ui/test/` 补作者、当前 Bot、交接折叠、单 Bot 隐藏测试。
5. **Interview 文本交接**（P2，未开始）
   - 当前 Interview 只补了 `authorAgentId`，投影仍是简单 role/text，不识别 audience。
   - 接入文本交接时复用 `core/team` 与 `core/transcript/projection.ts`；实时音频路径不改 VAD、ASR、turn settle。
6. **文档与生命周期**
   - 更新 `docs/notes/proposed/architecture/2026-11-11-interview-three-agent-boundaries.md` 的“三个 conversation”表述，指向本 Note 的统一持久化。
   - 更新 `AGENTS.md`：`core/team` 边界、`core/transcript/projection.ts`、单 Bot 也走 team、Answer/Interview 作者归属。
   - 更新 `.agents/skills/answra-vision/SKILL.md` 的多 Bot 编排状态（若仍描述为未实现）。
   - 全部完成并实机验证后，把本 Note 迁入 `implemented/architecture/`，补“后果与防回退”和“验证”。

### 2026-11-12 更新

- Bot 目录与会话选择已按
  [Bot 目录与会话参与者选择](2026-11-12-bot-catalog-and-conversation-selection.md)
  拆出：`conversation/team.ts`、`core/team/types.ts`、`core/team/directory.ts` 已删除；
  `core/bot` 提供身份/发现目录与会话参与者可见性，`core/team/preset.ts` 只保留预置。
- `chat.send` 的 `profileId` 已替换为可选 `botId`；`create-conversation` 支持 `selection`。
- 下述差异中与团队装配、`profileId` 相关的条目已由新 Note 处理；其余仍待实施（真实交接结果产出、UI 投影、Interview 文本交接）。

### 当前实现与提案的差异（继续前先决定）

- `core/team/registry.ts`、`core/team/context.ts` 尚未创建；当前团队装配在 `conversation/team.ts`，目录在 `core/team/directory.ts`。要么后续补通用 registry/context，要么在实现完成后修订本 Note 的代码落位。
- `AgentRegistry` 当前保存 `identity`/`discovery`，未保存完整 `AgentDefinition`；团队校验通过 `assertTeamMembers` 加 `ConversationTeam` 目录完成。若坚持提案“存定义”，需要重构注册表并补测试。
- `MemoryConversationStore.create` 对已存在会话会覆盖 `seed`（snapshot 只补缺失字段）；提案写的是“只补齐缺失”。需要决定：固定会话团队（不覆盖 seed），还是允许后续 `team-send` 切换团队并更新恢复入口。
- `ConversationApplication.sendChat` / `replyToLastUser` 仍接受 `profileId`；这是迁移别名，UI 稳定后删除 renderer 选择语义。
- 交接前缀当前在 `core/transcript/projection.ts`，未放到 `core/team/context.ts`；若要保持单向依赖，不能简单让 projection 反向 import team。
- `ConversationApplication.startTeamTurn` 对用户触发有重复 `store.create`（外层与 `startBot.prepareRun` 各一次）；无害但可收敛。
- `appendHandoffMessage` 已加“来源等于当前 `activeAgentId`”校验；后续任何新 writer 必须继续在 store 边界维护归属不变量。

### 继续时的验证

- 开发中：`pnpm --filter @answra/agent test`、`pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/shared typecheck`、`pnpm lint`。
- 提交前：`pnpm notes:check`；完整 `pnpm verify`。当前 `pnpm architecture:check` 可能仍被工作区已有 onboarding 文件阻断，需确认基线状态，不要为通过门禁修改无关文件。
- 实机：Windows 11 下从候选人 Bot 交接给面试向导 Bot，检查消息顺序、当前 Bot、取消、恢复和单 Bot 无多余标识。

## 模块边界

- `core/transcript`：消息、`activeAgentId`、`participantAgentIds`、run 认领、交接记录；不保存 Bot 身份/发现关系，不包含团队循环或领域 prompt。
- `core/agent`：Bot 身份、静态注册、发现引用校验、模型执行、run 结果端口；不包含会话循环、消息投影或资源 schema。
- `core/team`：团队定义、目录、可见性、交接校验、目录渲染；不持有 store、不创建 run、不调用 AI SDK、不定义领域 prompt。
- `conversation/application`：Conversation 的唯一编排循环；只组合 store/agent/team，不复制消息或 run 语义。
- `answer`/`interview`：各自用例；Answer 保持一次性；Interview 文本可复用 `core/team`，实时音频不进入。
- `host`：启动期注册与接线；不承载 Bot 路由策略。
- `worker`：显式命令与帧；不承载团队路由策略。
- `desktop`：命令转发、snapshot 推送、窗口生命周期；不决定 Bot 身份或交接目标。
- `packages/ui`：消息作者、当前 Bot、交接提示的投影；不推导交接或补造消息。
- `packages/shared`：跨进程字段与 schema；不放团队策略。

## 曾考虑的替代方案

- **Team 自己维护 `TeamSession`/`TeamEntry`/snapshot（初版方案）：** 舍弃。会造成两套 AI 消息、两套 `activeRunId`/revision/取消/恢复；持久化后同一回复出现两次。这是本次修订的直接原因。
- **每个 Bot 独立 conversation，交接时切换 conversation：** 舍弃。用户要求会话还是同一个；独立 conversation 会丢失共享上下文，且与“用户看到的是一条连续对话”不符。该模式只保留给实时音频会话。
- **把交接做成 `team.handoff` 工具：** 舍弃。工具在一次 run 内部返回结果，交接要结束当前 run 并转移控制权；用工具会引出嵌套 run、两条流写同一 assistant 占位和 transcript 认领冲突。
- **单个 Agent 在 prompt 里扮演多个角色：** 舍弃。system prompt、工具、资源授权和模型路由无法同时保持隔离，越权与串台无法用测试证明。
- **让 Conversation 继续走旧 `chat-send`，只有 Interview 使用团队：** 舍弃。所有会话应共享同一持久化与编排路径；单 Bot 用一成员 team，避免两套会话语义。
- **用 `BotTurnResult.reply` 在交接时再补一条 AI 消息：** 舍弃。它和本次 run 流式写入 store 的 assistant 消息重复；用户可见回复只保留 store 中的那一条。
- **把手写文本标记解析成交接：** 舍弃。路由藏进自然语言，难以校验和测试，违反显式状态来源与魔法值清零要求。
- **引入外部消息总线或每 Bot 一个 sidecar：** 舍弃。当前只需要同进程内的 run 序列；现有 `RunRegistry`、`AbortController` 和事件流已经覆盖取消与排序。
- **把 `team` 放在与 `conversation` 平级的领域目录：** 舍弃。Conversation 和 Interview 都会使用团队策略，平级目录会迫使领域互导；放入 `core/team` 保持单向依赖。
- **运行期动态增删 Bot 或发现关系：** 舍弃。首期静态注册，启动期构建目录；新增 Bot 或调整可见性需要重启 Agent 进程。

## 验收标准

- 可观察结果：
  - 单 Bot 会话通过 `team-send` 产生用户消息与一条 assistant 回复；两者都只存在于 `ConversationStore`，snapshot 的 `activeAgentId` 为入口 Bot。
  - 同一 `conversationId` 内，候选人 Bot 发起交接后，面试向导 Bot 接管并对用户发言；消息顺序为“用户 → 候选人回复 → 候选人→面试向导交接 → 面试向导回复”，没有重复的 AI 消息。
  - 交接记录对用户折叠、对目标 Bot 是 user 消息、对其他 Bot 隐藏；目标 Bot 看不到来源 Bot 的工具调用与 reasoning。
  - 恢复快照后仍由 `activeAgentId` 对应的 Bot 接待；清空会话后恢复到入口 Bot。
- 自动化验证：
  - `ConversationStore`：create/seed、clear 恢复入口、用户/回复/交接的作者与受众、`beginHandoffRun` 认领、交接不推进 revision、clone 保留字段。
  - 应用循环：单 Bot、交接、取消、模型失败、并发发送拒绝、交接目标非法；没有第二套 activeRunId 或 controller。
  - 投影：作者视角为 assistant，目标视角为 user，其他视角隐藏；图片与工具回放保留，其他 Bot 的 tool/reasoning 不泄露；legacy 无 audience 按用户可见处理。
  - 注册：重复 ID、未知 `visibleTo`、团队非法成员、入口未注册在启动期失败。
  - 协议/UI：`team-send`、snapshot 字段、作者、当前 Bot、交接折叠、恢复。
- 需要的实机验证：
  - Windows 11 下从候选人 Bot 交接给面试向导 Bot，确认消息顺序、当前 Bot 标识、取消和会话恢复。
  - 实时音频路径不纳入本提案实机验证。

## 风险

- 交接是“先写交接记录，再启动目标 run”的两步操作。目标 run 启动失败时会话仍停在目标 Bot，但没有活动 run；下一次用户输入由目标 Bot 接待。接受这个显式恢复点，不自动重放交接链。
- `team-send` 等到 idle 才响应会拉长 IPC 响应；中途 UI 依赖 snapshot/event 推进。若 snapshot 推送遗漏，取消按钮拿不到 `activeRunId`，必须用测试压住“每段 run 启动即推送”。
- 结构化输出与工具循环的组合依赖 AI SDK 6 的实际行为；实现前需要最小验证。若受限，收尾 `generateObject` 只产出 `{ to, task }`，不得生成第二条用户可见回复。
- 当前只有内存 transcript，交接链中途进程退出无法恢复；在磁盘存储落地前不宣称可恢复的多 Bot 会话。
- 发现关系在启动期固定，运行期不动态变化；新增 Bot 或调整可见性需要重启 Agent 进程。
- `ConversationMessage.audience` 采用“缺省 = 用户可见”的兼容规则；所有新写入必须显式设置。若某个新 writer 漏设，消息可能被错误地当成用户可见或隐藏，需用 store 边界校验和投影测试防止。
- 交接任务作为 user 内容注入目标 Bot；目标 Bot 的 prompt、工具和授权不变，但任务文本仍可能包含诱导性内容，需要长度上限和目录校验，不能把模型输出当授权。
- 把 `team` 从平级目录迁入 `core/team` 会触及架构文档和导入路径；迁移时同步 `AGENTS.md` 与架构守护，避免领域互导。
