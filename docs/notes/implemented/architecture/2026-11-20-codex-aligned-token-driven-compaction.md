# Note：Codex 对齐的 token 驱动上下文压缩

状态：已实施

## 问题

旧压缩在真实长任务里会失效，原因不是摘要模型失败，也不是 token 预算没触发：

- `apps/agent/src/core/context/compaction/profile.ts` 默认 `minimumMessagesToSummarize = 4`。
- `apps/agent/src/core/context/compaction/plan.ts` 自动压缩用 `lastUserMessageIndex(pending)` 选择摘要范围。
- `apps/agent/src/core/context/preparation.ts` 手动压缩用 `retention = "none"`，自动压缩用 `"current-user-turn"`。

失败场景一：约 160k 上下文时手动 `/compact`，检查点之后只有 1 条用户消息和 1 条 assistant 消息；`2 < 4`，直接返回 `insufficient-messages`。

失败场景二：用户只发 1 条消息，assistant 在同一回合执行几十个工具调用。达到 216k 时，`lastUserMessageIndex(pending)` 指向当前用户消息本身，可摘要消息数为 0；即使删除 `minimumMessagesToSummarize`，仍然返回 `insufficient-messages`。

根因是把压缩建模成“保留当前用户回合，只摘要它之前的历史”。真正需要压缩的往往正是当前回合里持续增长的工具调用和工具结果。

Codex 的实际行为是 token 驱动：

