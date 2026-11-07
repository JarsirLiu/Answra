# Note：面试转录没有进入对话面板

状态：已实施

## 问题

ASR 已识别并结算面试语音，Agent 也完成了模型回复，但 renderer 的 transcript 不会自动更新。面试文本输入路径同样无法显示已追加的用户消息。

## 涉及范围

- 代码/模块：Agent worker 命令响应、desktop interview IPC、Conversation snapshot 通知、UI conversation view
- UI/进程/协议/持久化表面：面试语音结算、手动追加用户消息、renderer 内存 transcript
- 相关 Note：[会话切页恢复游标](../architecture/2026-11-07-conversation-live-recovery-cursor.md)

## 根因

`ConversationRuntime.appendUserMessage()` 返回更新后的 transcript snapshot，但两个 Agent worker 的 `append-user-message` 分支都丢弃了返回值，导致 preload 调用方拿到 `undefined`。

语音自动追加在 Agent 内部直接写入 transcript。Agent 已发出 `turn-committed` worker DTO，但 desktop main 没有订阅该通知，renderer 也没有 transcript snapshot 刷新入口，所以消息没有显示。模型 run 的 `model finished` 日志不能证明 transcript UI 已收到更新。

普通对话另有一个时序缺陷：发送响应中的 snapshot 是 run 启动时取得的 revision；执行事件可能先于 IPC 响应到达 renderer。UI 已消费更高 revision 后会拒绝旧 snapshot，而 snapshot 中的用户消息和 assistant 占位因此被丢弃，后续 text delta 因没有 assistant 消息可更新而不可见。原 UI 测试没有覆盖“事件先到、旧 snapshot 后到”的顺序。

## 决定

- 两个 worker 的追加命令都返回 `ConversationSnapshot`，使手动文本发送在成功后更新 UI。
- desktop 订阅现有 `turn-committed` worker 事件；Agent 完成 transcript 写入后，main 读取现有 conversation snapshot 并通过专用 snapshot-changed 通知推送。
- UI 把推送 snapshot 交给唯一 conversation view；不从 ASR 文本另造 UI 消息，也不将 transcript snapshot 通知加入 Agent execution 事件流。

## 修复

- worker 的 `append-user-message` 返回权威 transcript snapshot。
- desktop main 将语音 `turn-committed` 转换为 snapshot-changed 通知。
- renderer 订阅 snapshot-changed，并在普通对话发送等待期间保留草稿、显示发送状态；收到 snapshot 后再清空草稿。
- 普通对话发送响应使用 snapshot 的 `eventRevision` 回读并重放后续事件；重放期间暂存实时事件，避免旧 snapshot 丢失用户消息或流式正文。

## 曾考虑的替代方案

- **让 renderer 根据 ASR chunk 自己拼出用户消息：** 会让同一 transcript 同时由 Agent store 和 renderer 写入，重试、分块合并及历史加载容易漂移，因此舍弃。
- **把 snapshot 内容伪装成 AgentEventEnvelope：** snapshot 是既有 transcript 查询结果，不是一个 run 执行事件；伪装会污染 envelope 的 run/attempt 语义，因此舍弃。
- **仅依赖模型 run 的事件刷新 transcript：** run 事件不包含用户 transcript 消息，日志中的模型终态不能替代 transcript snapshot，因此舍弃。

## 后果与防回退

- Agent transcript snapshot 仍是消息内容来源；新通知只表示该 snapshot 已更新。
- UI 收到 snapshot 通知后按 conversationId 过滤，并让更新后的 snapshot 接管过期的初始化请求。
- 若语音追加没有成功，不能发 snapshot-changed 通知；必须保留 Agent 的错误路径。

## 验收标准

- 手动面试消息追加命令返回含新增 user message 的 snapshot。
- 语音 turn 提交后，main 推送的 snapshot 含对应 user message，面试 UI 随即显示。
- 普通对话事件、运行终态和切页恢复不回退，消息只从 transcript snapshot 读取。

## 风险

- snapshot-changed 是进程内 IPC 通知；Agent 或 desktop 进程退出后的恢复仍依赖未来的 transcript/event 持久化。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/worker/host.test.ts`：16 项通过，覆盖 worker 对手动追加 transcript snapshot 的响应。
- `pnpm --filter @answra/desktop exec vitest run test/interviewIpc.test.ts`：2 项通过，覆盖语音 turn 提交后的 snapshot 通知。
- `pnpm --filter @answra/ui exec vitest run test/useConversationView.test.tsx test/FloatingBarApp.test.tsx`：通过，覆盖 snapshot 接管、事件恢复及面试/普通对话界面行为。

## 后续发送反馈修复

普通对话 UI 之前在 IPC 响应前就清空草稿，且没有展示 `sendPending`，所以 Agent 仍在准备和接收调用时面板看起来没有反应。现在保留草稿直到收到并应用 Agent 返回的 transcript snapshot；等待期间禁用输入并显示“正在发送…”，失败保持草稿和错误提示。回归测试用延迟的 send IPC 响应验证等待、snapshot 到达和消息展示，而不是只断言桥接函数被调用。

该测试仍不模拟真实 Electron utility process；worker 响应字段另由 Agent worker 测试覆盖，完整打包进程级 E2E 尚未建立。
