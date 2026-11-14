# Note：Conversation 输入队列与远程 Host 顺序语义

状态：已实施

## 实施结果

- `ConversationApplication` 与 `CodingApplication` 按 `conversationId` 持有进程内 FIFO 队列；队列项只有轮到时才创建 Agent run。
- chat/team 的 host 命令返回 `started` 或 `queued`，通过 worker、Desktop IPC、preload、UI 和 remote host/controller 传递；team handoff 完整结束后才释放下一项。
- `answer.run` 保持一次性运行的原有返回契约，不进入对话输入队列，避免把两种领域语义混成一个状态机。
- 取消活动 run 或清空会话会移除尚未启动的队列项；host 退出后队列不恢复，首版仍是内存实现。

## 决定

队列的唯一事实来源是 Agent host 的 Conversation/Coding application。AI SDK 与既有 Agent execution 状态继续描述当前 run；输入队列只描述用户消息何时被接受、启动和结束。Desktop、CLI TUI 与远程 controller 只消费 host 的 `started/queued` 结果，不维护第二个发送顺序。

## 后果与防回退

同一 `conversationId` 只允许一个完整用户回合运行，下一条消息在当前 Bot 与 handoff 链全部完成后按 FIFO 启动。队列目前是进程内内存结构，host 重启会丢失未启动消息；未来若需要恢复，必须单独增加 durable queue、幂等键与恢复游标，不能把当前数组隐式升级为持久化。

## 验证

- Agent queue/application/coding tests：24 项通过，覆盖 FIFO、完整回合结束后启动和取消 pending。
- Remote session/ports tests：13 项通过；CLI remote controller adapter tests：7 项通过。
- UI answer/conversation tests：18 项通过；shared、UI、remote typecheck 通过；本次改动文件 Biome 检查通过。
- Desktop 完整 typecheck 仍受工作区既有 `apps/agent/src/core/agent/executeRun.ts` 未使用导入阻塞。

## 问题

当前 AI SDK 的流式事件能够描述一次模型调用的文本、推理、工具活动、完成、失败和取消，但它不负责产品层的用户输入排队。现有实现也把两类语义分散在不同位置：

- `apps/agent/src/core/transcript/memoryStore.ts` 只允许同一会话存在一个活动 run；
- `apps/agent/src/conversation/application.ts` 负责用户回合、Bot 执行和 team handoff；
- `apps/cli/src/tui/runTui.tsx` 维护一份 CLI 进程内的本地消息数组；
- `packages/ui/src/app/useConversationChat.ts` 在当前回复未结束时直接拒绝新消息；
- 远程 CLI 的 controller 可以通过 host 发送命令，但不能让 controller 自己成为发送顺序的权威来源。

因此，用户在 AI 回复期间继续发送消息时，不能只在某个前端加一个数组。桌面、CLI、远程 controller 或多个发送入口可能各自绕过该数组，重新撞上“当前回复尚未完成”，造成顺序不一致或重复提交。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/conversation/`：会话输入队列、完整用户回合和 handoff 结束边界。
  - `apps/agent/src/execution/`：继续负责 Agent run 状态，不吸收输入队列语义。
  - `apps/agent/src/core/transcript/`：继续负责 transcript、活动 run 认领和快照，不负责启动队列。
  - `packages/shared/src/channels/conversation.ts`：跨进程 accepted/queued 结果与队列事件契约。
  - `apps/desktop/src/main/conversation/`、`packages/ui/src/app/`：IPC 转发和队列状态展示。
  - `apps/cli/src/tui/`、`apps/cli/src/remote/`、`packages/remote/`：复用 host 上的队列语义，移除真实顺序的前端自治。
- UI/进程/协议/持久化表面：
  - 队列首版只在 Agent host 进程内存中存在，不承诺跨进程重启恢复。
  - 远程 controller 只发送命令和消费 host 状态；host 断线期间不能宣称消息已被接受。
  - 不新增服务器端业务消息存储，不把 prompt、回复或工具输出放进远程信令服务。
- 相关 Note：
  - [Conversation 编排拆分与 Bot 边界收敛](../../proposed/architecture/2026-11-12-conversation-orchestration-decomposition.md)
  - [CLI Coding 模式与终端 UI 移植](../../proposed/architecture/2026-11-12-cli-coding-mode-and-tui-port.md)
  - [远程 CLI 控制——信令与 P2P 直连数据面](../../proposed/architecture/2026-11-13-remote-control-p2p-signaling.md)
  - [Agent 事件状态领域归属](../../implemented/architecture/2026-11-06-agent-event-status-domain-ownership.md)

## 提案

### 1. 复用 Agent run 状态，新增会话输入队列

AI SDK 的事件继续作为当前模型调用的事实来源；Agent execution 继续使用既有状态：

```text
queued -> claimed -> running -> retry-wait -> completed/failed/aborted/superseded/orphaned
```

另增一层只描述用户消息等待发送的状态：

```text
accepted -> queued -> started -> completed/failed/aborted
```

两者不是互相竞争的第二套模型状态机：输入消息只有在轮到它时才创建 Agent run。排队消息不能提前写入 assistant 占位消息，也不能伪装成已经开始生成的 run。

队列项由 Conversation 领域持有，最小形态为：

```ts
interface QueuedConversationMessage {
  queueId: string;
  conversationId: string;
  request: ConversationSendRequest;
  botId?: string;
  teamId?: string;
  enqueuedAt: number;
}
```

队列按 `conversationId` 串行，不做全局串行。它负责接受顺序、启动下一项、清理未启动项和对外发布队列状态；不负责模型调用、AI SDK 事件、prompt 组装或 transcript 细节。

### 2. 以完整用户回合作为队列的等待单位

队列的前一项只有在完整用户回合结束后才释放下一项。完整回合包括：

```text
启动用户 run
  -> 等待当前 Bot 完成
  -> 校验并写入 handoff
  -> 启动后续 Bot
  -> 等待整条 handoff 链结束
