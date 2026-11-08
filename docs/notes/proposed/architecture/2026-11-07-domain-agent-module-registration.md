# Note：领域 Agent 模块注册与面试链路归属

状态：提案

## 问题

Agent 已有 `execution`、`conversation`、`interview` 目录，但职责没有落在对应领域：

- `ConversationRuntime` 同时承担对话/答题用例、Agent 执行和 transcript 更新。
- 面试音频与转写在 `interview/`，自动回复组装却在 `worker/interviewReply.ts`，并由 `worker/host.ts` 把整条面试流水线接起来。
- 面试使用 `ConversationRuntime` 启动模型。该调用能返回 run snapshot，但 worker 适配层只保留 `runId`。
- Desktop 收到 `turn-committed` 后再查询 snapshot；UI 可能先消费执行事件、推进 revision，再拒绝较旧的 snapshot。

结果是一次面试用户回合要经过多个目录的隐含协作才能显示。新增会议或其他能力时，也会继续把 prompt、工具集、触发策略和 UI 交付塞进现有对话执行入口。

## 涉及范围

- Agent：`apps/agent/src/core/`、`execution/`、`conversation/`、`interview/`、`worker/`。
- 桌面与 UI：Agent worker transport、Conversation/Interview IPC、`useConversationView` 的 snapshot 与 event 恢复。
- 共享契约：现有 `AgentEventEnvelope`、`ConversationSnapshot`、`AgentCommand` / `AgentFrame`。
- 相关 Note：[产品方向与 Agent 底座](./2026-10-20-product-direction-and-agent-foundation.md)、[对话与答题能力拆分](../../implemented/architecture/2026-10-18-ai-capability-domains-and-reuse.md)、[面试运行时模块边界](./2026-10-19-interview-runtime-module-boundaries.md)、[Agent host 组装与传输](../../implemented/architecture/2026-10-17-agent-host-composition-and-transport.md)、[面试 transcript 未显示复盘](../../implemented/bug-fix/2026-11-07-interview-transcript-not-visible.md)、[会话恢复游标](../../implemented/architecture/2026-11-07-conversation-live-recovery-cursor.md)。

本提案把“AgentRuntime 稳定、领域模块静态注册”确定为目标。Conversation、Answer 和 Interview 都是现存真实消费者；不提前建设通用插件系统。提案获准后按实施阶段推进，不一次性重写所有领域。第一阶段的面试 snapshot 竞态修复与目录归属调整、第二阶段的 `core/agent` 抽取、第三阶段的 `core/transcript` 抽取、第四阶段 Answer application 独立，以及第五阶段 Chat application 和 Interview application 归属调整已经实施。

## 提案

### 目标架构

```text
Agent bootstrap（`apps/agent/src/host.ts`，唯一组合根）
  ├── 创建 AgentRuntime、TranscriptStore、ExecutionStore
  ├── registerConversationModule(...)
  ├── registerAnswerModule(...)
  └── registerInterviewModule(...)
         │
         ├── 领域模块装配自己的 prompt、上下文规则、工具和触发策略
         └── 调用 AgentRuntime 执行已注册的 Agent 定义

AgentRuntime
  ├── AI SDK/provider 调用、重试和流归一化
  ├── run / attempt / step 生命周期、取消、等待
  └── 唯一 AgentEventEnvelope 写入与事件查询

TranscriptStore（独立于 AgentRuntime）
  └── 当前内存实现保存会话消息；不保存第二套 Agent 事件

领域 snapshot → AgentFrame → Desktop IPC 转发 → UI snapshot/event 恢复器
```

### 核心规则

