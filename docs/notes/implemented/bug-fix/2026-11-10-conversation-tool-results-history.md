# Note：Conversation 历史回传工具调用与结果

状态：已实施

## 问题

Conversation transcript 已经保存 `tool` 类型消息 part，但下一次模型请求只回放文本和图片。用户完成一次带工具调用的回复后再说“继续”，模型看不到上一轮调用了什么工具、工具返回了什么，只能重新猜或重复调用。工具结果在 UI 中可见，却没有进入后续模型上下文。

## 涉及范围

- 代码/模块：`apps/agent/src/conversation/turn/modelMessages.ts`、`apps/agent/test/conversation/turn/modelMessages.test.ts`
- UI/进程/协议/持久化表面：不新增 IPC、worker 协议或事件类型；只改变 transcript 到 AI SDK `ModelMessage[]` 的投影。
- 相关 Note：`docs/notes/implemented/architecture/2026-11-08-core-transcript-store.md`、`docs/notes/implemented/architecture/2026-11-09-tool-business-failures-as-model-results.md`
- 参考实现：`D:\codespace\opencode\packages\opencode\src\session\message-v2.ts` 会把 assistant tool part 与 tool result 一起转换进模型消息；`D:\codespace\opencode\packages\core\src\session\runner\to-llm-message.ts` 在下一轮 provider turn 前重新加载并回放工具结果。

## 决定

把 `ConversationMessage.parts` 中已经持久化的工具事实投影成 AI SDK 模型消息：

- assistant 文本 part 继续转换为 `{ role: "assistant", content: [{ type: "text", ... }] }`。
- assistant tool part 转换为 `ToolCallPart`，保留 `toolCallId`、`toolName` 和 `input`。
- 工具调用之后生成对应的 `{ role: "tool", content: [{ type: "tool-result", ... }] }`。
- 按 part 出现顺序分段：同一段 assistant 文本与工具调用合并；工具结果单独成消息；工具结果之后的文本进入下一条 assistant 消息。
- 已完成的工具使用 `output` 生成文本结果；字符串直接使用，其他结构用 JSON 文本。
- 失败、拒绝、中断或未完成的工具调用也生成明确的文本结果，避免留下没有结果的 tool call。
- 历史消息没有 `parts` 时继续按旧逻辑只回放文本，兼容已有内存快照。
- 不把 reasoning part 重新发给模型，避免 provider 签名和跨模型兼容问题。

明确不做：

- 不新增 transcript 字段、事件或第二套工具结果存储。
- 不从 ExecutionStore 反向重建 transcript 历史。
- 不在本轮修改 shell、WebFetch 或工具结果预算策略。
- 不把 UI 的展示输出当成模型输出；模型只消费 `parts`。

## 根因

`buildModelMessages` 对 assistant 消息只构造 `{ role: "assistant", content: message.text }`，对 user 消息只取文本和图片。`ConversationMessage.parts` 中的 tool part 从未参与模型上下文构造，因此工具调用与结果只存在于 UI/transcript，不会进入下一轮请求。

## 修复

`modelMessages.ts` 新增 `userModelMessage`、`assistantModelMessages`、`toolResultText` 和 `stringifyToolOutput`：

1. 遍历 assistant message 的 parts。
2. 文本进入当前 assistant 内容。
3. 遇到带 `input` 的 tool part 时加入 `ToolCallPart`，同时记录对应结果。
4. 工具组结束时先输出 assistant 消息，再输出 tool 消息；后续文本开启新的 assistant 消息。
5. 对 completed / failed / denied / interrupted / pending 等状态统一生成可读文本结果。
6. 没有 parts 的历史 assistant 消息继续使用 `message.text`。

## 曾考虑的替代方案

- **只回传最终文本：** 舍弃。模型仍然看不到工具输入和结果，无法承接上一轮工作。
- **把工具调用和结果塞进一条 assistant 文本：** 舍弃。会破坏 provider 的 tool call/tool result 配对语义，也无法被 AI SDK 正确识别。
- **从 ExecutionStore 重建工具历史：** 舍弃。transcript 已经是消息事实来源，再读事件会产生第二套恢复路径。
- **新增 `modelContent` 持久化字段：** 暂缓。当前只需让结果可见；结构化工具输出可用 JSON 文本回放，先避免跨进程 schema 变更。
- **回放 reasoning：** 舍弃。reasoning 可能带 provider 签名，跨模型或重放时容易失败。

## 验收标准

- 第二轮请求中能看到上一轮 assistant 的 tool call 和 tool result。
- 失败或中断的工具调用不会产生悬空 tool call。
- 没有 parts 的旧历史仍只发送文本。
- 自动化验证：`modelMessages.test.ts` 覆盖成功、失败/中断、无 parts 回退、多工具与后续文本分段。
- `pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/agent test`、`pnpm notes:check` 通过。

## 风险

- 结构化工具输出使用 JSON 文本回放，可能比原始 `formatModelContent` 更长或可读性稍低；本轮不为它新增持久化字段。
- 历史 tool result 会占用上下文；当前 transcript 仍只有进程内存储，暂不做压缩或 artifact。
- provider 对 tool call/result 配对有严格要求，投影必须保证每个发出的 tool call 都有对应结果；测试要覆盖中断状态。

## 后果与防回退

- 后续模型上下文必须从 `ConversationMessage.parts` 回放工具事实，不得退回只发送 `message.text`。
- 每个回放的 tool-call 必须与 tool-result 成对；失败、拒绝、中断和未完成状态不得产生悬空调用。
- reasoning 仍不回放；需要跨模型重放 reasoning 时必须另立契约。
- 结构化 `output` 当前用 JSON 文本回放；若后续引入 `modelContent` 持久化，必须保持 transcript 单一事实来源并更新本 Note。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- 定向测试 `modelMessages.test.ts`、`stepLimit.test.ts`、`executeRun.test.ts`：8 个测试通过。
- `pnpm --filter @answra/agent test`：单独运行时 50 个测试文件、409 个测试通过；新增 `modelMessages.test.ts` 3 个测试。
- `pnpm notes:check`：通过。
- `pnpm architecture:check`：通过。
- 全 workspace `pnpm verify` 未全绿：`pnpm lint` 被并行 UI 文件 `packages/ui/test/FloatingBarApp.test.tsx` 的格式检查阻断；`pnpm typecheck` 被既有 PDF/Word 模块声明缺失阻断。两项均不在本次改动范围。
