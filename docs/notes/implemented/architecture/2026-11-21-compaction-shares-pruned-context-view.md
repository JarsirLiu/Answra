# Note：摘要压缩共享清理后的上下文视图

状态：已实施

## 问题

上下文准备有两套视图：

- `ContextPreparation` 先对最终模型请求应用 `prunedToolCallIds`，再按清理后的 `initial.tokens` 决定是否压缩；
- `ContextCompactor` 却从 store 重新读取原始 `snapshot.messages` 生成摘要。

结果是：触发判断看的是清理后的请求，摘要输入却包含清理前的完整工具结果。清理本应降低上下文体积，但摘要请求可能重新膨胀到模型窗口之外；`compact.ts` 的 overflow 逐条丢弃实际上在补这个契约裂缝，可能丢掉当前任务上下文，极端情况下单条巨大消息仍会让压缩失败。

Claude Code 的对应路径没有这个分叉：`query.ts` 的 snip、microcompact、context collapse 和 autocompact 都消费同一份 `messagesForQuery`；手动 `/compact` 也先执行 `microcompactMessages`，摘要输入与测量视图一致。Answra 需要把“一个 prepare 只产生一个有效视图”显式化。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/compaction/view.ts`：新增 `CompactionView`，同时携带 transcript、最终请求 token 与清理水印。
  - `apps/agent/src/core/context/preparation.ts`：把合并后的 `prunedToolCallIds` 与清理后的 `initial.tokens` 一起传给压缩器。
  - `apps/agent/src/core/context/compaction/compactor.ts`：用上述两项构造 `CompactionView`，不再把原始 snapshot 直接交给摘要。
  - `apps/agent/src/core/context/compaction/plan.ts`：只消费 `view.finalRequestTokens`，删除 `contextTokens?: number` 与 raw transcript 估算回退。
  - `apps/agent/src/core/context/compaction/compact.ts`：把 `view` 传入计划与摘要渲染；overflow 重试仍保留水印。
  - `apps/agent/src/core/context/compaction/transcript.ts`：`renderMessagesForSummary` 接收水印，已清理结果渲染为占位符，工具输入保留。
  - `apps/agent/src/core/context/compaction/prompt.ts`：说明 `[旧工具结果已清理]` 不可见，不得猜测或编造。
  - `apps/agent/src/core/context/pruning/prune.ts`、`pruning/clearedResult.ts`：占位符唯一来源改为 `PRUNED_TOOL_RESULT_TEXT`，投影清理与摘要渲染共用。
  - `apps/agent/test/core/context/`：覆盖视图、计划、摘要渲染、overflow 与端到端 prep。
- UI/进程/协议/持久化表面：不变。transcript、checkpoint schema、`ContextUsage`、IPC 与 worker 协议都不改；只改变摘要模型看到的 prompt 与压缩触发契约。
- 相关 Note：
  - [摘要输入从最近检查点开始且不再预截断工具内容](../simplification/2026-11-20-lossless-compaction-input.md)
  - [压缩路径取消“最近工具结果”保护](../simplification/2026-11-20-compaction-clears-all-tool-results.md)
  - [Codex 对齐的 token 驱动上下文压缩](./2026-11-20-codex-aligned-token-driven-compaction.md)
  - [旧工具结果清理的粘性水印](./2026-11-16-sticky-tool-result-pruning.md)

## 决定

### 1. 单一 `CompactionView`

```ts
interface CompactionView {
  messages: readonly ConversationMessage[];
  finalRequestTokens: number;
  prunedToolCallIds: ReadonlySet<string>;
}
```

- `messages` 是原始 transcript，只用于检查点边界、待摘要区间和保留用户消息选择。
- `finalRequestTokens` 是应用清理水印后的最终模型请求估算；压缩触发只看它。
- `prunedToolCallIds` 是合并后的跨轮水印，包含本轮新清理和之前轮次已清理的 ID。
- 摘要渲染必须用同一水印把已清理工具结果替换为 `[旧工具结果已清理]`；不得输出原始结果。

### 2. 数据流

```text
ContextPreparation.prepare
  load context state
  watermark = state.prunedToolCallIds
  apply watermark to modelRequest
  initial = pruneIfWorthwhile(...)
  watermark = merge(watermark, initial.prunedToolCallIds)
  compactor.prepare({ finalRequestTokens: initial.tokens, prunedToolCallIds: watermark })

