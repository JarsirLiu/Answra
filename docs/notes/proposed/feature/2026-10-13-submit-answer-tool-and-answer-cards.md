# Note：答案改为模型工具调用（submit_answer）并渲染答案卡

状态：提案

## 问题

截图答题回复以纯文本「题号：答案」输出，回复条用跑马灯滚动展示文本片段：答案不可结构化阅读（选择题看不到大号选项、代码无高亮块），跑马灯无法承载多题结果，且文本格式靠 system prompt 约定、两侧（模型输出与 UI）没有结构契约。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/answers.ts`（新增答案契约）
  - `apps/app/src/conversationRuntime.ts`（注册工具、重写 system prompt）
  - `packages/ui/src/app/replyActivity.ts`（工具活动投影）
  - `packages/ui/src/app/useReplyConversation.ts`（消息态携带答案）
  - `packages/ui/src/components/chat/answers/`（新增答案卡组件族）
  - `packages/ui/src/components/panels/ReplyBar.tsx`、`ReplyConversationPopover.tsx`、`packages/ui/src/app/ReplyBarWindowApp.tsx`（接线）
- UI/进程/协议表面：IPC 频道与 `ReplyBarState` 契约不变；模型侧从纯文本输出变为 tool-call 流（OpenAI-compatible function calling），AI SDK 统一转成 `tool-input-*` chunk，持久化事件格式不变。
- 相关 Note：`docs/notes/implemented/feature/2026-10-11-reply-bar-composer-redesign.md`（流式态跑马灯的定义，本提案部分替换）。

## 提案

- **模型逐题调用工具提交答案，前端按题型渲染答案卡**。runtime 注册无 `execute` 的 `submit_answer` 工具（zod 判别联合 schema），system prompt 改为「每道完整可作答的题调用一次 submit_answer」。
- **一个工具，不按题型开 N 个工具**。答案结构唯一契约在 `packages/shared/src/answers.ts`：`AnswerPayload` 判别联合（single-choice / multi-choice / judge / fill-blank / short-answer / code / text 兜底）+ `SubmittedAnswer` + 纯函数（`parseAnswerInput` 安全解析、`answerTitle`、`summarizeAnswer`）。新增题型 = 新增 union 分支 + ui 注册一个渲染器，管线零改动。
- **投影层定制**（`replyActivity.ts`）：`submit_answer` 的 `tool-input-start` 投影为「正在作答/识别题目中…」，`tool-input-available` 投影为「第 N 题 · 题型 + 单行摘要」，并按 toolCallId 抑制原始 JSON 参数流噪音；其他工具走通用「工具：」路径。
- **消息状态**（`useReplyConversation.ts`）：`ReplyConversationMessage` 新增 `answers: SubmittedAnswer[]`，从 `tool-input-available` chunk 提取（同 toolCallId 覆盖），快照/历史回放/run-finished 均可重建，不依赖瞬时 activities。
- **UI 组件族**（`chat/answers/`，从 `chat/` barrel 导出，可组合复用）：
  - `AnswerBody`：题型渲染注册表（`registerAnswerRenderer` 可覆写），单选/多选 = 大号字母 chip，判断 = ✔/✘ 徽标，填空 = 逐空编号列表，简答/兜底 = `TextResponse` markdown，编程 = 代码块；
  - `AnswerCard`：完整卡（「第 N 题 · 题型」标题 + 主体），用于对话面板；
  - `AnswerStrip`：回复条答案带（单行迷你卡 + 「识别题目中…」），替换跑马灯。
- **接线**：`ReplyBar` 流式态在 `answers.length > 0` 时渲染 `AnswerStrip`，否则回落 `ReplyActivityTicker`（thinking/等待/错误与非工具流仍走跑马灯）；`ReplyBarWindowApp` 从 `useReplyConversation` 提取最近带答案的助手消息传入；`ReplyConversationPopover` 渲染 `AnswerCard` 并对已被答案卡承载的工具活动去重。
- 组件 CSS 只消费 `tokens.css` 感知令牌（--field/--mint/--danger 等），无字面量颜色，与变色龙/隐身模式的令牌体系兼容。

## 影响表面

- 截图答题流：回复条流式态逐题出现答案迷你卡；对话面板出现完整答案卡（chip/徽标/列表/markdown/代码）。
- 模型不调用工具直接输出文本时，回复条仍走原跑马灯路径（兜底不回归）。

## 曾考虑的替代方案

- **每题型一个工具（submit_choice / submit_fill / …）：** 舍弃。N 个 schema、N 份 prompt 规则、N 个投影与 UI 分支，维护成本随题型线性涨；单工具 + 判别联合让模型只需选 `payload.type`。
- **structured output 整卷一次输出 JSON：** 舍弃。无流式粒度，一题识别不出整卷卡住；openai-compatible 各家对 response format 支持不一。
- **纯前端从文本解析答案渲染：** 舍弃。文本格式没有结构契约，解析脆弱；工具调用让「结构化」成为模型侧的硬约束。
- **回复条完全删除跑马灯：** 暂不。thinking 阶段、等待阶段、错误与非答题流仍需要活动展示；`AnswerStrip` 仅在有答案时接管，行为可预测。

## 验收标准

- 可观察结果：真实模型（含截图）多题型跑通——选择/判断/填空出现 chip 与列表卡、编程题代码块、未识别题型降级 markdown；模型不调用工具时回复条仍走跑马灯。
- 自动化验证：`conversationRuntime` 测试新增「请求体声明 submit_answer 工具 + mock SSE tool_calls 流端到端产出 `tool-input-available`」用例；`replyActivity` 测试新增「抑制参数流」「答案活动投影」用例；`answers` 纯函数（解析/摘要/标题）有独立测试；shared / app / ui typecheck 与 vitest 全部通过。
- 需要的实机验证：隐身模式下回复条答案带随令牌变淡不露内容。

## 风险

- 依赖模型是否稳定发起 tool-call：弱模型或未支持 function calling 的端点会退化为纯文本，走跑马灯兜底（行为可接受但体验降级）。
- 题型 schema 划分依赖试卷形态假设，可能出现模型填错分支（如把多题塞进一次调用）；靠 prompt 约定 + `text` 兜底降级为 markdown，而非空白或报错。
- `submit_answer` 无 `execute`，答案无服务端校验；后续若要校验需补 execute，且不得在前端复制校验逻辑。
