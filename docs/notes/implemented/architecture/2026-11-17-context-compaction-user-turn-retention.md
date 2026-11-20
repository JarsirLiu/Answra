# Note：上下文压缩只保留摘要与当前用户回合，工具结果进入摘要输入

状态：已实施

## 问题

旧实现按"保留最近 12 条 transcript 消息"截断（`apps/agent/src/core/context/compaction/profile.ts`），压缩后的软目标是 `postCompactTarget = 120_000`（`apps/agent/src/core/context/budget.ts`）。这套规则在工具密集型会话里几乎无效：

- 一条 assistant 消息可以包含几十个工具调用及其输出，"12 条消息"不等于 12 轮对话；实测一段 28 条消息的 coding 会话，最后 12 条就占约 100k token（工具输出约 66k、工具入参约 32k、正文约 10k）。
- 该会话手动 `/compact` 摘要了前 16 条（`summarizedMessages: 16`），保留后 12 条；压缩后 `usage.usedTokens = 112_999`、`inputLimit = 216_000`，仍是 **52%**。
- 摘要输入只渲染用户/助手正文和图片文件名，不包含工具调用与结果（`apps/agent/src/core/context/compaction/transcript.ts`）。因此即使想丢掉工具尾段，摘要也没有记录命令、文件路径、错误原文和验证结果。
- 压缩后总量 113k 低于 `pruneAt=172k`，普通旧工具结果清理不会触发；手动压缩路径也不做额外清理。

