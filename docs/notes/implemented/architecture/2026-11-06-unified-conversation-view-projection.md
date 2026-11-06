# Note：前端会话消息投影收敛为唯一一份

状态：已实施

## 问题

对话、面试、回复详情各自维护一套前端消息投影：

- `useConversationChat` 基于 AI SDK `useChat`，只保留 text/reasoning 到 `ChatMessage`；
- `interviewConversation` 只处理 `text-delta`，丢弃 `reasoning-delta`、工具、来源等事件；
- `useReplyConversation` 另写一套 revision/recovery/activities 折叠逻辑。

后果是同一份 `ConversationChange` 被三处解释，面试面板还绕开了 `AssistantMessage`，直接渲染纯文本 `div.message-content`，导致 Markdown、KaTeX、思考链和流式光标缺失；任何一处补事件类型都会继续漂移。

## 涉及范围

- 代码/模块：`packages/ui/src/app/useConversationChat.ts`、`packages/ui/src/app/interviewConversation.ts`、`packages/ui/src/app/useInterviewConversation.ts`、`packages/ui/src/app/useReplyConversation.ts`、`packages/ui/src/components/panels/ChatPanel.tsx`、`packages/ui/src/components/panels/InterviewCapturePanel.tsx`、`packages/ui/src/components/chat/AssistantMessage.tsx`
- UI/进程/协议/持久化表面：renderer 的 `ConversationChange` 消费与消息渲染；不改变 IPC 频道、shared schema、agent store 或持久化格式
- 相关 Note：[事件 schema 单一来源与 AI SDK 边界](./2026-11-03-event-schema-single-source.md)、[对话与答题 AI 领域拆分及对话能力复用](./2026-10-18-ai-capability-domains-and-reuse.md)

## 决定

### 唯一消息模型

新增 `packages/ui/src/components/chat/conversationMessage.ts`：

```ts
interface ConversationViewMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "complete" | "streaming" | "interrupted" | "failed";
  reasoning?: string;
  images?: { name: string; dataUrl: string }[];
  activities?: readonly ReplyBarActivity[];
}
```

这是前端唯一可渲染的 AI 消息模型；`ChatPanel`、`InterviewCapturePanel`、`ReplyConversationPopover` 都消费它。

### 唯一投影

新增 `packages/ui/src/app/conversationView.ts`：

- `applyConversationChange()` 把 `snapshot | messages-appended | event | run-finished` 折叠成 `ConversationView`；
- 处理 `text-delta`、`reasoning-delta`、错误、`run-finished` 状态；
- `trackActivities` 为回复详情保留工具/来源/错误卡片；
- `retainCapturedRound` 保留答题会话结束后被清空的已捕获轮次；
- `applyHistoricalConversationEvent()` 在初始化回放历史时只补思维链与活动，避免正文与快照重复。

新增 `packages/ui/src/app/useConversationView.ts`：唯一订阅入口，负责初始快照、历史回放、revision 连续性与 gap 恢复、等待 run 终态、切换活动会话。

### 三个表面统一接入

- `useConversationChat` 删除 `useChat`/`ChatTransport`/`UIMessage` 适配，改为 `useConversationView` + `sendConversationMessage` + `waitForRun`；
- `useInterviewConversation` 直接返回 `useConversationView` 的视图；
- `useReplyConversation` 使用同一 hook，开启 `create: false`、`retainCapturedRound`、`trackActivities`；
- `InterviewCapturePanel` 的 assistant 分支改为 `<AssistantMessage>`，与对话面板共用 Markdown/KaTeX/思考链/光标/操作条；
- 被新语音打断的回复保留内部 `interrupted` 状态，但面试与回复详情按普通结束内容展示，不追加“已中断/已停止”标签；没有内容的中断消息不占消息列表位置；
- 删除 `interviewConversation.ts` 与其测试，新增 `conversationView.test.ts` 覆盖原面试投影用例及 reasoning/activities。

