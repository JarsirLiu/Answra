# Note：会话上下文摘要压缩与旧上下文归档

状态：提案

## 问题

Conversation、CLI coding、Interview 等所有使用 transcript 的领域，每轮都可能把完整历史投影给模型；Answer 是一次性无历史输入，不在此列：

- `apps/agent/src/conversation/turn/modelMessages.ts:36` 从 `ConversationStore` 读取全部消息并交给 `projectConversationMessages`；
- `apps/agent/src/coding/context.ts:21` 同样读取完整 snapshot；
- `ConversationStore` 在提案时只有进程内实现（`apps/agent/src/core/transcript/memoryStore.ts:14`），没有上下文预算、摘要、归档或恢复能力。现已增加 checkpoint、压缩状态和 usage 锚点，但仍无 archive、重启恢复和 SQLite adapter。

结果是会话越长，模型输入越大，最终一定撞到 provider 的上下文窗口。提案时也没有 `contextWindow` 配置；`finish` 事件虽然带 `usage.inputTokens`（`apps/agent/src/core/model/streamEvents.ts:161`），但没有地方用它提前触发压缩。现在成功 run 的首个 step usage 已作为估算校准锚点，`contextWindow` 已作为可选模型能力字段进入端点契约，缺失时回退 256k。

用户需要的是**一个可长期使用的会话**，而不是每次满了就新建会话：

- 旧上下文应能归档，必要时再由 AI 检索；
- AI 回忆不能只依赖一份摘要；
- 归档中的工具结果可以压缩存储；
- 旧上下文应支持删除，避免会话历史无限增长；
- 同一会话可以继续使用，不应因为压缩而强制切换会话。

这与当前产品方向 Note 中“工具生态未成形前不预支记忆压缩”的约束冲突。本提案把它作为一次显式方向变更：先做摘要压缩验证策略，再做 hot/cold 归档与检索，不把“新建会话”作为默认压缩方式。

现状还存在三个结构问题，会直接影响并行开发：

