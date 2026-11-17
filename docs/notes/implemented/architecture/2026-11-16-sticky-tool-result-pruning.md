# Note：旧工具结果清理结果跨轮保留

状态：已实施

后续变更：文件 store 已由 [SQLite 会话 transcript 存储](2026-11-17-sqlite-transcript-store.md) 替代；本文引用的 ileConversationStore.test.ts 已迁移为 sqliteConversationStore.test.ts，pruning 行为未变。

## 问题

长会话里的旧工具结果清理原先只作用于“本次请求的投影副本”，清理结果没有进入下一轮请求的基线：

- `ContextPreparation` 每轮都从 transcript 重新组装完整投影，压缩后 `rebuild()` 也会再次带回原始工具结果。
- `pruneOldToolResults` 只替换本次 `ContextModelRequest` 的 copy，不写回 transcript。
- `ContextState.pruning` 只保存最近一次清理反馈，不保存“哪些结果已经被清理”；原方案明确决定“不持久化清理水位”（[256k 上下文预算与旧工具结果清理](../../implemented/architecture/2026-11-13-context-budget-and-tool-result-clearing.md) §4.3、§8）。

后果是：一次清理把投影从约 384k 降到约 40k，下一轮又从 384k 开始，再次命中 `pruneAt = 172k`，重复清理同一批结果。CLI 实测连续每轮提示“已清理 57 个旧工具结果，节省约 345.2k token”：数量和节省量都是每轮重算，不是累计。

用户可观察的影响：

- 清理提示每轮重复出现，看起来像清理没有生效；
- 每轮都在重写模型投影前缀。即使清理集合不变，也持续产生状态写入和估算开销；当受保护的最近结果越过保护边界时，前缀会再次变化并产生缓存写入；
- “达到 172k 才清理”的语义失真：清理后模型侧只剩约 40k，下一轮本不该再次触发。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/pruning/prune.ts`：新增 `applyPrunedToolResults`、`mergePrunedToolCallIds` 与 `PRUNED_TOOL_CALL_ID_LIMIT`；`pruneOldToolResults` 返回本次替换的 `prunedToolCallIds`。
  - `apps/agent/src/core/context/preparation.ts`：请求前读取并套用水印，再估算和增量清理；重建后再次套用；一次写入 usage、清理反馈和水印。
  - `apps/agent/src/core/transcript/contextState.ts`：新增 `prunedToolCallIds?: readonly string[]`。
  - `apps/agent/src/core/transcript/persistence/fileSessionRecord.ts`：`contextStateSchema` 增加可选字段，并通过 `toFileContextState` 归一化只读数组。
  - `apps/agent/src/core/transcript/persistence/restore.ts`、`memoryStore.ts`：克隆水印数组，snapshot 投影不包含水印。
  - `apps/agent/test/core/context/pruning/prune.test.ts`、`preparation.test.ts`、`test/core/transcript/fileConversationStore.test.ts`：覆盖套用、合并、上限、跨轮基线、增量清理与文件往返。
- UI/进程/协议/持久化表面：
  - `ConversationSnapshot` 与 `@answra/shared` 字段不变，CLI 与桌面不需要改协议。
  - transcript 与历史会话仍保存完整工具输出，`/resume` 不重新拉取消息，用户仍能看到原文；只有模型投影使用占位符。
  - `ContextState` 仍是内存/SQLite 可替换端口后面的会话级状态，不新增独立文件或数据库表。
- 相关 Note：
  - [256k 上下文预算与旧工具结果清理](../../implemented/architecture/2026-11-13-context-budget-and-tool-result-clearing.md)
  - [会话上下文摘要压缩与旧上下文归档](../../proposed/architecture/2026-11-13-conversation-context-compaction-and-archive.md)
  - [provider 超限的单次反应式压缩](2026-11-14-provider-overflow-reactive-compaction.md)
  - [历史工具结果进入模型上下文](../bug-fix/2026-11-10-conversation-tool-results-history.md)
  - [可切换的内存与 SQLite 存储边界](../../proposed/architecture/2026-11-08-switchable-memory-sqlite-storage.md)

## 决定

### 1. 只持久化 toolCallId 水印

`ContextState.prunedToolCallIds` 保存被替换为占位符的 `toolCallId`，不保存工具输出正文，也不进入 `ConversationSnapshot` 或 shared UI DTO。`clear(conversationId)` 清空 `contextState` 时水印一并失效。

水印按清理顺序追加，超过 `PRUNED_TOOL_CALL_ID_LIMIT`（2,000）时丢弃最旧 ID。丢弃后旧结果若仍在投影中，后续批次可能再次清理它；只会多一次前缀变化，不产生错误状态。

### 2. 请求前先套用水印，再做估算和清理

`ContextPreparation.prepare()` 的顺序变为：

```text
loadContextState
  -> definition.prepare() 生成 draft 投影
  -> 套用水印：把 toolCallId 命中的 tool-result 替换为 [旧工具结果已清理]
  -> 用 usage 锚点估算套用后的投影
  -> 估算 >= pruneAt：只对未清理结果做旧→新的增量清理
       -> 净节省 >= minPruneSaving 才应用
       -> 合并本次新清理的 ID 到水印
  -> 估算 >= compactAt：摘要压缩
       -> rebuild() 后再次套用水印，再按需增量清理
  -> 硬兜底裁剪
  -> 一次 saveContextState 写入 usage、pruning 反馈和水印
