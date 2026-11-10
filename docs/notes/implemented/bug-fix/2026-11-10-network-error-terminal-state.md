# Note：网络模型失败只保留真实错误并清理旧错误

状态：已实施

## 问题

模型请求在代理或网络中断时，AI SDK 会先发出真实的 provider `error`，随后关闭流而不发出 `finish`。运行时原先只检查是否有 `finish`，因此又追加“模型流未提供终态”，让用户看到与日志不一致的伪错误。UI 还会把上一轮错误带入后续快照或新一轮对话。

## 涉及范围

- 代码/模块：`apps/agent/src/core/agent/executeRun.ts`、`packages/ui/src/app/conversationView.ts`、`packages/ui/src/app/ChatFeaturePanel.tsx`、`packages/ui/src/app/useConversationChat.ts`、`packages/ui/src/app/FloatingBarApp.tsx`
- UI/进程/协议/持久化表面：Agent 模型流终态诊断、Conversation 快照与新一轮事件的错误投影、清空对话后的 UI 本地错误状态
- 相关 Note：`docs/notes/implemented/bug-fix/2026-11-07-conversation-terminal-state-projection.md`、`docs/notes/implemented/architecture/2026-11-07-ai-sdk-full-stream-as-agent-fact-source.md`

## 决定

- 已有 `error` 或 `abort` 事实时，不再补发“模型流未提供终态”；只有流既没有成功终态、失败事件，也没有取消时才生成该诊断。
- 新一轮明确收到 `start` 时清除上一轮错误。
- 服务端快照成为新的会话事实时清除旧错误；仅当快照仍指向同一个活动 run 时保留该 run 的重试指示。清空快照不保留错误或重试状态。
- 清空对话成功时同时清理只存在于 UI 的发送失败状态（对话面板 `failure` 与 `useConversationChat` 的 `sendError`、面试面板 `interviewError`）；服务端快照清掉投影错误后，本地 state 不能继续渲染同一提示。

## 根因

`executeRun` 只用 `finished` 和 `aborted` 判断是否需要合成终态诊断，没有把 provider `error` 计入失败事实。UI 侧 `applyConversationSnapshot` 始终携带旧的 `error`/`retry`，`start` 事件也只清重试不清错误；清空对话时 `ChatFeaturePanel.failure`、`useConversationChat.sendError` 和 `FloatingBarApp.interviewError` 未被重置。

## 修复

- 终态诊断增加 `journal.metrics.failed` 判断。
- 快照与 `start` 事件清除旧错误；快照只在仍指向同一活动 run 时保留重试指示。
- 清空成功时重置对话与面试的 UI 本地发送错误状态。

## 曾考虑的替代方案

- **在 UI 按错误文本去重：** 舍弃。错误文本来自外部 provider，无法可靠判断因果，且会把真实的重复事件隐藏掉。
- **继续保留“未提供终态”作为第二条提示：** 舍弃。日志已经有真实 provider 错误，第二条提示不能帮助用户诊断，反而遮蔽根因。
- **仅在 `clear()` 本地清理：** 舍弃。服务端快照随后仍可能覆盖 UI，无法解决切换会话或继续对话时的残留。

## 后果与防回退

网络失败时 UI 展示真实连接错误和已有网络重试事件；流关闭但没有任何错误事实时仍保留“模型流未提供终态”作为内部一致性诊断。新一轮或清空后不会继承旧错误。

- 终态判断必须同时考虑 `finished`、`failed`、`aborted`；新增 provider 错误事件时应先更新 journal 失败指标，再决定是否需要合成诊断。
- 不得按错误文本去重或从流结束顺序伪造终态。
- 清空对话必须同时清理投影错误与 UI 本地发送错误；只清一层会留下底部残留。

## 验证

- `packages/ui/test/conversationView.test.ts` 覆盖新一轮 `start` 和空快照清理旧错误。
- `packages/ui/test/FloatingBarApp.test.tsx` 覆盖失败后清空常驻对话与面试对话时错误提示一并消失。
- `pnpm --filter @answra/ui exec vitest run`：33 个测试文件、259 个测试通过。
- `pnpm --filter @answra/ui typecheck`、`pnpm --filter @answra/agent typecheck`：通过。
- `pnpm notes:check`、`pnpm verify`：待提交前执行。
