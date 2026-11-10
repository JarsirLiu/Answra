# Note：Conversation 工具步数上限与 tool-calls 终态

状态：已实施

## 问题

通用对话在 6 个模型 step 后停止。日志中最后一次 `finishReason` 是 `tool-calls`，但 run 仍被标记为 `completed`，用户看到的是回复结束，实际上模型还在请求工具，没有产出最终回答。

当前实现存在两个问题：

1. `stepCountIs(6)` 把工具调用步数上限设置得过低，正常的多轮读取/编辑会提前中断。
2. `tool-calls` 被当作普通完成终态；`streamJournal` 只要看到 `finish` 就标记 finished，`runOutcome` 因此返回 `completed`。

## 涉及范围

- 代码/模块：`apps/agent/src/conversation/agent.ts`、`apps/agent/src/conversation/turn/stepLimit.ts`、`apps/agent/src/core/agent/definition.ts`、`apps/agent/src/core/agent/executeRun.ts`
- 测试：`apps/agent/test/conversation/turn/stepLimit.test.ts`、`apps/agent/test/core/agent/executeRun.test.ts`
- UI/进程/协议/持久化表面：不新增事件、IPC 或 worker 协议；达到上限时仍通过既有 `run-state-changed` 和 transcript 状态呈现。
- 相关 Note：`docs/notes/implemented/bug-fix/2026-11-07-conversation-terminal-state-projection.md`
- 参考实现：`D:\codespace\opencode\packages\opencode\src\session\prompt.ts` 在 `tool-calls` 时继续循环；`D:\codespace\opencode\packages\core\src\session\runner\llm.ts` 在最后一步禁用工具并注入 `MAX_STEPS_PROMPT`；`D:\codespace\opencode\packages\core\src\session\runner\max-steps.ts` 要求模型只输出总结。

## 决定

采用“20 个工具步 + 1 个强制总结步”的有限循环，不把步数改成无限。

- 新增 Conversation 专用 `createToolStepLimit()`：
  - `MAX_TOOL_STEPS = 20`；
  - `stopWhen: stepCountIs(MAX_TOOL_STEPS + 1)`；
  - `prepareStep` 在前 20 步返回 `undefined`，继续允许工具；
  - 当 `stepNumber >= MAX_TOOL_STEPS` 时，返回 `toolChoice: "none"`，并在当前 messages 末尾追加 `MAX_STEPS_PROMPT`，要求模型只用文本总结已完成工作、未完成事项和下一步。
- `AgentModelRequest` 增加可选 `prepareStep`，由 `streamText` 原样消费；不在 `executeRun` 里自研第二套 agent loop。
- `executeRun` 记录最终 `finishReason`，`runOutcome` 增加显式判断：
  - 取消或 abort → `aborted`；
  - 失败、没有 finish、或最终 `finishReason === "tool-calls"` → `failed`；
  - 其余已有成功终态 → `completed`。
- 不修改 `streamJournal` 的通用 finish 记录；终态判定集中在 `executeRun`，避免 journal 与 run outcome 两套规则。
- 不新增 UI 提示。强制总结步会产出文本；若 provider 仍无视 `toolChoice: "none"` 返回工具调用，run 会明确失败，而不是静默完成。

明确不做：

- 不把步数设为无限。
- 不在 Conversation 层实现自定义 tool loop。
- 不因为提高步数就取消硬上限。
- 不在本轮修改 Bash、WebFetch 或命令预检。

## 根因

`conversation/agent.ts` 直接使用 `stopWhen: stepCountIs(6)`。AI SDK 在达到步数上限后停止流，最后一次模型响应可能仍是 `tool-calls`。`streamJournal` 只区分“是否收到 finish”，`runOutcome` 只检查 `finished/failed/aborted`，没有读取 `finishReason`，因此 `tool-calls` 被误判为完成。

## 修复

