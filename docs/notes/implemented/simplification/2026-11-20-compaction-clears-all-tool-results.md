# Note：压缩路径取消“最近工具结果”保护

状态：已实施

## 问题

压缩路径在强制清理保留尾段时，额外保护最近 3 个可清结果和最近 1 条模型消息。用户认为压缩后的历史应由摘要承载，不需要在模型投影里保留原始工具结果；保护最近结果会让压缩后大小受最近工具输出影响，也违背“摘要输出关键工具结果”的预期。

这条保护最初是为 provider 超限恢复准备的：恢复发生在当前回合中途，当前回合的 assistant/tool 消息不在摘要输入范围内（自动压缩只摘要最后一条用户消息之前的内容），清掉最近结果可能让模型看不到刚执行的结果，从而重跑有副作用的命令或写入。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/preparation.ts`：压缩路径的 `compactToolResultPruning` 不再缩小保护数，而是直接归零。
  - `apps/agent/test/core/context/preparation.test.ts`：覆盖压缩尾段所有可清结果都被清理。
- UI/进程/协议/持久化表面：不改变 `ContextUsage`、压缩边界、transcript 或 IPC；只改变压缩后模型投影中的工具结果文本。
- 相关 Note：
  - [上下文压缩只保留摘要与当前用户回合，工具结果进入摘要输入](../architecture/2026-11-17-context-compaction-user-turn-retention.md)
  - [256k 上下文预算与旧工具结果清理](../architecture/2026-11-13-context-budget-and-tool-result-clearing.md)
  - [压缩成功后刷新上下文用量](../bug-fix/2026-11-20-refresh-context-usage-after-compaction.md)
  - [摘要输入从最近检查点开始且不再预截断工具内容](./2026-11-20-lossless-compaction-input.md)

## 影响表面

| 表面 | 变化 |
| --- | --- |
| 手动 `/compact` | 不变：摘要覆盖全部消息，模型投影只保留摘要 |
| 自动预压缩 | 不变：只保留摘要 + 当前用户消息，通常没有工具结果 |
| Provider 超限恢复 | 当前回合中白名单工具结果不再保留最近 3 个，按压缩目标从旧到新全部清理 |
| 普通请求前清理 | 不变：仍保护最近 5 个结果和最近 12 条消息，并保留 `minPruneSaving` 门槛 |
| 压缩后用量 | 可能比之前更低，因为保留尾段不再固定留下最近工具输出 |

## 移除内容

- 删除 `COMPACTION_PROTECTED_RECENT_RESULTS = 3` 与 `COMPACTION_PROTECTED_RECENT_MESSAGES = 1`。
- 压缩路径不再把用户配置的保护数裁剪到更小值，而是固定为 `protectedRecentResults: 0`、`protectedRecentMessages: 0`。
- 压缩路径仍只清理 `Read` / `Grep` / `RunCommand` 的文本结果，仍受 `postCompactTarget` 目标和清理水印约束；普通 prune 策略不变。

## 重新引入条件

- 实测出现因压缩清掉当前回合工具结果导致模型重复执行有副作用工具（如 `RunCommand`、写入类操作）时，再按工具类型重新引入保护，而不是恢复全局“最近 3 个”。
- 若重新引入，优先只保护有副作用的工具结果；只读的 `Read` / `Grep` 结果继续允许清理。

## 决定

- 压缩路径的工具结果清理不再保留任何“最近结果”豁免；从旧到新清理到 `postCompactTarget` 或候选耗尽。
- 关键工具事实由摘要承载：摘要输入包含完整工具调用/结果，提示词要求保留路径、命令、错误原文和验证结论。
- Provider 超限恢复接受“模型可能需要重新读取或重跑工具”的代价，以换取更小、更可预测的压缩后上下文。
- 普通请求前的清理规则不跟着放宽，避免频繁改写缓存前缀。

## 曾考虑的替代方案

- **保持最近 3 个结果保护：** 舍弃。它让压缩后大小依赖最近工具输出，且与“摘要承载关键结果”的产品预期不一致。
- **压缩时把当前回合也纳入摘要并全部丢弃：** 舍弃。当前用户请求和已经执行到一半的工具链会一起丢失，恢复后模型不知道要继续做什么，重跑风险更大。
- **只保护有副作用的工具结果：** 暂不采用。当前工具白名单只有 `Read` / `Grep` / `RunCommand`，其中 `RunCommand` 副作用不确定；先统一清理，等实测出现重跑问题再按工具细分。
- **只降低保护数到 1：** 舍弃。仍是全局按数量保护，不能解决“最近结果决定压缩后大小”的问题。

## 后果与防回退

- 压缩后模型投影中不再保证保留任何原始工具结果；摘要质量成为关键事实的唯一载体。
- 摘要输入必须继续包含完整工具调用与结果；移除 `renderMessagesForSummary` 中的工具渲染会让压缩丢失路径、命令和错误。
- Provider 超限恢复可能让模型重新读取文件或重跑命令；这是本次有意接受的代价。
- 普通请求前 prune 的保护数与门槛不得跟随压缩路径归零。
- 压缩路径仍必须合并清理水印，避免下一轮重复清理同一批结果。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/context/preparation.test.ts`：29 项通过。
- 新增用例构造 6 条可清工具结果，压缩路径断言 `prunedCount: 6` 且水印包含全部 6 个 `toolCallId`；旧的“最近 3 个”保护会留下 3 条，无法通过。
- `pnpm --filter @answra/agent typecheck`：通过。
