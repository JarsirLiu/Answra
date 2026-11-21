# Note：移动端远程 controller——信令-only 与 P2P 数据面

状态：提案

## 问题

桌面端已有本地 Agent、Conversation 和 `packages/remote` 的 host/controller 契约，CLI 也已能通过 `remote host` / `remote attach` 做 P2P 远程控制；但仓库没有移动端 controller，也没有桌面 host 适配。用户希望：

- 手机连接本地电脑上的 Answra，查看会话、发送消息、停止 run、接收完成/审批结果。
- 复用现有 remote 机制，不新造公网协议。
- 内容不经过服务器，避免 prompt、回复、工具输出、图片和 transcript 消耗服务器带宽。
- 参考 `D:\codespace\cc-haha\mobile` 的信息架构和交互，而不是照搬它的数据路径。

必须区分：

- **信令服务：** 只转发房间、presence、SDP、ICE 和心跳，不承载业务内容。
- **数据面：** WebRTC DataChannel，P2P 直连；内容不经过服务器。

“服务器只路由转发业务帧”仍然会消耗服务器带宽，不是本提案的形态。

## 涉及范围

- `apps/mobile/`（新增）：Expo / React Native controller。只依赖 `@answra/shared` 和 `@answra/remote`，不依赖 `apps/cli`、`apps/desktop` 或 `@answra/agent`。
- `apps/mobile/src/transport/`：WebSocket 信令、`react-native-webrtc` DataChannel、`RemoteLink` 适配。
- `apps/mobile/src/credentials/`：SecureStore / Keychain 保存 remote key 与设备凭据。
- `apps/mobile/src/core/`：可测试的连接、会话、队列和视图投影，不依赖 React Native UI。
- `apps/mobile/src/ui/`：移动端 token、原语和页面；不复用 DOM-only 的 `packages/ui`。
- `apps/desktop/src/main/remote/`：桌面 host 运行时、`AgentService -> HostCommandPort` 适配、host key 存储与状态 IPC；网络代码只在 main。
- `packages/shared/src/schema/remote/capabilities.ts`：按需增加 `conversation` capability；不改变现有帧语义。
- `packages/shared/src/channels/`：只增加桌面 main 与 renderer 的远程状态 IPC；手机不经过桌面 IPC。
- `packages/remote/`：复用 host/controller/信令/access 状态机；只补移动端仍需且平台无关的传输契约。

相关 Note：

- [远程 CLI 控制——信令与 P2P 直连数据面](2026-11-13-remote-control-p2p-signaling.md)
- [远程会话自动重连核心——连接代际与分层恢复](../../implemented/architecture/2026-11-21-remote-session-reconnect-core.md)
- [产品方向与 Agent 底座](2026-10-20-product-direction-and-agent-foundation.md)
- [禁止在 src 中自建本地监听](../../implemented/architecture/2026-10-17-local-listener-forbidden.md)
- [UI 原语与比例契约](2026-11-11-ui-primitive-and-proportion-contract.md)
- [CLI Coding 模式与终端 UI 移植](2026-11-12-cli-coding-mode-and-tui-port.md)

## 提案

### 1. 定位：手机是桌面 host 的第二个 UI

手机不拥有 Agent 运行时，也不把本地电脑降级成“被调用的 API”。本地电脑持有唯一事实源：

```text
本地桌面 Answra（host）
  ├─ AgentService / Conversation / Bot catalog / 工具 / 工作区
  ├─ Desktop HostCommandPort 适配
  ├─ RemoteHostSession
  └─ 出站信令 + WebRTC DataChannel
                         │
手机 Answra（controller）
  ├─ RemoteControllerConnection
  ├─ 移动视图 store
  └─ 连接 / 会话 / 输入 / 停止 UI
```