目标：压缩后的模型上下文主要由"摘要 + 当前用户回合"构成，不再携带历史 assistant/tool 尾段；256k 窗口下总占用尽量控制在 16k 左右，固定 system/tools 另计。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/budget.ts`：新增 `summaryMaxTokens`，`postCompactTarget` 下调到 16k。
  - `apps/agent/src/core/context/compaction/profile.ts`：删除 `retainRecentMessages`，只保留最少摘要条数。
  - `apps/agent/src/core/context/compaction/plan.ts`：新增 `CompactionRetention`，按保留策略选择检查点边界。
  - `apps/agent/src/core/context/compaction/transcript.ts`：摘要输入渲染工具调用/结果；2026-11-20 起不再做单项或总量截断。
  - `apps/agent/src/core/context/compaction/prompt.ts`：明确工具结果已进入摘要输入，新增摘要缩短提示。
  - `apps/agent/src/core/context/compaction/compact.ts`、`compactor.ts`：传入保留策略和摘要上限，执行缩短与硬截断兜底。
  - `apps/agent/src/core/context/preparation.ts`：区分手动、自动和 provider 超限恢复；压缩路径强制清理当前回合旧工具结果。
  - `apps/agent/src/core/context/tokenEstimate.ts`：新增按 token 预算截断文本。
- UI/进程/协议/持久化表面：
  - 不改 `ConversationSnapshot`、`ContextUsage` 或 worker/IPC 协议。
  - transcript 与 UI 历史不变；丢弃和清理只作用于模型投影。
  - 压缩完成/失败的可见提示仍属于独立 UI 决策，未包含在本变更内。
- 相关 Note：
  - [256k 上下文预算与旧工具结果清理](./2026-11-13-context-budget-and-tool-result-clearing.md)
  - [旧工具结果清理结果跨轮保留](./2026-11-16-sticky-tool-result-pruning.md)
  - [Provider 上下文超限的单次恢复](./2026-11-14-provider-overflow-reactive-compaction.md)
  - [手动压缩的自定义摘要指令与摘要展示](../feature/2026-11-14-manual-compaction-instructions-and-summary.md)
  - [会话上下文摘要压缩与旧上下文归档](../../proposed/architecture/2026-11-13-conversation-context-compaction-and-archive.md)

## 决定

### 1. 摘要压缩对齐 Codex 的保留边界

Codex 本地摘要压缩只保留真实用户消息（上限 20k token），从新到旧截断正文，然后追加摘要；assistant 消息、工具调用和工具结果不保留。摘要请求会看到完整历史，包括工具调用与结果。

本实现采用同一主干，但把保留边界进一步收缩：

- `CompactionRetention = "none" | "current-user-turn"`。
- 手动 `/compact` 使用 `"none"`：摘要覆盖全部待处理消息，检查点指向最后一条消息，模型投影只保留摘要。
- 自动预压缩和 provider 超限恢复使用 `"current-user-turn"`：找到最后一条真实用户消息，摘要覆盖它之前的全部消息，检查点指向它的前一条；模型投影 = 摘要 + 当前用户消息及其后的当前回合消息。
- 自动预压缩发生在 `beginRun` 追加当前用户消息之后、第一次模型调用之前，因此实际只保留当前用户消息。
- provider 超限恢复保留当前用户回合中的 assistant/tool 消息，避免模型重跑已经产生副作用的工具。
- 没有用户消息时退回摘要全部；可摘要消息不足 `minimumMessagesToSummarize` 时跳过。
- 检查点仍是连续边界，`throughMessageId` 语义不变，不新增持久化 schema。

### 2. 摘要输入包含工具结果

`renderMessagesForSummary` 现在渲染：

- 用户/助手正文和图片文件名；
- 工具名、完整输入、状态、完整结果或错误原文。

2026-11-20 起删除单项和总量截断：摘要请求超限时由 `compact.ts` 逐条丢弃最旧消息并标注 `omittedMessages`。原因和代价见[摘要输入从最近检查点开始且不再预截断工具内容](../simplification/2026-11-20-lossless-compaction-input.md)。思考（reasoning）仍不进入摘要输入。

### 3. 摘要长度上限与压缩后预算

- `DEFAULT_SUMMARY_MAX_TOKENS = 4_000`，256k 窗口下为 4k；按窗口缩放，最低 2,000。
- 摘要超过上限时先追加一次"缩短摘要"模型调用；缩短失败或仍超限时，按 token 预算硬截断并追加 `[摘要因长度限制已截断]`。
- `postCompactTarget` 从 120k 下调为 16k（256k 窗口），按窗口缩放。
- `compactAt`、`pruneAt`、`pruneTarget` 和普通 prune 的 `minPruneSaving` 不变。

### 4. 压缩路径清理当前回合旧工具结果

压缩重建后、trim 前，对当前用户回合执行一次旧工具结果清理：

- 跳过普通 prune 的 `pruneAt` 和 `minPruneSaving` 门槛，因为压缩已改变投影前缀；
- 目标为 `postCompactTarget`；
- 只清理 `Read` / `Grep` / `RunCommand` 的文本结果；2026-11-20 起不再保护最近结果，见[压缩路径取消“最近工具结果”保护](../simplification/2026-11-20-compaction-clears-all-tool-results.md)；
- 清理结果合并进 `prunedToolCallIds` 水印，跨轮继续生效。

普通请求前的 prune 仍保持原有触发点和最小净节省门槛。

### 5. 明确不做

- 不保留最近 12 条或最近 N token 的 assistant/tool 原始尾段。
- 不删除 transcript，不把清理结果写回 UI 历史。
- 不在普通请求上降低 `minPruneSaving`。
- 不按模型名猜窗口，不把 4k/16k 写死在领域 profile 或 CLI/TUI。
- 不引入 provider 侧 cache editing 或第二套压缩协议。
- 不在本变更内改压缩完成/失败的 UI 提示。

## 模块边界

- `core/context/budget.ts`：只计算预算、缩放和派生阈值，包含 `postCompactTarget` 与 `summaryMaxTokens`；不读取 store、不估算消息。
- `core/context/compaction/profile.ts`：只保留 `minimumMessagesToSummarize`；不持有 token 数值或保留条数。
- `core/context/compaction/plan.ts`：只做消息选段；输入消息、检查点、保留策略和最小条数，输出摘要段与保留段；不调用模型、不读写 store。
- `core/context/compaction/transcript.ts`：只把 transcript 渲染成摘要文本；工具结果截断规则是纯函数，不访问模型或文件。
- `core/context/compaction/compact.ts`、`compactor.ts`：只执行摘要、检查点、摘要长度收敛和生命周期；预算与保留策略由 `ContextPreparation` 传入。
- `core/context/preparation.ts`：唯一编排点，负责选择保留策略、执行"套水印 -> 估算 -> prune -> 压缩 -> 重建 -> 当前回合清理 -> trim"；不实现摘要 prompt。
- `core/context/tokenEstimate.ts`：与估算同口径的文本截断；不读取上下文状态。
- `core/transcript/contextCheckpoint.ts`：检查点仍是连续边界，未新增 schema。
- `core/context/pruning/*`：保持纯函数和现有白名单；压缩路径只传不同的目标与保护参数。
- `conversation/`、`coding/`、`interview/`：只提供 profile 和当前请求，不复制保留策略或 token 预算。
- `packages/shared`：保留策略和预算不进入共享 schema；UI 继续只消费 `contextUsage` 和压缩边界。

## 曾考虑的替代方案

- **只把 `retainRecentMessages` 从 12 降到 2~4：** 舍弃。消息条数不是 token 单位，单条 assistant 消息可能包含数十个工具结果，降低条数仍无法约束压缩后大小。
- **保留最近 20k token 的尾段：** 舍弃。即便尾段可控，仍会留下 20k 原始工具上下文，加固定开销后接近 30k；与"尽量小于 30k"的目标不符。
- **完全照搬 Codex 的 20k 用户消息保留：** 舍弃。用户消息通常远小于 20k；保留当前用户回合即可，历史用户约束交给摘要，避免无谓占用。
- **只保留摘要，连当前用户回合也不保留：** 舍弃。自动预压缩和超限恢复需要当前请求；丢掉会让模型不知道要做什么，恢复路径还可能导致工具重跑。
- **超限恢复时丢掉当前回合工具结果：** 舍弃。coding 工具可能有副作用，重跑 `RunCommand` 或写文件不安全；保留当前回合并清理旧结果更稳。
- **只下调 `postCompactTarget`，继续保留 12 条消息：** 舍弃。硬裁剪按完整旧轮次丢弃，可能在保留段里随机丢掉刚完成的工作；不能保证裁剪点在 token 语义上合理。
- **只改摘要提示词，不丢尾段：** 舍弃。摘要再完整也不能减少 66k 工具输出和 32k 工具入参的占用。
- **每次请求都降低 prune 门槛：** 舍弃。会频繁改写投影前缀，造成缓存抖动；压缩路径已经接受一次前缀变化，才适合顺带清理。

## 后果与防回退

- 压缩后的历史完全由摘要承载；transcript 和 UI 仍保留全量消息，但模型不再看到被摘要的 assistant/tool 原文。
- 自动压缩后模型只看到摘要 + 当前用户消息；provider 超限恢复会多保留当前用户回合，避免重复执行有副作用的工具。
- 摘要质量直接决定压缩后的连续性。摘要输入必须继续包含工具结果；移除 `renderMessagesForSummary` 中的工具渲染等同于让模型丢掉路径、命令和错误。
- 不要重新引入 `retainRecentMessages` 或按消息条数保留尾段；需要调整保留量时，改 `CompactionRetention` 或预算并更新本 Note。
- 不要把 `postCompactTarget` 调回 100k 以上；它会直接抵消尾段收缩。
- 不要在普通 prune 路径取消 `minPruneSaving`；只有压缩路径可以跳过触发点和门槛。
- `trimContextRequest` 必须继续保留摘要和当前用户回合；不得为了达到目标而静默删除当前请求。
- 摘要上限是硬约束；缩短失败必须走带标记的截断，不能把超长摘要写入检查点。

## 验证

- `pnpm --filter @answra/agent test`：85 个测试文件、633 个测试全部通过。
- `pnpm typecheck`：所有 workspace 包通过。
- `pnpm lint`：Biome 检查通过。
- 自动化覆盖：
  - `plan.test.ts`：`"none"` 摘要全部、`"current-user-turn"` 保留当前回合、无用户消息回退、检查点边界、最少摘要条数。
  - `transcript.test.ts`：工具调用/结果进入摘要、完整工具内容保留、思考排除。
  - `compact.test.ts`：手动摘要全部、摘要缩短、缩短失败硬截断、摘要请求超限重试。
  - `tokenEstimate.test.ts`：按 token 预算截断。
  - `preparation.test.ts`：手动/自动/恢复保留边界、压缩路径强制清理、trim、watermark 与 usage 锚点。
- 尚需实机验证：用真实 CLI 工具密集会话执行 `/compact`、自动压缩和 provider 超限恢复，记录压缩前后 `usage.usedTokens` 及模型继续任务的表现。

## 风险

- 摘要质量成为唯一的历史载体；如果摘要漏掉工具结果中的关键事实，模型会重新读文件或重跑命令。缓解：摘要输入包含完整工具结果，提示词强制保留路径、命令、错误和验证结论。
- 丢弃最近 assistant 消息会丢失精确的编辑状态，模型需要重新读取文件；这是对齐 Codex 的有意代价，换取更小的压缩后上下文。
- 当前用户请求本身可能很大（例如粘贴大段代码），压缩无法缩小它；此时总占用会高于 16k，但仍保留请求完整性。
- 恢复路径保留当前用户回合，可能仍包含较多工具结果；只能清理白名单旧结果，不能保证一定降到目标。
- 摘要缩短是第二次模型调用，失败时会退化为硬截断，可能丢失细节；硬截断会显式标注。
- 中文 token 估算按逐字符计数偏保守，实际 tokenizer 可能不同；预算以估算为准。
- 固定 system/tools 开销无法压缩；`postCompactTarget=16k` 在工具 schema 很大时可能只能达到 16k-20k。
- 旧会话已保存的检查点不会追溯缩小；只有下一次压缩使用新规则，用户可能看到一次旧状态与新预算并存的过渡期。

## 后续变更

2026-11-20 起压缩路径取消“最近 3 个可清结果 / 最近 1 条模型消息”的保护，当前回合中的白名单工具结果按目标全部清理；普通请求前清理规则不变。原因、代价和重新引入条件见[压缩路径取消“最近工具结果”保护](../simplification/2026-11-20-compaction-clears-all-tool-results.md)。

2026-11-20 起摘要输入从最近检查点开始，但不再对工具输入/结果做 2k/40k 预截断；摘要请求超限时逐条丢弃最旧消息。原因、代价和重新引入条件见[摘要输入从最近检查点开始且不再预截断工具内容](../simplification/2026-11-20-lossless-compaction-input.md)。
