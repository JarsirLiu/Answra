# Note：独立 Agent 连接域与模型重试分离

状态：已实施

## 问题

此前“网络波动”没有独立状态：

- 模型请求重试由 `apps/agent/src/core/model/retryFetch.ts` 发出 `retry` 事件，并以 `run-state-changed.retry-wait` 写入执行状态；UI 的 `RetryNotice` 直接显示“网络连接中断，正在重试”。
- 主进程与 agent utility process 之间没有连接状态。worker 意外退出时，`AgentService` 只清理 pending 并报“本地 AI 服务已退出”，不会重启，也没有可观察的重连进度。
- 云端是每次请求 HTTP 调用的无状态服务，不存在可断开的常驻连接；云端不可用属于模型调用失败，不属于链路状态。若把云端也塞进连接域，会与模型重试形成第二事实源。

结果是用户只能看到一个混用的“网络重试”，无法区分“模型请求正在重试”和“本地运行时连接已断开、正在重连”；连接失败还会以普通错误留在会话底部。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/schema/connection.ts`：连接状态 schema、稳定 reason 与链路失败码。
  - `packages/shared/src/channels/connection.ts`、`packages/shared/src/channels.ts`、`packages/shared/src/index.ts`、`packages/shared/src/bridge.ts`：桌面 IPC 与 `window.answra` 类型面。
  - `apps/agent/src/client/connection.ts`：平台无关 `AgentConnectionSupervisor`、worker host 端口与默认退避策略。
  - `apps/agent/src/index.ts`：连接客户端公开导出。
  - `apps/agent/src/worker/protocol.ts`、`apps/agent/src/host.ts`、`apps/agent/src/answer/host.ts`：新增就绪探测命令 `ping`。
  - `apps/desktop/src/main/conversation/agentWorkerHost.ts`：Electron utility process host 适配。
  - `apps/desktop/src/main/conversation/agentService.ts`：只保留领域命令、配置重下发与快照刷新，连接生命周期交给连接域。
  - `apps/desktop/src/main/connection/connectionIpc.ts`、`apps/desktop/src/main/window.ts`、`apps/desktop/src/main/index.ts`：连接状态 IPC 与窗口广播。
  - `apps/desktop/src/preload/index.ts`：转发 `getConnectionState` / `onConnectionState`。
  - `packages/ui/src/app/useConnectionState.ts`、`packages/ui/src/components/chat/ConnectionNotice.tsx`：连接状态订阅与展示。
  - `packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/app/ChatFeaturePanel.tsx`、`packages/ui/src/app/ReplyBarWindowApp.tsx`、`packages/ui/src/components/panels/ChatPanel.tsx`、`packages/ui/src/components/panels/InterviewCapturePanel.tsx`、`packages/ui/src/components/panels/ReplyBar.tsx`、`packages/ui/src/components/panels/ReplyActivityTicker.tsx`、`packages/ui/src/components/panels/ReplyConversationPopover.tsx`、`packages/ui/src/components/panels/ReplyDetails.tsx`：按连接优先级接管提示。
- UI/进程/协议/持久化表面：main 持有连接状态；renderer 只订阅；不写 transcript、不写 `AgentEventEnvelope`、不落盘。
- 相关 Note：
  - `docs/notes/implemented/bug-fix/2026-11-10-network-error-terminal-state.md`
  - `docs/notes/implemented/bug-fix/2026-11-07-conversation-terminal-state-projection.md`
  - `docs/notes/implemented/architecture/2026-11-07-ai-sdk-full-stream-as-agent-fact-source.md`

## 决定

### 只覆盖 agent-service

连接域只有一个 target：`agent-service`（客户端 ↔ agent worker）。云端模型不可用（401、429 重试耗尽、5xx、未配置模型）继续属于 conversation/run：`error` 事件 + `run-state-changed failed` + 消息 `failed`，UI 使用 `ModelErrorNotice`。云端不新增连接状态。

### 断链判定

- 确定断链：worker 进程 `exit`。
- 疑似断链：worker 已创建但启动就绪探测 `ping` 超时。
- 不算断链：模型请求超时、provider 4xx/5xx、模型重试等待、长时间流式输出。

本轮只实现启动就绪探测，没有周期心跳；worker 存活期间以进程退出为唯一断链信号。禁止从模型错误文本推断连接状态。

### 状态机

状态是纯数据，时间统一用 epoch 毫秒，原因是稳定 code，展示文案由各客户端自行映射：

```ts
type ConnectionTarget = "agent-service";
type ConnectionReason = "worker-exit" | "worker-start-failed" | "readiness-timeout";

