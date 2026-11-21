# Note：桌面远程 host 命令适配——conversation scope 与队列启动等待

状态：已实施

## 问题

远程会话列表契约已经落地，但桌面还不能作为 `conversation` host 被另一台电脑或手机 controller 控制：

- `RemoteCapability` 没有 `conversation`，controller 无法判断桌面是否支持会话入口。
- 桌面 `AgentService` 没有 `wait-queue-start`。`HostCommandPort` 要求该方法，CLI 的 `CodingApplication` 已支持，桌面 worker 只有 `wait-queue` 和 `queue-position`；手机发送排队消息后无法拿到真正启动时的 `runId`。
- 桌面 `AgentService` 的 `onSnapshot` / `onEvent` 是全局流，直接接到 `RemoteHostSession` 会把 interview、answer 等 scope 的快照和事件推给 controller。
- `AgentService.getSnapshot` / `readEvents` 可以按任意会话 ID 读取；远程边界不能依赖手机隐藏入口，必须由 host 自己校验 scope。
- 桌面不能复制 CLI 的 `CodingApplication -> HostCommandPort` 适配，也不能把 CLI 的 `workspaceRoot`、模型设置和 host key 语义直接搬过来。

本 Note 只覆盖“桌面命令适配层”和它需要的两个共享契约缺口；信令、WebRTC、桌面 IPC、host key 持久化和移动端 UI 不在本次范围。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/schema/remote/capabilities.ts`：增加 `conversation` capability。
  - `packages/shared/test/remoteSchema.test.ts`：覆盖桌面 capability 组合。
  - `apps/agent/src/conversation/application.ts`：增加 `waitForQueueStart`。
  - `apps/agent/src/worker/protocol.ts`、`apps/agent/src/host.ts`：增加 `wait-queue-start` 命令与路由。
  - `apps/desktop/src/main/agent/agentService.ts`：增加 `waitForConversationQueueStart`，并把 `createConversation` 收紧为返回 `ConversationSnapshot`。
  - `apps/desktop/src/main/remote/host/agentPort.ts`：桌面 host 依赖的最小 Agent 端口。
  - `apps/desktop/src/main/remote/host/commandPort.ts`：`AgentService -> HostCommandPort` 适配。
  - `apps/desktop/test/remoteCommandPort.test.ts`、`apps/desktop/test/agentService.test.ts`、`apps/agent/test/worker/host.test.ts`：覆盖新契约。
- 进程/协议/持久化表面：
  - 进程：适配器只在 desktop main 使用；renderer 不接触 `@answra/remote`、host port 或事件流。
  - 协议：新增 `wait-queue-start` worker 命令和 `conversation` capability；远程帧格式不变。
  - 持久化：不新增存储；会话历史仍由桌面既有 SQLite session catalog 提供。
- 相关 Note：
  - [远程 controller 控制——信令与 P2P 直连数据面](../../proposed/architecture/2026-11-13-remote-control-p2p-signaling.md)
  - [移动端远程 controller——信令 only 与 P2P 数据面](../../proposed/architecture/2026-11-21-mobile-remote-controller-p2p.md)
  - [远程会话历史列表契约](../../proposed/architecture/2026-11-21-remote-session-history-contract.md)
  - [远程会话自动重连核心](2026-11-21-remote-session-reconnect-core.md)

## 决定

### 1. 桌面 host 只声明 conversation 与 sessions

桌面适配器声明：

```ts
["conversation", "sessions"]
```

不声明 `coding`、`team`、`multi-bot`、`model-settings`、`answer` 或 `interview`。首版 `createConversation` 只接受 Bot，`send` 只接受 `chat.send`；`team.send` 返回 `invalid-command`，而不是悄悄转到桌面团队执行。

模型设置端口必须存在，但所有方法显式抛 `invalid-command`。`RemoteHostSession` 读取 welcome 模型摘要时会把失败当成“未提供”，不会把桌面模型配置暴露给手机。不能用 no-op 假装支持远程改模型。

### 2. 可见会话集合由 host 维护，不靠 ID 前缀

`createDesktopRemoteCommandPort` 维护 `visibleConversationIds`：

- `listSessions` 强制 `scope: "conversation"`，把返回页中的会话加入集合。
- 远程 `createConversation` 成功后加入集合。
- `snapshot`、`readEvents`、`clearConversation`、`send`、`waitQueue`、`waitQueueStart` 先检查集合；未知 ID 返回 `not-found`，不泄露该 ID 属于 interview/answer 还是根本不存在。
- `onSnapshot` / `onEvent` 只转发集合内会话；这是必须的隔离层，因为 `AgentService` 的事件是全局的。

不能用 `chat-` / `screenshot-` 前缀猜 scope：ID 前缀不是权威 scope，且历史列表已经通过 `ConversationSessionSummary.scope` 提供真实来源。

### 3. 队列启动等待走 worker，不在 desktop 轮询

`ConversationApplication.waitForQueueStart` 直接委托 `TurnQueueRegistry.waitForStart`；worker 新增 `wait-queue-start`；`AgentService.waitForConversationQueueStart` 只做启动、track 和请求转发。这样 controller 在排队消息真正启动时拿到 host 生成的 `runId` 与 snapshot，不在 desktop 或手机侧推演“应该已经开始”。

### 4. 桌面适配器不复制 CLI 适配

CLI `createRemoteCodingHost` 继续服务 `CodingApplication`；桌面新增独立 `createDesktopRemoteCommandPort`，只依赖 `DesktopRemoteAgentPort`。两者共享 `HostCommandPort` 契约和 fake port 测试，但不共享 CLI 的模型设置、workspace 和 host key 实现。

### 5. 明确不做

- 不把 `AgentService` 直接暴露给 `HostCommandPort`；先经过窄端口，便于测试和隔离平台依赖。
- 不在适配器里创建第二套会话、run、transcript 或事件存储。
- 不把 `listBots` / `selectBot` 接上；等 `multi-bot` capability 真正声明后再开放。
- 不在本变更实现信令、WebRTC、host key、桌面 IPC 或移动端 app。
- 不把空会话自动加入手机列表；`session-list` 仍排除 `message_count = 0`。

## 模块边界

- `packages/shared/src/schema/remote`：只增加 `conversation` capability；不放桌面 adapter 或过滤规则。
- `apps/agent/src/conversation`、`apps/agent/src/worker`：只增加队列启动等待能力；不 import `@answra/remote` 或 Electron。
- `apps/desktop/src/main/remote/host`：只映射 `AgentService` 到 `HostCommandPort`，持有可见会话集合；不创建 host key、信令、WebRTC 或 IPC。
- `apps/desktop/src/main/agent`：继续持有 Agent worker 和全局事件流；不感知远程 capability。
- `apps/desktop/src/renderer`：不 import `@answra/remote`，不接触 host port、事件过滤或 host key。
- `apps/cli/src/remote`：继续服务 `CodingApplication`；不 import 桌面 adapter。

状态单写者：

- `ConversationApplication` / `TurnQueueRegistry`：唯一写队列启动结果。
- `AgentService`：唯一写桌面 worker 的请求与全局事件流。
- `createDesktopRemoteCommandPort`：唯一写远程可见会话集合和远程事件过滤。

## 曾考虑的替代方案

- **直接复制 CLI commandPort：** 舍弃。CLI 绑定 `CodingApplication`、`CodingHost` 和 CLI 模型设置；桌面需要 `AgentService`、桌面模型设置和不同 scope，复制会产生第二套错误码和事件语义。
- **按 conversationId 前缀判断 scope：** 舍弃。前缀不是持久化 metadata，`chat-*`、`screenshot-*` 等命名不能证明 scope；用列表返回的 scope 与远程创建记录才是显式来源。
- **桌面 adapter 自己轮询 queue-position 推演启动：** 舍弃。`queue-position` 只能说明排队位置，不能证明 run 已经启动，也没有权威 `runId`。
- **不补 worker 命令，让 `waitQueueStart` 返回合成结果：** 舍弃。会违反 `HostCommandPort` 语义，手机可能在 run 尚未创建时就开始等待或显示错误状态。
- **把模型设置端口做成 no-op：** 舍弃。controller 会以为修改成功，实际桌面模型未变；必须显式 `invalid-command`。
- **让 renderer 过滤事件：** 舍弃。renderer 不应接触远程事件；scope 过滤必须在 main 的 host 边界完成。

## 后果与防回退

- 桌面 remote 入口在协议上已具备 `conversation` 能力；移动端可以按 capability 显示入口，不需要猜桌面类型。
- 任何新增桌面远程命令都必须先经过 `visibleConversationIds` 检查；不得绕过 adapter 直接调用 `AgentService`。
- `AgentService.onSnapshot` / `onEvent` 仍然对其他桌面窗口全局广播；远程隔离只在 commandPort 的订阅包装里，不能删除。
- `session-list` 的空会话不入列表是既有行为；如果未来需要“打开桌面当前空会话”，必须新增显式命令或列表参数，不能放宽 scope 校验。
- `wait-queue-start` 现在贯通到 `ConversationApplication`；后续 worker 协议变更必须同步 desktop `AgentService` 和 CLI host 契约测试。
- 桌面 host 运行时、host key、IPC/设置入口与 `packages/remote-node` 抽取已由 [桌面远程 host 运行时](2026-11-21-desktop-remote-host-runtime.md) 承接；本 Note 仍只证明命令适配层。二维码和移动端 app 尚未实现。

## 验证

- `pnpm --filter @answra/shared test -- test/remoteSchema.test.ts`：10 个测试通过。
- `pnpm --filter @answra/agent test -- test/worker/host.test.ts -t "wait-queue-start"`：路由测试通过。
- `pnpm --filter @answra/desktop test -- test/remoteCommandPort.test.ts test/agentService.test.ts`：12 个测试通过，覆盖 capability、scope 列表、未知会话拒绝、事件/快照过滤、team 拒绝、cancel scope 和队列启动等待。
- `pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/desktop typecheck` 通过。
- 未完成证据：真实桌面 host 与 PC/手机 controller 的 P2P 联调、Windows 实机 APK 构建尚未进行。

## 风险

- **cancel 只校验 conversationId 可见，未校验 runId 归属。** `HostCommandPort.cancel(conversationId, runId)` 已阻止未列出会话的取消请求；runId 与 conversationId 的绑定仍由桌面 `AgentService` 的 run 归属保证，后续可补可见 run 集。
- **手机看不到空会话。** 用户刚在桌面新建但未发消息的会话不会出现在手机列表，这是 session catalog 的既有过滤，不是远程适配器遗漏。
- **capability 与命令面可能漂移。** 适配器声明 `conversation` 但不声明 `team`，因此必须继续拒绝 `team.send`；新增能力时要同时改 capability、adapter 和测试。
- **本次未接网络。** 没有 `RemoteHostSession` 和真实 link 时，单元测试只能证明命令映射和 scope 过滤，不能证明跨机可达性。
