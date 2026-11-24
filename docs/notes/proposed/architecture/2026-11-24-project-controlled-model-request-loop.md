# Note：项目控制的逐次模型请求循环

状态：提案

实施进度（2026-11-24）：SDK 单次请求实验、`ProviderStepRunner` 项目侧工具执行、项目 Step 限制、三类持久化会话的请求后 usage 刷新、同 Turn 活动 assistant 消息投影及跨 Step overflow 恢复已落地。自动化验证仍在进行。Note 仍留在 proposed：真实兼容端点、完整 Turn 内 tool-call/result 往返下的清理/压缩、取消及恢复集成尚未全部验证；不得据此宣称整个迁移验收完成。

### 同 Turn 内未收口消息的投影（2026-11-24）

把工具循环移出 SDK 后暴露了一个历史重建缺陷：`projectConversationMessages` 按 `status !== "streaming"` 过滤消息，而项目 Step 之间当前 Turn 的 assistant 消息必然仍是 `streaming`。于是第二 Step 的请求只剩用户消息，上一 Step 刚完成的工具调用与结果被丢弃，模型看不到结果又重复调用同一工具（实测在 CLI 中连续调用 `Skill({ name: "answra-code" })`），直到 Turn step 上限。

修正：投影接受当前 Turn 的 `activeMessageId`，只放行这一条未收口消息，且仅当它有可投影内容（非空文本或带 input 的工具调用）；其它 streaming 消息仍按原规则排除。Coding、Conversation、Interview 三个领域的消息构建都把 `snapshot.activeMessageId` 传入投影，工具 call/result 才能在下一 Step 成对出现。

## 问题

Session / Turn / Step 边界已落地，项目 Step 的目标语义是一次模型请求；但 `ProviderStepRunner` 当前通过 AI SDK `streamText` 消费整个 `fullStream`，且 Agent 定义配置 `createToolStepLimit()`，允许 SDK 在同一次调用内执行工具并继续发起多次模型请求。结果是项目 Step 仍可能包含多个 provider 请求。