1. 模型上下文装配散落在 `conversation/turn/`、`coding/context.ts` 和 `interview/agent.ts`；Interview 还反向 import 了 `conversation/turn/workspaceContext`。
2. `core/agent`、`core/model`、`core/transcript` 都没有“上下文预算/压缩”位置；直接加功能会让 transcript、Agent run 和领域 prompt 互相污染。
3. `conversation/turn` 名不副实，目前只放上下文装配；`conversation/session` 是空目录。目录本身没有表达职责。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/`（新增）：上下文预算、检查点投影、压缩计划、摘要 prompt、工具结果清理。
  - `apps/agent/src/core/transcript/`：消息与上下文状态端口；新增 checkpoint、archivedThrough 的持久化契约。
  - `apps/agent/src/core/model/`：token 估算与内部模型任务；不放领域摘要策略；摘要提示词只有 `core/context` 一份。
  - `apps/agent/src/core/agent/`：增加 `AgentExecutor.prepare()` 只读模型投影，供手动压缩估算 usage；不创建 run。
  - `apps/agent/src/conversation/`：`turn/` 收敛为 `context/`，新增 `compaction/` 领域策略与手动压缩用例。
  - `apps/agent/src/coding/`：拆分 context 与 compaction；Coding 只提供领域 profile，与 Conversation 共用同一压缩核心。
  - `apps/agent/src/interview/`：独立 `context/` 与 `compaction/`，不再 import `conversation/turn`；按实时场景分阶段启用同一压缩核心。
  - `apps/agent/src/execution/`：保持 run/event 事实流；摘要调用不注册为 Agent run。
  - `apps/desktop/src/main/`、`apps/cli/src/`：`contextWindow` 能力字段、压缩状态、上下文占用反馈、归档查看与删除入口。
  - `packages/shared/src/schema/`：只在 UI 需要时增加压缩/归档 DTO；不包含存储实现或 prompt。
  - `packages/shared/src/channels/` 与 `apps/agent/src/worker/protocol.ts`：增加桌面手动压缩命令和结果 DTO；不携带摘要正文。
  - 未来的 `apps/agent/src/storage/`：统一存储 backend、SQLite 连接、事务和迁移。
- UI/进程/协议/持久化表面：
  - 桌面端对话面板与回复条共享同一 conversationId；不因压缩切换会话；新增“压缩上下文”入口和运行中禁用。
  - CLI TUI 显示压缩/归档状态与手动 `/compact`；不改变现有单会话用例。
  - 新增 archive 读取/搜索命令；不把归档消息塞回活动 snapshot。
  - Phase 1 不新增磁盘持久化；Phase 2 依赖可切换的 SQLite 存储边界。
- 相关 Note：
  - [后端会话与内存仓储](../../implemented/architecture/2026-10-12-conversation-memory-store-port.md)
  - [可切换的内存与 SQLite 存储边界](2026-11-08-switchable-memory-sqlite-storage.md)
  - [历史工具结果进入模型上下文](../../implemented/bug-fix/2026-11-10-conversation-tool-results-history.md)
  - [Conversation 工具步数上限与终态](../../implemented/bug-fix/2026-11-10-conversation-step-limit-and-terminal.md)
  - [Conversation 编排拆分与 Bot 边界收敛](2026-11-12-conversation-orchestration-decomposition.md)
  - [CLI Coding 模式与 TUI 移植](2026-11-12-cli-coding-mode-and-tui-port.md)
  - [256k 上下文预算与旧工具结果清理](../../implemented/architecture/2026-11-13-context-budget-and-tool-result-clearing.md)
  - [Provider 上下文超限的单次恢复](../../implemented/architecture/2026-11-14-provider-overflow-reactive-compaction.md)
  - [产品方向与 Agent 底座](2026-10-20-product-direction-and-agent-foundation.md)

## 提案

### 1. 总策略：同一会话内分层，不先新建会话

采用“工作记忆 + 长期记忆”的两层结构，sessionId 不变：

```text
同一个 Session
├─ active transcript：最近 N tokens / 最近 K 轮，直接进入模型上下文
├─ checkpoint：已压缩到的消息边界 + 分段摘要
├─ archive：更早的消息，默认不进入模型上下文
│    └─ 工具结果保留元数据/预览，正文压缩或按保留策略清理
└─ search index：archive 的可检索索引，供 UI 与 Agent 检索工具使用
```

模型上下文 = 最近的 checkpoint 摘要 + active transcript。archive 不参与每轮投影；需要旧细节时，通过检索工具按需取回。

实施顺序是：

1. **Phase 1a：工具结果清理。** 先清旧工具结果，能省 token 时不必调用模型做摘要。
2. **Phase 1b：摘要压缩。** 验证触发、摘要质量、失败回退和 UI 反馈；不改存储，不做归档。
3. **Phase 1c：手动压缩入口。** 与自动压缩共用同一核心，补齐熔断绕过、usage 刷新、可区分结果和桌面入口；不改存储。
4. **Phase 2：旧上下文切分。** 引入持久化 store，把 checkpoint 之前的消息原子迁入 archive，让 active transcript 真正有界。
5. **Phase 3：检索与删除。** 增加 archive 搜索 UI 和 Agent 检索工具，再补工具结果压缩、保留策略与删除。

Phase 1 是刻意“存储中立”的：它只解决模型上下文溢出，不承诺重启恢复或 active 表变小。Phase 2 才是长期会话的存储方案。

压缩核心是通用能力，不是 Coding 专属。所有保留 transcript 的领域共用同一套预算、选段、摘要调用和 checkpoint 投影；领域只提供 `CompactionProfile`（保留量、可清理工具、触发阈值）。摘要提示词只有 `core/context` 一份，领域不得覆盖或追加。

| 领域 | 是否接入 | 说明 |
| --- | --- | --- |
| Conversation | 是 | 桌面通用对话；首个完整消费者 |
| Coding | 是 | Coding 共用同一核心，只换 profile |
| Interview | 是 | 有 transcript 上下文时接同一核心；按实时链路分阶段启用 |
| Answer | 否 | 一次性答题，不读历史，不产生可压缩上下文 |

`CompactionProfile` 只允许描述领域差异：保留多少 token/消息、哪些工具结果可清理、触发阈值。摘要提示词不进 profile；core 不读取领域 ID，也不出现 `if (coding)` 这类分支。

不允许为 Coding 复制第二套压缩引擎，也不允许把 Coding 的工具清理规则写进 `core/context`。

### 2. 摘要放在用户消息，不改系统提示词

摘要涉及两次不同的“注入”：

1. **压缩请求**：把压缩指令作为一条 user message 追加到现有消息末尾，system/tools/model 保持不变，尽量复用已有前缀缓存。
2. **压缩结果**：作为一条 synthetic user message 放到保留的最近消息之前；它不写回普通用户消息，也不进入 system prompt。

不要在每次压缩时修改 system prompt。那样会改变 system 前缀，破坏后续请求的缓存对齐，也把“会话记忆”错误地塞进“产品策略”层。

缓存需要准确说明：

- 压缩请求保持 system/tools/model 不变时，可以复用压缩前的前缀缓存；只追加一条 user message。
- 如果为了“禁工具”而移除工具列表或更换 system prompt，工具 schema / system 前缀会变化，反而可能 cache miss。更稳的做法是保留相同工具声明，拒绝工具执行；若实现无法保持，接受压缩调用单独计费。
- 压缩后消息前缀必然变化，**post-compact 第一次请求仍会 cache miss**；不能在 Note 或 UI 中承诺“零缓存影响”。后续回合会重新建立缓存。
- 压缩结果不参与 summary 调用本身的缓存键；它只影响压缩后的新上下文。

摘要调用建议复用 Claude Code 的两个原则：

- 使用独立摘要提示词，要求只输出文本，不调用工具；
- 摘要模型调用不注册为普通 Agent，不写入用户可见 transcript，不产生第二套 run 事件。

### 3. Phase 1a：工具结果清理

这是摘要前最便宜的一层，不调用模型：

- 可清理工具由领域 `CompactionProfile` 声明；core 只按通用规则裁剪，例如 read、shell、grep、glob、web fetch/search、edit/write 的返回；
- 保留最近 N 条工具结果，其余替换为明确标记（例如 `[旧工具结果已清理]`）；
- 只修改模型投影，不删除 transcript；UI 仍能查看原始历史；
- 清理前必须确认工具调用/结果配对完整，不拆开 tool-call/tool-result；
- 当前用户请求和最近一轮工具执行不得清理。

这层应发生在预算判断之前。如果清理后已低于阈值，就不必再做摘要。

### 4. Phase 1b：摘要压缩

#### 触发与预算

- 在模型能力端点或客户端配置中增加非 secret 的 `contextWindow`，以及可选的摘要输出预留。不能根据模型名猜窗口；服务端下发的模型能力优先。
- 预算公式固定为纯函数：

```text
effectiveWindow = contextWindow - summaryOutputReserve
autoCompactThreshold = effectiveWindow - safetyBuffer
```

`safetyBuffer` 需要配置，不要散落魔法数。参考 Claude Code 的量级：摘要输出预留约 20k，安全 buffer 约 13k；Answra 应根据实际 provider 校准。

- 优先使用上一次成功 run 的 `usage.inputTokens` 作为权威基数，再加上本轮新增输入的保守估算；provider 不返回 usage 时使用字符估算并留更大余量。
- 在 `beginRun` 后、模型请求发送前检查预算。达到阈值就触发，不等到 provider 报错。
- 保留最近的完整轮次；当前用户请求已经进入 draft，必须留在保留尾段，不能进入摘要。压缩后通过 `rebuild()` 重新装配请求。
- 压缩边界只能落在完整 assistant 消息或完整 tool-call/tool-result 对上，不能拆开 `core/transcript/projection.ts` 中的配对。
- 连续压缩失败要有熔断，避免每轮都调用注定失败的摘要请求。

#### Provider 超限兜底

Provider 返回 prompt-too-long / 413 时，允许一次 reactive compact：

- 只作为兜底，不作为主路径；
- 只重试一次，仍失败则向用户暴露明确错误；
- 不得在 stop hook、错误重试和压缩之间形成死循环；
- 兜底路径也要修复工具配对边界和图片/大附件，不能只在正常路径正确。

#### 摘要调用

- 摘要是一次内部模型调用：禁止工具，限制输出长度，低温度，输入和输出都有上限。
- 复用现有端点、凭据、重试和取消语义；不在领域层直接重写 `streamText` 或 `createOpenAICompatible`。
- 摘要调用复用 `AgentRuntime.generateText` 的鉴权/重试边界，但不注册为 Agent、不进入 `ExecutionStore` 的 run 路径，避免污染用户可见 run、Bot 目录和事件流；进度用独立的上下文状态与 snapshot 推送。
- 摘要失败时保留上一份可用 checkpoint，并降级为“保留最近完整轮次”的确定性裁剪；向用户显示降级提示，不静默丢历史。
- 摘要请求本身也可能超限；需要“截断最旧完整 API 轮次后重试”的受控逻辑，不能直接失败或无限重试。

#### 检查点与投影

checkpoint 是真实状态，不是一条普通 transcript 消息。建议形状：

```ts
interface ContextCheckpoint {
  summary: string;
  throughMessageId: string;
  createdAt: string;
  messageCount: number;
}
```

- 通用 transcript store（Conversation/Coding/Interview 共用）保存 checkpoint 与消息，不把 summary 写成 `role: "assistant"` 的普通回复；
- `core/context/projection.ts` 从 checkpoint 之后取消息，并在模型消息头部插入 synthetic user message；
- synthetic message 使用明确的续接文案（“会话从上一段压缩上下文继续……”），不显示为用户真的说过的话；
- 多次压缩生成多个 checkpoint，模型上下文取最近 checkpoint + active 尾段；不要把摘要摘要成一份无限漂移的全局文本；
- 保留段起点必须能通过 API 的 tool 配对校验，不能以孤立 `tool_result` 开头；
- 当前用户请求已进入 draft；压缩只处理保留尾段之前的消息，`rebuild()` 后当前请求仍在尾部，不能被摘要吞掉。

#### 压缩状态显示

摘要压缩需要用户可见状态，但**不复用 `AgentRunState` 或 `AgentEventEnvelope`**：它不是用户可见 Bot 回复，也不是注册 Agent run。

独立状态机：

```text
idle -> started -> succeeded
               ├─> failed
               └─> aborted
