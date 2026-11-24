# 进程与包拓扑

本文件回答：谁在哪个进程、依赖方向、一条消息怎么走。

## 拓扑

```text
desktop main (Electron)
├─ ipc/*                            窗口与领域 IPC（校验来源 + 转发）
├─ agent/agentWorkerHost.ts         utilityProcess.fork + AgentCommand/AgentFrame 适配
└─ conversation/workerTransport.ts  注入 SqliteConversationStore 及其 items
        │  worker 线协议：apps/agent/src/worker/protocol.ts
        ▼
agent utility process
├─ host.ts                          组合根：1 × SessionFrameBus / ToolRegistry / AgentRuntime
├─ ConversationApplication ─┐
├─ InterviewApplication    ─┼─→ SessionRuntime ─→ TurnScheduler ─→ TurnExecutor
├─ CodingApplication       ─┤                         └─→ StepExecutor ─→ ProviderStepRunner
└─ AnswerApplication       ─┘
        │  SessionItemRecorder.append（唯一写入顺序）
        ▼
  ① SessionItemStore（sessions.sqlite / 内存）：分配 seq 并写条目
  ② SessionFrameBus.publish(toSessionItemFrame)
  ③ ConversationStore 内存视图 + advanceLastSeq
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
  → 用户消息先写 user 条目，再进 TurnScheduler 队列
  → TurnExecutor：beginTurn 置 open_turn_id，占位 assistant 消息
  → step 循环（Step 只留在内存与 timeline 投影，不单独落条目）
      → ProviderStepRunner：目标为一个 Step 一次 AI SDK 模型响应（live delta + 结算事件）
      → 项目执行该响应的工具：ToolRegistry.authorize → executeToolCall → tool-call / tool-result 条目
      → 若响应要求继续，由 TurnExecutor 开始下一 Step；每个 Step 前重做上下文准备
  → finishTurn：补未结算 part → turn-end（completed / failed / aborted）
  → 每条条目按「内存视图 → 条目 → 帧」固定顺序落地
  → 宿主按 seq 折叠成 ConversationView
```

项目控制的逐次请求已按提案首阶段落地：SDK 单次响应、项目执行工具、TurnExecutor 决定是否继续。真实兼容端点的工具历史格式与长 Turn 清理/压缩时序仍需集成验证，证据边界见 [逐次请求 Note](../../../docs/notes/proposed/architecture/2026-11-24-project-controlled-model-request-loop.md)。

## 宿主职责边界

| 宿主 | 允许 | 禁止 |
| --- | --- | --- |
| desktop main | 窗口、IPC、worker 生命周期、注入存储与工作区上下文 | 代执行 Agent 工具、复制连接/重试语义 |
| CLI | 组装 coding host、TUI 投影、模型配置 | import Electron/desktop、启动 VAD/ASR |
| remote host | 转发帧与 read-frames、host key（safeStorage/keychain） | 复制信令/重连协议、在 controller 侧依赖 `remote-node` |
| renderer / TUI | 折叠帧、渲染 | 解析工具输出、注入 prompt/工具、自行补 seq |

相关：`events.md`、`state.md`。
