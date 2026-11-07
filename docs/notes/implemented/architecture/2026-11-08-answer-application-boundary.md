# Note：Answer application 独立于 Conversation

状态：已实施

## 问题

截图答题已经拥有静态 Agent 定义，但执行用例仍由 `ConversationRuntime.runAnswer()` 处理。Conversation application 因此继续承载 Answer 的请求校验、临时 transcript 安装和完成后清理策略。

## 涉及范围

- 代码/模块：`apps/agent/src/answer/`、`apps/agent/src/conversation/turn/`、Agent host 和对应测试。
- UI/进程/协议/持久化表面：`answer-run` 命令、AgentEventEnvelope 和 ConversationSnapshot 契约不变；transcript 仍是进程内存。
- 相关 Note：[共享 transcript 仓储归属](./2026-11-08-core-transcript-store.md)、[领域 Agent 注册与运行时底座](../../proposed/architecture/2026-11-07-domain-agent-module-registration.md)

## 决定

AnswerApplication 在 Answer 领域持有截图答题用例：校验请求、通过已注册的 Answer executor 原子安装一次性用户/assistant transcript、消费同一 AgentEventEnvelope 更新 transcript，并在成功或中止后清理本轮消息。失败结果保留失败 transcript，遵循既有行为。

ConversationRuntime 只保留 Conversation transcript 与 Chat/Interview 当前所需的会话能力；Agent host 在 `answer-run` 命令处分发给 AnswerApplication。AgentRuntime、ExecutionStore 与 ConversationStore 仍由组合根共享，没有新增事件流或状态来源。

## 模块边界

- `answer/application.ts` 拥有答题请求与一次性清理策略，不拥有 Agent 模型执行实现。
- `answer/agent.ts` 拥有答题 prompt 与模型选项。
- `core/agent` 执行静态注册的 Answer 定义并写入唯一 AgentEventEnvelope。
- `core/transcript` 保存临时消息；AnswerApplication 决定何时调用 `clear`。
- `host.ts` 只组合依赖并按线协议命令路由，不实现答题策略。

## 曾考虑的替代方案

- **继续把 `runAnswer` 留在 ConversationRuntime：** 变更最小，但 Conversation 继续拥有 Answer 策略与临时消息生命周期，领域依赖方向仍不正确，舍弃。
- **把 Answer 复制为单独的模型执行器：** 会复制调用、重试、事件和终态处理，与 AgentRuntime 的唯一执行责任冲突，舍弃。
- **让 Answer 写第二种执行事件：** 会造成事实流漂移，不符合现有共享事件契约，舍弃。

## 验收标准

- 可观察结果：`answer-run` 经 AnswerApplication 执行；成功/中止后只清理 Answer 临时 transcript，失败时保留失败结果。
- 自动化验证：Answer 回归测试、Agent 全量测试、全仓 verify、Note 检查和架构检查通过。
- 需要的实机验证：无 UI/worker 契约变化；不替代截图答题端到端产品验证。

## 后果与防回退

- Chat 与 Answer application 现在分属 Conversation 和 Answer；Interview 仍需下一阶段从 ConversationRuntime 收回自己的 reply application/runtime。
- Answer 临时 transcript 的清理归 AnswerApplication；不可把 `runAnswer` 重新加回 ConversationRuntime。
- `AgentEventEnvelope` 和 `AgentRuntime` 仍是唯一执行事件来源；不可让 Answer application 自建事件记录或状态迁移。

## 验证

- `pnpm notes:check`
- `pnpm verify`
