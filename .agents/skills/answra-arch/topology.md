# 进程与包拓扑

本文件回答：谁在哪个进程、依赖方向、一条消息怎么走。

## 拓扑

```text
desktop main (Electron)
├─ ipc/*                            窗口与领域 IPC（校验来源 + 转发）
├─ agent/agentWorkerHost.ts         utilityProcess.fork + AgentCommand/AgentFrame 适配
└─ conversation/workerTransport.ts  注入 SqliteConversationStore / SqliteSessionJournal
        │  worker 线协议：apps/agent/src/worker/protocol.ts
        ▼
agent utility process
├─ host.ts                          组合根：1 × SessionFrameBus / ToolRegistry / AgentRuntime
├─ ConversationApplication ─┐
├─ InterviewApplication    ─┼─→ SessionRuntime ─→ TurnScheduler ─→ TurnExecutor
├─ CodingApplication       ─┤                         └─→ StepExecutor ─→ ProviderStepRunner
└─ AnswerApplication       ─┘
        │  SessionRuntimeJournal.append（唯一写入顺序）
        ▼
  ① SessionJournal（sessions.sqlite / 内存）
  ② SessionFrameBus.publish(SessionFrame)
  ③ SessionTranscriptBridge.apply → ConversationStore 快照 + advanceLastSeq
        │
        ├─ durable：SessionFrame（带连续 seq，可重放）
        └─ live：LiveFrame（无 seq，只承载增量）
        ▼
宿主（只折叠，不推理）
├─ desktop renderer   useConversationView ─┐
├─ CLI TUI            tui/app/viewStore    ─┴→ @answra/ui/conversation-view
│                                              foldConversationFrame + overlayLiveFrame
├─ remote host        转发帧与 read-frames（不做投影）
└─ mobile             Phase 0 骨架，未消费帧
```

## 依赖铁律

`pnpm architecture:check` 强制：

- `shared` 被所有包依赖，自身不依赖任何业务包。
- `agent` 不 import Electron；平台能力留在 `desktop`。
- `desktop` 只从 `@answra/agent` 的 `exports` 入口导入；CLI 用 `@answra/agent/composition`。
- 跨包禁止深导入、禁止相对路径跨包。
- `remote` 只依赖 `shared`；`remote-node` 只依赖 `remote` + `shared` + Node 内置；controller 侧不得依赖 `remote-node`。
- `mobile` 只依赖 `shared` + `remote`，不 import agent/config/credentials/ui/desktop/cli。

## 一条消息的旅程

```text
renderer / TUI 输入
  → IPC chat.send（带 botId / profileId）
  → worker AgentCommand
  → Application.submitTurn（校验模型输入与 Bot 归属）
  → SessionRuntime.submit → TurnScheduler
      ├─ busy：写 turn-queued，排队等位置
      └─ 空闲：写 turn-queued + turn-started，占位 assistant 消息
  → TurnExecutor：step 循环（每次 step 一条 step-started/finished）
      → ProviderStepRunner：AI SDK 单次请求（流式 text/tool 事实 + live delta）
      → 工具：ToolRegistry.authorize → executeToolCall → tool-result / tool-error
  → turn-finished（completed / failed / aborted）
  → 每条事实按「journal → frame → transcript」固定顺序落地
  → 宿主按 seq 折叠成 ConversationView
```

## 宿主职责边界

| 宿主 | 允许 | 禁止 |
| --- | --- | --- |
| desktop main | 窗口、IPC、worker 生命周期、注入存储与工作区上下文 | 代执行 Agent 工具、复制连接/重试语义 |
| CLI | 组装 coding host、TUI 投影、模型配置 | import Electron/desktop、启动 VAD/ASR |
| remote host | 转发帧与 read-frames、host key（safeStorage/keychain） | 复制信令/重连协议、在 controller 侧依赖 `remote-node` |
| renderer / TUI | 折叠帧、渲染 | 解析工具输出、注入 prompt/工具、自行补 seq |

相关：`events.md`、`state.md`。
