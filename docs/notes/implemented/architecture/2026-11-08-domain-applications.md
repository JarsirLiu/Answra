# Note：领域 application 归属与 Agent 注册

状态：已实施

## 问题

Chat 的用例入口曾通过 `ChatConversationRuntime` 继承通用 runtime；Interview 回复又从 worker 注入 Conversation runtime。这样领域目录虽然存在，真正的 transcript 写入、assistant 占位和 snapshot 发布仍由另一个领域持有。

## 涉及范围

- Agent：`apps/agent/src/conversation/application.ts`、`apps/agent/src/interview/application.ts`、`apps/agent/src/interview/agent.ts`、`apps/agent/src/interview/runtime.ts`、`apps/agent/src/host.ts`
- 事件与状态：继续使用既有 `AgentEventEnvelope`、`ExecutionStore` 和 `RunOutcome`
- transcript：继续使用 `core/transcript` 的单一 `ConversationStore`

## 决定

- `ConversationApplication` 只拥有 Chat 的发送、回复、workspace 上下文和 transcript 处理；删除 `ChatConversationRuntime` 继承适配层。
- `InterviewApplication` 只拥有面试候选人 turn 的用户消息写入、assistant run 认领、snapshot 发布、事件收尾、取消和等待。`InterviewReplyLoop` 只负责语音触发状态机，通过 application 端口工作。
- `InterviewRuntime` 只拥有面试媒体生命周期和管线编排；它连接 audio ingress、VAD、ASR、turn assembler/settler 与 InterviewApplication，不承载 worker 协议。
- Interview 使用静态注册的 `interview.reply` Agent 定义，prompt 与历史上下文由 `interview/agent.ts` 组装；host 只创建并连接领域对象。
- 两个 application 都通过同一 `AgentRuntime` executor 执行模型，仍只有一条 `AgentEventEnvelope` 事实流。transcript snapshot 是查询 DTO，不是第二事件日志。

## 模块边界

`host.ts` 负责装配和 worker 命令路由；`core/agent` 负责 AI SDK、重试、run 生命周期和事件写入；`conversation`、`answer`、`interview` 分别负责自己的提示词、输入策略和 transcript 生命周期；`interview/runtime.ts` 负责媒体管线生命周期；`core/transcript` 只提供共享仓储端口与内存实现。

## 曾考虑的替代方案

- **继续由 Conversation runtime 提供 Interview reply：** 依赖方向仍然跨领域，舍弃。
- **Conversation、Interview 各复制模型执行和事件写入：** 会产生重试、run 状态和事件行为漂移，舍弃。
- **把 assistant 消息补造放到 UI：** 让 UI 成为 transcript 写者，舍弃。

## 验收标准

- 可观察结果：面试用户 turn 先发布 snapshot，assistant placeholder 在首个 AgentEvent 前发布，文本事件和终态继续更新同一 transcript。
- 自动化验证：Agent typecheck；Agent 145 项测试；Interview application 测试覆盖用户 turn、snapshot 和 Agent 启动。
- 实机验证：Windows 麦克风连续两轮、打断和真实 ASR 仍需人工验证。

## 验证

- `pnpm --filter @answra/agent typecheck`
- `pnpm --filter @answra/agent test`（145 项）
- `pnpm notes:check`
- `pnpm verify`

## 后果与防回退

- 新领域必须新增自己的 application 和静态 Agent 定义，不得把领域策略加回 Conversation application 或 host switch。
- 面试媒体流程必须通过 `InterviewRuntime` 组合；Host 不得重新持有 VAD、ASR、turn assembler 或 settle 状态。
- 当前 transcript、ExecutionStore 仍是进程内内存实现，不提供重启恢复或分布式持久化。
