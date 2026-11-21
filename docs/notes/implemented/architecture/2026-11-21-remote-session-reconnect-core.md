# Note：远程会话自动重连核心——连接代际与分层恢复

状态：已实施

## 问题

远程 CLI 已有信令、P2P 和 key-only auth，但连接是一次性的：

- `RemoteSignalingSession` 只接受一次 `join`，信令通道关闭就结束。
- `RemoteSignalingNegotiation` 只允许一次 offer/answer；第二次 offer 会被拒绝。
- `RemoteControllerSession` / `RemoteHostSession` 构造时绑定单个 `RemoteLink`，没有换 link 的能力。
- `startRemoteHost` 在信令关闭时直接失败；CLI controller 也没有网络切换后的重建流程。
- `WebSocketSignalingChannel` 明确不重连；`NodeWebRtcLink` 在 `failed` / `closed` 时直接关闭。

手机从 Wi-Fi 切到蜂窝、电脑短暂断网或信令 WebSocket 抖动时，旧实现只能断开，不能自动恢复。移动端提案依赖这条能力；如果先写移动 UI，会重复实现重连、过期 SDP/ICE、草稿和事件追平。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/schema/remote/signaling.ts`：offer/answer/ICE 增加 `connectionId`。
  - `packages/remote/src/signaling/`：协商与房间状态机只接受当前连接代际。
  - `packages/remote/src/reconnect/`：退避策略、终态判定、controller/host 重连协调器。
  - `packages/remote/src/host/remoteHostSession.ts`：新增 `onClosed`，让协调器感知 link/session 关闭。
  - `apps/cli/src/remote/host/startRemoteHost.ts`：改用 `RemoteHostConnection`。
  - `apps/cli/src/cli/remoteSessionCommands.ts`：`remote attach` 改用 `RemoteControllerConnection`。
  - `apps/cli/src/remote/controller/sessionHost.ts`：重连后按已打开会话执行 snapshot + `readEvents(afterRevision)`。
- 进程/协议/持久化表面：
  - 进程：controller 与 host 各自一个连接协调器；TUI 只消费 `CodingSessionHost` 和视图状态。
  - 协议：`RemoteFrame`、`HostCommandPort` 语义不变；信令 offer/answer/ICE 需要服务端同步支持 `connectionId`。
  - 持久化：不引入服务器历史；host 存活期间按 revision 追平。host 进程退出后的恢复另立提案。
  - 网络：仍只做出站信令和 WebRTC P2P；不开本地监听，不配置 TURN，不做 relay。
- 相关 Note：
  - [远程 CLI 控制——信令与 P2P 直连数据面](../../proposed/architecture/2026-11-13-remote-control-p2p-signaling.md)
  - [移动端远程 controller——信令-only 与 P2P 数据面](../../proposed/architecture/2026-11-21-mobile-remote-controller-p2p.md)
  - [Agent 连接域](2026-11-10-agent-connection-domain.md)
  - [禁止在 src 中自建本地监听](2026-10-17-local-listener-forbidden.md)

## 决定

### 1. 三层恢复，不用一个 retry 覆盖全部

| 层 | 负责 | 触发 | 恢复动作 | 失败 |
| --- | --- | --- | --- | --- |
| L1 信令 | `RemoteHostConnection` / controller attempt 工厂 | WS 关闭、心跳超时、网络切换 | 刷新 ticket、重建 WS、重新 `join` 同一房间 | 120 秒后 `remote-unreachable` |
| L2 WebRTC | link 工厂与连接协调器 | ICE failed/disconnected、DataChannel 关闭、网络切换 | 关闭旧 link，创建新 `connectionId`，重新 offer/answer | 连续 3 次重建失败或 120 秒 |
| L3 应用会话 | controller 协调器 + host session | 新 DataChannel 打开 | 重新 `hello` + `auth`，host 签发新 lease；controller 拉 snapshot + `readEvents(afterRevision)` | auth/版本不兼容时终止 |

只重连旧 DataChannel 或只在旧 WebSocket 上重发命令不够：手机换网后旧 candidate 和旧 PeerConnection 已经失效。

### 2. 连接代际（connectionId）

每次 L2 重建生成新的 `connectionId`，由 host 在 offer 中声明；controller 在 answer 和 ICE 中回传同一值。

已实现行为：

- `offer` / `answer` / `ice-candidate` 必填 `connectionId`。
- host 在 `acceptPeer` 时生成 `${hostPeerId}:${controllerPeerId}:${sequence}`。
- controller 从 offer 采用该值；answer/ICE 不能自行换代际。
- `RemoteSignalingNegotiation` 与 `RemoteSignalingSession` 拒绝或丢弃旧代际的 answer/ICE；重复 offer 不触发第二次状态迁移。
- 服务端只转发字段，不解释代际。若服务端使用严格 schema，必须先发布服务端兼容变更，再发布客户端。

如果没有这一层，旧代际的 answer/ICE 可能在重连后到达并覆盖新连接，造成“看起来连上了但一直超时”的隐蔽故障。

### 3. 重连策略

`RemoteReconnectPolicy` 是纯平台无关策略：

- 退避：1 / 2 / 4 / 8 / 16 / 30 秒，±20% 抖动。
- 总预算：120 秒；超过后返回 `remote-unreachable`。
- 最大 L2 重建次数：3 次；达到后不再无限重试。
- 主动关闭、auth 失败、key 过期/撤销、房间冲突、协议不兼容：立即终止，不进入重连。
- 重连成功后清零失败计数；短期再次失败重新开始退避。
- 策略只计算延迟和预算，不创建 WebSocket、PeerConnection 或 UI 状态。

终态码集中在 `isTerminalRemoteError`：`unauthorized`、`key-expired`、`key-revoked`、`room-conflict`、`controller-busy`、`unsupported-version`、`invalid-frame`、`invalid-command`、`session-mismatch`、`internal` 等不重试。

### 4. Controller 协调器

`RemoteControllerConnection`：

- 持有 `createAttempt()` 工厂：创建 ticket、信令 session、link、`RemoteControllerSession`。
- 每次 attempt 创建新 session；旧 attempt 的迟到回调按 generation 丢弃。
- link/session 关闭后进入 `interrupted`，按策略 `reconnecting`；成功回到 `ready`。
- `reconnectNow()` 供网络切换/回前台立即废弃当前 attempt，不等待普通退避。
- `close()`、终态错误、预算耗尽进入 `closed`；终态错误同时通知 `onError`。
- 对外暴露连接状态、原始 session、snapshot/event 转发、command facade 和稳定 `settings()`。
- 断线期间 in-flight 命令失败为 `remote-disconnected` / `retryable: true`；不自动重放。

CLI 的 TUI 不 import `@answra/remote`；`remote attach` 通过 `createRemoteControllerSessionHost` 消费 connection。

### 5. Host 协调器

`RemoteHostConnection`：

- 首次 `start()` 完成 signaling join；之后信令断开按策略刷新 ticket、重建 WS、重新 `join`。
- `peer-left` 或 link 关闭时关闭 `RemoteHostSession`，保留 host 命令端口和 Agent run，等待 controller 回来。
- 新 controller/新 link 到达时创建新的 `RemoteHostSession`；host key、workspace 和本地 transcript 不变。
- 同一时刻最多一个 active controller。
- host 退出、Ctrl-C 或预算耗尽时停止并释放资源。
- host 不因 controller 断线取消 run。

CLI `remote host` 已改用 `RemoteHostConnection`。

### 6. 重连后的状态恢复

- controller 只信任 host 的 snapshot + `eventRevision`，不把本地旧事件覆盖新状态。
- CLI `sessionHost` 记住已打开的 conversation 和最近 revision；连接从 `interrupted/reconnecting` 回到 `ready` 时，逐会话请求 snapshot 与 `readEvents(afterRevision)`。
- controller 在 `interrupted/reconnecting` 时禁用发送；恢复后不自动重发未确认命令。
- 事件 revision 过期、host 已重启或协议不兼容时明确失败为 `remote-disconnected`，不伪造恢复。
- 断线不触发本机 Agent 执行。

### 7. 明确不做

- 不做 TURN、服务器 relay、Cloudflare 数据兜底。
- 不做服务器历史、消息重放或 transcript 持久化。
- 不做无限重试、后台常驻或跨 host 重启恢复。
- 不做多 controller 同时写。
- 不在本变更实现移动 UI、桌面 host 或大消息分片。
- 不把重连逻辑放进 TUI、移动视图 store 或 Agent 领域。

## 模块边界

- `packages/remote/src/signaling`：连接代际、协商和房间状态；不创建 WebSocket/WebRTC。
- `packages/remote/src/reconnect`：退避、终态、controller/host 协调器；不 import Electron/React Native/Node。
- `packages/remote/src/controller`：controller 会话；不持有 TUI、transcript 或模型凭据。
- `packages/remote/src/host`：host 会话与 controller lease；不持有 Agent 领域或本地文件实现。
- `apps/cli/src/remote`：真实 WebSocket/WebRTC/ticket 适配和组合；不复制策略状态机。
- `apps/cli/src/tui`：只消费连接快照，不重试、不建 peer。
- `apps/desktop/src/main/remote`、`apps/mobile/src/transport`：后续复用协调器，分别注入 Electron/React Native 端口。
- `apps/agent`：不感知重连；host 适配器只调用既有应用能力。

状态单写者：

- `RemoteControllerConnection`：唯一写 controller 连接状态和 attempt generation。
- `RemoteHostConnection`：唯一写 host 信令/房间重连状态。
- `RemoteSignalingSession`：唯一写房间 join 和对端状态。
- `RemoteControllerSession` / `RemoteHostSession`：唯一写 auth、lease、命令和快照/事件流。
- UI store：只写视图状态，不判断重连。

## 曾考虑的替代方案

- **只重连信令 WebSocket，继续使用旧 WebRTC：** 舍弃。手机换网后旧 ICE 路径已失效，旧 candidate 无法恢复。
- **每个新连接复用 `RemoteControllerSession` 并替换 link：** 舍弃。auth、lease、pending 命令和事件订阅都绑定旧 link；首版每次 attempt 创建新 session。
- **无限指数退避重试：** 舍弃。会耗尽手机电量，并让用户误以为仍在连接；120 秒和 3 次重建是明确失败边界。
- **在移动端单独写一套重试：** 舍弃。CLI、桌面和移动会得到三套不同的状态、错误和测试。
- **依赖服务器 relay 维持连接：** 舍弃。内容带宽和服务器成本与项目目标冲突。
- **不做 `connectionId`，只靠关闭旧通道：** 舍弃。旧代际的迟到 SDP/ICE 可能在新连接后到达。
- **把重连放进 TUI 或移动 UI store：** 舍弃。UI 会拥有网络生命周期，导致后台、草稿、状态和错误文案各自实现。

## 后果与防回退

- controller 与 host 的连接生命周期现在都有唯一单写者；后续 UI 或移动端不得再自建重试循环。
- `connectionId` 成为信令必填字段，旧服务端/旧客户端不能静默混跑；发布顺序必须先服务端后客户端。
- 断线后每次 attempt 都是新 session；不得回退为“替换旧 session 的 link”，否则 pending 命令、lease 和事件订阅会跨代际泄漏。
- 预算固定为 3 次/120 秒；不得用无限重试替代。
- 未完成/后续：
  - link 级 ping/pong 心跳尚未实现；当前依赖 WebRTC/link 状态和信令关闭触发。移动端首版前必须补上，避免半开连接长时间不发现。
  - CLI 没有 NetInfo 端口；`reconnectNow()` 已提供，但尚未由 CLI 网络监听调用。移动端接入 NetInfo 后调用。
  - 桌面 host 适配与移动端 app 未开始。
  - 服务端必须支持并转发 `connectionId`；本次只修改仓库内共享 schema、客户端与 fake 测试。
  - host 进程退出或跨重启恢复不在本变更范围。

## 验证

- 自动化：
  - `packages/remote`：46 个测试通过，包含退避/抖动/预算、controller 断线重建、终态 auth 失败、`reconnectNow`、host 信令重入和新 controller。
  - `apps/cli`：26 个 remote 测试通过，包含 host 命令、attach 组合、controller adapter、真实 loopback DataChannel。
  - `pnpm --filter @answra/remote typecheck`、`pnpm --filter @answra/cli typecheck` 通过。
  - `pnpm lint`、`pnpm architecture:check` 通过。
- 未完成实机证据：
  - CLI 双机断网/换网、服务端 `connectionId` 转发、后台/前台移动端重连尚未实测。
  - 不能把 fake link 测试等同于真实 NAT/蜂窝恢复。

## 风险

- **可达性风险：** 不配置 TURN 时，换网后仍可能因为对称 NAT、CGNAT 或 UDP 封锁无法重建；这是显式失败，不是重连 bug。
- **协议兼容风险：** `connectionId` 是必填信令字段，服务端和客户端需要同步发布；旧服务端严格校验会拒绝新帧。
- **半开连接风险：** 只依赖 WebRTC 状态可能长时间发现不了死连接；link 心跳仍是移动端首版前置。
- **状态恢复风险：** host 进程退出后不能恢复 transcript；重连只保证 host 存活期间的 snapshot + revision 追平。
- **重复实现风险：** 如果桌面/移动各自写重试，错误码、退避和草稿语义会分叉；必须先复用共享协调器。