1. **AgentRuntime 是通用执行底座。** 它只执行已注册的定义，拥有模型调用、AI SDK `fullStream` 消费、HTTP 重试、run 生命周期和唯一事件 store。它不决定面试何时结算、对话是否带历史或答题何时清理消息。
2. **模块注册是静态、代码内、启动时完成。** 不引入插件加载、反射、renderer 自定义 prompt/tools 或 DI 容器。Agent ID 由 Agent 代码定义，renderer 继续只能发显式的 Conversation / Answer / Interview 命令。
3. **领域模块负责组装能力。** 每个模块注册 Agent 定义（模型路由、system prompt、上下文构造、工具白名单、AI SDK 步数/选项），并持有自己的输入和业务策略。
4. **一个 AgentEventEnvelope 事实流。** `events.ts`、`status.ts` 和现有事件名不因本次架构调整而重定义。领域 transcript 只消费流事件来更新消息内容，不另建领域事件日志。
5. **保持既有 snapshot 游标语义。** 活动 run 的 `eventRevision` 是 run 首个事件之前的 `aggregateRevision`；恢复 snapshot 中该 run 的 assistant 正文为空，UI 从 cursor 后重放事件。run 终结后，snapshot 保存完整正文并把 cursor 推进到终态事件。TranscriptStore 不把已写入的 delta 正文与旧 cursor 一起作为 UI snapshot 返回。
6. **Desktop 只做边界工作。** 验证来源、转发类型化命令、事件和 snapshot；不依据 `turn-committed` 推断何时查询 transcript。
7. **UI snapshot 只有一个恢复入口。** 初次加载先订阅，再读取 snapshot 和 cursor 后的事件；加载期间暂存 live events。运行中收到推送 snapshot 时也走同一恢复流程：用 snapshot 重建，再从它的 cursor 回放，不能因已有更高的 live revision 而拒绝有效的活动 run 基线。异步恢复使用 generation 丢弃迟到结果。事件先到时先保留在 UI 缓冲中；snapshot 到达后从其 cursor 补读并顺序应用，不丢失或重复 delta。不新增第二套消息 revision 或事件。

### 建议的 AgentRuntime 接口

以下接口已在第二阶段实现；后续阶段仍可在不改变事件事实格式的前提下调整领域输入类型：

```ts
type ModelRouteId = "conversation" | "answer";

interface AgentDefinition<Context> {
  id: AgentId;
  modelRoute: ModelRouteId;
  prepare(context: Context, signal: AbortSignal): Promise<{
    system: string;
    messages: ModelMessage[];
    tools?: ToolSet;
    providerOptions?: ProviderOptions;
    stopWhen?: StopCondition;
  }>;
}

interface AgentRunHandle {
  runId: string;
  /** Cursor immediately before this run's first event. */
  eventRevision: number;
  done: Promise<RunOutcome>;
}

interface AgentExecutor<Input> {
  startRun(request: {
    conversationId: string;
    input: Input;
    /** The domain persists and publishes its assistant placeholder before run events begin. */
    onRunPrepared: (run: { runId: string; eventRevision: number }) => Promise<void>;
    /** Installed before execution; awaited in event order to update the domain transcript. */
    onEvent: (event: AgentEventEnvelope) => Promise<void>;
  }): Promise<AgentRunHandle>;
}

interface AgentRuntimePort {
  registerAgent<Input>(definition: AgentDefinition<Input>): AgentExecutor<Input>;
  configureModelRoutes(
    routes: Readonly<Record<ModelRouteId, ConversationCapabilityEndpoint>>,
  ): void;
  subscribe(listener: (event: AgentEventEnvelope) => void): () => void;
  cancel(runId: string): void;
  waitForRun(runId: string): Promise<RunOutcome>;
  getRun(runId: string): AgentRun | undefined;
  getConversationRevision(conversationId: string): Promise<number>;
  readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]>;
  dispose(): void;
}

```

`registerAgent` 在启动时接收领域定义并返回保留输入类型的 executor；当前由 `apps/agent/src/host.ts` 与 Answer-only host 静态注册。`prepareRun` 在首个事件前等待领域 application 创建助手占位 snapshot 并组装输入；`onEvent` 在 `startRun` 调用时已经安装，按序收到每个追加的 envelope，Runtime 等待领域 transcript 更新后才继续该事件源。模型端点来自 Desktop 配置，Runtime 不接收 renderer 提供的 prompt/tools。

## 模块边界

### 文件清单

下列是本次目标架构涉及的文件清单。`新增`、`迁移`、`调整` 是提案；现有未列出的 VAD/ASR 算法不改行为。

### `apps/agent/src/core/`

