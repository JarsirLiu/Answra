# Note：答题提示词收敛内部推理

状态：已实施

## 问题

截图答题使用 MiMo v2.6 Flash 时，真实用量记录多次达到 1,503–6,243 tokens，其中最高一笔为 6,243。现有 `ANSWER_PROFILE` 提示词包含「第一步/第二步」流程引导，并默认要求每题补一句理由、计算/编程题列最多 3 条步骤；这些约束会把模型推向更长的内部推理和更多可见输出。提示词中的「不输出分析过程」只约束最终正文，不能限制模型内部的 reasoning tokens。

## 涉及范围

- 代码/模块：`apps/agent/src/conversation/profiles.ts`（`ANSWER_PROFILE.systemPrompt`）、`apps/agent/src/conversation/runtime.ts`（答题请求参数）、`apps/agent/test/conversation/runtime.test.ts`。
- UI/进程/协议/持久化表面：答题提示词与模型请求参数；会话仓储、chunk 投影、回复条和对话面板均不变。
- 相关 Note：[答题输出以答案开头](2026-10-19-answer-first-output-format.md)、[通用对话与截图答题分离](2026-10-17-separate-chat-and-exam-modes.md)、[一次性截图答题会话](../feature/2026-10-11-ephemeral-exam-image-chat-v1.md)。

## 决定

- 保留「答案优先」输出契约：整条回复第一个字符必须是「答案：」；单题一行，多题每题一行且题号在括号内。
- 增加内部推理约束：「内部推理从简，直接作答，不反复验算、不比较多个方案」。这里不试图禁止模型思考，只要求推理和输出保持简短。
- 明确最终回复只给答案，不写分析过程、不复述题目。
- 去掉「第一步/第二步」流程框架，改为直接列出输出规则，减少提示词对多阶段推理的诱导。
- 理由改为条件输出：只有题目要求说明理由时才补一句；能直接确定答案时不解释。
- 计算题、编程题默认只给最终结果；只有题目明确要求过程时，才写最多 3 条关键步骤。
- 仅对 `ephemeral` 答题请求设置 `temperature: 0.3`，通用对话保持提供商默认值。
- 仅对 `ephemeral` 答题请求设置 `providerOptions.openaiCompatible.reasoningEffort: "low"`，映射为 `reasoning_effort: "low"`；不支持该字段的 OpenAI-compatible 端点通常会忽略，但不能假定一定兼容。
- 不新增 `maxOutputTokens`；MiMo 是否将 reasoning tokens 计入 `max_tokens`/`max_completion_tokens` 仍未验证。

## 影响表面

- 截图答题：答案更短，默认不附带理由和计算步骤；单题、多题、缺题号等格式规则保持不变。
- 通用对话：不受影响；`general-chat` profile 仍使用原提示词、历史上下文、Read/Grep 工具和时间注入。
- 模型调用：答题请求新增 `temperature=0.3` 与 `reasoning_effort=low`；仍只有本轮截图、补充文字和 system prompt，不引入历史、工具或新的协议字段。通用对话请求不新增这两个参数。
- 代价：复杂题在「不反复验算」约束下可能牺牲少量准确率；计算题默认不展示步骤，需要过程的用户需在题目中明确要求。

## 曾考虑的替代方案

- **只设置 `maxOutputTokens`（如 4096/8192）：** 能硬性截断，但不改变模型先长时间思考的行为；MiMo 是否把 reasoning tokens 计入该上限尚未确认，因此本次先收敛提示词，输出上限另做参数验证。
- **保留原提示词，只追加「内部推理从简」：** 改动最小，但原有「第一步/第二步」和默认理由/步骤要求仍在，容易继续诱导长推理，舍弃。
- **只保留最简输出格式，删除全部边界规则：** 提示词更短，但多题编号、残缺题忽略和答案首字符约束容易回退，舍弃。
- **在接口层关闭或调低 thinking：** 这是更直接的硬控制；本次用 `reasoning_effort: "low"` 尝试，若 MiMo 不支持则请求可能被忽略或拒绝，需实机确认。
- **在渲染层截断或清理模型输出：** 会把提示词不可靠性转移到 UI，并可能截断有效答案，舍弃。

## 后果与防回退

- 任何后续修改答题提示词，都不得把「答案：」移到题号、引子或说明之后；多题行格式仍为「答案：\<答案\>（\<题号\>）」。
- 不得重新引入「第一步/第二步」式流程引导，也不得默认要求每题解释或计算步骤；理由和步骤只在题目明确要求时输出。
- 该提示词没有自动化行为回归：答案格式和思考长度都是模型行为，无法在仓库测试中断言。每次改动后必须实机跑单题与多题截图答题，确认首字符为「答案：」、输出无分析过程，并记录 token 用量。
- 提示词只能降低过度推理的概率，不能保证 MiMo 一定缩短 reasoning；若实机仍经常超过可接受上限，应继续验证 `max_completion_tokens` 或 MiMo 的 thinking 参数，而不是继续堆提示词。
- `reasoning_effort` 是 OpenAI-compatible 常见扩展而非所有端点都支持；若网关严格校验未知字段，可能返回 400。出现该情况时应移除该参数或仅在确认支持的来源上启用，不能静默吞掉请求失败。
- `maxOutputTokens` 在当前 `@ai-sdk/openai-compatible` 中映射为 `max_tokens`，不是 `max_completion_tokens`；不要假设设置它就能限制 MiMo 的 reasoning。

## 验证

- `pnpm exec biome check apps/agent/src/conversation/profiles.ts apps/agent/src/conversation/runtime.ts apps/agent/test/conversation/runtime.test.ts` 通过。
- `pnpm --filter @answra/agent test` 通过；新增用例「sets answer temperature and low reasoning effort without changing general chat」断言答题请求带 `temperature=0.3`、`reasoning_effort=low`，通用对话不带这两个字段。
- 提示词文本本身没有自动化行为回归，答案格式和思考长度仍依赖实机。
- 实机验证待执行：分别用单题、多题、要求计算步骤的截图各跑一次，核对首字符为「答案：」、无分析过程、无未要求的长理由，并记录 tokens 是否低于修改前的 1,503–6,243 区间；同时确认 MiMo 接受 `reasoning_effort=low` 而不是返回 400。