ContextCompactor.prepare
  load transcript snapshot
  view = { messages, finalRequestTokens, prunedToolCallIds: new Set(watermark) }
  compactContext({ view, ... })
```

压缩后重建仍先应用水印，再按 `postCompactTarget` 强制清理；新产生的 ID 合并进水印，供下一轮摘要使用。

### 3. 删除 raw 估算回退

`decideCompaction` 不再接受可选的独立 `contextTokens`，也不再在缺省时用 `checkpoint.summary + pending` 重新估算。调用方必须提供 `CompactionView`，避免出现“token 来自清理后请求，消息来自原始 transcript”的合法调用方式。

### 4. 摘要渲染与 overflow

- 摘要输入仍是检查点之后的完整消息，不按角色截断。
- 已清理的 tool-result 渲染为 `[工具结果] [旧工具结果已清理]`；工具名与输入仍保留，结果统一为占位符。
- `dropOldestSummaryMessage` 仍在 provider 报超限时逐条丢弃，但每次都继续使用同一水印；不会因为丢弃旧消息而恢复原始工具结果。
- 该重试降级为 provider 边界兜底，不再是正常路径的一部分。

### 5. 明确不做

- 不在摘要前额外清一次；初始清理仍按普通 prune 策略保留最近结果。
- 不把清理后的占位符写回 transcript 或 checkpoint；只改变摘要 prompt。
- 不改变压缩阈值、保留用户消息预算或摘要输出预算。
- 不新增 summary 专用目录、消息副本或第二套压缩状态。

## 模块边界

- `core/context/preparation.ts`：负责预算、初始清理、压缩编排、重建和 trim；只传视图事实，不实现摘要渲染。
- `core/context/compaction/view.ts`：定义压缩输入的唯一契约；不读写 store。
- `core/context/compaction/compactor.ts`：负责生命周期、检查点与 snapshot 推送；从请求构造视图。
- `core/context/compaction/plan.ts`：只按 `view.finalRequestTokens` 与待压缩消息决定计划；不读 store。
- `core/context/compaction/compact.ts`：执行摘要、overflow 收敛和检查点写入；渲染必须使用视图水印。
- `core/context/compaction/transcript.ts`：把消息渲染为摘要文本；识别清理水印但不决定清理策略。
- `core/context/pruning/clearedResult.ts`：占位符唯一来源；投影清理与摘要渲染共用。

## 曾考虑的替代方案

- **保留 compactor 的 raw 摘要，只把 `contextTokens` 改成必填：** 舍弃。触发判断与摘要输入仍来自两个视图，清理后摘要仍可能膨胀到窗口外。
- **摘要前再执行一次 prune：** 舍弃。会重复清理、改变摘要保留策略，并让“测量、摘要、重建”继续消费不同步骤的结果；Claude Code 选择的是共享视图，不是二次清理。
- **摘要使用无损原始 transcript，触发使用 raw token：** 舍弃。清理将不再降低压缩触发概率，摘要请求也更贵；与“清理是为了减少上下文”目标矛盾。
- **只按字符数再次截断工具结果：** 舍弃。会重新引入“提示词要求保留路径/命令/错误，但渲染层已丢弃”的矛盾；已有 Note 明确禁止。
- **把摘要改成结构化消息输入而非 prompt 字符串：** 舍弃。会扩大 `core/context` 与 AI SDK 的耦合；本次只需保证文本渲染不越界。

## 验收标准

- 可观察结果：
  - 触发清理后，摘要 prompt 中已清理的旧工具结果是 `[旧工具结果已清理]`，不包含原始结果。
  - 未清理的最近工具结果仍完整进入摘要。
  - 摘要请求 overflow 丢弃旧消息后，水印仍生效，不会恢复已清理内容。
  - 压缩后强制清理产生的新 ID 进入水印，下一轮摘要继续使用。
  - 手动压缩、自动压缩和 provider 超限恢复使用同一视图规则。
- 自动化验证：
  - `plan.test.ts`：`finalRequestTokens` 决定触发，raw transcript 大小不再参与回退估算。
  - `transcript.test.ts`：水印内结果渲染占位符，水印外结果完整，工具输入保留。
  - `compact.test.ts`：摘要 prompt 使用占位符；overflow 重试保持水印。
  - `preparation.test.ts`：端到端验证持久化水印进入摘要；压缩后清理与重建路径不变。
  - `pnpm --filter @answra/agent typecheck`、目标 vitest 与 `pnpm verify` 通过。
- 需要的实机验证：
  - 真实 provider 下构造单用户长工具循环，确认清理触发后摘要不再因原始工具结果超限。
  - 手动 `/compact` 在清理水印存在时仍成功，并刷新 usage。
  - Conversation/Interview 长上下文各跑一次；Answer 不参与摘要压缩。

## 风险

- 摘要不再看到被清理的旧工具结果，可能丢失只在原始输出中出现的细节；这是清理的有意代价，提示词要求模型不要补全。
- 水印容量上限为 `PRUNED_TOOL_CALL_ID_LIMIT`；超出后最旧 ID 被丢弃，未命中的结果可能再次进入摘要，行为与现有 sticky pruning 限制一致。
- `ContextCompactor` 仍会重新读取 transcript 快照；轮次队列保证同一 prepare 内没有并发写，但“严格同一对象”不在本 Note 范围。
- 摘要渲染依赖 `toolCallId` 命中水印；缺失或错误的 ID 会让结果保持原文。测试必须覆盖占位符与未清理结果两种路径。

## 后果与防回退

- 任何新的摘要入口都必须构造 `CompactionView`；不得恢复“可选 `contextTokens` + raw transcript 估算”的路径。
- 摘要渲染不得直接从 `view.messages` 读取已水印工具结果的原文；必须应用 `prunedToolCallIds`。
- 初始清理与摘要渲染必须共享同一个合并水印；只传本轮新 ID 会让旧清理结果在下一轮摘要中复活。
- overflow 逐条丢弃必须继续携带视图水印；不得在重试时回退到原始消息。
- 清理占位符只能在 `pruning/clearedResult.ts` 定义一次；投影清理与摘要渲染不得各写一份字符串。
- 摘要仍必须从最近检查点之后开始；不得为了“看得更全”重读完整历史。
- 压缩后强制清理与下一轮水印合并逻辑必须保留；否则压缩后的大工具结果会再次进入后续摘要。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/agent exec vitest run test/core/context/transcript.test.ts test/core/context/plan.test.ts test/core/context/compact.test.ts test/core/context/compactor.test.ts test/core/context/preparation.test.ts`：5 个文件、72 项通过。
- 新增测试覆盖：
  - `plan.test.ts` 使用 `finalRequestTokens`，raw transcript 很大但最终 token 低时跳过。
  - `transcript.test.ts` 水印内渲染 `[旧工具结果已清理]`，工具输入仍可见。
  - `compact.test.ts` 摘要 prompt 不包含被清理原始结果；overflow 重试仍使用水印。
  - `preparation.test.ts` 持久化水印与本轮新清理的 `prunedToolCallIds` 都端到端进入摘要，原始工具结果不出现。
- 真实 provider 长上下文与桌面 Conversation/Interview 实机验证尚未执行。