| 文件 | 函数 / 类型职责 | 变更 |
| --- | --- | --- |
| `core/agent/definition.ts` | 定义品牌 `AgentId`、模型路由、模型请求、AgentDefinition、Executor、Prepared run handle；只描述执行输入，不含产品命令和 UI DTO。 | 已新增 |
| `core/agent/registry.ts` | `register(id)` 拒绝重复 ID；`require(id)` 对未注册能力显式失败。仅组合根静态注册。 | 已新增 |
| `core/agent/runtime.ts` | 提供静态注册、模型路由、run 取消/等待、事件查询与 store 通知；`AgentExecutor.startRun` 先等待领域准备再执行。 | 已新增 |
| `core/agent/executeRun.ts` | `executeRun` 调用 AI SDK、消费模型流、执行工具循环、写现有事件并结束 run；不写 transcript。 | 已从 `conversation/turn/executeTurn.ts` 拆出 |
| `core/agent/streamJournal.ts` | `createExecutionJournal` 串行追加现有 AgentEvent 到 ExecutionStore、维护诊断 metrics，并等待领域事件回调；不更新消息文本。 | 已从 `conversation/turn/streamJournal.ts` 拆出 |
| `core/model/consumeStream.ts` | `consumeModelStream` 消费 AI SDK `fullStream` 并交给事件 writer。 | 保留；被 AgentRuntime 使用 |
| `core/model/streamEvents.ts` | `normalizeStreamPart`、`normalizeWarning` 将 AI SDK 类型归一为 shared 事件。 | 保留 |
| `core/model/retryFetch.ts` | `createRetryingFetch` 执行 HTTP 限流/服务错误自动重试。 | 保留 |
| `core/model/providerFetch.ts` | `validateEndpoint`、`createAuthorizedFetch`、`createLocalFetch` 处理 provider 请求边界与认证。 | 已从 `conversation/turn/endpointFetch.ts` 迁移 |
| `core/model/errorSummary.ts` | `summarizeModelError` 将 provider 错误归一为安全诊断摘要。 | 已从 `conversation/turn/errorSummary.ts` 迁移 |
| `core/model/imageInput.ts` | `parseDataUrl` 将输入图片 data URL 转为模型可用的 bytes/media type。 | 已抽出供 Conversation 与 Answer 共用 |
| `core/model/README.md`、`core/run/README.md` | 记录各自机制边界。 | 更新说明 |
| `core/run/registry.ts` | `RunRegistry` 维护 AbortController、活动 run 和完成等待原语。 | 保留；由 AgentRuntime 组合 |
| `core/transcript/store.ts` | 定义中立的 transcript 仓储端口：`create/load/appendUser/beginAssistant/applyStreamEvent/finish/clear`。保存消息和它的恢复 cursor，不写 AgentEventEnvelope。 | 从 `conversation/session/store.ts` 提取并瘦身 |
| `core/transcript/memoryStore.ts` | 实现上述端口；当前只保存在内存，不承诺进程重启恢复。 | 从 `conversation/session/memoryStore.ts` 迁移 |
| `core/transcript/message.ts` | `createUserMessage` 等 transcript 值构造器。 | 从 `conversation/session/message.ts` 迁移 |
| `core/README.md` | 写明 Runtime、TranscriptStore、ExecutionStore 三者边界和依赖方向。 | 更新 |

TranscriptStore 是 Conversation 与 Interview 已经共享的实际数据能力，不是新产品领域；Answer 继续用一次性输入，不要求长期 transcript。它不拥有 run 生命周期或事件日志。

### `apps/agent/src/execution/`

| 文件 | 函数 / 类型职责 | 变更 |
| --- | --- | --- |
| `events.ts` | `createExecutionEvent` 构造 envelope 元数据。 | 保留，AgentRuntime 调用 |
| `status.ts` | `canTransitionRun`、`isTerminalRunState` 定义 run 状态迁移约束。 | 保留 |
| `store.ts` | `ExecutionStore` 定义 run、revision、事件追加与读取端口。 | 保留 |
| `memoryStore.ts` | `MemoryExecutionStore` 提供进程内唯一事件事实流和查询。 | 保留；注入 AgentRuntime |

事件 payload 和状态词汇继续只定义在 `packages/shared/src/schema/events.ts` 与 `status.ts`；本方案不新增 `InterviewEvent`、`ChatEvent` 等事实类型。

### `apps/agent/src/conversation/`（保留对话领域名，重整现有目录）

