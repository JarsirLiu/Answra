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

语音自动追加在 Agent 内部直接写入 transcript。旧路径只发布 `turn-committed` worker DTO，Desktop 再查询 snapshot；这个事后查询既可能漏掉通知，也无法保证 snapshot 与执行事件的到达顺序。模型 run 的 `model finished` 日志不能证明 transcript UI 已收到更新。

普通对话另有一个时序缺陷：发送响应中的 snapshot 是 run 启动时取得的 revision；执行事件可能先于 IPC 响应到达 renderer。UI 已消费更高 revision 后会拒绝旧 snapshot，而 snapshot 中的用户消息和 assistant 占位因此被丢弃，后续 text delta 因没有 assistant 消息可更新而不可见。原 UI 测试没有覆盖“事件先到、旧 snapshot 后到”的顺序。

## 决定

- 两个 worker 的追加命令都返回 `ConversationSnapshot`，使手动文本发送在成功后更新 UI。
- Agent 在用户消息写入后直接发布 transcript snapshot，并在 assistant run 启动事件前发布带占位消息的 snapshot；两者共用既有 `conversation-snapshot` worker frame 和 `SnapshotChanged` IPC 通知。
- UI 把推送 snapshot 交给唯一 conversation view；不从 ASR 文本另造 UI 消息，也不将 transcript snapshot 通知加入 Agent execution 事件流。

## 修复

- worker 的 `append-user-message` 返回权威 transcript snapshot。
- Interview reply adapter 依次推送用户消息 snapshot 与 assistant 占位 snapshot；Desktop 只转发 AgentService 收到的 snapshot，不再依据 `turn-committed` 事后查询。
- worker 组合根位于 `apps/agent/src/host.ts`；`worker/` 只保留线协议，Interview 专属协议投影在 `interview/workerProjection.ts`。
- renderer 订阅 snapshot-changed，并在普通对话发送等待期间保留草稿、显示发送状态；收到 snapshot 后再清空草稿。
- renderer 对推送 snapshot 使用统一恢复入口，按 `eventRevision` 回读并重放后续事件；恢复期间暂存实时事件，并通过 generation 丢弃过期读取结果。

## 曾考虑的替代方案

- **让 renderer 根据 ASR chunk 自己拼出用户消息：** 会让同一 transcript 同时由 Agent store 和 renderer 写入，重试、分块合并及历史加载容易漂移，因此舍弃。
- **把 snapshot 内容伪装成 AgentEventEnvelope：** snapshot 是既有 transcript 查询结果，不是一个 run 执行事件；伪装会污染 envelope 的 run/attempt 语义，因此舍弃。
- **仅依赖模型 run 的事件刷新 transcript：** run 事件不包含用户 transcript 消息，日志中的模型终态不能替代 transcript snapshot，因此舍弃。

## 后果与防回退

- Agent transcript snapshot 仍是消息内容来源；新通知只表示该 snapshot 已更新。
- UI 收到 snapshot 通知后按 conversationId 过滤，并让更新后的 snapshot 接管过期的初始化请求；snapshot 先于其 run 的首个事件发布。
- 若语音追加没有成功，不能发 snapshot-changed 通知；必须保留 Agent 的错误路径。

## 验收标准

- 手动面试消息追加命令返回含新增 user message 的 snapshot。
- 语音 turn 提交后，main 推送的 snapshot 含对应 user message，面试 UI 随即显示。
- 普通对话事件、运行终态和切页恢复不回退，消息只从 transcript snapshot 读取。

## 风险

- snapshot-changed 是进程内 IPC 通知；Agent 或 desktop 进程退出后的恢复仍依赖未来的 transcript/event 持久化。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/worker/host.test.ts`：16 项通过，验证语音用户 snapshot 和 assistant 占位 snapshot 都被发送，且占位 snapshot 先于该 run 的首个事件。
- `pnpm --filter @answra/desktop exec vitest run test/conversationIpc.test.ts test/interviewIpc.test.ts`：14 项通过，验证 Conversation snapshot listener 转为 IPC 广播，且 Interview IPC 不再事后查询 snapshot。
- `pnpm --filter @answra/ui exec vitest run test/useConversationView.test.tsx`：4 项通过，验证执行事件先到时，稍后到达的 snapshot 仍以游标恢复并回放该事件。
- 三包定向 typecheck、`pnpm notes:check` 与 `pnpm verify` 通过；全量测试结果为 Agent 143、UI 228、Desktop 277 项通过。
- 自动化测试不模拟真实 Electron utility process 和麦克风；Windows 面试实机验证仍需单独进行。

## 后续发送反馈修复

普通对话 UI 之前在 IPC 响应前就清空草稿，且没有展示 `sendPending`，所以 Agent 仍在准备和接收调用时面板看起来没有反应。现在保留草稿直到收到并应用 Agent 返回的 transcript snapshot；等待期间禁用输入并显示“正在发送…”，失败保持草稿和错误提示。回归测试用延迟的 send IPC 响应验证等待、snapshot 到达和消息展示，而不是只断言桥接函数被调用。

该测试仍不模拟真实 Electron utility process；worker 响应字段另由 Agent worker 测试覆盖，完整打包进程级 E2E 尚未建立。
