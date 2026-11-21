# Note：摘要输入从最近检查点开始且不再预截断工具内容

状态：已实施

## 问题

摘要压缩在渲染 transcript 时，对工具输入和结果做固定截断：工具结果最多 2,000 字符、工具输入最多 1,000 字符、所有工具片段合计最多 40,000 字符。摘要提示词同时要求保留路径、命令、错误原文和验证结论，但这些事实可能已经被渲染层提前截掉，两者自相矛盾。

Codex 的本地压缩直接使用完整历史加摘要提示词，只在 provider 报 `ContextWindowExceeded` 时逐条移除最旧历史项并重试；Answra 已有检查点边界和 overflow 兜底，不需要在发请求前猜哪些内容会被摘要模型需要。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/compaction/transcript.ts`：删除工具输入/结果的单项和总量截断，完整渲染工具内容。
  - `apps/agent/src/core/context/compaction/compact.ts`：摘要请求超限时逐条丢弃最旧消息，不再按整轮丢弃，也不设固定 3 次重试上限。
  - `apps/agent/src/core/context/compaction/prompt.ts`：改为“优先保留 / 可以省略”的摘要指令，补敏感值约束，移除“输入经过截断”的描述。
  - `apps/agent/src/core/context/projection.ts`：摘要注入前缀提示模型避免重复工作、需要时重新读取或验证。
  - `apps/agent/test/core/context/transcript.test.ts`、`compact.test.ts`、`projection.test.ts`：覆盖完整工具内容、逐条溢出丢弃和摘要注入前缀。
- UI/进程/协议/持久化表面：不变。transcript、检查点 schema、`ContextUsage` 和 worker/IPC 协议都不改；只改变摘要模型看到的 prompt。
- 相关 Note：
  - [上下文压缩只保留摘要与当前用户回合，工具结果进入摘要输入](../architecture/2026-11-17-context-compaction-user-turn-retention.md)
  - [256k 上下文预算与旧工具结果清理](../architecture/2026-11-13-context-budget-and-tool-result-clearing.md)
  - [压缩路径取消“最近工具结果”保护](./2026-11-20-compaction-clears-all-tool-results.md)
  - [摘要压缩共享清理后的上下文视图](../architecture/2026-11-21-compaction-shares-pruned-context-view.md)
  - [压缩成功后刷新上下文用量](../bug-fix/2026-11-20-refresh-context-usage-after-compaction.md)

## 决定

### 1. 从最近检查点开始

- `latestCheckpoint(state)` 取最后一条摘要。
- `messagesAfterCheckpoint(messages, checkpoint)` 只取检查点之后的消息。
- 摘要输入 = `previousSummary` + 检查点之后、保留边界之前的消息。
- 自动压缩保留当前用户回合，手动压缩只留摘要；两种情况都不重新摘要检查点之前的内容。
- 检查点引用的消息不存在时继续 `checkpoint-invalid` 跳过，不回退到全量历史。

### 2. 无损渲染

- 删除 `TOOL_RESULT_MAX_CHARS`、`TOOL_INPUT_MAX_CHARS`、`TOOL_SECTION_MAX_CHARS`。
- 删除 `truncateToolText()`、`capToolSections()`、`[已截断]`、`[更早工具结果未进入摘要]`。
- 未被清理的工具输入和结果原样进入摘要 prompt；已应用到最终模型请求的旧工具结果必须按同一 `prunedToolCallIds` 水印渲染为 `[旧工具结果已清理]`，见[摘要压缩共享清理后的上下文视图](../architecture/2026-11-21-compaction-shares-pruned-context-view.md)。
- 继续排除 reasoning、图片二进制和重复 text parts；图片只保留文件名与 media type。
- 保留“渲染成文本”这一步：`SummaryGenerator` 接的是 prompt 字符串，序列化不等于有损预处理。

### 3. 溢出逐条退让

- 删除固定 `MAX_SUMMARY_OVERFLOW_RETRIES = 3`。
- 摘要请求报上下文超限时，每次丢弃最旧一条消息，`omittedMessages` 加一，然后重试。
- 每次至少少一条消息，循环天然收敛；只剩一条仍超限时抛出原错误。
- 非 overflow 错误不重试。
- 摘要输出预算 `summaryMaxTokens` 和二次缩短保留；这是控制输出大小，不是压缩前预处理输入。

### 4. 摘要提示词

- 优先保留：当前目标、用户约束、已确认决定、未完成事项与下一步；文件路径、命令、错误原文、关键数字/版本、验证结论；影响判断的风险。
- 可以省略：寒暄、重复解释、与结论无关的探索过程、大段工具输出和代码。
- 工具结果只留结论和必要的路径/命令/错误原文。
- 禁止编造；不确定内容标注为不确定；不输出 API Key、令牌、密码等敏感值，必须提及时用占位符。
- 六个标题保留，没有内容的标题可省略。
- 摘要注入前缀改为：“以下是之前会话的摘要。基于摘要继续，不要重复已完成的工作；需要时重新读取文件或验证，不要臆测摘要未包含的细节。”

## 移除内容

- 工具结果 2,000 字符上限和头 1,200 / 尾 800 截断。
- 工具输入 1,000 字符上限和头 600 / 尾 400 截断。
- 所有工具片段合计 40,000 字符上限及从旧到新丢弃。
- 摘要请求超限时按“整轮”丢弃和固定 3 次重试上限。

## 重新引入条件

- 实测摘要请求经常超限，导致大量最旧消息被丢弃或压缩失败时，先考虑提高模型窗口、降低历史进入摘要的频率或调整压缩触发点。
- 单个工具输出独占窗口且逐条丢弃仍无法收敛时，再按 provider 或工具类型增加更粗的输入上限；不要恢复未经实测的 2,000 / 40,000 字符预截断。
- 若摘要 prompt 成本或延迟明显上升，优先减少摘要触发次数或缩小保留边界，不用预截断掩盖输入规模。

## 曾考虑的替代方案

- **保留现有 2k / 40k 预截断：** 舍弃。它会在模型看到前丢掉路径、命令、错误原文，而这些正是摘要提示词要求保留的事实。
- **只提高上限到 8k / 160k：** 舍弃。仍是拍脑袋的字符预算，不能保证覆盖关键输出，还会继续制造“提示词要求保留但输入已丢失”的矛盾。
- **保留整轮丢弃：** 舍弃。一个巨大工具结果可能连带丢掉整轮用户请求；逐条丢弃更接近 Codex 的 `remove_first_item()`。
- **保留固定 3 次重试：** 舍弃。大历史可能在 3 次后仍未收敛，直接失败；逐条丢弃到只剩一条再失败更可解释。
- **把 summary 改为结构化消息输入：** 暂不采用。`SummaryGenerator` 当前接 prompt 字符串，改动会扩大 core/context 与 AI SDK 的耦合；无损文本渲染已满足本次目标。

## 后果与防回退

- 摘要请求更大、更慢、更贵；这是换取事实完整性的有意代价。
- 摘要模型可能看到更多工具输出中的敏感内容；提示词只约束输出，不约束输入。需要输入侧脱敏时另立 Note。
- 单个巨大工具输出仍可能让摘要请求超限；此时只能逐条丢弃，最坏会丢掉大部分历史并标注不完整。
- 摘要输入必须继续从最近检查点开始；不得为了“看得更全”回退到每次重读全部 transcript。
- `renderMessagesForSummary` 不得重新引入按字符数截断工具输入/结果；需要控制大小时走预算或 provider 能力，不在渲染层静默丢事实。
- 已清理工具结果的“无损”边界是：未清理内容完整进入摘要；清理水印内的结果只保留占位符，不得恢复原文。
- overflow 必须逐条减少消息并收敛；不得恢复固定次数上限后直接失败。
- 摘要注入前缀必须保留“避免重复工作”和“需要时重新读取/验证”，否则模型容易在压缩后重复执行已完成操作。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/context/transcript.test.ts test/core/context/compact.test.ts test/core/context/projection.test.ts test/core/context/preparation.test.ts`：47 项通过。
- `transcript.test.ts`：超长工具结果完整保留、30 条大工具输出全部保留、不出现 `[已截断]` 或 `[更早工具结果未进入摘要]`。
- `compact.test.ts`：首次 overflow 只丢最旧一条并标注“已省略最早的 1 条消息”；持续 overflow 时逐条丢弃到只剩一条后失败。
- `projection.test.ts`：摘要前缀包含“不要重复已完成的工作”和“需要时重新读取文件或验证”。
- `compact.test.ts` 的检查点用例继续断言摘要 prompt 只包含上一条摘要和检查点后的新消息，不包含检查点前内容。
- `pnpm --filter @answra/agent typecheck`：通过。