| 文件 | 函数 / 类型职责 | 变更 |
| --- | --- | --- |
| `module.ts` | `registerConversationModule(deps)` 调用 `agentRuntime.registerAgent(generalConversationAgent)`，返回 `send/getSnapshot/clear/dispose` 用例入口。 | 新增 |
| `application.ts` | `sendMessage` 校验输入并写 user transcript；调用已注册 executor，在 `onRunPrepared` 中以分配的 runId/cursor 写 assistant 占位并发布 snapshot；订阅该 run 的文本事件写回 transcript；`getSnapshot` 组合 transcript 与保存的恢复 cursor。 | 从 `ConversationRuntime.sendChat/getSnapshot` 拆分 |
| `agent.ts` | `generalConversationAgent` 注册通用对话 system prompt、历史上下文策略、工具白名单与模型路由。 | 从 `conversation/profiles/registry.ts` 迁移 |
| `context/messages.ts` | `buildConversationMessages` 组装对话历史；只读取 TranscriptStore，不读取 UI 状态。 | 从 `turn/modelMessages.ts` 拆分 |
| `context/timeReminder.ts` | `buildTimeReminder` 追加对话专属时间提示。 | 从 `conversation/turn/timeReminder.ts` 迁移 |
| `context/workspaceContext.ts` | `buildWorkspaceSystemContext` 只为有工作区工具授权的定义构造系统上下文。 | 从 `conversation/turn/workspaceContext.ts` 迁移；保留当前未提交实现和测试内容 |
| `tools/types.ts` | 对话工具 ID 与工具调用上下文类型。 | 保留并调整文件头职责 |
| `tools/registry.ts` | `createConversationTools` 按 Agent 定义的静态白名单构造工具集。 | 从 `conversation/tools/registry.ts` 改名 |
| `tools/read.ts`、`tools/grep.ts`、`tools/workspace.ts` | `executeRead`、`executeGrep` 和路径/大小/取消校验等工作区工具实现。 | 保留在对话领域；不搬到 Desktop |
| `request.ts` | `validateConversationRequest` 校验文本、图片数量和 data URL 外部输入。 | 从 `conversation/turn/requestContent.ts` 拆分；模型 bytes 解析移到 `core/model/imageInput.ts` |
| `README.md` | 说明对话领域拥有多轮产品策略和 Agent 注册，不拥有通用执行状态机。 | 更新 |

### `apps/agent/src/answer/`（由现有答题 profile 拆出）

| 文件 | 函数 / 类型职责 | 变更 |
| --- | --- | --- |
| `module.ts` | `registerAnswerModule(deps)` 调用 `agentRuntime.registerAgent(screenshotAnswerAgent)`，返回显式 `answer.run` 入口。 | 新增 |
| `application.ts` | `runAnswer` 准备一次性输入，调用 AgentRuntime，终结后清理本轮临时数据。 | 从 `ConversationRuntime.runAnswer/startRun` 拆分 |
| `agent.ts` | `screenshotAnswerAgent` 固定答题 prompt、模型路由、temperature/reasoning 选项；不读取对话历史。 | 从 `conversation/profiles/answer.ts` 迁移 |
| `request.ts` | `validateAnswerRequest` 校验截图问答输入。 | 从 `conversation/turn/requestContent.ts` 拆分共享校验后 co-locate |

### `apps/agent/src/interview/`

