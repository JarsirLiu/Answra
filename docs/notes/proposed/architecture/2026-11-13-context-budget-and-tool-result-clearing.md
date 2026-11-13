# Note：256k 上下文预算与旧工具结果清理

状态：提案

## 问题

当前自动压缩使用固定预算：`triggerTokens: 96_000`、保留最近 12 条消息、至少摘要 4 条（`apps/agent/src/core/context/compaction/profile.ts:3`）。这个数字只计算“最新 checkpoint 摘要 + checkpoint 之后的消息”（`apps/agent/src/core/context/compaction/plan.ts:24`），不包含 system prompt、工具 schema、当前请求文本和当前请求图片，也不代表模型的总上下文窗口。

同时，当前 token 估算和真实模型投影不一致（`apps/agent/src/core/context/tokenEstimate.ts:19`）：

- assistant 消息同时计算 `text` 和 `parts`，但真实投影有 `parts` 时只使用 `parts`；
- 工具结果同时计算 `output` 和 `errorText`，但投影只按状态取一个；
- 工具输入同时计算 `inputText` 和 `input`，但投影只使用 `input`；
- streaming 消息被计入，但 `projectConversationMessages` 会过滤掉；
- 图片固定按 1024 token/张，当前请求的图片没有进入压缩预算；
- 摘要渲染不包含 `message.images`，压缩后旧图片会从模型上下文中消失。

用户对当前行为不满意的核心不是“压缩算法不够复杂”，而是：256k 窗口没有明确设置；触发点、保留量、图片和工具结果如何计入没有可见规则；实现里出现了“待处理消息”这类用户没有要求过的内部概念；自动行为缺少开关和可解释的上下文占用。