succeeded/failed/aborted -> started（下一次压缩）
```

```ts
interface ContextCompactionStatus {
  state: "idle" | "started" | "failed" | "succeeded" | "aborted";
  trigger: "auto" | "manual";
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  summarizedMessages?: number;
  errorText?: string;
}
```

- `ConversationSnapshot` 增加可选 `contextCompaction`；缺省表示从未压缩或已清空。
- `ContextCompactor` 在每次迁移后写入 `ConversationStore` 的上下文状态，并推送 snapshot；UI 显示“开始压缩上下文 / 压缩失败 / 压缩完成 / 压缩已取消”。摘要不流式展示；CLI 折叠态显示累计消息数、手动指令与展开提示，展开后显示最终摘要正文；桌面用压缩边界卡显示条数与指令，展开后显示摘要正文。
- `started` 覆盖整个摘要调用过程；没有独立 `summarizing` 状态，因为中间文本不展示时它与 `started` 对用户没有区别。
- checkpoint 正文留在 store，并通过压缩边界投影进入 snapshot 供 CLI 展开；普通 `snapshot.messages` 不包含 summary 消息。
- 当前只有一个 transcript 消息列表；checkpoint 属于 `ContextState`，不是消息，也不写入 `snapshot.messages`。synthetic user message 只在模型投影时临时生成。
- 成功、失败或取消状态保留到下一次压缩或用户清空会话，作为最近一次压缩结果，不做无来源的定时清除。
- 未来若需要压缩遥测或事件回放，另加独立压缩事件；不要把 `compacting` 塞进现有 run 状态迁移表。即使补事件，也不定义用于展示思考内容的 `delta`。

#### 手动压缩入口（Phase 1c）

手动压缩与自动压缩共用同一套摘要、检查点、裁剪和 usage 写入，差别只在触发条件、失败熔断和宿主反馈。当前 CLI Coding 已有 `/compact`，但它直接调用 `ContextCompactor`，没有经过 `ContextPreparation`，因此还不能作为最终实现：压缩后 usage 仍停留在压缩前，手动操作也会被自动失败熔断拦住。

目标链路：

```text
CLI /compact 或桌面“压缩上下文”
  -> 领域 application 校验会话空闲
  -> 读取 snapshot 与当前 Bot
  -> AgentExecutor.prepare() 生成只读模型投影（不追加新用户消息）
  -> ContextPreparation.compactNow()
       -> force=true、trigger="manual"、bypassFailureBreaker=true
       -> 摘要 -> checkpoint -> rebuild -> postCompactTarget 裁剪
       -> 重新计算并写入 usage
  -> 返回 ManualCompactionResult + snapshot