| 文件 / 目录 | 函数 / 类型职责 | 变更 |
| --- | --- | --- |
| `module.ts` | `registerInterviewModule(deps)` 调用 `agentRuntime.registerAgent(interviewReplyAgent)`，再装配 InterviewApplication 和面试媒体 runtime；返回 `start/stop/acceptAudioFrame/sendText/dispose` 端口。注入 VAD/ASR source、TranscriptStore 与发布回调，不 import worker protocol。 | 新增；领域组合入口 |
| `application.ts` | `commitCandidateTurn` 追加完整用户消息并立即发布 snapshot；`startReply` 调用已注册 executor，在 `onRunPrepared` 中认领助手消息并发布带起始 cursor 的 snapshot；订阅该 run 文本事件更新 transcript；`getSnapshot` 读取恢复基线。 | 从 `worker/interviewReply.ts`、`worker/host.ts` 收回 |
| `runtime.ts` | `startSession`、`stopSession`、`acceptAudioFrame` 连接 ingress、VAD、ASR、turn assembler 和 InterviewApplication；不做算法实现。 | 从 `worker/host.ts` 拆出 |
| `contracts.ts` | 当前 brand ID、PCM、VAD、transcription、turn、session 与领域事件类型。 | 保留；只在实际契约变化时改 |
| `audio/ingress.ts` | `InterviewAudioIngress` 接收、投递和结束 Agent 侧 PCM 会话。设备采集仍在 Desktop。 | 保留 |
| `audio/pcmFrameValidator.ts` | `PcmFrameValidator` 校验帧格式、顺序和 gap。 | 保留 |
| `vad/config.ts` | VAD 参数常量和 `msToSamples`。 | 保留 |
| `vad/pipeline.ts` | `InterviewVadPipeline` 接 detector/segmenter 并发布 speech/segment 回调。 | 保留 |
| `vad/segmenter.ts` | `VadSegmenter` 管理 PCM 分段、预录与边界。 | 保留 |
| `vad/speechDetector.ts` | `SpeechActivityDetector` 把 hop VAD 输出归一成语音活动。 | 保留 |
| `vad/tenVadEngine.ts` | `createTenVadEngine` 装配 TEN VAD native source。 | 保留 |
| `transcription/pump.ts` | `TranscriptionPump` 调度 segment 转录 session 并发布归一事件。 | 保留 |
| `transcription/local/adapter.ts` | `LocalParaformerAdapter` 适配本地 recognizer。 | 保留 |
| `transcription/local/recognizerPort.ts` | recognizer session/assembly/source 端口。 | 保留 |
| `turns/assembler.ts` | `InterviewTurnAssembler` 合并 transcript chunks 成 turn。 | 保留 |
| `turns/settler.ts` | `CandidateTurnSettler` 合并短句并在结算后通知 application。 | 保留；回调改接 InterviewApplication |
| `reply/loop.ts` | `InterviewReplyLoop` 串行化 turn 回复、开口打断、session/speech epoch。 | 保留在 Interview；startReply 结果携带 run 与 snapshot |
| `reply/loop.ts` | 已确认 interview turn 的排队、回复 API 调用和会话停止收口。语音活动不直接控制 AI run。 | 保留 |
| `reply/agent.ts` | `interviewReplyAgent` 注册面试 prompt、历史/上下文策略、工具授权和模型路由。 | 从 `reply/profile.ts` 改为静态 Agent 定义 |
| `evaluation.ts` | 暴露 VAD/ASR 评测所需类型。 | 保留 |

Interview 模块拥有“识别 turn → 写用户 transcript → 启动回复 → 发布 snapshot”的完整流程。模型生成仍由 AgentRuntime 执行；Audio/VAD/ASR 算法仍由现有文件负责。

### `apps/agent/src/worker/`

| 文件 | 函数 / 类型职责 | 变更 |
| --- | --- | --- |
| `protocol.ts` | `AgentCommand`、`AgentFrame` 唯一 worker 线协议。新增独立 `conversation-snapshot` frame（带 `ConversationSnapshot`）；它是查询状态通知，不是 AgentEvent。 | 调整一次，desktop worker 必须同步；本目录只保留协议类型 |
| `interviewProjection.ts` | `toInterviewWorkerEvent` 将 Interview 内部事件投影为 worker DTO。 | 移至 `interview/` 边界 adapter；worker 目录不承载 projection 实现 |
| `protocol.ts` Interview commands | 新增 `interview-send-text`，载荷只有 `conversationId/text`；worker 路由到 InterviewModule 的 `sendText`。 | 从现有通用 append 入口改为面试显式命令 |

### Agent 组合根与 Answer 入口

| 文件 | 函数 / 类型职责 | 变更 |
| --- | --- | --- |
| `apps/agent/src/host.ts` | 当前 `startAgentHost` 创建共享 stores/runtime、路由显式命令和帧、连接面试领域 adapter 并统一 dispose；目标中再逐阶段改为静态注册领域模块。只装配，不实现面试算法。 | 从 `worker/host.ts` 移出 |
| `apps/agent/src/answer/host.ts` | Answer-only worker 组合入口，只装配 AnswerModule 和 transport，不复制执行逻辑。 | 从 `worker/answerHost.ts` 移出 |
| `apps/agent/src/interview/reply/createReplyLoop.ts` | 组合 InterviewReplyLoop 与 Interview-owned policy/profile/application ports。 | 从 `worker/interviewReply.ts` 移出 |

`apps/agent/src/index.ts` 只导出 Agent host、线协议类型和公开评测入口；内部 ConversationRuntime 与 store 不再作为 desktop 跨包 API。`apps/agent/src/answer/host.ts` 和 `apps/desktop/src/main/conversation/workerAnswerTransport.ts` 作为 Answer-only 构建入口保留，但调用相同的 AgentRuntime 与 AnswerModule，不复制执行器。

