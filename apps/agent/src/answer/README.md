# Answer 领域

Answer 负责截图答题的一次性应用流程。它拥有输入校验、临时 transcript 生命周期和固定 Agent 定义；模型调用、重试、事件写入由 `core/agent` 提供。

```text
answer/
  application.ts  一次性答题用例、事件回调和成功/中止清理
  agent.ts        答题 prompt、模型路由和模型选项
  host.ts         Answer-only worker 组合入口
```

Answer 不拥有第二套事件或状态机。它使用共享 `AgentEventEnvelope` 和 `ConversationStore`；失败终态保留失败消息，成功或中止后清理临时 transcript。