- 手机只发语义命令：`create-conversation`、`send`、`cancel`、`snapshot`、`read-events`、`list-bots`、`select-bot`。
- 手机不获得 shell、工具实现、模型凭据、`safeStorage` 或任意 RPC。
- 手机断线不取消 host 上的 run；host 继续执行，controller 重连后按 `eventRevision` 追平。
- 本地桌面 UI 与手机可以同时观察同一会话，但首版只允许一个 active controller。

### 2. 连接链路

1. 桌面用户显式开启“手机连接”，选择/创建 remote access key。
2. 桌面 host 出站连接信令服务，`join` 固定房间；不监听公网端口。
3. 手机完成账号设备准入，换取一次性 signaling ticket。
4. 手机扫描桌面二维码或手动输入 key；二维码只承载 `answra1.<roomId>.<keyId>.<secret>` 的导入信息，不引入服务端配对码。
5. 双方通过信令交换 SDP / ICE；服务器只看到房间、角色、presence 和网络候选。
6. WebRTC DataChannel 建立后，手机发送 `hello` + `auth`；host 校验 key 的 room、secret hash、过期和撤销状态。
7. host 返回 `welcome`、capabilities、workspaceRoot 和可选模型摘要；手机请求 snapshot 和 `readEvents(afterRevision)`。
8. 断线时重建信令和 WebRTC，重新 auth，再用 snapshot + revision 追平；不依赖服务器历史。

P2P 失败时返回稳定错误 `remote-unreachable`，保留 ICE 诊断；不得静默回退到云端 relay，也不得回退到手机本地 Agent。

### 2.1 网络切换、弱网与重试（首版必做）

手机从 Wi-Fi 切到蜂窝后，旧 WebRTC 路径和旧 ICE candidate 已失效，不能只在旧 DataChannel 上重发。重连分三层：

- **L1 信令 WebSocket：** 网络切换、心跳超时或 socket 断开时，指数退避重连（1/2/4/8/16/30 秒，±20% 抖动），刷新 access token 和一次性 ticket，重新 `join` 同一房间。
- **L2 WebRTC 数据面：** `disconnected` 先等 15 秒 ICE 自愈；未恢复则关闭旧 `PeerConnection`，用新的 `connectionId` 重新 offer/answer。旧 generation 的迟到 answer/ICE 必须丢弃；不能复用旧 candidate。
- **L3 应用会话：** 新 DataChannel 建立后重发 `hello` + `auth`，由 host 签发新 lease；controller 请求 snapshot，并按 `afterRevision` 补齐事件。授权失败或协议版本不兼容时终止，不重试。

触发与预算：

- 手机通过原生网络状态监听（Wi-Fi / 蜂窝 / 无网）立即触发 L1/L2 重建，不受普通退避等待；回到前台时先探测旧连接，失败马上重建。
- controller 进入后台后不承诺保持连接；超过 60 秒关闭 P2P，回前台重新连接并追平。后台常驻和推送另立提案。
- 连续 3 次 L2 重建失败或 120 秒内未恢复，显式进入 `remote-unreachable`，不无限重试、不静默切服务器。
- 状态对 UI 暴露为 `connecting | open | interrupted | reconnecting | closed`；临时断线不销毁 transcript，不把用户踢回本地模式。
- 断线期间 in-flight 的发送命令不自动重放；UI 保留草稿并提示失败，由用户显式重发。若未来自动重放，host 必须按 `requestId` 去重。
- host 上的 Agent run 不因 controller 断线而取消；host 进程退出时直接 `remote-disconnected`，不做无限重连。

共享层的退避、终态和 controller/host 协调器已经实现，见[远程会话自动重连核心](../../implemented/architecture/2026-11-21-remote-session-reconnect-core.md)。移动端仍需接入 NetInfo、前后台生命周期，并补齐 link 级 ping/pong 心跳。

### 3. 服务器只做信令，不做内容转发