现有 `conversation/turn/` 的拆分归属如下，避免把文件机械整包搬进 `core/`：

| 当前文件 | 当前职责 | 目标文件 |
| --- | --- | --- |
| `executeTurn.ts` | AI SDK 调用、provider 配置、事件消费、run 终态和 transcript 收尾混合。 | 已拆为 `core/agent/executeRun.ts` 执行模型与 run；Conversation application 在事件回调更新 transcript |
| `streamJournal.ts` | 追加 AgentEvent，同时把 text delta 写入 ConversationStore。 | 已迁入 `core/agent/streamJournal.ts`，只写 ExecutionStore；领域 application 按序消费 envelope |
| `endpointFetch.ts` | provider endpoint 校验、云端/本地 fetch。 | 已迁至 `core/model/providerFetch.ts` |
| `errorSummary.ts` | provider 错误压缩。 | 已迁至 `core/model/errorSummary.ts` |
| `modelMessages.ts` | Conversation 历史与本轮图片转换成 AI SDK messages。 | `conversation/context/messages.ts` + `core/model/imageInput.ts` |
| `requestContent.ts` | 用户请求校验与图片 data URL 解码。 | 对话/答题各自 `request.ts` 做入口校验；通用图片解码进 `core/model/imageInput.ts` |
| `timeReminder.ts`、`workspaceContext.ts` | 对话产品策略。 | `conversation/context/`；不进入 AgentRuntime |
| `runtime.ts`、`chatRuntime.ts` | ConversationStore、Answer 策略和执行器的组合。 | 删除；由 ConversationModule、AnswerModule、AgentRuntime 各自承担清晰职责 |

`conversation/README.md` 的职责说明并入该目录下新的职责表；当前未提交的 `workspaceContext.ts`、对应测试和 Note 必须原样保留，实施迁移时一起移动/更新，不能覆盖或丢弃。

### Desktop、shared 与 UI

| 文件 | 函数 / 类型职责 | 变更 |
| --- | --- | --- |
| `apps/desktop/src/main/conversation/agentService.ts` | `AgentService` 管 worker 生命周期、命令请求、事件/snapshot listeners。新增 `onSnapshot`，转发 `conversation-snapshot` frame。 | 调整 |
| `apps/desktop/src/main/conversation/conversationIpc.ts` | 注册 Conversation channels；校验 renderer 来源；订阅 `onSnapshot` 后转发 snapshot，继续转发 AgentEventEnvelope。 | 调整为唯一会话 snapshot IPC 转发入口 |
| `apps/desktop/src/main/interview/interviewIpc.ts` | 管麦克风权限、PCM capture 与 Interview commands。 | 移除 `turn-committed → getSnapshot()` 查询；只保留音频及面试 IPC |
| `apps/desktop/src/main/conversation/workerTransport.ts` | Electron parentPort 到 `AgentTransport` 的适配。 | 同步新 frame 类型；不含产品流程 |
| `apps/desktop/src/main/window.ts` | `sendConversationSnapshot`、`sendConversationEvent` 将已验证 DTO 发送到目标窗口。 | 保留传输 helper；不含查询和领域判断 |
| `apps/desktop/src/main/index.ts` | 注册 `AgentService`、`ConversationIpc` 与 `InterviewIpc`，连接平台资源和模型配置。 | 调整组装顺序；不装配面试处理算法 |
| `apps/desktop/src/main/interview/interviewCaptureService.ts` | `InterviewCaptureService` 持有 Electron 麦克风采集 session、PCM frame 和 Agent audio credit。 | 保留；设备/权限仍是 Desktop 平台职责 |
| `apps/desktop/src/main/interview/asrRecognizer.ts` | `createParaformerRecognizerModule` 校验并创建本地 ASR native module。 | 保留资源 adapter；Agent Interview 拥有转录策略 |
| `apps/desktop/src/main/interview/tenVadResources.ts` | `createTenVadFileSource` 校验并提供 TEN VAD 资源。 | 保留资源 adapter；Agent Interview 拥有 VAD 流程 |
| `packages/shared/src/schema/events.ts`、`status.ts` | 现有 AgentEvent payload 和状态词汇。 | 不变，不新增领域事件 |
| `packages/shared/src/schema/conversation.ts` | 现有 `ConversationSnapshot` DTO 与 `eventRevision`。 | 本阶段不改字段；不称为 durable snapshot |
| `packages/shared/src/channels/conversation.ts` | 现有会话 IPC ChannelMap。 | SnapshotChanged 频道不另造第二份 |
| `packages/shared/src/channels/interview.ts` | `InterviewChannels` 与 `InterviewChannelMap` 拥有 `SendText` IPC 请求/响应契约。 | 新增面试文本发送频道 |
| `packages/shared/src/bridge.ts` | `DesktopBridge.sendInterviewText` 将类型化面试文本命令暴露给 UI。 | 新增；移除仅服务面试的 `appendConversationUserMessage` |
| `apps/desktop/src/preload/index.ts` | `sendInterviewText` 只转发 `InterviewChannels.SendText`。 | 新增薄转发 |
| `apps/desktop/src/main/interview/interviewIpc.ts` | 校验窗口 sender、面试会话 id 与文本，调用 `AgentService.sendInterviewText`。 | 接手现位于 `conversationIpc.ts` 的面试专用 AppendUserMessage handler |
| `apps/desktop/src/main/conversation/conversationIpc.ts` | 通用 Conversation channels 不再含硬编码 interview ID 的 AppendUserMessage handler。 | 删除面试专属逻辑 |
| `packages/ui/src/app/FloatingBarApp.tsx` | 面试面板 `onSendText` 调用 `sendInterviewText` 并消费返回的 Interview snapshot。 | 移除跨领域的 `appendConversationUserMessage` 调用 |
| `packages/ui/src/app/useInterviewConversation.ts` | 对 snapshot 通知统一调用恢复入口；暴露面试自己的 send 操作封装。 | 调整 |
| `packages/ui/src/app/useConversationView.ts` | `reconcileSnapshot` 暂存 live events、按 snapshot cursor 补读、去重并 drain revision 序列。 | 调整；所有 snapshot 入口走同一恢复流程 |
| `packages/ui/src/app/conversationView.ts` | `applyConversationSnapshot` 与 `applyAgentEvent` 唯一会话 UI reducer。 | 保持单一投影；不能从未知 run 推导占位消息 |
| `packages/ui/src/app/useConversationChat.ts`、`useInterviewConversation.ts` | 普通对话、面试交互调用共享 view/recovery 入口。 | 调整调用方式，不再各自重放事件 |