```

接口约束：

```ts
interface ManualCompactionResult {
  status: "compacted" | "skipped" | "failed" | "aborted";
  reason?: "insufficient-messages" | "breaker-open" | "checkpoint-invalid";
  usage?: ContextUsage;
  errorText?: string;
}
```

- 给 `AgentExecutor` 增加只读 `prepare(input, signal)`：只组装 `AgentModelRequest`，不创建 run、不写 `ExecutionStore`、不执行工具；`AgentDefinition.prepare` 必须保持无副作用。
- `ContextPreparationRequest` 增加 `bypassFailureBreaker`；`compactNow` 固定 `forceCompact: true`、`trigger: "manual"`、`bypassFailureBreaker: true`，复用 `prepareRequest` 的预算、清理、摘要、rebuild、`postCompactTarget` 和 usage 写入。
- `ContextCompactor.prepare` 返回可区分结果，而不是 `boolean`：成功、跳过（含原因）、失败、取消。CLI 不再用 snapshot 里残留的 `contextCompaction.state` 猜失败或跳过。
- 手动压缩必须传 `bypassFailureBreaker: true`；自动压缩和 provider 超限恢复不得绕过。手动成功清零自动失败计数；手动失败**不增加**自动熔断计数，避免用户连续点 `/compact` 把自动路径永久关掉。
- `AbortError` 记录为 `aborted`，不显示成压缩错误，也不增加失败计数。
- 手动压缩后必须重新计算 usage。投影失败不回滚已写入的 checkpoint，但清空旧 usage，下一次 run 自动恢复，避免 UI 显示压缩前的错误数字。
- 手动压缩仍遵守 `retainRecentMessages` 和 `minimumMessagesToSummarize`；没有足够旧消息时返回 `skipped: insufficient-messages`，不能伪成功。只有启用历史的 profile 才提供手动入口。
- 手动压缩不写用户消息、不写 Agent 事件、不新建 run；成功后只写 checkpoint、压缩状态、usage 和 snapshot 边界。
- 桌面端需要新增 `answra:conversation:compact` 通道、worker `compact-conversation` 命令、main IPC handler 与 preload/renderer 入口；运行中或队列非空时拒绝。CLI 复用现有 `/compact` UI，只替换底层编排和结果提示。
- Interview 手动入口后置；Answer 不参与。

### 5. Phase 2：旧上下文切分与归档

- 依赖 [可切换的内存与 SQLite 存储边界](2026-11-08-switchable-memory-sqlite-storage.md)，先实现可替换的持久化 transcript store 与统一 storage backend；archive 对 Conversation、Coding、Interview 是同一套能力，Answer 除外。
- 增加 archive 能力：将 checkpoint 之前的消息从 active transcript 原子迁入 archive，同时写入 archive 段摘要和边界；三步必须在同一事务中完成。
- `ConversationSnapshot` 只返回 active 消息；archive 通过独立查询读取，不把整段旧消息塞回活动 snapshot。
- UI 显示“已归档 N 条消息”和 archive 查看入口；当前视图仍只渲染 active transcript。归档消息不重新参与实时事件回放。
- archive 段摘要按 `fromSeq/toSeq` 记录，便于单独查看、删除和重新生成；不要把摘要和归档消息混成一份不可追溯的文本。
- 归档时保留工具调用元数据、状态和输出预览；完整工具输出优先做无损压缩（如 gzip blob），再按保留策略清理。不要为了省存储直接丢弃所有工具细节，否则后续检索无法回答“当时运行了什么、结果是什么”。
- 归档后的消息不再作为原始 `tool-call/tool-result` 回放给模型；检索结果只返回文本片段和来源，避免破坏工具配对契约。

### 6. Phase 3：检索、压缩与删除

- Agent 工具 `history.search` 先限定当前 session 的 archive；之后再评估跨 session 搜索。
- 搜索结果必须返回来源、时间、角色/工具类型和有界片段；结果按不可信历史数据处理，不能当成当前指令。
- 中文全文检索不能直接假设 SQLite FTS5 默认分词可用；需要 trigram 或专门分词方案。
- UI 搜索与 Agent 工具搜索是两个表面：前者给人看，后者把片段送入模型上下文；两者共享索引但权限与预算不同。
- 删除以 archive 段为单位：删除消息、索引条目和受影响的 checkpoint；如果摘要仍引用已删除内容，必须重新生成或明确标记为已失效。
- 未来的 execution journal 如果落盘，删除也必须覆盖事件中的工具输出；不能只删 transcript 留下副本。
- 跨会话搜索需要额外的 workspace/时间/权限过滤和隐私策略，不在首版自动开启。

### 7. 目录架构

不新增 workspace 包；压缩仍属于 `@answra/agent` 的内部能力。推荐目录如下：

```text
packages/shared
└─ schema/                         跨进程 DTO、事件、snapshot；不放 prompt/压缩策略