- 服务端只处理 `join` / `offer` / `answer` / `ice` / presence / 心跳。
- 不转发 `RemoteFrame`，不保存 prompt、回复、事件、图片或工具输出。
- 不配置 TURN，不实现 L7 relay，不做 Cloudflare 式数据兜底。
- 移动端遇到 CGNAT、对称 NAT、公司 UDP 封锁时显式失败，并提示切换 Wi-Fi、IPv6 或检查网络策略。
- 信令成本按并发连接和心跳计算，不按内容量计算。

### 4. 桌面 host 适配

新增 `apps/desktop/src/main/remote/`：

- `host/commandPort.ts`：把桌面 `AgentService` / Conversation 能力映射为 `HostCommandPort`，不复制 Agent 领域逻辑。
- `host/startRemoteHost.ts`：复用 `RemoteHostSession` 和 `RemoteHostConnection`，接桌面 main 的 run、事件和 snapshot 流。
- `credentials/`：host key 存储；沿用 7/30 天有效期、secret hash、撤销和 lastUsedAt。
- `ipc/`：桌面窗口显示“手机已连接”、controller 标识、路径、断开和撤销入口；renderer 不接触 peer 或 key。
- 桌面 host 默认关闭，必须由用户显式开启；连接成功后可在桌面随时撤销。
- 新增 `conversation` capability 时，手机按 capability 显示入口，不靠 UI 猜测 host 是否支持。

桌面 host 的网络实现只在 main；`apps/desktop/src/renderer` 不 import `@answra/remote`，不持有 WebRTC peer 或 access key。

### 5. 移动端结构

首版建议使用 Expo / React Native，按以下竖切组织：

```text
apps/mobile/src/
  app/             expo-router 页面：connect / hosts / sessions / chat / settings
  state/           AppContext、host registry、连接与当前会话投影
  core/            纯逻辑：连接状态、队列、消息投影、错误文案
  transport/       WSS 信令、react-native-webrtc、RemoteLink
  credentials/     SecureStore / Keychain
  ui/              移动 token、原语、页面组件
```

- `RemoteControllerConnection` 是远程事实的唯一入口；移动 `state/` 只做视图投影，不自行推导 run 或 transcript。
- `core/` 不 import React Native，便于在 Node/Vitest 中测试连接、排队、重连和错误映射。
- 不复用 `packages/ui` 的 React DOM 组件；移动端建立自己的语义 token 和原语。
- 首版只做前台连接；App 进入后台后关闭 WebRTC/WebSocket，回前台重新连接并追平。后台常驻、推送和 Live Activity 另立提案。

### 6. 移动 UI：借信息架构，不借视觉皮肤

参考 cc-haha 的“值守”模型，但按 Answra 的产品语境重排：

- **连接页：** 扫码 / 手动输入 key，显示“正在连接信令、正在建立直连、等待授权、已连接”；失败时给出网络原因，不显示假在线。
- **电脑页：** 当前电脑卡片、连接路径（局域网 / 直连 / 不可达）、最后在线时间、切换电脑、断开。
- **会话页：** 按“等你决定 / 进行中 / 最近”分组；显示 active Bot、run 状态、最后消息摘要。
- **对话页：** 流式消息、工具步骤时间线、排队消息、停止按钮、连接中断横幅；发送失败保留草稿，不自动重放。
- **设置页：** 通知、外观、连接诊断、撤销本机授权；模型 Key、shell、工作区权限留在桌面。
- **状态语义：** 等待/运行/完成/错误使用固定语义色；品牌色只做标识，不承担状态。

首版不做手机截图答题、面试音频、工具市场、团队交接和完整模型配置；这些能力需要各自的领域提案。

### 7. 数据量与通道

- P0 只保证文本会话和受控大小的文本历史；单条 DataChannel 消息设上限，host 发送 snapshot/事件前做大小保护。
- 启用图片、全量历史或大工具输出前，必须补分片/重组，或采用 cc-haha 的 `ctl` / `bulk` 双通道；不能把大图直接塞进控制帧。
- 任何分片都只属于 transport 适配，不改变 `RemoteFrame` 的业务语义，也不引入第二套消息模型。
- 慢手机不能阻塞 Agent；host 对高频事件合批，必要时降级为关键事件 + snapshot。