### 明确不做

- 不修改 `ConversationChange` 契约，不新增第二套消息 schema；
- 不把 `activities` 写回持久化消息，活动卡片仍是渲染态；
- 不为面试单独保留一套 reducer 或单独的消息组件。

## 模块边界

- `components/chat/conversationMessage.ts`：中立的消息渲染模型，components 与 app 都可引用，避免 components → app 反向依赖；
- `app/conversationView.ts`：纯函数投影，不订阅、不持有 React 状态；
- `app/useConversationView.ts`：唯一订阅与恢复逻辑；
- `components/chat/AssistantMessage.tsx`：唯一 assistant 消息容器，面试与对话不再各写正文渲染。

## 曾考虑的替代方案

- **只把面试面板换成 `AssistantMessage`，保留两套投影：** 立刻解决 Markdown，但 reasoning/工具/错误仍会继续漂移，下一次补事件还要改两处；舍弃。
- **保留 `useChat`，再抽一个共享 reducer 给面试：** `useChat` 只接受主动发送的流，无法直接消费 agent 被动回复（面试语音、自动回复）；最终仍会出现两套状态源；舍弃。
- **把 `useReplyConversation` 留在统一投影之外：** 回复详情是第三个消费者，保留它会继续复制 revision/recovery/activities 逻辑；本次一并迁移。
- **让 components 直接引用 `app/conversationView` 的消息类型：** 会把 components 绑到 app 层；改用 `components/chat/conversationMessage.ts` 作为中立类型。

## 验收标准

- 可观察结果：面试 assistant 消息与对话面板一样渲染 Markdown、KaTeX、思考链、流式光标；三个表面消费同一消息模型。
- 自动化验证：`conversationView.test.ts`、`replyConversation.test.tsx`、`InterviewCapturePanel.test.tsx`、`FloatingBarApp.test.tsx`、`ReplyBarWindowApp.test.tsx` 全绿；UI typecheck、lint、architecture check 通过。
- 需要的实机验证：`pnpm dev:full` 下分别验证对话发送、截图答题、面试语音自动回复三条链路的 Markdown 与思考链。

## 风险

- 初始化时快照与历史事件可能重叠：正文只信快照，历史事件仅补 reasoning/activities，避免 text 双计。
- 答题会话结束后 agent 会发布空快照：回复详情依赖 `retainCapturedRound` 保留已捕获轮次，否则详情会瞬间清空。
- 答题每轮使用新的 `screenshot-<uuid>` 会话：切换必须同步更新活动会话并保留 revision 游标，否则会丢首帧或串轮。
- `send` 在 `run-finished` 后读取本轮错误；若保留旧错误不清理，会把上一轮失败误判到新一轮。投影在 assistant 消息追加时清错。

## 后果与防回退

- 新增任何会话表面必须使用 `useConversationView`，不得再写本地 `ConversationChange` reducer；消息渲染必须走 `ConversationViewMessage`。
- `packages/ui` 不再使用 AI SDK `useChat` 做消息状态；AI SDK 类型只允许留在 agent 的归一化边界与测试辅助中。
- 新增 `ConversationChange` 事件类型时只改 `conversationView.ts` 一处投影，并补 `conversationView.test.ts`；若某个表面需要额外渲染态，用 `ConversationProjectionOptions` 表达，不复制 reducer。
- assistant 正文只能通过 `AssistantMessage`/`TextResponse` 渲染，禁止在面板里直接输出 `message.text` 的纯文本节点。

## 验证

- `pnpm --filter @answra/ui test`：26 个测试文件、215 个测试通过。
- `pnpm --filter @answra/ui typecheck`：通过。
- `pnpm exec biome check`（本次变更文件）：通过。
- `pnpm architecture:check`：通过（4 个 workspace 包，无深导入、无环、无越界平台依赖）。
- 未完成：`pnpm dev:full` 下三条链路的 Windows 实机验证。