```

关键语义：

- 套用水印只改 `tool-result.output`，不改 `tool-call`、`toolCallId`、`toolName`，不删消息、不重排消息，保持 tool-call/result 配对。
- 增量清理的候选集合排除已经是占位符的结果，仍保护最近 5 个可清结果和最近 12 条消息。
- `prunedCount` 与 `savedTokens` 只统计本次新增清理，不累计历史水印。一次清理只提示一次；下一轮没有新增清理时不写 `pruning` 状态，现有“下一次请求未清理时清除”的 UI 语义保持不变。
- 估算始终基于“套用水印之后”的投影，因此清理后约 40k 的占用是下一轮的真实起点；只有新内容把上下文重新推过 172k 才会再次清理，天然满足 `minPruneSaving = 132k` 的批处理门槛。
- 清理发生在请求发出前并立即持久化。即使本轮 run 失败或中断，水印也保留：它记录的是“已经发出去的投影”，不是“成功完成的事实”。
- 套用水印本身不计入 `projectionChanged`；只有新增清理、压缩或裁剪才使锚点失效，避免每轮都丢掉 usage 校准。

### 3. 压缩、裁剪与恢复路径

- 摘要压缩产生 checkpoint 后，重建投影会丢掉 checkpoint 之前的历史，其中可能包含水印里的 ID。套用时未命中的 ID 是无害的 no-op，不在同一请求里做反向垃圾回收。
- `trimContextRequest` 只裁剪最终投影，不修改水印；被裁掉的消息在后续请求中不再出现，对应 ID 自然失效。
- 手动 `/compact` 与 provider 超限恢复（`recoverContext`）走同一条 `prepare()` 路径，同样先套用水印，避免手动或恢复路径把旧结果重新带回上下文。

### 4. 明确不做

- 不把占位符写回 transcript，不改变 UI 历史。
- 不保存工具结果正文副本，不引入 archive。
- 不实现 provider 侧 cache_edits 或服务端 context editing；当前 OpenAI 兼容端点没有等价能力。
- 不新增用户开关，不改变 172k/40k/132k 预算值。
- 不把水印放进 shared schema 或 snapshot；它是 Agent 内部的模型投影状态。

## 模块边界

- `core/context/pruning/*` 保持纯函数：输入 `ContextModelRequest` 与 ID 集合，输出新请求、清理计数和节省量；不读写 store，不 import 领域代码。
- `core/context/preparation.ts` 是唯一读写水印的编排点：通过 `ContextStateStore` 加载与合并保存，不直接访问 transcript。
- `core/transcript/contextState.ts` 只扩展数据定义；`fileSessionRecord.ts` 只扩展持久化校验；两者都不包含清理策略。
- `memoryStore` 的 snapshot 投影不增加水印字段；CLI/桌面继续只消费 `contextUsage` 和 `contextPruning`。
- 水印与 transcript 分离，保证“用户看到的原文”和“模型看到的投影”仍是两份，且各自只有单一写入者。

## 曾考虑的替代方案

- **保持每轮从 transcript 重算（原实现）：** 实现最简单，但清理永远不进入下一轮基线，会重复清理同一批结果、重复提示，并持续改写投影前缀；与要解决的用户问题直接冲突，因此舍弃。
- **把占位符直接写回 transcript：** 能让清理天然跨轮生效，但 UI 历史、`/resume` 和后续其他 Bot 都会永久失去原始工具输出，且不可逆；违反“清理只改模型投影、不改 transcript”的既有边界，舍弃。
- **只保存一个单调游标（例如已清理到第 N 条消息）而不存 ID：** 消息会被 checkpoint、trim 和投影过滤改变位置，下标会漂移；ID 在 transcript 中稳定且不会被复用，因此舍弃游标方案。
- **把水印放进 `ConversationSnapshot` 或 shared schema：** 会让内部投影状态进入 IPC 和 UI 契约，增加跨端迁移成本，UI 又不需要读取具体 ID；舍弃。
- **改用服务端 `cache_edits` / provider 原生 context editing：** 能同时解决缓存失效，但 Answra 当前走 OpenAI 兼容端点，没有等价能力；等 provider 提供后另立 Note，不在本次预埋第二套缓存协议。
- **改成按时间触发（Claude Code 冷缓存路径）：** 依赖 1 小时级缓存 TTL 语义，Answra 没有同等假设；继续按 token 阈值触发。

## 后果与防回退

- **提示只在批次发生时出现：** 清理后的下一轮从已清理投影开始，通常低于 `pruneAt`，不会写 `pruning` 状态；这修复了每轮重复提示的根因。
- **缓存收益仍需实测：** 本决定消除“每轮重复改前缀”，但第一批清理本身仍会改变前缀并产生一次缓存写入；不能承诺零缓存影响，必须以真实 usage 和缓存指标验收。
- **run 失败保留水印：** 这是有意行为；下次请求继续使用已清理投影即可，不回滚成“每轮重清”。
- **多 Bot 会话：** 水印按会话保存，不看 viewer；某个 Bot 看不到的消息对应 ID 在它的投影中是 no-op。代价是集合会包含其他 Bot 的条目，靠上限收敛。
- **旧结果可能被再次清理：** 超过上限丢弃旧 ID 或 checkpoint 移走消息后，同一内容可能再次进入清理；只会多一次前缀变化，不会破坏配对或丢失用户可见内容。
- **状态迁移：** 新字段是可选字段，旧会话文件可读；未来 SQLite adapter 把它当普通 `ContextState` 字段处理。
- **防回退约束：** 不要把占位符写进 transcript，不要把水印暴露到 snapshot/shared，不要改回游标或每轮无水位重算；若引入 provider 缓存编辑，必须另立 Note 并保留本水印作为冷缓存基线。
- **与原 Note 的关系：** 本决定推翻 [256k 上下文预算与旧工具结果清理](../../implemented/architecture/2026-11-13-context-budget-and-tool-result-clearing.md) 中“不持久化清理水位”的规则，该 Note 已加交叉引用。

## 验证

- 自动化验证：
  - `pnpm --filter @answra/agent exec vitest run test/core/context/pruning/prune.test.ts test/core/context/preparation.test.ts test/core/transcript/fileConversationStore.test.ts`：44 tests passed，覆盖套用 ID、幂等、非文本输出跳过、合并去重与上限、跨轮不重复清理、增量清理、文件往返。
  - `pnpm --filter @answra/agent typecheck`：通过。
  - `pnpm --filter @answra/agent test`：573 tests passed，覆盖全包回归。
- 待实机验证：
  - CLI 长会话连续多轮观察：清理提示只出现一次、`ctx` 状态保持约 40k 并随新消息增长、`/resume` 后历史完整；
  - 桌面 Conversation 同一路径验证；
  - 记录清理前后的 `usage.inputTokens`，确认后续轮次复用已清理前缀；缓存收益需要真实 provider 指标，不能只看估算。