### 8. 安全与凭据

- remote key 独立于模型 API Key；手机不读取模型凭据，不接收 API Key。
- 手机用 SecureStore / Keychain；桌面 host 只存 secret hash、keyId、roomId、创建/过期/撤销时间和 label。
- 二维码泄露等同 key 泄露，默认短期有效；桌面必须显示连接状态和撤销入口。
- 不通过 URL query 放 key；二维码是本地导入通道，不把 key 放进服务端日志。
- key 失效、撤销或过期时，手机清理当前会话状态并要求重新导入；不清除桌面 transcript。

### 9. 明确不做

- 不做手机 host、手机本地 Agent、手机工具执行。
- 不做 TURN、服务器 relay、L7 转发或 Cloudflare 式内容兜底。
- 不做服务端 transcript、消息历史、工具输出或 replay。
- 不做桌面 renderer 直接建 peer 或保存 remote key。
- 不做公网本地监听端口。
- 不做双 controller 同时写；不做手机后台常驻 WebRTC。
- 不把 `answra code` / `answra config` 的进程语义搬到手机。

## 模块边界

- `packages/remote`：继续只放平台无关的 host/controller/信令/access 状态机与端口；不 import React Native、Electron、Node 或具体 WebRTC 库。
- `packages/shared/src/schema/remote`：只放跨端 schema、稳定错误码和 capability；不放移动 UI 状态。
- `apps/mobile/src/transport`：唯一创建移动 WebRTC / WebSocket 的层；只实现 `RemoteLink` / `SignalingChannel`，不解释业务命令。
- `apps/mobile/src/core`：纯投影与重连队列逻辑，不 import React Native、Ink 或桌面组件。
- `apps/mobile/src/state`：移动视图状态单写者；不复制 `RemoteHostSession` 的 lease、auth 或事件游标。
- `apps/mobile/src/ui`：移动原语和页面；不 import `@answra/remote`，不创建 peer。
- `apps/desktop/src/main/remote`：桌面 host 适配与网络；复用 `HostCommandPort`、`RemoteHostSession`、host key store，不复制 Agent 运行时。
- `apps/desktop/src/renderer`：只通过 `DesktopBridge` 读取远程状态，不接触网络和 key。
- `apps/agent`：不新增移动领域；只提供服务给桌面 host 适配。

## 曾考虑的替代方案

- **TURN / 服务器 relay 兜底：** 舍弃为默认方案。它能显著提高手机蜂窝和对称 NAT 下的成功率，但所有内容流量会经过服务器，直接违背带宽目标；未来若要支持，只能作为用户显式开启的独立模式。
- **cc-haha 的 Cloudflare 隧道兜底：** 舍弃。它默认先走 Cloudflare，再后台升级 P2P，断线还会退回 Cloudflare；虽然不自建服务器，但 Cloudflare 承载了业务内容，不符合“内容不走服务器”。只借鉴 UI 信息架构和连接状态模型。
- **服务器 L7 转发但不存储：** 舍弃。不存储仍会占用带宽，并让服务端进入内容边界。
- **手机直接开本地 HTTP/WS 服务或桌面反向代理：** 舍弃。违反仓库的本地监听约束，暴露面大，且需要 NAT/端口映射。
- **只做 CLI controller，不做移动端：** 舍弃。用户明确需要手机；现有 TUI controller 不能替代移动交互和通知。
- **完全手动交换 SDP、不用信令服务器：** 舍弃。每次连接都要复制长文本、无法处理 ICE trickle 和网络切换，移动体验不可接受；信令流量本身很小。
- **Tailscale / ZeroTier 作为产品基础：** 不采用。它们能解决 NAT，但把账号、部署和第三方网络依赖转嫁给用户；可作为高级用户兜底，不作为官方客户端的默认路径。
- **直接复用 `packages/ui`：** 舍弃。现有 UI 包是 React DOM 组件和 CSS token，不能直接在 React Native 中运行；移动端需要独立的原语和 token，但共享 schema、状态语义和测试模型。