1. 新增 `conversation/turn/stepLimit.ts`，导出 `MAX_TOOL_STEPS`、`MAX_STEPS_PROMPT` 和 `createToolStepLimit()`。
2. `conversation/agent.ts` 用 `...createToolStepLimit()` 替换裸 `stopWhen: stepCountIs(6)`。
3. `core/agent/definition.ts` 为 `AgentModelRequest` 增加 `prepareStep` 类型，沿用 AI SDK `streamText` 的 `PrepareStepFunction`。
4. `executeRun.ts` 在 `finally` 中把最终 `finishReason` 传入 `runOutcome`；导出纯函数用于测试。
5. 补单元测试：停步阈值、最后一步禁用工具并注入总结提示、`tool-calls` 不再返回 `completed`。

## 曾考虑的替代方案

- **只把 6 改成 12/20：** 舍弃。能缓解频率，但最后一步仍可能停在 `tool-calls`，问题会以更低概率复现。
- **改成无限步数：** 舍弃。模型可能循环调用工具，成本和延迟不可控。
- **在 Conversation 层写 while 循环重新调用模型：** 舍弃。会复制 AI SDK 的 tool loop、消息拼接和终态处理，形成第二套 agent loop。
- **只改 `runOutcome` 把 `tool-calls` 标为失败：** 舍弃。能让状态不再骗人，但用户仍然拿不到总结，任务依旧中断。
- **只在 UI 显示“步数达到上限”：** 舍弃。提示不能替代最终回答，且会新增 UI 分支。
- **把总结提示作为 user 消息注入：** 舍弃。最后一步是模型在工具结果之后收尾，用 assistant 提示与 OpenCode 的做法一致，也避免伪造新的用户输入。

## 验收标准

- 普通多工具任务不会在第 6 步被截断。
- 达到 20 个工具步后，仍有一次禁用工具的文本总结请求。
- 最终 `finishReason === "tool-calls"` 时 run 不再标记 `completed`。
- 取消仍为 `aborted`， provider 错误仍为 `failed`。
- 自动化验证：`stepLimit.test.ts`、`executeRun.test.ts`、`pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/agent test`、`pnpm notes:check`。
- 实机验证：带多个 Read/Grep 的对话能完成并给出最终文本；若模型在总结步仍请求工具，消息以失败结束而不是静默完成。

## 风险

- 多一次模型调用会增加少量延迟和 token 成本；这是为了避免“没有最终回答”的必要代价。
- 某些 provider 可能不严格遵守 `toolChoice: "none"`；此时会走 `tool-calls` 失败路径，至少不会伪装完成。
- 20 步仍是硬上限；极端长任务需要用户再次发起，或后续单独设计跨 run 的继续策略。
- `MAX_STEPS_PROMPT` 会占用上下文；当前不引入压缩或摘要服务。

## 后果与防回退

- `finishReason === "tool-calls"` 不得再映射为 `completed`；终态语义由 `executeRun` 的 `runOutcome` 统一收口。
- 工具循环必须在最后一步禁用工具并注入总结提示；不得只提高步数而保留“停在 tool-calls”的路径。
- `streamJournal` 继续只记录流事实；新增终态判断应放在 outcome 层，不得在 journal 里复制一套产品终态。
- 若后续把步数改成按 profile 配置，`MAX_TOOL_STEPS` 的默认值和最后一步语义必须仍然成立。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- 定向测试 `stepLimit.test.ts`、`executeRun.test.ts`、`modelMessages.test.ts`：8 个测试通过。
- `pnpm --filter @answra/agent test`：单独运行时 50 个测试文件、409 个测试通过；新增 `stepLimit.test.ts` 2 个、`executeRun.test.ts` 3 个测试。
- `pnpm notes:check`：通过。
- `pnpm architecture:check`：通过。
- 全 workspace `pnpm verify` 未全绿：`pnpm lint` 被并行 UI 文件 `packages/ui/test/FloatingBarApp.test.tsx` 的格式检查阻断；`pnpm typecheck` 被既有 PDF/Word 模块声明缺失阻断。两项均不在本次改动范围。
