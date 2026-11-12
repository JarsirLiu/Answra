# Note：Conversation 编排拆分与 Bot 边界收敛

状态：提案

## 问题

Bot 目录、会话参与者、单 Bot 会话和交接已经在
[Bot 目录与会话参与者选择](2026-11-12-bot-catalog-and-conversation-selection.md)
中落地；单一身份源、seed 不可改写和未知参与者 fail-closed 也已修复。当前剩余的问题不是“功能跑不起来”，而是并行维护和边界收紧：

1. `ConversationApplication` 同时承担会话选择、seed、快照、run 启动、事件写回、交接循环、错误回调和 read-file 状态，已经超过 400 行；`send`、`sendTeamMessage`、`startBot` 有重复的 run 启动准备，新增行为和测试都要改同一个大文件。
2. 后台交接失败只通过可选 `onTeamError` 暴露，`host.ts` 只打日志；用户看到的是“前一个 Bot 正常结束后没有下文”，而不是明确失败。`onTeamError` 可选会让外部客户端静默忽略失败。
3. `finishRun` 清空 `activeRunId` 与 `appendHandoffMessage` 之间有一个窗口；并发 `send` 可能抢占新 run，随后交接链再启动第二个 run 或失败，破坏单活动 run 和消息顺序。
4. `listBots` 返回整个目录，`BotVisibility` 只服务 Bot 间交接；未来加入内部 Bot 时，用户选择器和交接发现会混成一个权限面。
5. `BotCatalog.require/find` 返回可变 descriptor，`TeamPresetCatalog.list()` 暴露内部数组；当前“不可变目录”只是注释约定。
6. `ConversationApplication` 没有显式 `defaultBotId` 时退化为 `catalog.ids()[0]`，自定义客户端的默认 Bot 由注册顺序决定。
7. `composition.ts` 仍有 `export * from "./core/tool"`，公共入口会随内部新增自动扩大；内存 store 也直接出现在跨客户端入口。
8. `BotDomain` 是 core 内的封闭联合，新增领域必须修改 `core/bot/contracts.ts`。CLI 正在新增 `coding` 领域并消费 `bot.domain`，说明“领域新增 → core 必改”的反向依赖已经真实发生。
9. 32,000 消息上限散落在 agent、desktop IPC 和 conversation；修改上限必须人工同步多处。