## 验收标准

- 可观察结果：
  - 同一局域网内，手机扫描桌面二维码后建立 P2P 连接，看到桌面 host 的会话快照并能发送、排队、停止。
  - 信令服务日志只有房间、角色、presence、SDP/ICE 元数据和心跳；没有 prompt、回复、工具输出、图片或 transcript。
  - 手机不持有模型 API Key；桌面 host 的 key 可撤销，撤销后手机立即断开。
  - 手机断线期间 host 上的 run 继续执行；手机回前台重连后按 revision 追平，不重复发送未确认消息。
  - 手机从 Wi-Fi 切到蜂窝或反向切换时，旧 P2P 连接被废弃，App 自动重建信令和 WebRTC；120 秒内恢复则回到会话，失败则显示 `remote-unreachable`。
  - 蜂窝/CGNAT 或 UDP 封锁导致 P2P 失败时，手机显示 `remote-unreachable`，不自动走 relay，也不在手机本地执行。
  - 桌面 renderer 不出现 peer、key 或网络连接逻辑；所有网络代码在 main。
- 自动化验证：
  - `packages/remote`：复用现有 fake link/signaling 测试，覆盖手机 controller 的 hello/auth、命令、snapshot/event 追平、取消与断开。
  - `apps/mobile/src/core`：连接状态、错误映射、队列、重连和视图投影单测；不 import React Native。
  - `apps/mobile/src/transport`：DataChannel 消息大小、分片/重组、半开连接和心跳测试；用 fake WebRTC 覆盖 Wi-Fi/蜂窝切换、旧 `connectionId` 迟到 SDP/ICE、连续重建失败和 120 秒预算。
  - `apps/desktop/src/main/remote`：`AgentService -> HostCommandPort` 适配测试、host key 撤销、单 controller lease 和 shutdown。
  - 架构检查：`apps/mobile` 不 import `apps/cli` / `apps/desktop` / `@answra/agent`；`packages/remote` 不 import React Native。
- 需要的实机验证：
  - iOS 和 Android 各一台，局域网、家庭 Wi-Fi NAT、IPv6、手机蜂窝、公司 UDP 封锁逐项测试。
  - 记录每项的结果、ICE 路径、连接耗时和失败码；不能只用本机回环或模拟器证明 P2P 可用。
  - 验证 App 后台/前台切换、锁屏、网络切换后的重连与草稿保留。
  - 用抓包或信令日志确认内容不出现在服务器侧。

## 风险

- **可达性风险：** 不加 TURN 时，蜂窝 CGNAT、对称 NAT、公司网络 UDP 封锁会导致无法连接；这是有意接受的代价，产品必须明确提示而不是静默兜底。
- **移动系统生命周期：** iOS/Android 会挂起后台网络；首版只保证前台连接，后台推送和常驻连接需要另立提案。
- **大消息风险：** snapshot、历史、图片和工具输出可能超过 DataChannel 单消息上限；在补齐分片或 bulk 通道前不能开放无限历史和大附件。
- **凭据风险：** 二维码和 local key 泄露等同远程控制权限；必须短期有效、可撤销、不得进入日志或 URL query。
- **桌面 host 暴露风险：** remote host 能触发工具和 shell；桌面必须显式开启、显示连接状态、支持立即撤销，并保持 renderer 无网络能力。
- **多 controller 限制：** 首版手机与桌面同时输入时，后连接者被拒绝；多 controller 协作需要单独设计 lease 和冲突策略。
- **无服务端历史：** host 进程退出后不能恢复远程会话；跨重启恢复依赖本地持久化，另立提案。