### 目标依赖方向

```text
conversation ─┐
answer ────────┼──> core/agent + core/model + execution + core/transcript
interview ──┘

worker ──> 注册领域模块并映射线协议
desktop ──> worker transport / IPC 转发
UI ──> snapshot + AgentEventEnvelope 恢复与投影
```

领域模块不互相 import；core 不依赖领域；Desktop 不执行 Agent 工具；worker 不包含具体面试流程。会议模块在真正启动时再按同一注册入口加入，不先建空目录。

## 面试 snapshot 的目标流向

```text
InterviewApplication.commitCandidateTurn
  └── TranscriptStore.appendUser → snapshot(user, eventRevision = 当前 transcript 保存的恢复 cursor)
       └── emitSnapshot(snapshot) → worker host 映射为 AgentFrame(conversation-snapshot)
            → AgentService.onSnapshot
            → Conversation IPC SnapshotChanged
            → UI reconcileSnapshot

InterviewApplication.startReply
  └── AgentExecutor.onRunPrepared(runId, cursor)
       └── TranscriptStore.beginAssistant → snapshot(user + assistant placeholder, run 开始前保存的 cursor)
       └── emitSnapshot(snapshot) → 同一 snapshot frame/IPC 路径
            → UI 以 snapshot.eventRevision 为基线，回放之后的 AgentEventEnvelope
```

即使模型配置或启动失败，已识别的用户消息 snapshot 仍先显示。助手占位 snapshot 必须在该 run 的首个 AgentEvent 之前发布；模型后续文本由同一事件流更新。Desktop 不查询“最新状态”，InterviewApplication 是面试消息和 snapshot 的唯一写入/发布者；worker host 只把回调投影成帧；AgentRuntime 是 run/event 的唯一写入者。

## 实施阶段

