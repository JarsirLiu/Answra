# Note：256k 上下文预算与旧工具结果清理

状态：提案

## 问题

提案前自动压缩使用固定预算：`triggerTokens: 96_000`、保留最近 12 条消息、至少摘要 4 条（原 `apps/agent/src/core/context/compaction/profile.ts`）。这个数字只计算“最新 checkpoint 摘要 + checkpoint 之后的消息”（`apps/agent/src/core/context/compaction/plan.ts`），不包含 system prompt、工具 schema、当前请求文本和当前请求图片，也不代表模型的总上下文窗口。

同时，当前 token 估算和真实模型投影不一致（`apps/agent/src/core/context/tokenEstimate.ts:19`）：

- assistant 消息同时计算 `text` 和 `parts`，但真实投影有 `parts` 时只使用 `parts`；
- 工具结果同时计算 `output` 和 `errorText`，但投影只按状态取一个；
- 工具输入同时计算 `inputText` 和 `input`，但投影只使用 `input`；
- streaming 消息被计入，但 `projectConversationMessages` 会过滤掉；
- 图片固定按 1024 token/张，当前请求的图片没有进入压缩预算；
- 摘要渲染不包含 `message.images`，压缩后旧图片会从模型上下文中消失。

用户对当前行为不满意的核心不是“压缩算法不够复杂”，而是：256k 窗口没有明确设置；触发点、保留量、图片和工具结果如何计入没有可见规则；实现里出现了“待处理消息”这类用户没有要求过的内部概念；自动行为缺少开关和可解释的上下文占用。