apps/agent/src/
├─ core/
│  ├─ agent/                       AgentDefinition、runtime、executeRun；不读 transcript
│  ├─ model/                       provider、stream 归一化；不放压缩策略
│  ├─ transcript/
│  │  ├─ store.ts                  transcript 端口
│  │  ├─ memoryStore.ts            当前内存实现
│  │  ├─ projection.ts             原始消息投影
│  │  ├─ contextState.ts           ContextState、usage 锚点类型
│  │  ├─ contextCheckpoint.ts      checkpoint 类型、最新检查点与尾段选择
│  │  └─ contextBoundary.ts        只含边界的 UI 投影；不携带摘要正文
│  └─ context/                     跨领域上下文预算与压缩
│     ├─ budget.ts                 窗口、预留输出、阈值
│     ├─ tokenEstimate.ts          字符/usage 估算与锚点校准
│     ├─ usageAnchor.ts            成功 run 首步 usage 锚点生命周期
│     ├─ preparation.ts            唯一最终请求编排入口
│     ├─ trim.ts                   超硬上限的完整轮次裁剪
│     ├─ projection.ts             checkpoint-aware 模型上下文
│     ├─ pruning/
│     │  ├─ policy.ts              可清理工具与保护窗口
│     │  └─ prune.ts               纯旧工具结果替换与净节省计算
│     └─ compaction/
│        ├─ profile.ts             CompactionProfile 契约：保留量、最少摘要量
│        ├─ plan.ts                按完整消息边界选段
│        ├─ transcript.ts          摘要输入只取可见正文
│        ├─ prompt.ts              唯一摘要提示词；所有领域共用，不可覆盖
│        ├─ compact.ts             计划 -> 摘要 -> 写 checkpoint
│        ├─ lifecycle.ts           独立压缩生命周期
│        └─ compactor.ts           状态持久化、snapshot 推送、失败回退
├─ execution/                      run/event 状态；不承载压缩逻辑
├─ conversation/
│  ├─ context/                     由 turn/ 重命名：模型上下文装配
│  │  ├─ messages.ts
│  │  ├─ environment.ts
│  │  ├─ workspace.ts
│  │  └─ time.ts
│  ├─ compaction/                  领域 adapter
│  │  └─ profile.ts                Conversation 保留量、工具、阈值
│  ├─ bots/
│  ├─ profiles/
│  ├─ agent.ts
│  └─ application.ts
├─ coding/
│  ├─ context/                     由 context.ts 拆开
│  ├─ compaction/                  领域 adapter
│  │  └─ profile.ts
│  └─ ...
├─ interview/
│  ├─ context/                     新增：不再 import conversation/turn
│  ├─ compaction/                   领域 adapter；按实时链路阶段启用
│  │  └─ profile.ts
│  └─ ...
├─ answer/                         一次性答题，不参与压缩
├─ host.ts                         只接线
└─ composition.ts                  只导出稳定入口
```

目录调整的硬约束：

- `core/context` 不 import `conversation`、`coding`、`answer`、`interview`；
- `core/transcript` 不调用模型，不知道摘要 prompt；
- `core/model` 不放领域摘要策略；
- `conversation`、`coding`、`interview` 不直接 import `streamText`、`createOpenAICompatible`；
- `interview` 不再 import `conversation/turn/*`；
- `host.ts` 不写压缩算法；只注入 compactor、summarizer 和 store；
- `packages/shared` 只放跨进程 DTO，不放压缩计划、prompt 或 token 预算；
- `conversation/turn` 当前名不副实，改为 `context/`；空的 `conversation/session` 删除。

### 8. 调用位置与并行拆分

已决定采用 run 内 `prepareContext`，而不是 `beginRun` 前的独立检查：

```text
Conversation / Coding / Interview application
  -> store.beginRun / beginReplyRun / beginHandoffRun(...)
  -> AgentDefinition.prepare() 生成最终 AgentModelRequest（当前请求已在尾部）
  -> ContextPreparation.prepareRequest(...)
       -> usage 校准 -> 清理 -> 摘要 -> rebuild -> 再清理 -> 硬兜底
  -> streamText()
```

原因：

- 预算必须看到最终请求的 system、tools、当前请求和图片，`beginRun` 前拿不到这些；
- 摘要要复用 run 的取消信号，并在活动 run 内写 `ContextState`；
- 当前请求由保留最近完整轮次的规则保护；摘要调用不注册为 Agent run，不产生第二套 run 事件。

不要放进 `AgentDefinition.prepare` 内部直接调用摘要：`prepare` 只负责装配 draft，预算、清理、摘要、重建和裁剪统一由 `ContextPreparation` 编排，避免领域重复实现和摘要吞掉当前请求。

建议按以下工作流并行：

| 工作流 | 目录 | 交付 |
| --- | --- | --- |
| A 通用上下文核心 | `core/context/`（`budget`、`tokenEstimate`、`usageAnchor`、`preparation`、`trim`、`pruning/`） | 预算、清理、裁剪、编排与纯函数测试 |
| B 模型任务 | `core/model/`、`core/context/compaction/` | 摘要调用、状态、重试、取消 |
| C Conversation adapter | `conversation/application.ts`、`conversation/turn/` | 领域接线与桌面状态 |
| D Coding adapter | `coding/application.ts`、`coding/context.ts` | Coding 接线与 CLI `/compact` |
| E Interview adapter | `interview/application.ts`、`interview/agent.ts` | 实时上下文接入 |
| F 存储/归档 | `core/transcript/contextState.ts`、`contextCheckpoint.ts`、`contextBoundary.ts`、未来 `storage/` | checkpoint 持久化、边界投影、archive |
| G 集成 | `host.ts`、`composition.ts`、`AGENTS.md` | 接线、架构守护、Note |

### 9. 迁移顺序

1. **无行为变更的目录收口**：`conversation/turn -> conversation/context`，删除空 `conversation/session`，抽出 `core/context` 纯函数，统一 Interview 投影并移除跨领域 import。
2. **手动压缩（Phase 1c，部分已落地）**：增加 `core/model/generateText`、摘要 prompt、synthetic user message 投影和 `/compact`；CLI Coding 已有过渡实现。下一步补 `AgentExecutor.prepare`、`ContextPreparation.compactNow`、熔断绕过、usage 刷新和可区分结果，再把桌面 Conversation 接到同一入口。
3. **自动压缩**：增加预算阈值、工具配对保护、失败熔断和先清旧工具结果的 microcompact。
4. **持久化**：把 checkpoint 落到通用 transcript store，再验证重启恢复和 SQLite 事务。
5. **归档与检索**：最后做 archive 切分、搜索、工具结果压缩和删除。

目录重命名必须单独提交或单独评审，避免与压缩逻辑、SQLite 迁移同时发生，制造大面积 import 冲突。

### 10. 明确不做

- 不在压缩后自动新建会话；不引入 parent/child session 作为默认路径。
- 不在 Phase 1 引入磁盘持久化、重启恢复或 archive 搜索。
- 不在首版做向量检索/embedding；先用确定性全文检索验证需求。
- 不把摘要写成用户可见的 assistant 消息，也不让 renderer 注入摘要 prompt。
- 不删除 active 尾段中的工具结果；工具结果压缩只发生在 archive 与明确的保留策略中。
- 不为了缓存把摘要塞进 system prompt。

## 当前落地进度

已落地 Phase 1a/1b 的模型侧核心与自动触发：

- `core/context/compaction/prompt.ts`：唯一通用摘要提示词；所有领域复用，不可覆盖。
- `core/context/compaction/profile.ts`：只描述保留量、最少摘要量和触发 token。
- `core/context/compaction/plan.ts`：按完整消息边界选择旧消息，保留最近尾段。
- `core/context/compaction/transcript.ts`：把 transcript 渲染成摘要输入。
- `core/context/compaction/compact.ts`：摘要生成、空结果 fail-closed、检查点追加。
- `core/context/compaction/lifecycle.ts`：独立的 started/succeeded/failed 状态迁移。
- `core/context/compaction/compactor.ts`：自动触发、状态持久化、snapshot 推送、失败回退。
- `core/transcript/contextState.ts` 与 `ConversationStore`：保存 checkpoint、压缩状态和 usage 锚点；checkpoint 选段在 `contextCheckpoint.ts`，UI 边界投影在 `contextBoundary.ts`，边界携带摘要、累计消息数与可选手动指令。
- `core/context/projection.ts`：把摘要作为 synthetic user message 注入，只投影检查点之后的尾段。
- `core/model/provider.ts` 与 `AgentRuntime.generateText`：复用鉴权/重试的内部摘要模型调用。
- Conversation、Coding、Interview 的 `prepareRun` 先写活动 run（`beginRun` / `beginHandoffRun` / `beginReplyRun`），再由 `prepareContext` 调用同一 `ContextCompactor`；checkpoint 变化后通过 `rebuild()` 重新装配最终请求。
- `ContextPreparation` 已接入最终请求预算、usage 锚点、旧工具结果清理、摘要压缩、重建后二次清理和硬兜底裁剪；硬兜底裁剪独立在 `core/context/trim.ts`，不反向依赖编排。
- 桌面 `ChatPanel` 的 `ContextCompactionNotice` 显示压缩生命周期；消息流中的 `CompactionBoundaryCard` 显示“上下文已压缩”、累计消息数与可选指令，展开后显示摘要正文。桌面“压缩”入口先打开可选指令输入，不新增独立压缩 run。CLI TUI 对齐 Claude Code：压缩中蓝色 Spinner 固定 `Compacting conversation…`，成功后依次显示 dim 边界 `✻ Conversation compacted (ctrl+o for history)` 和摘要块。带手动指令的边界对应 `summarizeMetadata` 分支：折叠显示 `Summarized conversation` / `Summarized N messages up to this point` / `Context: “…”` / `(ctrl+o to expand history)`；无指令的自动或普通边界走默认分支：折叠显示 `Compact summary` / `(ctrl+o to expand)`，不显示条数与 Context。两个分支展开后都只显示摘要正文；失败显示 `Error compacting conversation`，且失败提示不被运行中 Spinner 覆盖。`ctrl+o` 是独立 transcript 模式开关，展开思考、工具输出与压缩摘要，并显示 `Showing detailed transcript · ctrl+o to toggle`，不新增第二个历史面板。
- CLI `/compact [instructions]` 已经过 `ContextPreparation.compactNow`：一次性指令只影响本次摘要 prompt，不写入会话或配置；`force` 跳过上下文触发点但仍遵守保留尾段和最少摘要消息数；运行中拒绝；取消通过 `AbortSignal` 记录为 `aborted`；没有可摘要消息时提示而不是伪成功。具体实现见[手动压缩的自定义摘要指令与摘要展示](../../implemented/feature/2026-11-14-manual-compaction-instructions-and-summary.md)。
- CLI 压缩边界来自 snapshot 的 checkpoint 列表，可被 `initialize`/重连回放；边界行可选中复制，边界插入会使旧选区失效。跨进程重启恢复仍取决于持久化 store，当前 `MemoryConversationStore` 不提供。
- 压缩相关 CLI TUI 测试已按关注点拆分：`tui.compaction`、`tui.composer`、`tui.render`、`tui.transcript`、`tui.thinking`、`tui.toolPresentation`，共享 `tuiTestHarness`，避免单个测试文件承载所有交互。
- 测试覆盖阈值、保留尾段、checkpoint 去重、summary 注入、单 prompt、压缩生命周期迁移、状态快照、失败回退、边界回放、CLI 强制手动压缩、CLI Spinner/边界/命令与 UI 投影；schema 明确拒绝已移除的 `summarizing`。
- P1 健壮性已落地：`postCompactTarget` 软目标与压缩后尾段保护、摘要中的图片文件名/media type、连续摘要失败熔断（3 次 / 5 分钟冷却，`AbortError` 不计数）、摘要请求超限时丢弃最旧完整回合并受控重试、provider 上下文超限错误识别（`isContextOverflowError`）。provider 超限后的单次 reactive compact 已在同一个 run 内落地，`executeRun` 消费 `recoverContext` 并通过 pre-content 缓冲避免重复生命周期事件；具体边界见[Provider 上下文超限的单次恢复](../../implemented/architecture/2026-11-14-provider-overflow-reactive-compaction.md)。

已落地上下文占用与工具清理反馈：`ContextPreparation` 将最终请求的 `contextUsage` 和实际应用的 `contextPruning` 写入 `ContextState`，snapshot 投影到桌面 `ChatPanel` 和 CLI 状态行/尾部提示；模型窗口可从端点 `contextWindow` 派生，缺失时回退 256k。自动压缩与自动清理保持默认开启，不提供用户开关（2026-11-14 产品决定）。

尚未落地：手动压缩的 `AgentExecutor.prepare` 只读投影、`ContextPreparation.compactNow`、`bypassFailureBreaker`、usage 刷新、可区分结果和桌面 Conversation 入口；`executeRun` 的 provider 超限单次恢复；摘要输出 20k 固定上限；Conversation/Coding/Interview 的独立 `CompactionProfile`；archive/SQLite；依赖持久化 store 的跨进程重启恢复。当前自动触发已使用 256k 窗口、216k 压缩点和 172k/40k/132k 工具清理预算，不再是 96k；预算与工具清理的细化规则见[256k 上下文预算与旧工具结果清理](../../implemented/architecture/2026-11-13-context-budget-and-tool-result-clearing.md)。

## 模块边界

- `core/context`：所有 transcript 领域共用的通用压缩引擎；预算、选段、checkpoint 投影、摘要模板和工具结果清理；纯跨领域逻辑，不 import 领域，不实现存储。
- `core/transcript`：消息、checkpoint、archive 边界和上下文状态端口；保存事实，不调用模型，不定义摘要策略。
- `core/model`：token 估算、内部 `generateText`、provider/重试/取消；不放领域 prompt。
- `core/agent`：静态 Agent 注册、run 生命周期和模型执行；`AgentExecutor.prepare` 只提供无副作用的模型请求投影，不创建 run；摘要不是注册 Agent，不进入 Bot 目录。
- `execution`：run/event 事实流；不把摘要 run 投影成用户 transcript 消息，手动压缩也不产生 run 事件。
- `conversation/context`：Conversation 的模型上下文装配；只调用 `core/context`，不复制预算和投影。
- `coding/context`、`interview/context`：各自的上下文装配；只调用 `core/context` 和共享 transcript projection，不复制预算。
- `conversation/application`、`coding/application`：手动压缩只做空闲校验、选择当前 Bot、构造只读投影并调用 `ContextPreparation.compactNow`；不实现摘要、裁剪或第二套状态。
- `conversation/compaction`、`coding/compaction`、`interview/compaction`：只提供 `CompactionProfile`，共用 `core/context` 的单一摘要提示词；不实现第二套压缩，不覆盖 prompt，不实现存储或模型调用。
- `answer`：一次性答题，不读取历史、不参与压缩。
- `apps/desktop`、`apps/cli`：配置、压缩状态、手动压缩入口和 archive/搜索 UI；只调用 application 端口，不决定摘要边界或 prompt，不直接调用 compactor。
- `packages/shared`：只在 UI 需要时提供压缩/归档 DTO；不放 token 预算、prompt、存储实现。
- `storage`：未来统一 backend、连接、事务、迁移与 archive adapter；领域 application 不直接 import 数据库驱动。

## 曾考虑的替代方案

- **压缩后新建会话，旧会话归档并支持搜索：** 作为默认方案舍弃。它能自然切分存储，但会同时引入会话列表、活动会话指针、父会话关系、搜索 UI 和固定 conversationId 改造，把上下文预算问题扩大成会话管理项目。保留为 Phase 3 的可选产品形态，而不是第一阶段。
- **把摘要追加到 system prompt：** 舍弃。每次压缩都会改变 system 前缀，破坏后续缓存对齐，并把会话记忆混进产品策略；摘要应作为 synthetic user message 注入消息序列。
- **摘要调用走 `AgentRuntime` 的注册 Agent：** 舍弃。摘要不是用户可见 Bot，也不应产生普通 run 事件或出现在 Bot 目录；内部模型任务需要独立端口。
- **只保留完整历史，靠 UI 虚拟化或模型自动截断：** 舍弃。UI 虚拟化不减少模型 token；依赖 provider 自动截断会不可控地丢开头或工具结果，且无法解释模型为什么忘记。
- **直接按字符数丢弃最旧消息，不做摘要：** 舍弃作为默认。实现最简单，但会突然丢失任务线索和用户偏好；只作为摘要失败时的降级策略。
- **把摘要作为一条 assistant 消息插入 transcript：** 舍弃。会伪造用户可见对话、污染后续投影，并且多次压缩会叠加假的助手发言；checkpoint 元数据 + synthetic user message 更干净。
- **在领域层直接调用 `createOpenAICompatible` 做摘要：** 舍弃。会复制鉴权、重试、错误归一和取消语义，形成第二套模型执行路径；应通过 `core/model` 的内部模型任务。
- **先完整实现 SQLite 与 archive，再做摘要：** 舍弃作为第一步。存储迁移、事务、图片 blob 和搜索索引的工程量更大，先用 Phase 1 验证摘要质量与触发阈值，Phase 2 再复用 checkpoint 抽象。
- **把归档工具输出直接丢弃，只留摘要：** 舍弃。会降低后续 AI 检索和审计能力；优先无损压缩 + 预览 + 保留策略，删除必须由用户显式触发。
- **为 Coding 单独实现一套压缩：** 舍弃。压缩是通用能力，Coding 只是第一个使用场景；复制引擎会导致 Conversation、Interview 各自漂移，测试也无法共用。Coding 只提供 `CompactionProfile`。
- **每个领域各自维护摘要引擎：** 舍弃。预算、选段、工具配对、checkpoint 投影和失败回退必须只有一个实现；领域差异只通过 profile 注入，core 不出现 `if (coding)`。
- **每个领域各自维护摘要提示词：** 舍弃。当前阶段所有领域只接一套通用摘要提示词；领域自定义会让摘要边界、事实保留和失败行为漂移，也让测试无法共用。确实需要领域措辞时另立决策 Note，不在首版预留。
- **继续把上下文装配留在 `conversation/turn` 和 `coding/context.ts`：** 舍弃。压缩会同时改多个领域和核心 store，职责无法并行；先抽 `core/context`，领域只保留 profile。
- **继续由 `CodingApplication` 直接调用 `ContextCompactor`：** 舍弃作为最终方案。它绕过了 `ContextPreparation`，压缩后 usage 仍是旧值，`postCompactTarget` 不会立即生效，也无法复用裁剪和状态写入；只保留为当前过渡实现。
- **为手动压缩复制一套摘要/裁剪引擎：** 舍弃。手动与自动必须共用 checkpoint 选段、摘要 prompt、失败状态和 usage 计算；复制会让两条路径的边界和失败语义漂移。
- **手动失败也计入自动熔断：** 舍弃。用户显式重试不应把自动压缩永久关掉；手动失败只记录 `failed`/`aborted`，自动失败计数只由自动路径增加，手动成功清零。
- **只在 renderer 上禁用按钮，不在 agent/worker 校验：** 舍弃。队列、跨窗口和 IPC 都能绕过 renderer 状态；空闲校验必须在领域 application 和 worker 边界执行。
- **给手动压缩新增独立 run 或执行事件：** 舍弃。手动压缩不是用户可见回复，也不应污染 run 状态机；只写上下文状态、checkpoint 和 snapshot 边界。

## 验收标准

- 可观察结果：
  - 长会话在达到预算前完成压缩，下一次请求不再超过模型窗口。
  - 当前用户请求不会被摘要；最近完整轮次和工具配对保持可回放。
  - 压缩失败时仍有可用的最近上下文，并显示明确降级提示。
  - 压缩状态按 started → succeeded/failed/aborted 推送 snapshot，展示开始、完成、失败、取消；失败或取消不阻断本轮，也不进入 Agent run 状态机。
  - 压缩请求保持 system/tools/model 前缀不变，只追加 user message；压缩后 system prompt 不变。
  - 手动压缩成功后新增一次 checkpoint、snapshot 边界和更新后的 usage；不新增用户消息，不产生 run 事件，下一次请求立即使用摘要。
  - 自动熔断打开时手动压缩仍可执行；没有足够旧消息时显示“没有足够的旧消息可压缩”，取消显示为已取消而不是失败。
  - Phase 2 后 active snapshot 的消息数/token 有界；archive 可查看，重启后仍存在。
  - Phase 3 后 Agent 能按需检索 archive；删除 archive 后 UI、索引和摘要引用状态一致。
- 自动化验证：
  - 预算阈值、usage 缺失回退、当前请求保护、tool pair 边界、重复压缩拒绝、摘要失败回退。
  - 摘要请求形状：system/tools/model 不变；消息序列是原前缀 + 追加 user message；摘要结果只出现在合成投影中。
  - 目录约束：`core/context` 不 import 领域；`interview` 不 import `conversation`；领域不直接调用 provider。
  - 通用性验证：至少用 Conversation 与 Coding 两个 `CompactionProfile` 跑同一套 core 测试，证明没有领域分支；Interview profile 启用时复用同一契约。
  - 提示词单一来源：Conversation、Coding、Interview 的压缩调用都引用 `core/context/compaction/prompt.ts` 的同一常量；领域不得传入自定义摘要提示词。
  - 手动压缩覆盖：自动熔断后仍成功、成功清零计数、失败不增加自动计数、`AbortError` 返回 `aborted`、少于最少消息返回 `insufficient-messages`、成功刷新 usage 且不新增消息/run、投影失败不回滚 checkpoint。
  - `AgentExecutor.prepare` 只读：不创建 run、不写 `ExecutionStore`、不执行工具；手动压缩的合成输入不进入 transcript。
  - 桌面端 `answra:conversation:compact`、worker 命令、IPC/preload 和运行中禁用有测试覆盖。
  - 持久化 archive 事务、重启恢复、afterRevision/过期游标回退、删除一致性。
  - 检索结果预算、来源字段、中文分词、秘密/提示注入防护。
  - `pnpm verify`、`pnpm notes:check`、`pnpm architecture:check`。
- 需要的实机验证：
  - 桌面端 Conversation 与 CLI Coding 各跑一轮超过 `contextWindow` 的长会话，确认压缩后继续工作；Interview 在启用阶段补测实时链路。
  - 桌面端手动“压缩上下文”、查看归档、重启后恢复；CLI 手动 `/compact` 与自动压缩。
  - 真实 provider 的 usage 缺失/异常、手动压缩取消、SQLite 锁与磁盘不可写路径。
  - 压缩前后 API 请求的缓存 read/write 指标，验证正常回合缓存语义和 post-compact 首次 miss 的可解释性。

## 风险

- 摘要质量不足或多次压缩漂移，会丢失关键约束；用分段 checkpoint、保留最近完整轮次和可检索 archive 降低依赖。
- `contextWindow` 来自端点能力字段；字段错误会导致过早压缩或仍然溢出。需要保守阈值、provider usage 校准和端点字段校验，不依赖用户手动配置。
- 摘要调用增加延迟与 token 成本；必须只在该会话空闲时触发，并允许取消和失败回退。
- 手动压缩绕过自动熔断后，用户可以连续重试注定失败的摘要请求；必须立即返回明确错误、允许取消，且手动失败不能把自动路径永久关掉。是否需要手动冷却另立证据再决定，首版不增加第二套冷却状态。
- 手动压缩的 usage 依赖 `AgentExecutor.prepare` 的只读投影；如果未来某个 `prepare` 产生工具副作用或 run 事件，会破坏“手动压缩不执行工具”的约束，必须用测试守住。
- 桌面手动压缩与 conversation queue 存在竞态：队列非空或 active run 未结束时必须拒绝，不能只依赖 renderer 按钮禁用。
- 缓存假设不稳定：不同 provider 的缓存键可能包含 tools、system、model 或消息前缀；保留 system/tools 不变是必要条件，不是充分条件。不要把“用户消息注入”当成零缓存影响。
- 归档工具结果压缩可能损失后续检索所需细节；使用无损压缩、预览和明确保留策略，避免默认有损。
- 持久化 archive 会扩大敏感数据面（截图、代码、工具输出）；需要加密、保留期、清除入口、workspace/会话权限和跨客户端锁。
- 桌面端固定 `active-chat-conversation` 与现有 snapshot 替换语义会影响 archive UI；Phase 2 必须验证回复条、重连空快照和事件游标回退。
- 领域差异（交接、工具集、实时面试）可能被硬编码进 core；必须通过 `CompactionProfile` 注入，core 不出现 `if (coding)` 或领域 import。
- Interview 实时链路对摘要延迟敏感；不能把在线摘要放在音频 turn 热路径，必须空闲/后台触发，并允许关闭。
- 中文全文检索的分词、排序和旧事实冲突会直接影响 AI 回忆质量；需要检索结果预算与时间/来源标注。
- 目录重命名会制造大面积 import 变更；必须与压缩逻辑、SQLite 迁移分开提交，避免并行开发冲突和 review 噪声。
- 本提案与现有产品方向 Note 的“暂不预支记忆压缩”冲突；实施前应把该方向变更同步到产品方向 Note，避免两套决策并存。