```

`ConversationRunCoordinator` 或等价的 conversation 内部协作对象提供 `runTurn()`，队列只等待该用例返回结果。这样队列不会复制 `ConversationApplication` 的交接规则，也不会靠“流文本停止”或 UI 空闲状态推断回合结束。

### 3. Host 是本地、远程和多入口的唯一顺序来源

队列放在 Agent host 的 Conversation 编排层，而不是 React、Ink 或 remote controller：

```text
desktop renderer / CLI TUI / remote controller
       -> host command
       -> ConversationApplication
       -> per-conversation input queue
       -> Agent run + handoff
```

本地 UI 可以保留输入草稿和临时展示，但不得把自己的数组当作消息顺序的权威。CLI 现有 `runTui.tsx` 的本地队列应迁移为 host accepted/queue 状态的展示适配。

远程场景采用 host-owned queue：

- host 接受后分配 `queueId` 和单调的会话内顺序；
- controller 只能把“命令发送失败”和“host 已接受”区分开；
- controller 断线不取消 host 上已接受的消息或活动 run；
- 重连后通过 snapshot 与 event cursor 追平队列和 run 状态；
- 尚未收到 host accepted 的消息不能由 controller 宣称为已发送；
- 取消命令作用于 host 上的活动 run或指定排队项。

### 4. 共享契约只表达跨进程事实

`packages/shared/src/channels/conversation.ts` 增加明确的 accepted/queued 结果和队列事件，建议形态如下：

```ts
interface ConversationSendResult {
  queueId: string;
  status: "started" | "queued";
  runId?: string;
  position: number;
  snapshot: ConversationSnapshot;
}
```

队列事件至少需要覆盖：

```text
message-queued
message-started
message-finished
message-removed
```

事件携带 `conversationId`、`queueId`，开始后携带 `runId`；结束原因使用稳定的 `completed/failed/aborted` 或 `cancelled/cleared` 语义。共享层不放队列实现，不放 UI 文案，也不把 AI SDK 的原始事件直接暴露给 renderer。

### 5. 取消、清空和失败规则

- 取消活动 run 时，默认清空该会话尚未启动的输入队列；每条移除项发布明确原因。
- 清空会话要求会话空闲，并同时确认没有排队项；不能留下队列消息在清空后继续发送。
- 当前队列项失败后，默认结束该项并继续后续队列；如果失败意味着会话或模型配置失效，则由稳定错误码决定是否暂停队列，不能在 UI 中猜测。
- host 退出时内存队列丢失；首版不声称持久化或跨重启恢复。若未来需要恢复，必须单独设计 durable queue/store，不把内存数组升级成隐式持久化。

## 模块边界

- `apps/agent/src/conversation/queue/`：队列契约、按会话串行执行和队列事件；不 import Electron、Ink、React 或 AI SDK。
- `apps/agent/src/conversation/turn/`：一个完整用户回合的 run/handoff 等待；不定义共享 execution 状态。
- `apps/agent/src/execution/`：Agent run 状态迁移、事件 envelope 和 execution store；不管理用户输入队列。
- `apps/agent/src/core/transcript/`：消息 transcript、活动 run 认领、快照和恢复游标端口；不启动下一条用户消息。
- `packages/shared/src/channels/`：跨进程 DTO、频道和稳定事件类型；不放排队算法。
- `packages/remote/`：远程 frame、host/controller port、重连和传输适配；不复制 Conversation 队列语义。
- `apps/desktop/src/main/`、`apps/cli/src/remote/host/`：将宿主实现映射到同一 host port；不重新判断 run 是否完成。
- `packages/ui/`、`apps/cli/src/tui/`：输入和状态投影；不维护第二个真实发送队列。

## 并行开发切分

先冻结契约和 fake，再按竖切并行：

| 工作流 | 主要范围 | 不碰 |
| --- | --- | --- |
| Q0 契约与 fake | `packages/shared/src/channels/conversation.ts`、queue fake/contract test | UI、AI SDK、远程传输 |
| Q1 Agent 队列 | `apps/agent/src/conversation/queue/**`、`turn/**`、ConversationApplication 接线 | desktop、TUI、remote protocol |
| Q2 桌面/UI | main IPC、preload、`packages/ui/src/app/**`、队列展示 | Agent 队列算法 |
| Q3 CLI/远程 | `runTui.tsx`、`remote/host`、`remote/controller` 的 accepted/queued 映射 | Conversation 内部实现 |
| Q4 验收与迁移 | 并发、断线、取消、架构检查与 Note 实施迁移 | 不改运行时语义 |

Q1 与 Q2/Q3 只能在 Q0 契约冻结后并行；Q3 不为远程场景另建队列。目录重构与行为实现分开提交，避免和正在进行的 TUI 目录调整混合。

## 曾考虑的替代方案

- **只在桌面或 CLI 前端维护数组：** 舍弃。多个发送入口、远程 controller 和重连都会绕过前端数组；它只能提供局部交互效果，不能保证会话顺序。
- **让 AI SDK 直接管理输入队列：** 舍弃。SDK 只知道当前模型调用的流生命周期，不知道 Conversation 的 handoff、取消、会话清空和多入口授权。
- **把排队消息提前创建成 Agent run：** 舍弃。会提前写入 transcript 和 assistant 占位，造成“已开始生成”的假状态，并与单活动 run 约束冲突。
- **新增一套替代 execution 的 run 状态机：** 舍弃。既有 `queued/claimed/running/...` 已是 Agent run 的唯一状态来源；输入队列只表示消息等待，不复制 execution 语义。
- **使用全局串行队列：** 舍弃。不同会话应可并行；按 `conversationId` 串行即可保护同一会话的顺序。
- **把队列下沉到 transcript store：** 舍弃。store 负责状态、认领和快照，不应启动模型、执行 handoff 或持有宿主连接生命周期。
- **在远程 controller 侧重新排序并依赖本地 ack：** 舍弃。host 才是远程会话的权威运行时；controller 断线或多 controller 并发时，本地顺序无法代表 host 顺序。
- **首版引入磁盘持久化队列：** 舍弃。当前 transcript/run 仍是进程内存实现；持久化会增加恢复、去重和版本迁移契约，应在有明确产品需求后单独立项。

## 验收标准

### 可观察结果

- AI 回复期间提交的新消息被 host 接受并显示为排队，不再立即报“当前回复尚未完成”。
- 同一 `conversationId` 始终只有一个活动 Agent run；当前完整回合结束后，下一条按接受顺序启动。
- team handoff 未完成时，下一条不会抢占中间窗口。
- 桌面、CLI 和远程 controller 看到一致的 queue/run 状态；controller 断线不导致 host 已接受的消息丢失。
- 取消、清空、失败和 host 退出的行为符合本提案，不伪造跨重启恢复。

### 自动化验证

- queue fake 测试：两个 `send` 在真实异步 await 交错时仍保持 FIFO 和单活动 run。
- handoff 测试：第一条消息的 handoff 链全部完成后才启动第二条。
- 取消/清空/失败测试：队列项移除原因稳定，活动 run 不被错误排到队尾。
- shared contract 往返测试：`started/queued`、`message-*` 事件和未知字段/版本拒绝。
- remote fake link 测试：host accepted 与 controller 断线/重连、snapshot + event cursor 追平、重复 requestId 和多 controller 顺序。
- CLI/UI 测试：运行中提交、队列数量、取消清队列、远程 host 状态投影；不再测试本地数组作为权威顺序。
- `pnpm --filter @answra/agent test`、`pnpm --filter @answra/cli test`、相关 UI 测试、`pnpm architecture:check`、`pnpm notes:check`、`pnpm verify` 全绿。

### 需要的实机验证

- 桌面和 CLI 在模型流式输出、工具调用和 handoff 期间连续发送多条消息，确认顺序和最终 transcript。
- 远程 controller 发送后立即断网再重连，确认 host 继续运行、队列通过 snapshot/event cursor 追平。
- host 退出时确认内存队列丢失，并且产品文案没有暗示跨重启恢复。

## 风险

- **队列位置与 transcript 的时间差：** 排队项尚未写入 transcript，UI 必须明确区分“已排队”和“已开始”，否则用户会误解消息已经进入模型上下文。
- **失败后的继续策略：** 一味继续可能让配置失效时产生一串相同失败；需要稳定错误码和明确的暂停条件，不能由 UI 启发式决定。
- **远程重复提交：** 网络重试可能重复发送；host 需要 `requestId`/幂等边界，不能只依赖 controller 的超时判断。
- **多 controller 并发：** host 必须分配会话内顺序并串行处理；controller 生成的本地序号不能作为事实来源。
- **无持久化恢复：** host 重启会丢失内存队列和当前 transcript；若未来产品要求恢复，必须新增 durable queue、去重和恢复游标契约。
- **与现有 CLI 队列迁移冲突：** 迁移前不得同时让 TUI 本地数组和 host 队列都自动发送，否则会产生重复运行；切换期间应由单一适配层承担发送。