这些问题大多会改动 `core/bot`、`composition.ts`、`apps/agent/src/index.ts`、`AGENTS.md` 或共享 schema，而 CLI 工作正在同时修改这些文件。现在直接做会把两个方向的未完成状态混在一起，增加冲突和回退风险。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/conversation/`：拆分会话选择、run 协调、交接循环；收窄 `ConversationApplication` 职责。
  - `apps/agent/src/core/bot/`：`BotDescriptor` 领域泛型、目录不可变、用户选择 ACL 的类型边界。
  - `apps/agent/src/core/team/`：预置目录不可变与默认团队解析。
  - `apps/agent/src/core/transcript/`：交接写入与 run 完成的原子边界（只加必要的端口/校验，不把编排塞进 store）。
  - `apps/agent/src/composition.ts`、`apps/agent/src/host.ts`：显式导出与错误出口接线。
  - `packages/shared/src/`：用户消息上限、失败状态/事件的跨进程契约；只在确认 UI 消费者后扩展。
  - `apps/desktop/src/main/`、`packages/ui/src/`：仅在失败可见性和 BotPicker 落地时接入。
- UI/进程/协议/持久化表面：
  - 背景交接失败需要用户可见状态；不能伪造一条 AI 消息。
  - `listBots` 的“用户可选”与 `visibleBots` 的“Bot 可发现”是两个权限面。
  - 当前仍是内存 store，不承诺磁盘恢复；本提案不引入持久化。
- 相关 Note：
  - [Bot 目录与会话参与者选择](2026-11-12-bot-catalog-and-conversation-selection.md)
  - [多 Bot 同会话注册、发现与交接](2026-11-11-multi-bot-session-registry-and-handoff.md)
  - [领域 Agent 模块注册与面试链路归属](2026-11-07-domain-agent-module-registration.md)
  - [CLI Coding 模式与终端 UI 移植](2026-11-12-cli-coding-mode-and-tui-port.md)
  - [域应用边界](../../implemented/architecture/2026-11-08-domain-applications.md)

## 提案

### 1. 稳定分层，先冻结跨领域契约

```text
packages/shared       跨进程 DTO、频道、稳定错误码与用户消息上限；不放编排策略
apps/agent/src/core   Agent 执行、Bot 目录、团队预置、transcript/run 状态；不 import 领域
apps/agent/src/<domain>  conversation、interview、coding、answer 的用例与 Bot 装配
apps/agent/src/host.ts   只做领域接线；不复制会话/交接算法
apps/cli                 独立宿主；只 import composition 公开入口，不 import conversation 深路径
```

- `core/bot` 只负责“这个 Bot 是谁、能被谁发现”；不负责“用户是否能在选择器里看到它”。
- `conversation` 负责会话选择、run 编排和交接；不拥有 Bot 身份、prompt 或工具授权。
- `coding` 继续独立，不 import `conversation`；CLI v1 不因为桌面有团队/交接就复制一套 team 语义。
- 新增领域不得要求修改 `core/bot` 的领域枚举；core 不认识具体领域列表。

### 2. 拆分 `ConversationApplication`

`ConversationApplication` 保留为用例门面，只负责把下列协作对象接起来：

- `ConversationSessionService`：解析 selection、生成 seed、创建/清空会话、加载 snapshot、默认 Bot、`listBots` 的选择过滤。
- `ConversationRunCoordinator`：每个 conversation 一条串行执行队列；启动 user/handoff run、调用 executor、写回事件、推送 snapshot。
- `ConversationHandoffLoop`：读取 run result、校验参与者与 discovery、写交接消息、启动下一 Bot；**不设置交接次数上限**，这是产品明确的 AI 接手语义。
- `ConversationApplication`：`send` / `sendTeamMessage` / `createConversation` 等用例只做参数校验、调用上述对象和返回结果。

拆分是内部职责拆分，不新增第二套会话模型、store、事件或 run 生命周期。每个协作对象可以有独立测试文件；`ConversationApplication` 的测试只验证用例串联。

### 3. 用一个串行队列保护“run 完成 → 交接写入 → 下一 run”

- 队列按 `conversationId` 串行，覆盖 `send`、`sendTeamMessage` 和后台交接链；`cancel` 仍可直接调用 runtime，不等待队尾。
- 队列只做执行顺序，不替代 store 的归属校验：`appendHandoffMessage` 继续在 store 边界校验空闲、来源等于 `activeAgentId`、目标是参与者。
- 不在 `ConversationApplication` 里用“先 load 再判断”自行实现并发控制；认领和状态迁移仍由 store/run 的既有原子方法承担。
- 队列必须有真实异步测试：每个 store await 都跨宏任务，两个 `send` 竞争时只允许一个活动 run，交接消息顺序稳定。

### 4. 交接失败进入显式失败面

- `onTeamError` 改成必需注入，或由 `ConversationRunCoordinator` 统一写入明确的 conversation failure 状态；不能继续“可选回调 + console.warn”。
- 失败必须有稳定错误码（如 `handoff-failed`、`session-invalid`）、可展示消息和可重试标记；不得把失败伪装成 assistant 文本来让 UI 看起来正常。
- 具体落在 `ConversationSnapshot.failure` 还是独立事件，先与 UI 的第二消费者一起定；在没有 UI 消费方之前不扩协议字段。
- 失败后不得留下 `activeRunId`、半条交接消息或第二个后台 run；队列必须收敛到 idle。

### 5. Bot 选择与交接发现分离

- `visibleBots` 继续只回答“当前发言人能发现谁”，由参与者 + `BotDiscovery` 决定。
- `listBots` 改为显式的用户选择视图：目录提供 `selectable` 元数据，或 `ConversationApplication.listBots` 调用独立的用户选择策略；内部向导 Bot、工具 Bot 默认可发现但不可选。
- `BotSummary` 只增加一个明确的用户选择字段，不在 `BotVisibility` 里混入用户权限；协议扩展必须等 BotPicker 的真实 UI 消费者出现。

### 6. 目录不可变与类型边界

- `BotDescriptor` 字段标 `readonly`；`createBotCatalog` 对其 freeze，`list()` 返回新数组，`require/find` 返回只读对象。
- `TeamPresetCatalog.list()` 返回副本，不暴露内部 `ordered` 数组；`teams()` 仍只暴露查询端口。
- `AgentId` 在 core 函数参数中使用品牌类型；字符串只在 IPC/worker 边界校验后转换，不在 core 继续放宽为 `string`。
- `ConversationApplicationOptions` 增加显式 `defaultBotId`；没有默认团队时不再用 `catalog.ids()[0]` 猜测。内置 host 显式传 `CONVERSATION_AGENT_ID`。

### 7. 领域标签由领域拥有

当前 `BotDomain` 放在 `core/bot`，每新增一个领域都要修改 core。推荐改为泛型：

```ts
interface BotDescriptor<Input, Policy, Domain extends string> {
  readonly domain: Domain;
  readonly id: AgentId;
  readonly identity: BotIdentity;
  readonly discovery: BotDiscovery;
  readonly executor: AgentExecutor<Input>;
  readonly policy: Policy;
}
```

- 每个领域定义自己的字面量（`"conversation"`、`"coding"`）和别名；core 不枚举领域。
- 只有确实需要跨领域比较时才在共享层定义稳定的领域联合；不能把“注册目录”变成“core 认识所有领域”。
- 该改动会触及 CLI 正在使用的 `BotDomain`，必须等 CLI 合入后单独做，并且先补类型测试再迁移各领域 catalog。

### 8. 显式公共入口与常量收敛

- `composition.ts` 改为显式命名导出；禁止 `export *`。内存 store 移到测试专用入口或在 Note 中明确标注为非生产 API。
- 用户消息上限提取为 shared 常量，agent 校验、desktop IPC 和 conversation 共用同一值；不允许再出现第二份 32,000。
- `ConversationApplication` 拆分后再评估是否把公共门面进一步缩成工厂函数；当前不为了“看起来小”新增包装层。

### 9. 与 CLI 并行的工作顺序

1. **等待 CLI 合入或冻结 `apps/cli`、`coding/`、`composition.ts`、`core/bot/contracts.ts`、`index.ts`、`AGENTS.md`。**
2. 先做不依赖 UI 的 2、3、5、6、8：拆分、单会话串行队列、选择 ACL 类型、目录不可变、显式默认 Bot、公共导出与常量。
3. 再做 4：失败状态需要 shared/UI 的第二消费者，单独评审协议字段。
4. 最后做 7：领域泛型迁移，避免与 CLI 的 `coding` 类型改动同时发生。
5. BotPicker 和真实第二个 Bot 仍按“等第二消费者”原则后置；在此之前不继续扩 Bot 协议字段。

## 模块边界

- `core/bot`：目录、身份、发现、可见性、启动期校验；不持有 run、store、prompt、用户选择器状态。
- `core/team`：团队预置与交接任务约束；只描述成员，不执行交接。
- `core/transcript`：消息、snapshot、run 认领、交接记录；不启动 run，不定义 Bot 策略。
- `conversation`：会话用例与交接编排；不复制 store/run 语义，不 import CLI 或 TUI。
- `conversation/bots`：Conversation Bot 的 executor、profile、identity 装配；不接受 renderer 注入。
- `coding`：CLI coding 领域；只 import `core/*` 和 shared，不 import `conversation`。
- `host`：进程组合根；只接线、转发事件和错误。
- `packages/shared`：跨进程 schema、频道、统一常量；不放团队策略、Bot 选择策略或 UI 状态。

## 曾考虑的替代方案

- **继续保留单体 `ConversationApplication`：** 舍弃。每个新用例都要改同一文件，测试互相耦合；CLI、Interview 和 UI 并行时会持续制造冲突。
- **把编排全部下沉到 `ConversationStore`：** 舍弃。store 是状态与认领边界，不负责启动 run、组装 prompt 或决定交接；下沉会把领域策略和平台生命周期塞进 core/transcript。
- **把交接循环放进 `core/bot` 或 `core/team`：** 舍弃。core 不持有 run，也不应依赖执行器；交接是用例编排，不是目录查询。
- **让 CLI 直接复用 `ConversationApplication`：** 舍弃。CLI v1 不需要 team/handoff；复用会把桌面的参与者、选择和交接语义带进编码宿主。保持 `CodingApplication` 独立，等第三个单 Bot 消费者出现再评估共享单 Bot 原语。
- **保留 `BotDomain` 封闭联合：** 舍弃。新增领域必须修改 core，已经与“领域平行目录、团队并行维护”冲突；用领域泛型把字面量还给领域自己。
- **把用户选择 ACL 塞进 `BotVisibility`：** 舍弃。`BotVisibility` 是 Bot 间发现权限；用户选择是产品/宿主权限，混在一起会让内部 Bot 默认出现在选择器。
- **用一个全局串行队列：** 舍弃。不同会话可以并行；只需要按 `conversationId` 串行，避免把整个 Agent 进程变成单会话。
- **先扩 shared 错误 schema 再找 UI 消费者：** 舍弃。按“抽象等第二消费者”原则，先确定 UI 需要展示什么，再定 snapshot/event 形状。

## 验收标准

- 可观察结果：
  - 交接失败时用户能看到明确失败状态，不再表现为正常结束。
  - 并发发送同一 conversation 时，只有一个活动 run，交接顺序稳定，不留半条交接消息。
  - 用户选择器只显示 `selectable` 的 Bot；内部 Bot 仍可被交接发现。
  - 自定义 Conversation 客户端必须显式指定 `defaultBotId`，不再由注册顺序决定。
- 自动化验证：
  - `ConversationApplication` 用例测试改为门面级；session/run/handoff 各自测试。
  - store await 全部跨宏任务的并发测试；失败路径测试；目录不可变测试；选择 ACL 测试；显式默认 Bot 测试。
  - `pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/agent test`、`pnpm architecture:check`、`pnpm notes:check`、`pnpm verify` 全绿。
  - 架构守卫验证 `coding` 不 import `conversation`，CLI 只从 `@answra/agent/composition` 公开入口导入。
- 需要的实机验证：
  - 桌面端并发发送/取消后仍能继续会话；交接失败可见。
  - CLI 完成后再跑一次跨宿主组装，确认共享 core 和 composition 入口没有被 Conversation 拆分破坏。

## 风险

- 拆分 `ConversationApplication` 会改变测试组织；如果不先冻结公开行为，容易出现“文件变小但行为漂移”。
- 单会话串行队列必须覆盖取消和后台链；错误实现可能把取消也排到队尾，导致用户等待。
- 失败状态涉及 shared/UI/desktop 三层；先扩协议再找消费者会造成未验证契约。
- `BotDescriptor` 领域泛型会触及所有 catalog 类型；必须等 CLI 完成并单独提交，避免类型迁移和 CLI 新领域同时改 `contracts.ts`。
- 用户选择 ACL 如果粒度太细会把产品权限写进 core；应保持 `core/bot` 只提供可表达元数据，具体选择规则留在 conversation/宿主。
- 目录 freeze 可能暴露某些测试或调用方对可变对象的隐式依赖；迁移时先补测试再收紧。
- 交接无上限是产品决定，不能借串行队列或超时逻辑偷偷加上限；队列只保证顺序，不设次数预算。