1. 审核并冻结目标目录、AgentDefinition 输入、snapshot owner 与 worker frame；同步更新 `AGENTS.md`、`answra-vision` 和本 Note 的决定。
2. 抽取 `core/agent`，把当前 `executeTurn` 中 provider 调用、AI SDK 流处理、重试、事件写入和 run 完成逻辑移入 AgentRuntime；先用 Chat 和 Answer 双消费者验证。
3. 将 transcript 仓储提取为 `core/transcript`；Chat、Answer、Interview 不各自复制 message store。Answer 使用明确的一次性清理策略。
4. 把 Chat/Answer 用例定义移到各自模块，移除 `ConversationRuntime` 多职责组合。保持 UI 可见行为和 worker 命令语义。
5. 把 InterviewReplyLoop/application 与媒体管线从 worker host 收回 `interview/`；由 InterviewApplication 直接发布两个关键 snapshot。
6. 增加 snapshot frame 转发和 UI 恢复时序修复；删掉 Desktop 事后查询路径。
7. 逐阶段补测试、跑 `pnpm notes:check` 与 `pnpm verify`，最后按 diff 更新结构文档。

每个阶段应是独立可审查提交；不得一次性重写所有领域。截至 2026-11-08：第 1 阶段边界同步、第 2 阶段 `core/agent` 抽取、第 3 阶段 `core/transcript` 抽取、第 4 阶段 Answer application 独立、第 5 阶段 Chat/Interview application 归属调整，以及第 6 阶段面试媒体 runtime 收回和 transcript 时序修复已完成；真实持久化和重启恢复仍不在本提案范围。

## 曾考虑的替代方案

- **继续扩展 `ConversationRuntime`，仅修复 interview snapshot：** 改动较少，但 Interview 仍依赖 Conversation 的执行组合，后续 Meeting/其他 Agent 能力会继续跨域接线；无法满足模块自持 Agent 定义的目标。
- **Conversation、Answer、Interview 各复制模型流和 run lifecycle：** 领域隔离更强，但 AI SDK 归一、重试、取消、状态迁移和事件写入会形成多个实现，事件行为容易漂移。
- **引入插件市场、动态脚本或通用 DI 框架：** 扩展性更泛化，但当前只需静态 Agent 代码注册；会扩大权限边界和调试成本，不采用。
- **在 UI 根据事件自动补造缺失 assistant message：** 可暂时掩盖 snapshot 丢失，却把 transcript 写入事实搬到 UI；违反单一写入来源，不采用。
- **Desktop 继续在 `turn-committed` 后拉 snapshot：** 保留时序竞态，并把领域恢复策略放入平台进程，不采用。

## 验收标准

- 可观察结果：Interview 识别文本先形成用户消息；回复认领时出现助手占位；文本、重试和终态沿现有 AgentEventEnvelope 更新；切页后不丢消息、不重复 delta。
- 架构约束：Chat/Answer/Interview 都通过静态注册使用同一个 AgentRuntime；新领域只需在本领域组装 Agent 定义和 application，不修改另一个领域的执行分支。
- 单一事实：AgentEventEnvelope 仍是唯一执行事件事实；transcript 是消息数据；ConversationSnapshot 是带恢复游标的查询 DTO；无第二事件 journal。
- 自动化验证：覆盖注册重复/未知 Agent、执行流/取消/失败、领域定义隔离、Interview 用户消息 snapshot、事件先到后 snapshot、snapshot 后继续流式输出、UI revision 缺口补读、worker frame 往返。
- 质量门禁：架构检查禁止 `core → domain`、`domain → domain`、`worker → domain implementation`；`pnpm notes:check` 与 `pnpm verify` 通过。
- 需要的实机验证：Windows 面试连续识别两轮，确认 user snapshot、assistant placeholder、自动回复和再次开口打断；自动化不替代麦克风实机验证。

## 风险

- 这是跨 Agent、worker、Desktop、UI 的架构调整，涉及文件多；必须按实施阶段拆分并保留当前工作区未提交改动。
- `AgentDefinition.prepare` 若接收过宽的上下文，可能成为绕开工具授权的通用入口；实现时必须由静态领域模块闭包提供，不让 renderer 传入。
- AgentRuntime 对模型选项和 ToolSet 的 API 必须在实现前对照当前 AI SDK 版本核实；本 Note 中接口是待审核草案。
- TranscriptStore 与 ExecutionStore 仍为独立内存写入；进程崩溃和重启恢复不在本方案范围，不能声称提供跨进程重启恢复。
- `ConversationSnapshot` 名称会继续用于 Interview 面板查询 DTO；若未来出现语义不相同的 Meeting transcript，应先评估是否复用同一消息结构，不因注册架构而强行统一业务模型。