这让 usage 汇总、上下文预算校准、工具结果后的上下文清理/压缩以及请求间策略缺少稳定的项目级检查点。最近的 usage 修复区分了请求 usage 与 step 总 usage，但属于对现有多请求 step 的适配，不等于项目已经控制每次请求之间的流程。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/agent/definition.ts`、`toolStepLimit.ts`：当前工具调用循环策略。
  - `apps/agent/src/core/agent/providerStepRunner.ts`、`core/model/modelTransport.ts`：单次请求执行和 AI SDK 适配边界。
  - `apps/agent/src/core/session/stepExecutor.ts`、`turnExecutor.ts`：step/turn 编排。
  - `apps/agent/src/core/context/stepContextManager.ts`、`context/preparation.ts`、`usageState.ts`、`usageAnchor.ts`：请求前上下文准备、压缩及 usage。
  - `apps/agent/src/core/transcript/`：历史事实与后续请求消息重建。
- 测试：Agent SDK 集成测试、provider step runner、工具执行、上下文准备/恢复、step/turn 事件和取消测试。
- UI/进程/协议/持久化表面：目标是维持 Session/Turn/Step 外部语义；若实现证明现有 step/事件足以表达一次请求，则不增加新的 response/attempt 架构层或 UI 状态。需要核实 transcript/tool-call/tool-result 记录是否足以重建下次请求的有效历史。
- 相关 Note：
  - [Session、Turn、Step 的职责边界](./2026-11-21-session-turn-step-boundaries.md)
  - [上下文用量按单次请求计，不按 step 求和](../../implemented/bug-fix/2026-11-24-context-usage-counts-request-not-step.md)
  - [拒绝将 Pi 作为桌面 Agent Runtime](../../rejected/architecture/2026-10-11-pi-agent-runtime-for-conversation.md)
  - [Agent 在 step 边界消费用户排队消息](../../implemented/architecture/2026-11-21-agent-step-boundary-queue.md)

## 提案

### 决策方向

将循环控制权收归项目：一次项目 Step 对应一次 provider 模型请求。AI SDK 可以继续使用，但仅作为单次请求的模型/流协议适配层；不得在单个项目 Step 内由 SDK 自动执行工具后再次请求模型。是否继续使用 `streamText`、采用其更低层单请求 API，或更换为 Pi 等实现，留待最小验证后决定；Pi 不是本提案的前置条件或默认依赖。

### SDK 实验结论与实现选择（2026-11-24）

已在锁定的 AI SDK `6.0.303` 上用 `ai/test` 的 `MockLanguageModelV3` 运行真实 `streamText`，测试位于 `apps/agent/test/core/model/singleRequestExperiment.test.ts`：

- `tools` 包含本地 `execute` 且 `stopWhen` 允许继续时，SDK 收到第一响应的 tool-call 后会执行工具，并在同一次 `streamText` 流中发起第二次模型请求；实验断言 provider `doStream` 调用为 2。故不能把当前带执行器和多步 `stopWhen` 的配置直接作为单请求 StepRunner。
- 只向 `streamText` 提供工具 schema、不提供 `execute` 时，tool-call 响应以 `finishReason: tool-calls` 收口；provider 调用数为 1。可作为保留 AI SDK 高层请求/流解析能力的单次请求边界。
- 第一响应可从 SDK response messages 取得 assistant tool-call；项目补入对应 tool-result 后，第二次独立 `streamText` 的 model prompt 含配对的 assistant call 与 tool result，往返可行。

因此选定：继续使用 `streamText`，但单次请求调用只接收声明/schema，不传任何 `execute`；SDK 返回并结束当前 Step 后，由项目工具系统校验、授权、执行并记录结果，再由下一项目 Step 重新构建完整消息历史。暂不引入 Pi 或自建 provider/SSE 协议。AI SDK 的工具输入解析与 provider 消息转换仍复用；项目拥有业务执行循环。上述 mock-model 测试证明 SDK 行为和消息往返，不代表真实供应商对所有工具历史变体的兼容性，真实兼容端点仍需后续集成验证。

### 目标流程

```text
SessionTurnExecutor                         # 一轮 Turn 唯一循环所有者
  └─ SessionStepExecutor                    # 写 step-started / step-finished 与 usage
      └─ ProviderStepRunner                 # 一次模型响应，不发起下一次请求
          1. StepContextManager.prepare     # 请求前预算、清理、压缩与重建
          2. ModelTransport.streamModel     # AI SDK streamText，仅一个 provider 响应
          3. ToolCallExecutor               # 本次响应的工具调用由项目执行
          4. StepEventSink                  # 工具结果与模型事实进入既有条目漏斗
      └─ 收口当前 Step
  └─ 若 finishReason 为 tool-calls，由 SessionTurnExecutor 开始下一 Step
      新 Step 再次经过 ContextManager.prepare
```

Step 的身份表示一次模型响应；工具执行是该响应的后续副作用，在 StepExecutor 收口前完成。因此 step usage 在 provider 响应完成时可立即刷新；Step 结算之后，TurnExecutor 才决定是否继续。工具调用的参数校验、授权、执行、拒绝/失败结果和取消仍由项目工具系统负责；模型响应格式解析可委托 AI SDK，但不把业务工具循环交给它。工具调用与结果必须作为匹配的一组历史事实，保证下一请求能重建合法上下文。达到最终文本、handoff、取消或策略上限时，由项目 Turn/Step 编排显式收口。

### 文件与职责

首轮只拆单一消费者需要的窄模块，不新增通用 loop framework，也不把 AI SDK 类型扩散到 Session 契约：

```text
apps/agent/src/core/
├─ session/
│  ├─ turnExecutor.ts          # 唯一拥有 Turn 内 Step 循环、handoff 与终态策略
│  ├─ stepExecutor.ts          # Step 生命周期、step 事件与 usage 的唯一写入者
│  └─ contracts.ts             # Session 内部端口；不 import AI SDK
├─ agent/
│  ├─ providerStepRunner.ts    # 组合一次请求、工具执行、overflow recovery；不发第二次请求
│  ├─ modelToolSet.ts          # 把已授权 ToolSet 投影为不含 execute 的模型声明
│  └─ toolCallExecutor.ts      # 执行模型返回的 tool-call，发出开始/结束事实与取消
├─ model/
│  ├─ modelTransport.ts        # streamText/provider/headers/retry 的唯一 SDK 传输边界
│  └─ streamEvents.ts          # SDK 流事件 → AgentStreamEvent 归一化
├─ tool/
│  ├─ registry.ts              # 注册、授权；现有 execute 闭包继续复用
│  └─ executor/executeToolCall.ts # 输入校验、取消/超时、handler 与输出预算
├─ context/
│  └─ stepContextManager.ts    # 每次模型请求前的上下文检查点
└─ transcript/
   └─ projection.ts            # 成对 tool-call/tool-result → 下一次 ModelMessage