- `D:\codespace\codex\codex-rs\core\src\session\context_window.rs:108` 达到 token 上限产生 `token_limit_reached`，与消息条数无关。
- `D:\codespace\codex\codex-rs\core\src\session\turn.rs:1548` 每轮采样前检查。
- `D:\codespace\codex\codex-rs\core\src\session\turn.rs:745` 工具循环需要继续时也会中途压缩。
- `D:\codespace\codex\codex-rs\core\src\compact.rs:301` 摘要请求带当前完整历史。
- `D:\codespace\codex\codex-rs\core\src\compact.rs:365` 摘要请求超限时从最旧历史项开始删并重试。
- `D:\codespace\codex\codex-rs\core\src\compact.rs:411-413` 压缩后重建历史。
- `D:\codespace\codex\codex-rs\core\src\compact.rs:732-848` 保留最近用户消息，最多 `20_000` token；assistant 和工具过程只进摘要；摘要最后追加。
- 手动 `/compact` 与自动压缩共用同一套逻辑，没有“消息太少不允许压缩”。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/compaction/plan.ts`：删除 `lastUserMessageIndex` 和最少消息条数；摘要全部待压缩消息；选择保留用户消息。
  - `apps/agent/src/core/context/compaction/profile.ts`：删除。压缩不再有领域 profile。
  - `apps/agent/src/core/context/compaction/compact.ts`：摘要全部待压缩消息，写入保留用户消息和 checkpoint，返回保留数量。
  - `apps/agent/src/core/context/compaction/compactor.ts`：移除 profile 与 retention 参数。
  - `apps/agent/src/core/context/preparation.ts`：手动、自动、provider 超限恢复统一；压缩后 trim 保护保留消息和摘要。
  - `apps/agent/src/core/context/projection.ts`：投影“保留用户消息 + 摘要 + 尾段”。
  - `apps/agent/src/core/transcript/contextCheckpoint.ts`：checkpoint 增加 `retainedUserMessages` 与深拷贝函数。
  - `apps/agent/src/core/transcript/persistence/sessionRecord.ts`：checkpoint schema 增加可选字段，限制为用户消息。
  - `apps/agent/src/core/transcript/memoryStore.ts`、`persistence/restore.ts`：克隆和恢复保留消息。
  - `apps/agent/src/coding/application.ts`、`conversation/application.ts`、`interview/application.ts`：移除 `DEFAULT_COMPACTION_PROFILE` 注入。
  - `apps/cli/src/tui/commands/handlers/session.ts`：`insufficient-messages` 文案改为“当前没有可压缩的上下文”。
- UI/进程/协议/持久化表面：
  - 不改压缩阈值、UI 状态机、worker/IPC 协议和 `ContextUsage`。
  - `insufficient-messages` 枚举保留，语义从“少于 4 条”改为“没有待压缩消息”。
  - checkpoint 增加可选持久化字段；旧 SQLite/JSON 记录读取后按缺省处理，不删除、不重写历史。
- 相关 Note：
  - [会话上下文摘要压缩与旧上下文归档](../../proposed/architecture/2026-11-13-conversation-context-compaction-and-archive.md)
  - [上下文压缩只保留摘要与当前用户回合](../../implemented/architecture/2026-11-17-context-compaction-user-turn-retention.md)
  - [摘要输入从最近检查点开始且不再预截断工具内容](../simplification/2026-11-20-lossless-compaction-input.md)
  - [压缩路径取消“最近工具结果”保护](../simplification/2026-11-20-compaction-clears-all-tool-results.md)
  - [Provider 上下文超限的单次恢复](./2026-11-14-provider-overflow-reactive-compaction.md)

## 决定

### 1. 只按 token 和待压缩消息决定是否压缩

删除 `CompactionProfile`、`minimumMessagesToSummarize` 和 `lastUserMessageIndex` 边界。`decideCompaction` 只保留三个条件：

- checkpoint 引用的消息不存在：`checkpoint-invalid`。
- 非手动且 token 估算低于 `compactAt`：`below-threshold`。
- 最新 checkpoint 之后没有消息：`insufficient-messages`。

只要 checkpoint 之后有消息，手动压缩和自动压缩都允许。自动压缩不再要求“最后一条用户消息之前还有旧消息”。

```ts
const pending = messagesAfterCheckpoint(messages, checkpoint);
if (!pending) return skip("checkpoint-invalid");
if (!force && tokens < triggerTokens) return skip("below-threshold");
if (pending.length === 0) return skip("insufficient-messages");
return {
  messagesToSummarize: pending,
  retainedUserMessages: selectRecentUserMessages(messages),
};
```

`compactAt`、`pruneAt`、`postCompactTarget` 和摘要输出上限保持不变。

### 2. 摘要输入覆盖整个待压缩区间

`messagesToSummarize = pending`，不再按角色截断。摘要请求包含：

- 最新 checkpoint 的 `previousSummary`；
- checkpoint 之后的所有用户消息；
- 所有 assistant 可见正文；
- 工具调用名、输入、状态、完整结果和错误原文。

保留用户消息也进入摘要请求。它们会在压缩后再次以原始消息投影，因此当前用户消息可能在摘要和原始消息中各出现一次；这是 Codex 的既有行为，用于降低摘要漂移对当前任务的影响。

摘要输入超过模型窗口时，继续使用 `dropOldestSummaryMessage` 逐条丢弃最旧消息并重试；`omittedMessages` 写入摘要，明确标注早期信息不完整。该重试是输入超限兜底，不是消息条数门槛。

### 3. 压缩后保留最近的用户消息

`selectRecentUserMessages(messages)`：

- 从最新消息向最旧遍历，只选择 `role === "user"` 的消息。
- 总预算 `RETAINED_USER_MESSAGE_TOKEN_BUDGET = 20_000`。
- 选择结果保持原始时间顺序。
- 从**截至当前最后一条消息的完整 transcript** 选择，不只选 checkpoint 之后的消息。这样长工具循环没有新的用户消息时，原始任务仍不会从投影中消失。
- 单条用户消息超过剩余预算时，截断文本、丢弃该条图片并标注 `[用户消息因压缩预算截断]`；不得因为超预算而完全丢掉最新任务。
- 保留消息以正文快照写入 checkpoint，投影时直接使用，不依赖 future archive 是否还能解析 ID。

示例：

```text
pending:
  user1      800 token
  assistant1 60k token
  user2      300 token
  assistant2 120k token