Conversation 和 Coding 的长会话还会积累大量旧的 `read`、`grep`、`glob` 等工具结果。旧结果即使不再需要，仍作为完整文本进入模型投影，造成不必要的输入 token、缓存写入和费用。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/budget.ts`（新增）：上下文窗口、输出预留、固定开销、触发阈值和硬上限的纯计算。
  - `apps/agent/src/core/context/pruning/policy.ts`（新增）：可清理工具名、最近结果/消息保护条数和默认策略。
  - `apps/agent/src/core/context/pruning/prune.ts`（新增）：旧工具结果候选识别、占位替换、节省量计算。
  - `apps/agent/src/core/tool/toolNames.ts`（新增）：内置工具对模型暴露的固定名称，供工具定义与清理策略共用。
  - `apps/agent/src/core/context/preparation.ts`：按“估算 -> 清理 -> 压缩 -> 重建 -> 再清理 -> 兜底裁剪”的顺序编排。
  - `apps/agent/src/core/context/tokenEstimate.ts`：从原始 transcript 估算改为估算最终 `ModelMessage[]`、system、tools 和当前请求图片。
  - `apps/agent/src/core/context/compaction/*`：继续只负责摘要压缩，不接管工具结果清理。
  - `apps/agent/src/core/transcript/contextState.ts`：保存可选的 usage 锚点；不保存清理状态，也不保存工具结果正文副本。
  - `apps/agent/src/conversation/application.ts`、`apps/agent/src/coding/application.ts`、`apps/agent/src/interview/application.ts`：在 `definition.prepare()` 生成 draft 后、发送前把最终模型请求交给 `ContextPreparation`；需要重建时通过回调重新组装。
  - `packages/shared/src/schema/`：只在需要 UI 展示时增加上下文占用/清理状态 DTO；预算公式和清理策略不进入 shared。
  - `packages/config/src/`、云端模型能力端点：保存或下发非 secret 的 `contextWindow`、`maxOutputTokens`、可选的图片估算规则。
  - `apps/desktop/src/main/`、`apps/cli/src/`：模型能力配置、自动压缩/自动清理开关、上下文占用展示。
- UI/进程/协议/持久化表面：
  - 桌面和 CLI 显示“当前上下文 / 上限 / 触发点 / 清理阈值”，不显示“待处理消息”。
  - 工具结果清理只改变模型投影，不删除 transcript、不改 UI 历史。
  - 本提案不新增磁盘持久化、不实现 archive、不实现服务端 cache editing。
- 相关 Note：
  - [会话上下文摘要压缩与旧上下文归档](2026-11-13-conversation-context-compaction-and-archive.md)
  - [历史工具结果进入模型上下文](../../implemented/bug-fix/2026-11-10-conversation-tool-results-history.md)
  - [后端会话与内存仓储](../../implemented/architecture/2026-10-12-conversation-memory-store-port.md)
  - [可切换的内存与 SQLite 存储边界](2026-11-08-switchable-memory-sqlite-storage.md)
  - [产品方向与 Agent 底座](2026-10-20-product-direction-and-agent-foundation.md)

## 提案

### 1. 产品规则：只暴露用户能理解的控制面

- 最大上下文固定为 `256_000`，但来源必须是模型能力字段或本地模型配置，不能按模型名猜。
- 自动摘要压缩和自动工具结果清理分别是两个开关。
- 自动清理旧工具结果的触发上下文是 `172_000`，清理后目标上下文是 `40_000`；两者都显示在控制面中，不能只藏在代码默认值里。
- 主界面只展示“当前占用 / 上限 / 摘要触发点 / 清理触发点”，内部保留量、最少摘要条数等放在高级设置。
- 删除“待处理消息”这一用户概念。代码内部可以继续叫 `messagesAfterCheckpoint`，Note、UI 和错误文案中不得把它包装成用户需要理解的新对象。
- 压缩状态继续沿用现有 `started` / `succeeded` / `failed`，不展示摘要正文；工具结果清理有独立状态，不塞进压缩状态机。

### 2. 预算公式与初始值

预算是一个纯函数，输入模型能力、固定开销和投影后的上下文，输出阈值。建议初始值：

| 参数 | 初始值 | 含义 |
| --- | ---: | --- |
| `contextWindow` | 256,000 | 模型总窗口，包含输入和输出 |
| `maxOutputTokens` | 20,000 | 正常回答和推理的输出预留 |
| `safetyTokens` | 12,000 | 估算误差、协议开销和 tokenizer 差异 |
| `fixedOverheadTokens` | 8,000 起 | system prompt、工具 schema、时间提醒等；用真实 usage 校准 |
| `compactionBuffer` | 40,000 | 最大上下文到摘要压缩触发点的缓冲 |
| `inputLimit` | 216,000 | 允许进入模型的历史 + 当前请求上限 |
| `compactAt` | 216,000 | 触发摘要压缩 |
| `pruneAt` | 172,000 | 触发旧工具结果清理 |
| `pruneTarget` | 40,000 | 清理后希望达到的目标上下文 |
| `minPruneSaving` | 132,000 | 净节省不足该值就不应用清理 |
| `retainRecentToolResults` | 5 | 最近 5 个可清理工具结果保持原样 |
| `postCompactTarget` | 120,000 | 摘要压缩后的软目标，留出再次增长空间 |

公式固定为：

```text
compactionBuffer = maxOutputTokens + safetyTokens + fixedOverheadTokens
inputLimit       = contextWindow - compactionBuffer
compactAt        = min(contextWindow - config.compactionBuffer, inputLimit)
pruneAt          = config.pruneAt
```

初始值下 `compactionBuffer = 40k`，`inputLimit = 216k`，`compactAt = 216k`。摘要压缩触发点就是“最大上下文 - 40k 缓冲”，不再额外设置 hysteresis；压缩在请求发出前执行，所以 216k 是压缩检查点，不是允许发送的普通请求上限。如果实际测量固定开销是 16k，`compactionBuffer` 变为 48k，`inputLimit` 自动降到 208k，`compactAt` 也随之降到 208k，不能继续写死 216k。

`pruneAt`、`pruneTarget` 和 `minPruneSaving` 的关系固定为：

```text
pruneAt - pruneTarget = minPruneSaving
172k - 40k = 132k
```

这与 Claude Code 的 `trigger` / `target` / `clear_at_least` 是同一类预算模型：本产品取 `trigger=172k`、`target=40k`、`clear_at_least=132k`。当前本地 Claude Code 源码的 API 策略默认值是 `180k/40k/140k`，结构相同，数字按本产品 256k 窗口重新取。本提案采用该结构，但不照搬其内部缓存编辑实现。

### 3. 估算对象必须是真实模型投影

预算不能继续估算原始 `ConversationMessage[]`。`ContextBudget` 应接收最终请求形状：

```ts
interface AgentModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
}
```

估算顺序：

1. 用 `definition.prepare()` 生成真实 `AgentModelRequest`；`beginRun` 后的当前请求已经进入消息尾部。
2. 计算 system、工具 schema、消息和图片；当前请求不再单独加一次。
3. 图片默认按 2,000 token/张起步，后续按 provider 规则和分辨率校准；不能再沿用固定 1,024 且不区分截图大小。
4. 首版先做保守全量估算；后续再用上一轮成功 run 的 `usage.inputTokens` 作为锚点校准。
5. 压缩或工具清理改变投影后，立即丢弃 usage 锚点，重新全量估算。

`usage.inputTokens` 是校准依据，不是压缩触发前的唯一来源；provider 不返回 usage 时允许只用保守估算。

### 4. 旧工具结果清理

清理只修改本次模型投影。摘要压缩前清理一次，用于尽量避开摘要；如果仍触发摘要并 `rebuild()`，必须在重建后再清理一次，否则重建会把完整工具结果重新带回投影。

#### 4.1 可清理范围

- 首版处理模型工具名 `Read`、`Grep`、`RunCommand`（内部 ToolId 分别是 `workspace.read`、`workspace.grep`、`workspace.run-command`）。清理读取的是 `ModelMessage.toolName`，不能用 ToolId 匹配；名称常量统一放在 `core/tool/toolNames.ts`，工具定义和清理策略共用，默认名单集中在一处。
- 只处理 `ModelMessage` 中 `tool-result` 的文本输出。当前投影把 completed/failed/denied/interrupted 都投影成 `text`，所以首版按 `text` 输出处理；其他 `output.type` 先跳过，避免误改结构。
- `RunCommand` 必须纳入：Claude Code 的本地微压缩和 API 工具清理都包含 `Bash`/`PowerShell` 结果（`COMPACTABLE_TOOLS`、`TOOLS_CLEARABLE_RESULTS` 均展开 `SHELL_TOOL_NAMES`），而 shell 输出通常是最大的旧结果来源。清的是模型投影，不是命令执行记录。
- 首版不处理 `Edit`、`WriteStdin`：编辑类结果的事实价值高，`WriteStdin` 是交互会话轮询，先不扩大范围。
- 最近 5 个可清理工具结果和最近 12 条模型消息不参与清理。当前请求在消息尾部，因此天然受最近消息保护。
- 不按输出哈希、不判重。Claude Code 的本地微压缩也是按工具名和顺序清旧结果，不按重复输出清。
- 失败/拒绝/中断结果不单独保护。它们在 transcript 和 UI 中仍有真实状态；模型侧只看到“已清理”占位。若后续要保护，必须从 transcript 传入状态，不在最终 `ModelMessage` 上猜。

#### 4.2 选择算法

1. 扫描最终 `ModelMessage[]`，按出现顺序收集命中白名单的 `tool-result`。
2. 最近 5 个可清理结果标记为 protected。
3. 最近 12 条模型消息内的所有结果也标记为 protected。
4. 其余候选从旧到新逐个替换 `tool-result.output`，直到估算降到 `pruneTarget` 或候选耗尽。
5. 只替换结果输出，不改 `tool-call`、`toolCallId`、`toolName`，不删消息、不重排消息；tool-call/result 配对保持完整。
6. 占位文本为 `[旧工具结果已清理]`。已经是占位文本的结果跳过，保证重复执行幂等。
7. 实现为 `pruning/prune.ts` 的纯函数，不持有 store、不调用模型、不 import 工具实现；工具名常量来自 `core/tool/toolNames.ts` 的叶子模块，避免把 fs/shell 代码拖进 context。

#### 4.3 节省量门槛

节省量按替换前后的真实投影计算，并自然扣除占位文本成本：

```text
saved = estimate(original request) - estimate(cleared request)
```

只有同时满足以下条件才应用：

```text
currentInputTokens >= 172_000
saved >= 132_000
```

`132_000` 是净节省门槛，不是“扫描到了多少旧内容”。低于门槛时返回原请求，不修改投影，也不写 `ContextState`。首版不持久化“清理尝试水位”：扫描是 O(messages) 的纯计算，状态会引入失效和迁移成本；等有真实遥测需求再另立 Note。

#### 4.4 缓存与批处理

替换旧结果会改变 prompt 前缀。Answra 当前走 OpenAI 兼容端点，不能假设存在 Claude Code 那种 cache editing API，因此：

- 清理必须一次性批量执行，不能每轮做小幅替换。
- 在 172k 触发且净节省达到 132k 时接受一次前缀变化和可能的 cache miss。
- 如果 provider 后续支持 cache editing，另立 Note，不在本提案中预埋第二套缓存协议。
- 132k 门槛首版按 token 计算；缓存成本作为风险记录，后续用真实 usage 和 provider 价格校准。
- 清理结果不写 transcript、不改变 UI 历史；下一次请求重新按最终投影判断。

### 5. 编排顺序

`ContextPreparation` 在 `prepareRun` / `beginRun` 之后、模型请求发送前执行：

```text
definition.prepare()
  -> draft AgentModelRequest
  -> 估算 system + tools + messages（当前请求已在尾部）
  -> >= 172k：选择并清理最旧工具结果（第二阶段）
       -> 净节省 >= 132k：应用投影替换，重新估算
  -> >= compactAt：调用现有摘要压缩
       -> 检查点变化后重新 definition.prepare()
       -> 重建后仍 >= 172k：再次清理旧工具结果（防止 rebuild 还原）
       -> 净节省 >= 132k：应用第二次投影替换
  -> 仍 >= inputLimit：裁剪最旧完整轮次/工具对
  -> 当前请求本身超过 inputLimit：明确报错，不发送
  -> streamText()
```

工具结果清理不需要模型调用；摘要压缩继续由现有 `ContextCompactor` 执行。两者失败都不能静默让请求超过窗口。

### 6. 与现有摘要压缩的关系

- `ContextCompactor` 只负责 checkpoint 和摘要；预算、触发点、重建和硬兜底由 `ContextPreparation` 负责。
- `ContextPreparation` 是唯一编排入口；领域 application 只传最终 draft、`rebuild` 回调和 conversation id。
- 压缩发生在 `beginRun` 之后；当前用户消息已在 snapshot 尾部，按保留策略不参与摘要。
- 压缩后上下文应回到 `postCompactTarget` 附近；如果摘要 + 保留尾段仍超过 `inputLimit`，进入确定性裁剪。
- 摘要渲染必须补充图片处理：至少保留图片名称/描述，或把原图保留到 archive；不能像当前 `renderMessagesForSummary` 一样直接忽略。

### 7. 控制面与可观察性

- 桌面模型设置增加“自动压缩”“自动清理旧工具结果”以及只读的 256k 窗口展示。
- CLI 增加等价的设置展示和状态行，不新增第二套模型配置来源。
- 上下文明细至少包含：system/tools 固定开销、历史消息、当前请求、图片、压缩 buffer、剩余空间。
- 工具清理完成后显示“已清理 N 个旧工具结果，节省 X token”；低于 132k 不显示“已完成”，只记录跳过原因。
- 不把“待处理消息”“checkpoint 后消息”等内部词放到主界面。

### 8. 明确不做

- 不在首版做按时间间隔清理；清理只按 token 阈值和旧到新顺序触发，不按 60 分钟缓存过期。
- 不做输出哈希判重；只按工具名、顺序和 token 预算选择。
- 不清 assistant 文本、用户文本、最终回答或 thinking；只替换工具结果输出。
- 首版不清 `Edit`、`WriteStdin` 的结果；`RunCommand` 纳入白名单。
- 不为清理持久化尝试水位；每次从最终投影重新计算。
- 不删除 transcript、不改变 UI 历史、不做 archive。
- 不在当前请求或当前 run 的工具结果上做清理。
- 不承诺“零缓存影响”。
- 不按模型名猜窗口，不把阈值写死在 `profile.ts` 的默认常量里。
- 不向用户暴露新的中间状态概念。

### 9. 当前实现进度（2026-11-14）

第一阶段“让压缩看到最终模型请求”已落地：

- `budget.ts`、`tokenEstimate.ts`、`preparation.ts` 已新增；`CompactionProfile` 不再持有 `triggerTokens`。
- `AgentRunRequest.prepareContext` 在 `definition.prepare()` 之后执行；检查点变化后通过 `rebuild()` 重新组装请求。
- `ContextPreparation` 负责估算最终请求、调用 `ContextCompactor`、重建请求和硬兜底裁剪；当前请求本身超限时抛 `ContextLimitExceededError`。
- `ContextCompactor` 只接收 `triggerTokens`/`contextTokens`，不再持有预算或执行硬兜底。
- Conversation、Coding、Interview 已接入同一条 `prepareContext` 路径。
- 第二阶段已按 Claude Code 对照修订并落地：清理对象从“重复工具结果”改为“旧工具结果”，新增 `core/tool/toolNames.ts`、`core/context/pruning/policy.ts`、`core/context/pruning/prune.ts`；`ContextPreparation` 在压缩前和重建后各清理一次。不引入 `error-text`，不清 thinking，不持久化清理水位。
- 尚未实现：usage 锚点、自动压缩/清理开关、上下文占用展示、archive/SQLite。

## 模块边界

- `core/context/budget.ts`：纯预算公式、阈值和 usage 锚点校验；不读文件、不读 store、不 import 领域。
- `core/tool/toolNames.ts`：只放工具对模型暴露的固定名称；不 import 工具实现、registry 或平台模块。
- `core/context/pruning/policy.ts`：可清理工具名、最近结果/消息保护条数和默认策略；不承载 token 阈值。
- `core/context/pruning/prune.ts`：纯候选识别、受保护窗口计算、占位替换和净节省计算；不读 store、不调模型、不改 transcript。
- `core/context/preparation.ts`：编排预算、两阶段旧工具结果清理、压缩、重建和硬兜底；不实现摘要 prompt、不实现领域上下文装配。
- `core/context/tokenEstimate.ts`：只做估算；同时支持文本、工具结果、图片和模型消息形状。
- `core/context/compaction/*`：只做摘要、检查点和生命周期；不负责工具清理。
- `core/transcript/contextState.ts`：保存 checkpoint、压缩状态和可选 usage 锚点；不保存清理水位或工具结果副本。
- `core/transcript/projection.ts`、`core/context/projection.ts`：继续是模型消息投影的唯一入口；工具清理通过替换副本参与，不复制投影逻辑。
- `conversation/`、`coding/`、`interview/`：只提供 `ContextPolicy`/`CompactionProfile` 和当前请求，不实现第二套预算或清理。
- `packages/shared`：只提供 UI 需要的设置和状态 DTO；不包含阈值公式、prompt 或存储实现。
- `apps/desktop`、`apps/cli`：读写非 secret 设置、展示上下文占用；不决定清理边界。

## 曾考虑的替代方案

- **继续使用固定 96k：** 舍弃。它既不是 256k 窗口的预算，也不包含 system、工具和当前请求；继续保留会把“实现默认值”伪装成产品规则。
- **直接照 Claude Code 的 223k 自动压缩：** 暂不采用。按 Claude Code 公式套 256k 约为 223k；本提案按“最大上下文 - 40k 缓冲”取 216k，低于 223k，后续用真实 usage 校准后再决定是否上调。
- **只做摘要压缩，不清工具结果：** 舍弃。旧的 `read`/`grep` 结果会在摘要前持续占用输入和缓存，先清理更便宜，也可能避免一次摘要模型调用。
- **按时间/数量清理所有旧工具结果（Claude Code 风格）：** 不做时间触发。Answra 没有 Claude Code 的 1 小时缓存 TTL 语义，按 token 阈值和旧到新顺序清理更可解释。
- **只清重复工具结果：** 舍弃。需要输出哈希和失败状态保护，且 Claude Code 的本地方案不是按重复清理；唯一旧结果仍会继续占用上下文。
- **首版排除 `RunCommand`：** 舍弃。Claude Code 的 `COMPACTABLE_TOOLS` 明确包含 `Bash`/`PowerShell`，shell 往往一次就产生几万 token；排除它会让 132k 门槛经常无法达到。风险是旧 exit code/stderr 在模型侧消失，但 transcript 仍保留，且最近 5 个结果受保护。
- **把失败结果先编码成 `error-text` 再清理：** 舍弃。这个前提只属于“重复判定”方案；改为按工具名和顺序清旧结果后，不需要在最终 `ModelMessage` 上恢复状态。
- **清理 thinking/推理内容：** 舍弃。thinking 签名和回传要求依模型而定，乱删可能 400 或降低质量；需要时另立 provider 能力 Note。
- **持久化清理尝试水位：** 暂不做。扫描是低成本纯计算，持久化状态会引入失效与迁移；先观察真实遥测再评估。
- **直接修改 transcript 的 tool result：** 舍弃。UI 历史、审计和后续 archive 会丢失原始结果；只改模型投影。
- **使用 provider 原生 `clear_tool_uses`：** 暂不采用。当前 OpenAI 兼容端点无法保证支持 Anthropic 风格的 context management；先做本地投影，后续按 provider 能力单独接入。
- **每次超过 172k 就清理，不设 132k 门槛：** 舍弃。会产生频繁前缀变化和 cache miss，也可能只清掉少量 token；132k 净节省是批处理门槛。
- **只依赖上一轮 `usage.inputTokens`，不做估算：** 舍弃。当前请求在压缩前还未发送，第一轮也没有 usage；必须保留保守估算路径。
- **把“待处理消息”作为产品概念展示：** 舍弃。它是实现内部的 `messagesAfterCheckpoint`，不应成为用户心智模型。

## 验收标准

- 可观察结果：
  - 模型能力配置为 256k 时，预算显示 `compactionBuffer=40k`、`inputLimit=216k`、`compactAt=216k`、`pruneAt=172k`、`pruneTarget=40k`；固定开销变化时，`compactAt` 自动下降。
  - 当前请求的文本和图片进入预算，但不会被摘要或清理。
  - 172k 触发时，按旧到新清理 `Read`/`Grep`/`RunCommand` 结果；保留最近 5 个可清理结果和最近 12 条模型消息；净节省不足 132k 时投影不变。
  - 不清理 `Edit`、`WriteStdin` 等非白名单结果，不清 assistant 文本、用户文本或 thinking。
  - 工具结果清理后 transcript 和 UI 历史不变，tool-call/tool-result 配对完整。
  - 自动清理开关、上下文占用和跳过原因属于后续控制面，本阶段只交付 core 行为。
- 自动化验证：
  - 预算公式覆盖 256k、固定开销变化、输出预留变化和硬上限。
  - 估算覆盖 system、tools、assistant parts、工具状态、图片、当前请求，证明不再重复计数。
  - 工具清理覆盖最旧优先、白名单、最近结果保护、最近消息保护、占位文本净节省、131,999/132,000 边界、幂等和失败结果仅替换模型侧文本。
  - 编排覆盖“清理后低于压缩线”“清理后仍需压缩”“压缩重建后再次清理”“压缩失败回退”“硬上限裁剪/报错”。
  - 工具名常量覆盖内置 registry 中存在 `Read`/`Grep`/`RunCommand`，防止白名单拼写漂移。
  - `pnpm notes:check`、`pnpm verify`。
- 需要的实机验证：
  - 桌面 Conversation 和 CLI Coding 各跑一轮超过 172k、包含大量旧 `read`/`grep` 结果的长会话，确认清理后继续工作正常。
  - 真实 provider 的 usage 缺失、图片输入、压缩取消和缓存 miss 场景。
  - 16k 固定开销和 20k 输出预留下的阈值校准。

## 风险

- 132k 门槛可能长期不触发，导致旧工具结果清理没有实际收益；不应用时直接进入摘要压缩，后续按模型/领域调整。
- 清理会丢失旧失败结果在模型侧的可见性；transcript 和 UI 仍保留真实状态，模型可能重试已失败的调用。`RunCommand` 的 exit code/stderr 也会被占位，最近 5 个结果除外。
- 清理会改变 prompt 前缀并可能造成一次 cache miss；如果 provider 的缓存折扣很高，132k token 节省不一定等于成本节省，需要后续按真实价格校准。
- `compactAt` 与 `inputLimit` 重合，触发点没有额外余量，安全裕量完全依赖 12k `safetyTokens`；估算误差超过该值时必须由硬兜底裁剪接管，不能继续发送。
- 固定开销和图片估算仍可能偏差；256k 窗口的 provider 语义（总窗口还是输入窗口）必须确认，不能假设所有模型一致。
- 当前 store 仍是进程内实现，usage 锚点重启后会丢失；这不影响本提案的输入预算，但不能宣称持久恢复。
- 摘要渲染目前忽略图片；如果不在本提案中补图片描述或 archive，压缩仍可能丢失旧图片信息。
- 工具结果可能包含敏感内容；清理只减少模型输入，不减少 transcript 存储或审计面，存储清理仍需独立 Note。
- 预算和清理横跨 Agent、desktop、CLI 和模型能力配置；如果各宿主各自维护默认值，会重新出现“不由用户控制”的漂移。
- 清理策略仍可能误删模型当时需要的事实；首版通过只读白名单、最近 5 个结果和最近 12 条消息降低风险，但不能证明对所有任务无损。
