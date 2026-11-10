# Note：工具参数流式阶段的卡片活动反馈

状态：已实施

## 问题

模型发起 `Edit` 等参数较长的工具调用时，用户看到工具卡片后要等待很久才有可读内容：文件名、`+N/-N` 和 diff 都要等 `tool-call` 事件拿到完整 `input` 才出现；参数生成期间卡片只有“准备中”状态词，缺少持续活动感，主观上像界面卡住或流断掉。

现状链路并不缺事件：`tool-input-start` 会创建 `input-streaming` 状态的 tool part，`tool-input-delta` 会持续累积 `inputText`（`packages/ui/src/app/conversationParts.ts`），但 UI 没有把这个阶段的可观察信息表达出来：

- `ToolCallCard` 只显示统一状态词“准备中”，没有参数接收量或活动提示；
- `EditToolCall` 的摘要主目标在 `input` 出现前回退成“文件”，`file_path`、diff 和统计都不可读（`packages/ui/src/components/tool-call/renderers/edit.tsx`）；
- `tool-call` 到达时 `EditToolCall` 立即对 `old_string/new_string` 计算 diff，大参数可能把首帧更新推迟到计算之后。

参考实现 opencode 的做法是“骨架先出、持续动、内容后补”，而不是提前解析参数：`tool-input-start` 立刻创建 pending `ToolPart`，header 立刻渲染并持续 shimmer；`pending`/`running` 阶段刻意隐藏文件名、args 和 diff；重内容延迟挂载，文本按节奏渲染。它不展示 partial JSON，也不展示流式 diff。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/components/tool-call/ToolCallCard.tsx`
  - `packages/ui/src/components/tool-call/toolCallPresentation.ts`
  - `packages/ui/src/components/tool-call/renderers/edit.tsx`
  - `packages/ui/test/ToolCallCard.test.tsx`
  - `packages/ui/test/toolCallRenderers.test.tsx`
- UI/进程/协议/持久化表面：只改 renderer 的展示与本地渲染时序；不改 `AgentEventEnvelope`、`ConversationMessagePart` schema、worker 协议、IPC 频道或 transcript 持久化。
- 相关 Note：
  - [工具调用卡片的统一 UI 架构](../architecture/2026-11-09-tool-call-ui-architecture.md)
  - [Edit 多段 diff 展示与工具结构化输出](../architecture/2026-11-10-edit-multi-hunk-diff-display.md)
  - [AI SDK fullStream 作为 Agent 事实来源](../architecture/2026-11-07-ai-sdk-full-stream-as-agent-fact-source.md)

## 决定

### 目标

在不改变事件契约、不解析半截 JSON、不伪造进度的前提下，让 `input-streaming` 阶段始终有可观察的活动反馈，并保证 `tool-call` 到达时先出摘要、后补重内容。

### P0：输入流式阶段的显式活动

1. `ToolCallCard` 在 `part.state === "input-streaming"` 且 `part.inputText` 非空时，用 `formatToolInputStreamSize` 在摘要尾部显示参数接收量：
   - 数据只读 `part.inputText.length`，不对 JSON 做任何解析；
   - 不足 100 字符显示原值，之后按 100 字符向下取整；达到 1024 字符后换算为 KB 并保留一位小数，避免每个 delta 都产生可见变化；
   - 只在 renderer 没有提供 `summaryExtra` 时兜底（`summaryExtra ?? streamedSize`），不会覆盖 Edit 完成后的 `+N/-N`；
   - 不进入 `aria-live`，避免逐 token 打断读屏。
2. 状态词表不变：`input-streaming` 仍映射“准备中”；接收量是附加元信息，不新增状态、不改变 `TOOL_CALL_STATE_LABEL`。
3. 保留现有文字扫光：`ToolCallCard` 已对 `isToolCallRunning(part.state)` 设置 `data-running`，`input-streaming` 命中同一条规则；没有新增 spinner 或第二个视觉锚点。
4. `input-streaming` 阶段没有 children，因此不渲染 chevron、不生成可展开详情；由测试固定，避免点开必然为空的 diff。

### P1：`tool-call` 到达时先出摘要，后补 diff

1. `EditToolCall` 立即使用 `input.file_path` 渲染动作词和文件名；`replace_all` 等轻量字段同样即时读取。
2. `old_string`/`new_string` 及其 diff 通过 `useDeferredValue` 延后计算；首帧先提交文件名与状态，diff 和 `+N/-N` 在后续帧补齐。允许统计晚一帧出现，不允许文件名和卡片骨架等待 diff。
3. 结构化 diff（`output.diff`）仍同步读取；只有 legacy 字符串 diff 走延后计算。diff 继续只在展开时渲染内容，视觉与 `buildEditDiff` 的预算不变。

### 明确不做

- 不做 partial JSON 解析，不从 `inputText` 正则提取 `file_path`、diff 或任何工具语义；工具身份仍只认 `part.toolName`。
- 不做百分比进度条：模型参数总长度在流式阶段不可知，百分比只能是伪造值。
- 不改 Agent 事件、不新增协议字段、不把 raw 参数写入 transcript 或日志。
- 不为等待时间新增全局状态或连接提示；`input-streaming` 是执行内阶段，不属于连接域或模型重试域。

## 影响表面

- **用户体验**：`input-streaming` 阶段能看到“参数在增长”，`tool-call` 到达后文件名和卡片先出现，diff 紧随其后；长参数编辑不再像界面卡死。
- **UI**：只影响 `ToolCallCard` 的摘要元信息和 `EditToolCall` 的 diff 计算时序；`MessageTimeline`、`conversationParts`、`conversationView` 的事件投影和状态语义不变。
- **Agent/Desktop/Shared**：无变化；不新增事件、不新增 IPC、不改 `packages/shared`。
- **可访问性**：接收量不进入 live region；状态词仍由文本表达，扫光仅作视觉增强，`prefers-reduced-motion` 下沿用现有降级规则。

## 曾考虑的替代方案

- **解析 partial JSON，提前显示文件名或 diff：** 舍弃。半截 JSON 不可靠，diff 会闪烁或画错；现有架构 Note 也禁止从 `title`/`raw` 猜工具语义。参数体量增长已足够表达“在动”。
- **等参数完整后再显示整张卡片（更接近 opencode 的隐藏策略）：** 舍弃。这正是当前“卡住感”的来源；opencode 至少让 skeleton header 持续 shimmer，本次实现保留我们更早显示内容的优势。
- **显示百分比进度条：** 舍弃。流式阶段没有可信总长度，百分比只能伪造，属于禁止的推演状态。
- **给卡片加旋转 spinner：** 舍弃。既有工具卡约定运行态用文字扫光，不新增第二个视觉锚点。
- **增加等待计时器和停顿检测：** 暂缓。计时器需要 UI 本地状态，且与“状态必须来自显式事实”的边界更近；先用参数接收量验证是否足以消除卡住感，再决定是否增加“仍在生成参数”文案。

## 后果与防回退

- 每个 `tool-input-delta` 仍会触发 UI commit；接收量只在文本层按 100 字符 / 0.1 KB 粒度收敛。若实机出现抖动，只允许把格式化频率改为由 UI 本地节流，不允许解析或缓存 raw JSON 结构。
- `useDeferredValue` 让 diff 和统计晚于文件名出现，这是有意取舍。不得用 `setTimeout`、双份 store 状态或“先渲染旧值再手动同步”替代；`toolCallRenderers.test.tsx` 固定“流式摘要 → 完整文件名 → diff 统计”的顺序。
- `inputText` 可能很大，只允许读取 `length`；禁止渲染完整 raw 文本或把它复制进新状态。
- 不得在没有新 Note 的情况下增加百分比、计时器、spinner 或 partial file path 预览。
- 不同 provider 不保证分片输出 tool arguments；若 `tool-input-start` 与 `tool-call` 几乎同时到达，接收量可能只闪一下。这是 provider 行为，不通过伪造进度补偿。

## 验证

- `pnpm --filter @answra/ui test -- ToolCallCard toolCallRenderers`：29 个测试通过，覆盖流式接收量、无展开入口、`data-running` 扫光属性，以及 Edit 从流式摘要切换到完整 diff。
- `pnpm --filter @answra/ui test`：完整 UI 套件 300 个测试通过。
- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell/shellTools.test.ts`：16 个测试通过（同时修复该文件既有的 `writeStdin.handler` 返回值未收窄类型错误）。
- `pnpm --filter @answra/ui typecheck`、`pnpm --filter @answra/agent typecheck`、`pnpm lint`、`pnpm notes:check`、`pnpm architecture:check` 通过。
- 全仓 `pnpm verify` 未能在本次运行中完成：`apps/desktop` 工作区当时存在与本变更无关的未提交改动（`src/main/userShellEnv.ts`），其 typecheck 在 `spawnSync` 返回类型上失败；本变更相关包不受影响。
- 本次未执行 `pnpm dev:full` 实机观察；自动化只覆盖 DOM 行为。扫光动效、Layout 跳动和长参数下的实际首帧仍需在会分片输出 tool arguments 的端点上人工确认。