retainedUserMessages = [user1, user2]
messagesToSummarize = [user1, assistant1, user2, assistant2]
```

`assistant1`、`assistant2` 和其中的工具结果只进入摘要；`user1`、`user2` 在压缩后仍以原消息投影。

### 4. checkpoint 增加保留用户消息

`ContextCheckpoint` 增加可选字段：

```ts
interface ContextCheckpoint {
  summary: string;
  throughMessageId: string;
  createdAt: string;
  messageCount: number;
  retainedUserMessages?: ConversationMessage[];
  instructions?: string;
}
```

约束：

- `throughMessageId` 仍是最后一条被摘要消息，边界语义不变。
- `retainedUserMessages` 必须是 `role === "user"` 的完整消息快照；persistence schema 用 `conversationMessageSchema.refine(...)` 校验。
- 旧 checkpoint 没有该字段时按缺省处理；这是向后兼容的可选字段，不是新 schema 版本。
- 旧 SQLite/JSON 记录不追溯修改；升级后第一次压缩才写入新字段。
- 不新增 archive、检索或独立 checkpoint 正文表。

### 5. 模型投影顺序

`projectContextMessages` 改为：

```text
保留用户消息 1..N（原始顺序）
摘要 synthetic user message
checkpoint 之后的新消息尾段
```

摘要文案仍使用“以下是之前会话的摘要……”的 synthetic user message，不写入 transcript，不显示为用户真实发言。摘要文案增加约束：不要重做已完成的写文件、提交、发消息或运行命令等有副作用操作，需要时先做只读验证。

压缩后 `rebuild()` 的 trim 保护“保留用户消息 + 摘要”这个前缀：

- 旧实现固定 `preserveLeadingMessages = 1`，只保护摘要。
- 新实现使用 `compaction.retainedUserMessages + 1`，否则 trim 可能丢掉保留用户消息或摘要。
- 尾段仍按完整轮次裁剪；不得拆开 tool-call/tool-result 对。
- 保留用户消息和摘要已经超过 `postCompactTarget` 时允许超过软目标；只在超过 `inputLimit` 时继续 trim 或报 `ContextLimitExceededError`。

### 6. 手动、自动和 provider 超限恢复统一

- 手动 `/compact`：`force = true`、绕过失败熔断；只要 pending 非空就压缩。
- 自动预压缩：每次模型请求前由 `ContextPreparation` 检查，达到 `compactAt` 就压缩；不再选择 `current-user-turn`。
- 工具循环中途：coding/conversation 的每次模型调用前都会重新执行 `prepareRequest`，因此 tool result 写入后、下一次模型调用前可以自动压缩；不需要新增后台任务。
- provider 超限恢复：`recoverRequest` 使用同一计划。取消“保留当前用户回合”的例外，因为保留整个工具回合会让压缩后仍接近原上下文大小，和 Codex 不一致。
- 为防止模型重跑有副作用的工具，摘要提示词和投影摘要文案都要求记录并避免重做已完成操作。
- 压缩成功后仍写 `usage.source = "compaction"`，并刷新 usage；压缩失败、取消和熔断语义不变。

### 7. 明确不做

- 不实现 Codex 的 `TokenBudget` 实验模式；该模式直接开新 context window、不生成摘要。
- 不实现后台异步压缩；v1 在模型调用前同步压缩。
- 不按消息条数保留 assistant/tool 尾段。
- 不把摘要写入 transcript 或 system prompt。
- 不修改 216k/172k/16k 预算和普通工具结果清理规则。
- 不新增领域专属压缩 profile 或摘要 prompt。
- 不做 archive、检索和独立 checkpoint 正文表。

## 与现有决定的关系

本 Note 显式修订 [上下文压缩只保留摘要与当前用户回合](../../implemented/architecture/2026-11-17-context-compaction-user-turn-retention.md)：

- `current-user-turn` 在工具密集型单回合任务中会阻止压缩，不再作为自动压缩默认策略。
- `minimumMessagesToSummarize` 是本次缺陷的直接触发条件，已删除，不只改手动路径绕过。
- 旧 Note 保留为历史决定，并增加“后续变更”指向本 Note；不要留下两套互相矛盾的规则。

## 模块边界

- `core/context/compaction/plan.ts`：只做 token 判定、待压缩消息选择和保留用户消息选择；不读写 store、不调用模型。
- `core/context/compaction/compact.ts`：执行摘要、输入超限重试、摘要收敛和 checkpoint 写入；保留用户消息由 plan 提供。
- `core/context/compaction/compactor.ts`：压缩生命周期、失败熔断、snapshot 推送；不持有领域 profile。
- `core/context/preparation.ts`：唯一编排点；负责 prune、压缩、rebuild、压缩后 trim 和 usage 写入；不实现摘要 prompt。
- `core/context/projection.ts`：把保留用户消息、摘要和尾段投影为模型消息；不读取 store，不解析摘要正文。
- `core/transcript/contextCheckpoint.ts`：checkpoint 事实与 `messagesAfterCheckpoint`；不调用模型，不定义摘要内容。
- `core/transcript/persistence/sessionRecord.ts`、`restore.ts`、`memoryStore.ts`：持久化与恢复；不解释压缩语义。
- `conversation/`、`coding/`、`interview/`：只提供当前请求和调用 `ContextPreparation`；不复制压缩计划、不注入 profile。
- `packages/shared`：不新增压缩计划或保留消息 DTO；`ManualCompactionResult.reason` 保持现有枚举，只更新文案语义。

## 曾考虑的替代方案

- **只删除 `minimumMessagesToSummarize`，保留 `current-user-turn`。** 舍弃。长工具循环中 `lastUserMessageIndex` 仍为 0，自动压缩仍无法执行。
- **只让手动 `/compact` 绕过最少条数，自动压缩继续要求 4 条。** 舍弃。能修复 160k 手动失败，但 216k 单回合工具任务仍会卡住。
- **保留当前 assistant/tool 回合原文，只摘要更早历史。** 舍弃。当前回合正是上下文增长的主要来源；保留它会让压缩后仍接近原大小。
- **不保留用户消息，只保留摘要。** 舍弃。当前任务、用户约束和验收条件容易在摘要中漂移；Codex 明确保留最近用户消息。
- **用消息 ID 引用保留用户消息。** 舍弃。ID 在 future archive 删除 active transcript 后会失效；改为正文快照，checkpoint 自包含。代价是重复保存最多 20k token 的用户消息。
- **完全照搬 Codex 的 token-budget fresh window。** 舍弃作为本变更范围。它不生成摘要，直接换新窗口，不适合需要保留任务连续性的 coding 会话。
- **新增后台异步压缩。** 舍弃。同步压缩已能在下一次模型调用前完成，先不引入第二套并发状态。
- **保留 `CompactionProfile`，只把最小值改成 1。** 舍弃。值为 1 时仍要求至少一条消息，和“没有待压缩消息才跳过”没有区别；保留一个永远不再参与决策的 profile 是死配置。

## 验收标准

- 可观察结果：
  - 160k、checkpoint 后只有 2 条消息时，手动 `/compact` 成功；`summarizedMessages = 2`，usage 在压缩后刷新。
  - 单个用户任务、assistant 持续工具循环、达到 216k 时，下一次模型调用前自动压缩成功；当前用户消息仍保留，工具过程进入摘要，当前 run 继续。
  - 只有 1 条超大消息时，手动或自动压缩也能执行。
  - checkpoint 后没有消息时，手动压缩返回 `skipped: insufficient-messages`，文案为“当前没有可压缩的上下文”。
  - 压缩后的投影顺序为“保留用户消息 + 摘要 + 尾段”，摘要不写入用户可见 transcript。
  - 压缩后 trim 不丢保留用户消息和摘要，不拆开 tool-call/tool-result 对。
- 自动化验证：
  - `plan.test.ts`：手动/自动都摘要全部 pending；无 pending 跳过；checkpoint invalid；保留用户消息跨旧 checkpoint；20k 预算截断。
  - `compact.test.ts`：摘要输入包含当前用户、assistant 和工具结果；输入超限逐条丢弃；checkpoint 写入 `retainedUserMessages`。
  - `projection.test.ts`：保留用户消息、摘要和尾段顺序；无保留消息时摘要在前；stale checkpoint 回退全量。
  - `preparation.test.ts`：单用户工具循环自动压缩；单条待压缩消息手动压缩；无 pending 跳过；压缩后 trim 使用保留数量。
  - `sqliteConversationStore.test.ts`：`retainedUserMessages` 随 checkpoint 往返。
  - `docs/notes/implemented/architecture/2026-11-17-context-compaction-user-turn-retention.md` 已增加后续变更指向。
- 需要的实机验证：
  - 用真实 CLI coding 会话制造“单用户 + 多工具”长回合，在 216k 附近观察自动压缩、当前用户保留、run 继续和 usage 刷新。
  - 在约 160k 手动执行 `/compact`，确认不再返回 `insufficient-messages`。
  - 真实 provider 下确认摘要请求超限时逐条丢弃重试不会无限循环，最终失败有明确错误。
  - 桌面 Conversation 与 Interview 各跑一次长上下文，确认至少不因消息条数门槛拒绝压缩；Answer 不参与。

## 后果与防回退

- 压缩不再有消息条数门槛；任何“至少 N 条才压缩”的新逻辑都必须先说明它如何避免单用户长工具循环卡死。
- 摘要必须覆盖 checkpoint 后的全部消息，包括当前 assistant/tool 回合；不得重新引入 `lastUserMessageIndex` 截断。
- 保留用户消息从完整 transcript 选择，不能只选 pending，否则长工具循环会丢掉原始任务。
- 投影顺序固定为“保留用户消息 → 摘要 → 尾段”；压缩后 trim 必须保护 `retainedUserMessages + 1` 个前缀消息。
- `retainedUserMessages` 是完整消息快照；持久化必须深拷贝，不能浅拷贝数组或图片。
- checkpoint schema 是可选字段，不是全局 schema 版本；升级不得删除旧会话或重写历史。
- provider 超限恢复也走同一压缩计划，不再保留当前工具回合；副作用风险由摘要约束和只读验证承担。
- 如果未来实现 archive，保留消息快照仍可独立投影；若改为 ID 引用，必须先证明归档后 ID 可解析。

## 风险

- 摘要成为 assistant/tool 工作的唯一载体；如果摘要漏掉文件路径、命令、错误或验证结论，模型会重新读取文件或重跑命令。缓解：摘要输入继续包含完整工具结果，提示词要求保留副作用操作与验证结论。
- 取消 `current-user-turn` 后，provider 超限恢复可能让模型重做有副作用的工具。缓解：摘要明确“已完成操作不要重做”，并要求先做只读验证；该风险需要在真实 coding 工具循环中验证。
- 保留用户消息最多 20k token，超大用户请求会被截断，图片会在超预算时丢弃；摘要仍包含完整输入，但当前消息的尾部约束可能丢失。需要后续根据真实 tokenizer 校准。
- 保留用户消息与摘要可能超过 `postCompactTarget`；这是有意的，硬上限仍是 `inputLimit`。
- 每次模型调用前同步压缩会增加当前回合延迟；v1 接受该代价，不引入后台异步状态。
- 旧 checkpoint 没有保留用户消息，升级后第一次压缩前仍按旧投影工作；不追溯修改历史 checkpoint。
- `insufficient-messages` 枚举保留但语义变化，旧 UI/日志可能仍按“消息不足”显示；所有展示文案和测试已同步，新增入口不得复制旧文案。

## 验证

- `pnpm --filter @answra/agent typecheck` 通过。
- `pnpm --filter @answra/agent exec vitest run test/core/context test/core/transcript/sqliteConversationStore.test.ts` 通过。
- `pnpm --filter @answra/agent test` 通过。
- `pnpm notes:check` 通过。
- `pnpm verify` 通过：biome lint、`notes:hint`、全 workspace typecheck、`db:check`、全仓 vitest、发布 Profile 检查、架构检查和设计令牌检查。
- 真实 provider 的 216k 工具循环、160k 手动压缩和桌面 Conversation/Interview 长上下文验证尚未执行，不在本次自动化结论内。