Conversation 和 Coding 的长会话还会积累大量重复的 `read`、`grep`、`glob` 等工具结果。旧结果仍作为完整文本进入模型投影，即使后续已有相同调用和相同输出，造成不必要的输入 token、缓存写入和费用。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/budget.ts`（新增）：上下文窗口、输出预留、固定开销、触发阈值和硬上限的纯计算。
  - `apps/agent/src/core/context/toolResults.ts`（新增）：重复工具结果识别、占位替换、节省量计算。
  - `apps/agent/src/core/context/prepare.ts`（新增）：按“估算 -> 清理 -> 压缩 -> 再估算 -> 兜底”的顺序编排。
  - `apps/agent/src/core/context/tokenEstimate.ts`：从原始 transcript 估算改为估算最终 `ModelMessage[]`、system、tools 和当前请求图片。
  - `apps/agent/src/core/context/compaction/*`：继续只负责摘要压缩，不接管工具结果清理。
  - `apps/agent/src/core/transcript/contextState.ts`：保存可选的 usage 锚点、清理尝试水位和清理遥测；不保存工具结果正文副本。
  - `apps/agent/src/conversation/application.ts`、`apps/agent/src/coding/application.ts`、`apps/agent/src/interview/application.ts`：在 `beginRun` 前把当前请求和上下文状态交给 `ContextPreparation`。
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
| `pruneAt` | 172,000 | 触发重复工具结果清理 |
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

这与 Claude Code 的 `trigger` / `target` / `clear_at_least` 是同一类预算模型：本产品取 `trigger=172k`、`target=40k`、`clear_at_least=132k`。本提案采用该结构，但不照搬其内部缓存编辑实现。

### 3. 估算对象必须是真实模型投影

预算不能继续估算原始 `ConversationMessage[]`。`ContextBudget` 应接收最终请求形状：

```ts
interface ContextBudgetInput {
  system: string;
  messages: ModelMessage[];
  tools?: Record<string, unknown>;
  pendingRequest: {
    text: string;
    images: readonly ConversationImage[];
  };
  usageAnchor?: ContextUsageAnchor;
}
```

估算顺序：

1. 用 `projectConversationMessages`、`projectContextMessages` 生成真实 `ModelMessage[]`。
2. 计算 system、工具 schema、消息、图片和当前请求的 token。
3. 图片默认按 2,000 token/张起步，后续按 provider 规则和分辨率校准；不能再沿用固定 1,024 且不区分截图大小。
4. 如果存在上一轮成功 run 的 `usage.inputTokens`，并且模型、system、tools 和投影指纹未变化，用 `usageAnchor + 新增消息估算` 作为基准；否则全量估算。
5. 压缩或工具清理改变投影后，立即丢弃 usage 锚点，重新全量估算。

`usage.inputTokens` 是校准依据，不是压缩触发前的唯一来源；provider 不返回 usage 时允许只用保守估算。

### 4. 重复工具结果清理

清理发生在摘要压缩之前，且只修改模型投影。

#### 4.1 可清理范围

- 只处理 `read`、`grep`、`glob`、`list`、`web.search`、`web.fetch` 等只读工具。
- 首版不处理 `shell`、`edit`、`write`，因为输出可能受时间、工作区状态和副作用影响；只读 shell 命令要单独白名单和命令分类后再评估。
- 最近 5 个可清理工具结果和最近 12 条消息不参与清理。
- 当前 run、当前用户请求、失败/拒绝/中断的工具结果不参与清理。

#### 4.2 重复判定

重复指纹由三部分组成：

```text
toolName + 规范化 input + output 内容哈希
```

同一个工具、同一个输入但输出不同，不视为重复；只按相同输入判定会错误清理“文件已变化后的旧读取”。保留最新一次结果作为 canonical，旧结果不删除 tool-call，只替换结果正文：

```text
[旧工具结果已清理：与 toolCallId=xxx 的相同调用结果重复，结果见该调用]
```

tool-call 与 tool-result 的配对必须保持完整，不能只删结果块，也不能让保留段以孤立 tool-result 开头。

#### 4.3 节省量门槛

节省量按真实投影文本计算，并扣除占位文本本身的成本：

```text
saved = sum(estimate(原工具结果) - estimate(占位文本))
```

只有同时满足以下条件才应用：

```text
currentInputTokens >= 172_000
saved >= 132_000
```

`132_000` 是净节省门槛，不是“发现了多少重复内容”。低于门槛时不修改投影、不记录为已清理，只记录一次尝试水位，避免每轮重复扫描。下一次尝试至少要等上下文再增长一段，或直接进入 216k 摘要压缩。

#### 4.4 缓存与批处理

替换旧结果会改变 prompt 前缀。Answra 当前走 OpenAI 兼容端点，不能假设存在 Claude Code 那种 cache editing API，因此：

- 清理必须批量执行，不能每轮做小幅替换。
- 在 172k 触发且净节省达到 132k 时接受一次前缀变化和可能的 cache miss。
- 如果 provider 后续支持 cache editing，另立 Note，不在本提案中预埋第二套缓存协议。
- 132k 门槛首版按 token 计算；缓存成本作为风险记录，后续用真实 usage 和 provider 价格校准。

### 5. 编排顺序

`ContextPreparation` 在 `beginRun` 前执行：

```text
读取 snapshot + context state + 当前请求
  -> 生成真实模型投影并估算
  -> >= 172k：计算重复工具结果
       -> 净节省 >= 132k：应用投影替换，重新估算
  -> >= compactAt：调用现有摘要压缩，重新估算
  -> 仍 >= inputLimit：裁剪最旧完整轮次/工具对
  -> 当前请求本身超过 inputLimit：明确报错，不发送
  -> 进入 beginRun
```

工具结果清理不需要模型调用；摘要压缩继续由现有 `ContextCompactor` 执行。两者失败都不能静默让请求超过窗口。

### 6. 与现有摘要压缩的关系

- `ContextCompactor` 继续只负责 checkpoint 和摘要，不吸收预算、工具清理或图片策略。
- `ContextPreparation` 是唯一编排入口；领域 application 只传 snapshot、context state、当前请求和 profile。
- 压缩仍然发生在当前用户消息写入 store 之前；当前请求只进入预算，不参与摘要。
- 压缩后上下文应回到 `postCompactTarget` 附近；如果摘要 + 保留尾段仍超过 `inputLimit`，进入确定性裁剪。
- 摘要渲染必须补充图片处理：至少保留图片名称/描述，或把原图保留到 archive；不能像当前 `renderMessagesForSummary` 一样直接忽略。

### 7. 控制面与可观察性

- 桌面模型设置增加“自动压缩”“自动清理旧工具结果”以及只读的 256k 窗口展示。
- CLI 增加等价的设置展示和状态行，不新增第二套模型配置来源。
- 上下文明细至少包含：system/tools 固定开销、历史消息、当前请求、图片、压缩 buffer、剩余空间。
- 工具清理完成后显示“已清理 N 个重复工具结果，节省 X token”；低于 132k 不显示“已完成”，只记录跳过原因。
- 不把“待处理消息”“checkpoint 后消息”等内部词放到主界面。

### 8. 明确不做

- 不在首版做按时间/数量清理所有旧工具结果；先做重复结果清理，避免误删唯一信息。
- 不删除 transcript、不改变 UI 历史、不做 archive。
- 不把重复判定简化为只看 `toolName + input`。
- 不在当前请求或当前 run 的工具结果上做清理。
- 不承诺“零缓存影响”。
- 不按模型名猜窗口，不把阈值写死在 `profile.ts` 的默认常量里。
- 不向用户暴露新的中间状态概念。

## 模块边界

- `core/context/budget.ts`：纯预算公式、阈值和 usage 锚点校验；不读文件、不读 store、不 import 领域。
- `core/context/toolResults.ts`：纯候选识别、指纹、占位替换和节省量计算；可清理工具清单由领域 profile 注入，core 不出现 `if (coding)`。
- `core/context/prepare.ts`：编排预算、清理、压缩和硬兜底；不实现摘要 prompt、不实现领域上下文装配。
- `core/context/tokenEstimate.ts`：只做估算；同时支持文本、工具结果、图片和模型消息形状。
- `core/context/compaction/*`：只做摘要、检查点和生命周期；不负责工具清理。
- `core/transcript/contextState.ts`：保存 checkpoint、压缩状态、可选 usage 锚点和清理尝试水位；不保存工具结果副本，不定义清理策略。
- `core/transcript/projection.ts`、`core/context/projection.ts`：继续是模型消息投影的唯一入口；工具清理通过替换副本参与，不复制投影逻辑。
- `conversation/`、`coding/`、`interview/`：只提供 `ContextPolicy`/`CompactionProfile` 和当前请求，不实现第二套预算或清理。
- `packages/shared`：只提供 UI 需要的设置和状态 DTO；不包含阈值公式、prompt 或存储实现。
- `apps/desktop`、`apps/cli`：读写非 secret 设置、展示上下文占用；不决定清理边界。

## 曾考虑的替代方案

- **继续使用固定 96k：** 舍弃。它既不是 256k 窗口的预算，也不包含 system、工具和当前请求；继续保留会把“实现默认值”伪装成产品规则。
- **直接照 Claude Code 的 223k 自动压缩：** 暂不采用。按 Claude Code 公式套 256k 约为 223k；本提案按“最大上下文 - 40k 缓冲”取 216k，低于 223k，后续用真实 usage 校准后再决定是否上调。
- **只做摘要压缩，不清工具结果：** 舍弃。重复的 `read`/`grep` 结果会在摘要前持续占用输入和缓存，先清理更便宜，也可能避免一次摘要模型调用。
- **按时间/数量清理所有旧工具结果（Claude Code 风格）：** 不作为首版。它更简单，但会清掉唯一旧结果；先把“重复结果”做安全，再评估是否增加按最旧优先的清理层。
- **只按 `toolName + input` 判重：** 舍弃。文件内容会变化，同一读取输入可能对应不同输出；必须加入输出哈希，避免把旧版本结果误判为重复。
- **直接修改 transcript 的 tool result：** 舍弃。UI 历史、审计和后续 archive 会丢失原始结果；只改模型投影。
- **使用 provider 原生 `clear_tool_uses`：** 暂不采用。当前 OpenAI 兼容端点无法保证支持 Anthropic 风格的 context management；先做本地投影，后续按 provider 能力单独接入。
- **每次超过 172k 就清理，不设 132k 门槛：** 舍弃。会产生频繁前缀变化和 cache miss，也可能只清掉少量 token；132k 净节省是批处理门槛。
- **只依赖上一轮 `usage.inputTokens`，不做估算：** 舍弃。当前请求在压缩前还未发送，第一轮也没有 usage；必须保留保守估算路径。
- **把“待处理消息”作为产品概念展示：** 舍弃。它是实现内部的 `messagesAfterCheckpoint`，不应成为用户心智模型。

## 验收标准

- 可观察结果：
  - 模型能力配置为 256k 时，预算显示 `compactionBuffer=40k`、`inputLimit=216k`、`compactAt=216k`、`pruneAt=172k`、`pruneTarget=40k`；固定开销变化时，`compactAt` 自动下降。
  - 当前请求的文本和图片进入预算，但不会被摘要或清理。
  - 172k 触发时，只有净节省达到 132k 才替换旧重复工具结果；低于门槛时投影不变。
  - 工具结果清理后 transcript 和 UI 历史不变，tool-call/tool-result 配对完整。
  - 桌面和 CLI 能看到自动压缩/自动清理开关、当前上下文占用和跳过原因。
- 自动化验证：
  - 预算公式覆盖 256k、固定开销变化、输出预留变化和硬上限。
  - 估算覆盖 system、tools、assistant parts、工具状态、图片、当前请求，证明不再重复计数。
  - 工具清理覆盖相同输出去重、不同输出不清理、最近结果保护、失败结果保护、占用位文本后的净节省、131,999/132,000 边界和尝试水位。
  - 编排覆盖“清理后低于压缩线”“清理后仍需压缩”“压缩失败回退”“硬上限裁剪/报错”。
  - `pnpm notes:check`、`pnpm verify`。
- 需要的实机验证：
  - 桌面 Conversation 和 CLI Coding 各跑一轮超过 172k、包含重复 `read`/`grep` 的长会话，确认清理状态、UI 历史和继续工作正常。
  - 真实 provider 的 usage 缺失、图片输入、压缩取消和缓存 miss 场景。
  - 16k 固定开销和 20k 输出预留下的阈值校准。

## 风险

- 132k 门槛可能长期不触发，导致重复结果清理没有实际收益；需要记录尝试水位和跳过原因，后续按模型/领域调整。
- 重复检测依赖输出哈希，可能漏掉近重复结果；这是有意的保守代价，不能用模糊匹配替代。
- 清理会改变 prompt 前缀并可能造成一次 cache miss；如果 provider 的缓存折扣很高，132k token 节省不一定等于成本节省，需要后续按真实价格校准。
- `compactAt` 与 `inputLimit` 重合，触发点没有额外余量，安全裕量完全依赖 12k `safetyTokens`；估算误差超过该值时必须由硬兜底裁剪接管，不能继续发送。
- 固定开销和图片估算仍可能偏差；256k 窗口的 provider 语义（总窗口还是输入窗口）必须确认，不能假设所有模型一致。
- 当前 store 仍是进程内实现，usage 锚点和清理状态重启后会丢失；这不影响本提案的输入预算，但不能宣称持久恢复。
- 摘要渲染目前忽略图片；如果不在本提案中补图片描述或 archive，压缩仍可能丢失旧图片信息。
- 工具结果可能包含敏感内容；清理只减少模型输入，不减少 transcript 存储或审计面，存储清理仍需独立 Note。
- 预算和清理横跨 Agent、desktop、CLI 和模型能力配置；如果各宿主各自维护默认值，会重新出现“不由用户控制”的漂移。