type AgentConnectionState =
  | { target; status: "connecting"; revision; updatedAt; attempt; maxAttempts }
  | { target; status: "connected"; revision; updatedAt; attempt; maxAttempts; connectedAt }
  | {
      target;
      status: "reconnecting";
      revision;
      updatedAt;
      attempt;
      maxAttempts;
      nextRetryAt;
      reason;
      detail?;
    }
  | { target; status: "unavailable"; revision; updatedAt; attempt; maxAttempts; reason; detail? };
```

- `revision` 单调递增，客户端据此丢弃乱序的初始快照与推送。
- `attempt` 表示本轮尝试序号；`maxAttempts` 随状态下发，客户端不写死。
- 默认策略为 5 次尝试，失败后退避 1s/2s/4s/8s；策略在 `@answra/agent`，由状态携带结果。
- `connected` 表示 worker 已通过 `ping` 就绪探测；模型端点/凭据配置仍在下一次发送时按需下发，认证失败不属于连接失败。
- `reconnecting` 期间自动重启 worker；`unavailable` 后不自动循环。下一次 `ensureStarted` 开启新 episode。
- 每次发送是独立一轮：不复用上一轮 attempt，不做发送前网络检查；发送路径内部按需拉起 worker。
- `unavailable` 不是持久化错误：下一次发送或连接恢复后自然消失，不留在会话底部。
- worker 在 `connected` 时退出会自动开启一次 `reconnecting` episode；在尝试过程中退出由启动失败路径处理，避免重复计数。

### 断链时的会话行为

- worker 重启会丢失内存 transcript（当前 `MemoryConversationStore` 无磁盘持久化），这是已接受的代价。
- `AgentService` 记录最近 32 个会话 ID；重连成功后逐个向新 worker 请求权威快照并广播。新 worker 返回空 transcript，UI 回到干净状态。
- 旧 worker 的迟到帧按 worker 身份丢弃，不能写入新连接。
- 在途 run 不会伪造模型失败：UI 在连接断开时清空会话，并把 `waitForRun` 的等待者以 `aborted` 结束、清除活动 run；原因由连接提示承担。
- UI 清空会话时同时把事件游标归零；新 worker 的 transcript 与 revision 从头开始，旧游标会让重连后的空快照和第一轮事件被误判为过期。
- 链路失败使用 `agent-service-disconnected` 稳定错误码；UI 不把它渲染成 `ModelErrorNotice`。
- 连接状态不阻止发送：发送失败按该次调用的正常失败处理。

### IPC 与 UI

```ts
export const ConnectionChannels = {
  GetState: "answra:connection:get-state",
  StateChanged: "answra:connection:state-changed",
} as const;
```

- 不使用 `AgentEventEnvelope`，也不进入会话事件日志。
- main 广播到主窗口与回复条窗口；preload 只转发；`GetState` 只接受应用窗口调用。
- `useConnectionState` 先订阅再拉取初始快照，按 revision 保留较新状态。
- `ConnectionNotice` 只接收 `AgentConnectionState`；`connecting`/`connected` 不显示。
- 提示优先级：`unavailable` > `reconnecting` > 模型 `RetryNotice` > `ModelErrorNotice`；同一表面只显示一条主因。
- 连接提示出现时，对话与面试面板清空本地发送失败；回复条 ticker 用连接活动替换模型错误/活动。
- 现有 `RetryNotice` 保持只表达模型请求重试。

### 明确不做

- 不新增 run 终态（如 `disconnected`）。
- 不把连接状态写进 `agentRunStateSchema`、消息状态或 transcript。
- 不提供手动重试按钮。
- 不在发送前做连接检查。
- 不为云端建立伪连接状态或周期探测。

## 模块边界

- `shared`：只定义状态词汇、channel 和 bridge 类型；不持有运行时状态。`AgentConnectionState` 不依赖 Electron，可被桌面、CLI、未来其他客户端直接复用。
- `@answra/agent`：持有平台无关的 `AgentConnectionSupervisor` 与 `AgentConnectionClient`。它接受 worker host 端口（启动、停止、退出通知），不依赖 Electron `utilityProcess`。
- `desktop/main/connection`：只做 Electron worker host 适配、IPC 与窗口广播；不在 desktop 复制状态机。
- `desktop/main/conversation/agentService`：只保留对话/面试命令、配置重下发、已知会话快照刷新；连接生命周期全部委托连接域。
- `desktop/preload`：只转发 channel，不推导状态。
- `packages/ui`：只投影 main 下发的状态；不读会话消息、不解析错误文案。

### CLI 可移植性

未来 CLI 不复用 `desktop` 的 IPC、`DesktopBridge` 或 `useConnectionState`，但复用：

- `AgentConnectionState` schema（纯数据、epoch 毫秒、稳定 reason code、`target` 自描述、revision 单调）；
- `AgentConnectionSupervisor` 状态机与重试策略；
- `AgentConnectionClient` 的 `getState` / `subscribe` / `ensureStarted` 接口；
- worker 线协议中的 `ping` 就绪探测。

CLI 只需实现自己的 worker host（如 `child_process`）和输出适配层。连接状态的 `reason`/`detail` 不携带中文文案，CLI 可自行本地化。

## 曾考虑的替代方案

- **复用现有 `retry` / `run-state-changed.retry-wait` 表达重连：** 舍弃。模型请求重试与链路断开是不同事实，共用一个槽会让 UI、恢复和错误清理互相覆盖。
- **把云端也建模为连接状态：** 舍弃。云端是无状态 HTTP 服务，没有断链事件；只能从模型错误反推，会制造第二事实源。
- **把连接状态机留在 `desktop/main`：** 舍弃。未来 CLI 会复制一套退避、计数和断链判定，两个客户端的连接语义必然分叉；状态机放在平台无关层，desktop/CLI 只做适配。
- **连接状态直接复用 `AgentEventEnvelope`：** 舍弃。连接状态不是模型执行事件，进入事件日志会污染 transcript 的恢复与重放语义，也会让 CLI 被迫消费会话事件流。
- **达到上限后提供手动重试：** 舍弃。产品要求直接显示网络不可用并结束本轮；手动重试会把失败状态固化为需要用户操作的流程。
- **发送前先做网络检查：** 舍弃。要求下一轮正常运行，不依赖上一轮重试；发送路径内部按需启动即可。
- **把连接状态做成事件日志：** 舍弃。连接是瞬时 app 状态，快照 + 变更通知足够；事件日志会引入不必要的持久化与重放语义。
- **新增 `disconnected` run 终态：** 舍弃。连接断开不是模型执行结果；UI 清空时以 `aborted` 结束在途 run 的等待者，由连接提示解释原因，避免一个原因两个终态。

## 后果与防回退

- 模型重试与链路重连现在是两个独立域：`RetryNotice` 只读 `retry` 事件，`ConnectionNotice` 只读 main 下发的连接状态。
- 连接状态不落盘、不进 transcript；worker 重启后 transcript 为空，由已知会话快照刷新承担清理。
- 默认策略与原因 code 只在 `@answra/agent` / `@answra/shared` 定义；不得在 desktop 或 UI 复制计数与退避。
- 云端模型失败必须继续走 `ModelErrorNotice`，不得因“网络”字样被改判为连接状态。
- 新增客户端（CLI 等）必须实现 worker host 端口并复用同一状态机；不得自建第二套连接状态词汇。
- 旧 worker 的迟到帧必须按 worker 身份丢弃；新增帧类型时保持这一约束。
- 连接提示与模型提示的优先级必须由测试固定，禁止同一表面出现两个 Wi-Fi 提示。

## 验证

- `packages/shared/test/schema.test.ts`：四种连接状态 JSON 往返，时间字段为 epoch 毫秒，reason 为稳定 code。
- `apps/agent/test/client/connection.test.ts`：connecting → connected、退避重连、5 次失败 → unavailable、下一次请求开启新 episode、connected 时 worker 退出自动重连、dispose 停止重试。
- `apps/desktop/test/agentService.test.ts`：启动经 `ping` 进入 connected；worker 退出后自动重启；重连后刷新已知会话空快照。
- `apps/desktop/test/connectionIpc.test.ts`：主窗口/回复窗口可读状态、非法来源拒绝、状态变更广播。
- `packages/ui/test/ConnectionNotice.test.tsx`、`ChatPanel.test.tsx`、`ReplyActivityTicker.test.tsx`、`ReplyBarWindowApp.test.tsx`、`useConnectionState.test.tsx`：连接文案、不可用无手动重试、连接提示压过模型重试/错误、revision 防乱序。
- `packages/ui/test/useConversationView.test.tsx`：清空会话时在途 run 等待者以 `aborted` 结束，发送方不会永久停在等待状态；清空同时把事件游标归零，重连后新 worker 的事件可以重新应用。
- 已执行：`pnpm lint`、`pnpm typecheck`、`pnpm architecture:check` 通过；`packages/shared` 8 测试、`apps/agent` 379 测试、`apps/desktop` 283 测试、`packages/ui` 274 测试全部通过。
- `pnpm verify` 复跑通过。首次并行运行时 `apps/agent/test/core/tool/shell/sessions.test.ts` 有 4 条 5s 超时；该文件单独运行 19/19 通过，复跑整套 agent 379/379 通过，判定为并行负载下的既有慢测抖动。
- `pnpm notes:check` 当前被另一未完成的 `docs/notes/implemented/feature/2026-11-10-workspace-edit-tool.md` 阻断（缺少“后果与防回退”“验证”），与本次连接域无关。
- 需要的实机验证：手动结束 agent utility process，观察 WiFi 重连计数、5 次失败后的“网络不可用”，以及重连后 transcript 清空；断网发送确认不做前置连接检查，模型失败仍显示模型错误。