```

模块契约：

- `modelToolSet.ts` 接收领域已经授权的工具集，只剥离执行能力，保留名称、描述、input schema 和 provider 工具元数据；不重新做授权。
- `toolCallExecutor.ts` 接收归一化后的 `{ toolCallId, toolName, input }` 与原始已授权工具执行闭包；未知工具、输入不合法、拒绝、失败、取消都必须形成既有明确结果，不能伪造成功结果。所有工具事实仍经 `StepEventSink`，不直接写 transcript/store。
- `ProviderStepRunner` 把 schema-only ToolSet 传给 `streamModel`；收完唯一模型响应后，按响应顺序执行本响应的 tool-call，再返回 `finishReason: tool-calls`。响应里出现多个 tool-call 时，首版顺序执行，避免并行副作用与历史次序含混；若后续需要并行，另立策略与测试。
- `SessionTurnExecutor` 只根据 StepResult 继续当前 Bot、结束 Turn 或 handoff；它不认识 AI SDK 的 ToolSet/ToolCall，也不执行工具。
- 工具结果在下一 Step 开始前已通过现有 transcript/item 漏斗写入；下次 `prepareRequest` 必须从投影历史构造合法配对的 SDK 消息。

不新建 `core/agent/loop/`：请求间的 turn 策略已有唯一所有者 `SessionTurnExecutor`；新增一个独立循环服务会与它争夺“是否继续”的状态。`toolCallExecutor.ts` 是当前真正缺失的职责模块。

### 团队并行边界

并行开发前先由集成负责人冻结 `contracts.ts` 的 StepRunner 结果与工具调用执行端口，以及 `AgentStreamEvent` 写入形状。之后按不重叠文件拆分：

1. **模型适配**：`modelToolSet.ts`、`toolCallExecutor.ts` 与 AI SDK MockLanguageModel 集成测试；只依赖冻结工具调用 DTO 与 fake event sink。
2. **历史与上下文验证**：transcript projection、工具结果配对、清理/压缩因果组测试；不改 StepRunner/工具执行实现。
3. **Turn/Step 编排验证**：Step 数、usage 结算、取消与 handoff 回归测试；用 fake StepRunner/ToolCallExecutor 驱动，不改模型适配。
4. **集成负责人**：接线 `ProviderStepRunner` 与领域组合根，处理跨任务冲突并运行全包门禁。

任何人不得为适配另一任务的私有类型而直接改对方模块；契约调整先回集成负责人统一合并。

### 每次请求之间的维护检查点

每个请求结束时至少有本次请求的独立 usage、finish reason 和模型产物；项目在继续前可以执行明确的策略钩子，包括：

- 更新上下文实际用量/锚点与运行中快照；
- 执行工具并把结果纳入 transcript；
- 基于最新 transcript 与预算清理旧工具结果；
- 必要时同步压缩并提交 checkpoint；压缩失败或压缩后仍超限时 fail-closed，不发送下一请求；
- 检查取消、step 上限及其他 turn 继续条件。

顺序和可恢复性须由测试锁定。usage 结算属于当前请求完成后的事实；预算检查、清理和压缩通常在下一请求发出前，以包含刚产生工具结果的最新历史执行。

### 硬约束

1. 每个 `StepStart` 最多且恰好对应一次实际 provider 请求；provider 内部传输重试若存在，必须沿用既有 retry 语义并明确它是否仍属同一逻辑请求，不能静默引入 SDK 工具循环。
2. 每个请求的 usage 单独结算；Turn 总消耗可聚合，但不得拿聚合值作为当前上下文占用或请求校准锚点。
3. 每次 provider 请求前必须经过 ContextManager；任何执行入口不得绕过预算/准备。
4. 工具调用与工具结果必须完整配对后才可继续请求；未完成、失败或取消工具调用不得生成伪造成功结果。
5. AI SDK 的 step/finish 汇总事件不能直接冒充项目 Step 或本次请求 usage；项目事件来源与归属保持唯一。
6. 不新增 Pi 依赖，不迁移模型供应商、不改变工具授权，不重写 Session/Turn/Scheduler/Journal；除非验证发现现有契约表达不了必需事实，再单独评估契约变更。

## 模块边界

- `core/session/TurnExecutor`：拥有 turn 内何时继续、结束或交接的策略；不执行工具，也不依赖 SDK 类型。
- `core/session/StepExecutor`：拥有项目 Step 生命周期；一次调用 `StepRunner` 后结算该请求结果，不接管 turn 终态。
- `core/agent/ProviderStepRunner`：一次请求的领域适配、响应后工具执行与结果归一；不在 SDK 控制下循环请求。
- `core/agent/ToolCallExecutor`：复用已授权执行闭包执行当前模型响应中的工具；不创建模型请求或决定 Turn 是否继续。
- `core/agent/ModelToolSet`：生成没有本地 `execute` 的 schema-only SDK ToolSet；不持有授权策略。
- `core/model/ModelTransport`：单次 provider 请求及流协议适配，不持有工具业务循环、transcript 或压缩策略。
- `core/tool`：校验、授权、执行工具并产出显式结果；不决定下一次模型请求。
- `core/context/ContextManager`：每次请求前准备/预算/清理/压缩，及请求后 usage 状态更新；不控制 turn 队列或 provider 循环。
- `core/transcript`：记录并投影模型消息、工具调用和结果；为后续请求提供可重建历史，不依赖 AI SDK 私有对象作为事实格式。

## 分阶段方案

1. **验证现状与 SDK 单次调用能力**：已完成。锁定版本实验确认传入本地 `execute` 会在一个 `streamText` 内继续请求；仅提供 tool schema 则只发一次请求并以 tool-call 结束。
2. **验证历史往返**：SDK 层已完成 mock-model 往返：从首响应取 assistant tool-call、项目补 tool-result、第二次独立调用收到成对消息。实施阶段仍须验证现有 transcript 条目折叠、压缩/清理能保持配对；若真实供应商不接受其请求历史，再针对 provider adapter 处理，不预防性更换运行时。
3. **建立单次请求契约与集成测试**：首版已落地。`modelToolSet.ts` 向 SDK 去除本地 `execute`，ProviderStepRunner 收集单响应 tool-call 并返回单请求 usage；MockLanguageModelV3 验证一响应一请求。模型响应错误在当前 Step 收口；若为 context overflow 且压缩成功，结果明确标记 `context-recovered`，由 Turn 层启动独立的新 Step。底层传输层对同一 HTTP 请求的 retry 仍由 `ModelTransport` 既有策略处理。
4. **将工具循环移至项目 Turn/Step 编排**：首版已落地。ProviderStepRunner 收完唯一模型响应后通过 `toolCallExecutor.ts` 顺序执行原授权闭包；SessionTurnExecutor 根据 `tool-calls` 或显式 `context-recovered` 继续下一 Step。项目 `prepareStep` policy 在发请求前按零基 Step index 执行，不再交给 SDK；Conversation/Coding/Interview 在每个请求结束时持久化实际 usage 并推送新快照。活动 Turn 的 streaming assistant 消息在下一 Step 纳入历史，保证工具 call/result 成对可见。仍需真实端点和清理/压缩集成验证。
5. **逐项验证运行语义**：迁移/复核重试、取消、部分流、工具失败/拒绝、overflow recovery、handoff、多 Bot、step 上限、usage anchor、自动与手动压缩、排队与恢复；按实际必要性调整事件/持久化，不做预防性 schema 扩张。
6. **移除 SDK 循环配置并收敛文档**：仅在新路径测试覆盖并通过后，移除 `createToolStepLimit()` 对 SDK 多轮循环的依赖；确认旧路径无活跃调用后再清理死代码。

## 曾考虑的替代方案

- **只修正 `onStepFinish` usage，并继续由 SDK 循环：** 不采用为最终方向。它能修复逐请求观测数字，但不能让项目在每个请求之间执行工具结果后的预算、清理/压缩和继续策略；作为过渡修复不等于边界问题已解决。
- **仅设置 `stopWhen: stepCountIs(1)`：** 不采用。循环即使恰好停止，SDK 仍持有工具执行权，也没有给工具执行后的项目检查点；测试直接证明不传本地 `execute` 才让当前请求在 tool-call 后结束。
- **立即改用 Pi：** 不预设。Pi 可能提供适合的单请求原语，但更换底座会带来协议适配、依赖和历史格式成本；控制权来自项目 loop，而非某个特定库。
- **彻底自研模型协议与流解析：** 不作为首选。项目需要自控循环，不意味着必须重写 provider 协议、流解析、供应商兼容和传输重试；只有现有单请求 API 不足以满足契约时才扩大自研范围。

## 验收标准

- 可观察结果：
  - 一次项目 Step 最多发起一次模型生成请求；工具调用后是否继续由项目显式决定。
  - 每次模型请求结束后，本次 usage 可单独读取、记录；下次请求之前可观察到 ContextManager 检查点。
  - 工具调用/结果在两个独立请求间正确配对，模型历史可从项目 transcript 重建。
  - 请求前预算不足时先完成清理/压缩；失败或仍超限则不发 provider 请求。
  - Turn、handoff、取消、重试、错误、队列和恢复仍符合既有 Session/Turn/Step 契约。
- 自动化验证：
  - AI SDK/provider 集成测试验证“tool-call → 项目工具执行 → 下一独立请求收到 call/result → final text”。
  - 断言一次模型生成响应对应一个项目 Step 和一份本次 usage；SDK 不会在第一次请求中隐式执行项目工具并再次请求。
  - 断言下一次请求前 ContextManager 被调用，且能够在该点触发清理/压缩；工具调用配对跨请求完整。
  - 覆盖工具校验失败、执行失败/拒绝、取消、部分流/异常、provider 重试、overflow recovery 与 step 上限。
  - 覆盖多 Bot handoff、turn 原子队列及恢复回归。
- 需要的实机验证：
  - 一个多工具长 Turn：逐次确认请求数、每次 usage、工具往返和状态快照一致。
  - 自动压缩恰好发生在后续请求发出前；压缩失败时上游无后续请求。
  - 真实兼容端点对 tool-call 历史格式的接受情况；不读取或记录生产秘密。

## 风险

- 不同模型/provider 对工具调用消息格式、并行工具调用和错误结果的要求不完全一致；必须以实际 provider adapter 集成测试验证。
- 历史投影/压缩可能删掉某一侧 tool-call/result，造成 provider 400 或上下文语义损坏；清理必须保持完整因果组。
- AI SDK 的 transport retry 与项目逻辑请求边界可能不同；需明确 usage、事件和 request id 的计数口径，避免重试被误计成新 Step 或漏记费用。
- 将原来 SDK 内部的工具/流错误路径改为项目编排后，失败、取消、部分输出和工具副作用的终态顺序需特别验证。
- 同步压缩会增加后续请求延迟；这是在请求边界获得确定性检查点的成本，不应通过后台异步压缩绕开 checkpoint 原子性。
