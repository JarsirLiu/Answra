# Note：远程 CLI 控制——信令与 P2P 直连数据面

状态：提案

## 问题

目标场景是：用户在公司通过自己的 CLI 连接家里正在运行的 CLI，获得与本机 TUI 一致的对话、工具和多 Bot 操作体验；多 Bot 仍是本地能力，AnswraSite 只负责让两端找到彼此，不承载消息、transcript 或工具输出，以避免服务器带宽和内容托管。

当前仓库没有这个能力，且有几条已冻结的边界：

- CLI 是本机单 Bot coding 宿主，`CodingSession` 与 TUI 只面向进程内 host；没有远程传输、设备配对或 client attach。见 [CLI Coding 模式与终端 UI 移植](2026-11-12-cli-coding-mode-and-tui-port.md)。
- 非测试 `src` 禁止 `createServer(` / `.listen(`；远程方案不能让家里 CLI 暴露公网端口。见 [禁止在 src 中自建本地监听](../../implemented/architecture/2026-10-17-local-listener-forbidden.md)。
- `AgentCommand` / `AgentFrame` 是 desktop utility process 的本地线协议，含本地生命周期和 `accessToken` 假设，不能直接当公网协议。见 [Agent 组装点收归自身并抽象宿主传输](../../implemented/architecture/2026-10-17-agent-host-composition-and-transport.md)。
- 当前 transcript 和事件 store 仍是内存实现；远程重连只能依赖 host 进程存活时的快照与事件游标，不能承诺 host 重启恢复。
- Claude Code 的 Bridge 参考实现是服务端中转（v1 WebSocket 读 + HTTP POST 写，v2 SSE + CCRClient 写），消息和事件经过其后端；它可借鉴会话生命周期与传输抽象，但不满足“服务器不承载业务消息”的目标。

“只要有密钥”是必要但不充分条件：密钥解决身份和授权，不解决 NAT、公司网络 UDP 封锁、host 休眠或信令不可用。Note 需要把密钥、信令、P2P 可达性和本地运行时分开描述。

本提案采用 **key-only attach**：不设配对码，持有有效访问密钥即可直接连接；密钥默认 7 天、最小 7 天，host 可随时撤销。数据面只做 P2P 直连，不配置 TURN、不实现服务器 relay；P2P 无法建立时显式失败，不静默回退。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/schema/remote/`（新增）：版本化远程帧、命令、事件、能力、错误码与信令帧；只放跨端 schema。
  - `packages/remote/`（新增纯库）：远程 host/controller 状态机、协议编解码、访问密钥解析/证明/过期判断、信令状态机与端口；不依赖 Electron/Node/CLI/Agent。
  - `apps/cli/src/remote/`（新增）：CLI host/controller 适配、信令与 WebRTC 适配、设备密钥存储；本阶段只做 CLI。
  - `apps/cli/src/config/remoteOptions.ts`、`apps/cli/src/cli/remoteCommand.ts`（新增）：`remote` 子命令语法与分派；不把远程模式塞进 `code` 用例。
  - `apps/cli/src/tui/`、`apps/cli/src/session/`：保持不变；远程 controller 通过 `CodingSessionHost` 驱动同一个 TUI，TUI 不 import `@answra/remote`。
  - `apps/agent/src/`：不新增 `remote/` 目录。Agent 只暴露 `CodingApplication` / `AgentService` 能力，远程映射由宿主适配层完成。
  - `apps/desktop/src/main/remote/`（第二阶段）：桌面 host 服务、IPC 与 P2P 适配；复用 `AgentService`，renderer 不接触网络。
  - `packages/config/src/`：只增加非 secret 的信令端点/远程开关；远程 key 仍由各宿主凭据存储负责。
  - `AnswraSite`（仓外）：登录、房间、presence、SDP/ICE 信令；不存业务消息，不接触访问密钥的 secret。
- UI/进程/协议/持久化表面：
  - 进程：家里 CLI/桌面为 host；公司 CLI/浏览器为 controller。host 出站连接信令，不开公网监听。
  - 协议：新增 `RemoteFrame` 与 `HostCommandPort`；不复用 worker 线协议。
  - 数据面：WebRTC DataChannel，DTLS 加密；只允许 P2P 直连，不配置 TURN，不做服务器 relay。
  - 持久化：服务端零 transcript；本地仍沿用现有内存 store，跨重启恢复另立 Note。
- 相关 Note：
  - [产品方向与 Agent 底座](2026-10-20-product-direction-and-agent-foundation.md)
  - [CLI Coding 模式与终端 UI 移植](2026-11-12-cli-coding-mode-and-tui-port.md)
  - [CLI TUI 对话交互重建](../../implemented/architecture/2026-11-13-cli-tui-conversation-interaction-rebuild.md)
  - [禁止在 src 中自建本地监听](../../implemented/architecture/2026-10-17-local-listener-forbidden.md)
  - [Agent 组装点收归自身并抽象宿主传输](../../implemented/architecture/2026-10-17-agent-host-composition-and-transport.md)
  - [Agent 连接域](../../implemented/architecture/2026-11-10-agent-connection-domain.md)
  - [统一 Conversation UI 投影](../../implemented/architecture/2026-11-06-unified-conversation-view-projection.md)
  - [单一 Agent 事件流](../../implemented/architecture/2026-11-07-single-agent-event-stream.md)
  - [多 Bot 同会话注册、发现与交接](2026-11-11-multi-bot-session-registry-and-handoff.md)
  - [Conversation 编排拆分与 Bot 边界收敛](2026-11-12-conversation-orchestration-decomposition.md)
  - [远程运行环境上下文](../../implemented/feature/2026-11-10-conversation-runtime-environment-context.md)
  - [远程时区上下文](../../implemented/feature/2026-11-10-conversation-time-context.md)

## 提案

### 1. 目标：远程是同一 host 的第二个 UI

远程不是“上报 coding”，也不是降级功能。家里 CLI 持有唯一的 Agent host、工具、工作区、多 Bot 目录和 transcript；公司 CLI 只持有 TUI 与远程客户端。

```text
家里 CLI host
  ├─ CodingApplication / ConversationApplication
  ├─ Bot catalog / team / handoff
  ├─ workspace tools / shell
  └─ RemoteHostSession ── RemoteFrame ──┐
                                        │
公司 CLI controller                     │
  ├─ 同一个 TUI / TuiViewStore          │
  ├─ 同一个 CodingSessionHost 端口      │
  └─ RemoteControllerSession ───────────┘
```

- 两端看到同一个 snapshot、同一组 Agent 事件、同一个 active Bot 和 run 状态。
- 公司 CLI 的 cwd、时区和 shell 不注入 Agent；工作区、时间、环境事实仍来自家里 host。公司端只决定连接目标和 UI 尺寸。
- 本地 TUI 与远程 controller 可以同时观察；host 用同一会话队列串行化 send 与 cancel，不新增第二套 run 语义。
- 多 Bot、team、handoff、工具授权全部留在 host；信令服务器不知道 Bot 目录，也不解析命令内容。

### 1.1 目录分层与依赖

远程不是 `apps/agent` 的新领域，也不是 CLI TUI 的新面板。它是一条独立的“连接/会话”支撑域，按四层落位：

```text
契约层
  packages/shared/src/schema/remote/
    index.ts
    frames.ts          # RemoteFrame / RemoteHello / ack / error
    commands.ts        # RemoteCommand 变体
    events.ts          # snapshot / event batch / run 状态投影
    capabilities.ts    # 版本、role、capability
    modelSettings.ts   # 无 secret 的模型设置摘要/变更 DTO
    signaling.ts       # SignalingFrame：join/offer/answer/ice/presence/bye
    errors.ts          # 稳定错误码

远程领域层（纯库，无平台依赖）
  packages/remote/src/
    index.ts
    protocol/          # 版本协商、编解码、错误映射
    host/              # HostCommandPort、HostModelSettingsPort、RemoteHostSession、lease、event stream
    controller/        # RemoteControllerSession、重连、run 等待
    access/            # 访问密钥解析、证明、过期判断与授权记录
    signaling/         # 信令状态机与房间发现；不实现 WebSocket
    ports/             # RemoteLink / SignalingChannel / RemoteCredentialStore
    testing/           # fake link / fake signaling / fake host port

宿主适配层
  apps/cli/src/
    config/remoteOptions.ts
    cli/remoteCommand.ts
    remote/
      host/            # CodingApplication -> HostCommandPort / HostModelSettingsPort
      controller/      # RemoteControllerSession -> CodingSessionHost + RemoteModelSettings
      signaling/       # AnswraSite WS/HTTP 适配
      transport/       # Node WebRTC DataChannel 适配
      credentials/     # CLI 远程 key 存储
  apps/desktop/src/main/remote/   # 第二阶段
    host/
    controller/
    signaling/
    transport/
    credentials/

UI / 外部
  apps/cli/src/tui/               # 不 import @answra/remote
  apps/desktop/src/renderer/      # 只经 DesktopBridge，不建 peer
  AnswraSite                      # 控制面，只做登录/房间/信令
```

两条竖切是 `host/` 与 `controller/`，分别拥有自己的状态机、lease 和测试；`signaling/`、`transport/`、`credentials/` 是支撑适配，不混进 host/controller 业务。新增能力只改对应竖切，不同时改三处。

依赖方向：

```text
@answra/shared
   ↑
@answra/remote  ←  @answra/cli
   ↑             ←  @answra/desktop(main)
@answra/agent   ←  @answra/cli / @answra/desktop(main)

@answra/config  ←  @answra/cli / @answra/desktop(main)
```

- `packages/remote` 只依赖 `@answra/shared`；不得 import `@answra/agent`、`apps/*`、Electron、Node 内置、Ink/React 或具体 WebRTC 库。
- `apps/agent` 不 import `@answra/remote`；Agent 仍然只认识 `CodingApplication`、`CodingSessionHost`、`HostCommandPort` 背后的纯命令语义。
- `apps/cli/src/tui` 不 import `@answra/remote`；远程 controller 只实现现有 `CodingSessionHost`，TUI 继续只认识 session 端口。
- 首版不建 `packages/remote-node`。CLI 是第一个 Node 消费者，WebRTC/信令适配先放 `apps/cli/src/remote`；桌面成为第二个真实消费者时，再把共用 Node 适配上提，避免提前抽象。
- `packages/shared` 只放 schema 与稳定常量；访问密钥校验、重连、背压、lease 等行为全部在 `packages/remote`。

状态单写者：

- `RemoteHostSession`：唯一写 host 连接状态、controller lease 和出站事件游标。
- `RemoteControllerSession`：唯一写 controller 连接状态与重连状态；不写 transcript，不推导 Agent 状态。
- `HostCommandPort` 适配器：不保存业务状态，只把远程命令映射到 `CodingApplication` / `AgentService`。
- `TuiViewStore` / 桌面 UI store：只写视图状态；远程帧与 Agent 事件是它的显式输入。
- `RemoteCredentialStore`：唯一写远程 key；信令与 host 不直接碰磁盘安全存储。

目录与命名纪律：

- 单目录文件数控制在 12 个以内；单文件超过约 400 行必须拆出 `lease`、`eventStream`、`reconnect` 等具体职责，不靠注释分区。
- 命名使用领域词：`RemoteHostSession`、`RemoteControllerSession`、`HostCommandPort`、`RemoteLink`、`SignalingChannel`、`RemoteCredentialStore`；禁止 `RemoteService`、`RemoteManager` 这类无法说明职责的名字。
- 不建 `remote/utils.ts`。编解码进 `protocol/`，访问密钥证明与过期判断进 `access/`，重连进 `controller/`，lease/背压进 `host/`。
- 每个文件顶部一行职责注释；每个竖切一个测试文件/目录，测试名写行为而不是实现。
- 远程目录的“空壳”不提前建；阶段 0 只建 shared schema、`packages/remote` 的端口/fake 与必要空实现，避免空目录制造虚假架构。

### 2. 控制面与数据面

```text
控制面（AnswraSite）
  登录 / 房间 / presence / SDP / ICE / 房间 TTL
  不保存 prompt、Agent 事件、transcript、工具输出
  不接触访问密钥 secret，不判断密钥过期

数据面（WebRTC DataChannel）
  RemoteFrame(hello / command / event / snapshot / ack / error)
  DTLS 加密，P2P 直连
```

- 服务端只做信令与网络发现，不转发业务消息；服务器带宽只覆盖 SDP/ICE/心跳。
- 数据面只允许 WebRTC P2P 直连。**不配置 TURN、不实现服务器 relay、不做 L7 转发兜底。**
- P2P 无法建立时显式失败为 `remote-unreachable`，并保留 ICE 诊断；绝不自动改成转发，也绝不回退到 controller 本机 Agent。
- 不采用“服务器 L7 消息转发但不存储”：它仍占带宽，也仍能观察或篡改明文边界；与目标不一致。

### 3. 两端形态

- **家里 CLI host**：使用独立的 `answra remote host` 子命令，不把远程模式塞进 `answra code`。host 启动现有 `startCodingHost`，生成远程访问密钥（默认 7 天、最小 7 天），出站连接 AnswraSite 信令；收到 controller 后提供 `RemoteHostSession`。不显示配对码，也不要求逐次确认。
- **公司 CLI controller**：使用 `answra remote attach`，采用 key-only attach；只要密钥有效、host 在线且信令可达即可直接连接，不需要配对码。它用远程实现的 `CodingSessionHost` 驱动现有 TUI；TUI 不感知传输，也不把公司机器的模型配置或 API key 发给 host。`/model` 与 `config` 的 host 语义全部回到家里 host：查看/切换/新增/清空本地模型、改 base URL 都由 host 执行；公司端只持有视图。API key 仍是 host 本地 secret，不从公司端上传，也不在公司端展示。
- **桌面**：复用现有登录、`AgentService` 与安全存储，作为第二 host；renderer 不直接持有网络 peer，远程网络代码留在 main。CLI 不复制桌面 UI，也不要求桌面常驻。
- **浏览器**：使用同一 `RemoteFrame` 与 capability 协商；不是首版必需，但架构不能把 CLI 锁死成唯一 controller。

### 3.1 命令归属：host / controller / host-only secret

CLI 可以做到“几乎与本地一致”，但不能把所有命令都当成远程命令。先按执行位置分类，再决定是否上远程协议：

| 类别 | 例子 | 执行位置 | 远程策略 |
| --- | --- | --- | --- |
| Host 命令 | send、cancel、queue、clear、`/model` 的 snapshot/add/switch/clear、model base URL、bots/team/handoff、工具调用、workspace 上下文 | 家里 host | 全部走 `HostCommandPort`；CLI 已有语义尽量一一映射 |
| Controller 本地视图 | 滚动、选区/复制、alt-screen、终端尺寸、输入编辑、`/help` 文案、退出 TUI | 公司 controller | 只在本机执行，不发给 host |
| Host-only secret | API key、OAuth token、OS keychain、桌面 `safeStorage`、host 进程/休眠/重启 | 家里 host | 不进入远程无秘密协议；需要时走 host 本地确认或独立安全流程 |
| 顶层进程命令 | `answra code`、`answra config`、`answra --version` | 当前进程 | `config` 不能静默改 host；远程配置用 `answra remote config` 或 TUI `/model` |
| 非交互运行 | `answra code "prompt"` | 当前进程 | 首版不远程化；未来可加 `answra remote run`，不改变 `code` 语义 |

结论：

- **可以远程**：CLI 的模型选择/非 secret 配置、会话、多 Bot、team/handoff、工具和工作区上下文，因为都在 host 执行。
- **本地保留**：终端呈现、输入、复制、滚动、alt-screen，以及顶层 `answra code` / `answra config` 的进程语义。
- **不能普通远程**：API key 写入/读取、OS 凭据、桌面 UI 和需要 host 本地确认的动作；这些需要单独的 host-local 安全流程。
- **不静默重定向**：`answra config` 在公司机器上仍然只改公司本地配置；用户必须显式使用 `answra remote config` 或远程 TUI 的 `/model`，避免“以为改了家里，实际改了公司”。
- **模型端点属于 host 网络**：远程配置的 base URL 由家里 host 解析；公司 localhost/内网端点不会自动变成 host 可达端点，错误应在 host 侧显式返回。
- **桌面与 CLI 的远程上限不同**：桌面远程可以转命令和状态，但无法在 controller 上复现 host 的浮窗卡片、截屏覆盖层、全局快捷键、窗口隐身、IME 和原生对话框；这些是 host-local 表面，不能假装远程可见。CLI 没有这些原生表面，所以 host 命令 + controller 本地终端视图即可接近本地体验。

### 4. 端口与协议

新增一个薄门面，避免 CLI 与 desktop 各自解释远程命令：

```ts
interface HostCommandPort {
  capabilities(): RemoteCapabilities;
  snapshot(conversationId: string): Promise<ConversationSnapshot>;
  readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]>;
  createConversation(conversationId: string, selection?: ConversationSelection): Promise<void>;
  clearConversation(conversationId: string): Promise<ConversationSnapshot>;
  send(command: HostSendCommand): Promise<{ runId: string }>;
  cancel(runId: string): void;
  listBots?(): Promise<BotSummary[]>;
  selectBot?(conversationId: string, botId: string): Promise<void>;
  settings(): HostModelSettingsPort;
  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): () => void;
  onEvent(listener: (event: AgentEventEnvelope) => void): () => void;
}

interface HostModelSettingsPort {
  snapshot(): Promise<RemoteModelSettingsView>;
  addLocal(input: RemoteLocalModelInput): Promise<RemoteModelSettingsView>;
  switchChatModel(chatModel: string): Promise<RemoteModelSettingsView>;
  clearLocal(): Promise<RemoteModelSettingsView>;
}
```

`HostSendCommand` 是 `ConversationSendCommand` 去掉 `accessToken` 后的 host 本地命令；它不是 `ConversationSendRequest` 的别名，避免把网络输入和模型凭据混成一个 DTO。

`RemoteModelSettingsView` / `RemoteLocalModelInput` 定义在 `packages/shared/src/schema/remote/modelSettings.ts`，只含 `baseUrl`、`chatModel`、`answerModel`、`source`、`configured` 等非 secret 字段；不得把 `ModelSettingsSnapshot` 从 `apps/cli` 反向 import 到 `packages/remote`。CLI host 适配器负责把 `ModelSettings` 映射成该 DTO；CLI controller 的 `RemoteModelSettings` 再映射回 TUI 的 `ModelSettings` 端口。

- `HostCommandPort` 定义在 `packages/remote/src/host/hostPort.ts`；桌面用 `AgentService` 适配实现，CLI host 用 `CodingApplication` 适配实现，CLI controller 用 `RemoteCodingSessionHost` 适配回现有 `CodingSessionHost`。
- `HostSendCommand` 不包含 `accessToken`；模型配置和云端凭据只由 host 本地解析。远程 controller 不得把自己的模型 API key、cwd 或时区发给 host。
- `packages/remote` 还定义 `RemoteLink`（send/receive/close/state）、`SignalingChannel`、`RemoteCredentialStore` 三个端口；WebRTC、WebSocket、OS keychain 的真实实现由 `apps/cli` / `apps/desktop` 注入。
- `RemoteFrame` 只承载序列化后的命令、snapshot、事件和 ack；不出现 `accessToken`、worker 生命周期、Electron/DOM 类型。
- 访问密钥只进入 DataChannel 建立后的独立 auth handshake；不进入信令帧、常规 `RemoteFrame`、日志或错误文案。host 校验 `keyId + secret + expiresAt + sessionId` 后才签发 controller lease。
- `RemoteHello`/capabilities 明确 `protocolVersion`、`role`、`sessionId`、`capabilities`（如 `coding`、`multi-bot`）。CLI 不声明 `answer`/`interview`，网页按能力隐藏入口。
- 事件复用现有 `AgentEventEnvelope` 与 `ConversationSnapshot`；`seq` / `eventRevision` 只用于丢旧与重放，不引入第二套消息模型。
- 远程命令必须有 `requestId`；错误使用稳定 code，不把中文文案当协议。

### 5. 访问密钥、授权与撤销

- **不设配对码，首版采用 key-only attach。** controller 只要持有有效访问密钥即可直接连接；密钥同时承担房间定位和授权，host 不要求逐次确认。
- 远程密钥必须是**独立的 remote access key**，不复用模型 API key，不写入 shell 历史，不进入日志；高熵随机值至少 256-bit。密钥格式包含 `roomId`、`keyId` 和 `secret`，便于 host 管理多设备、轮换和撤销。
- host 生成密钥后只展示一次；host 凭据存储保存 `keyId`、secret 的验证材料或加密值、`createdAt`、`expiresAt`、`label`、`lastUsedAt`、`revokedAt`。controller 只把完整密钥存入 OS keychain 或受保护文件。
- 有效期默认 **7 天**，最小 **7 天**；host 可签发 7/30 天并提前轮换。过期后新连接返回 `key-expired`，活动连接在过期点断开；host 可随时撤销，撤销后立即断开现有 controller。
- 信令服务器只按 `roomId` 路由房间并转发 SDP/ICE，不接触 secret，也不判断密钥过期。DataChannel 建立后由 host 做应用层 handshake：校验 `keyId + secret + expiresAt + sessionId`，再签发 controller lease；不能只信 SDP。
- host 必须显式开启远程模式，并本地显示“远程已连接”、controller 标识、密钥剩余时间和断开/撤销入口。远程 shell 等同本机 shell，key-only 不能省略 host 侧状态与撤销。
- 首版一个 active controller；其他连接只读或拒绝，避免两个输入源同时 send/select/handoff。多 controller 共享控制另立提案。
- 密钥泄露等同于 host 远程执行权限；默认一周窗口、每设备独立密钥、host 可见和可撤销是首版安全边界。不要通过 argv 传 key，使用交互输入、密钥文件或 keychain。

### 6. 多 Bot 的位置

- 多 Bot 完全留在 host 的 `ConversationApplication`：目录、选择、team preset、handoff、active agent 全在本地。
- 远程 client 只发 `list-bots`、`send`、`team-send`、`select-bot` 等语义命令；如果 CLI 首版只有 coding，就只声明 coding capability，不预建空命令。
- `ConversationSnapshot` 继续携带 `activeAgentId`、参与者、消息和 run 状态；远程 UI 不自行推导“下一个 Bot”。
- 信令服务器不参与 Bot 路由；它不知道消息属于哪个 Bot，也不保存会话历史。

### 7. 连接、重连与背压

- 首连：host 注册房间 → controller 加入 → SDP/ICE → DataChannel → app handshake → snapshot + 当前 run。
- 重连：controller 重新握手后请求 snapshot 与 `readEvents(afterRevision)`；host 用内存事件游标补齐。服务端不保存历史。
- 事件顺序由 host 的 revision 决定；controller 丢弃旧 revision，避免重连回放覆盖新状态。
- DataChannel 有背压：host 对高频 delta 合批，慢 controller 不能阻塞 Agent；必要时降级为只发 snapshot/关键事件。
- 远程断开必须显式失败为 `remote-disconnected` / `remote-unreachable`，禁止静默回退到公司本机 Agent；否则用户以为在操作家里机器，实际在公司执行工具。
- host 退出或休眠，远程会话结束；跨 host 重启恢复需要本地持久化事件日志，另立 Note，不在本提案伪造服务端恢复。

### 8. 网络与本地监听边界

- 家里 host 只做出站：到 AnswraSite 的 HTTPS/WSS 信令，以及 WebRTC 的 STUN/ICE 连接；不开 HTTP/WS 监听端口。
- **不配置 TURN，不实现任何服务器 relay。** 数据面只允许 host/srflx/prflx candidate 的 P2P 直连；P2P 无法建立时显式失败为 `remote-unreachable`，禁止自动转发或本机执行。
- 家庭宽带通常可用：同一 LAN、普通 cone NAT、双方 IPv6 成功率高。双 CGNAT、对称 NAT、公司/酒店只放行 TCP/443 或封 UDP 时可能不可用；不存在可靠的“TCP 直连打洞”替代。
- 手机流量、公共 Wi-Fi 不承诺 P2P 可达；这些场景若要稳定工作，需要 TURN/relay 或可用 IPv6，前者与“服务器不承载业务流量”目标冲突。
- STUN 流量极小，可使用公共或托管 STUN；信令带宽主要是 SDP/ICE 与心跳，不是业务数据。成本瓶颈是并发连接、CPU 与运维，不是转发带宽。
- WebRTC 会使用 UDP socket，但这不是本地 HTTP 服务；架构守护继续禁止 `createServer`/`.listen`，只允许出站 P2P/信令。
- 不把用户自带 TURN 作为首版能力；未来若支持，只允许用户自配置且默认关闭，Answra 不托管 TURN。
- 不自建 frp、SSH 隧道或本地反向代理作为默认路径；它们是运维兜底，不是产品地基。

### 9. 明确不做

- 不在 CLI 移植 answer、interview、截图或桌面表面。
- 不做服务端 transcript、消息历史、工具输出存储或 replay。
- 不做服务端 Bot 路由、prompt 注入或工具执行。
- 不设配对码；首版只有 key-only attach。
- 不配置 TURN、不做服务器 relay、不做 L7 转发兜底。
- 不把远程 key 当模型 API key，不共享桌面 `safeStorage`。
- 不把模型 API key 放进远程配置 frame，不把 `answra config` 静默重定向到 host。
- 不把 `AgentCommand`/`AgentFrame` 直接暴露到公网。
- 首版不承诺多 controller 同时写、不承诺 host 重启恢复、不承诺所有网络可 P2P。

## 模块边界

- `packages/shared/src/schema/remote/`：只放跨端 schema、稳定错误码、信令帧和无 secret 的 `RemoteModelSettingsView`；不放访问密钥校验流程、重连状态机、WebRTC 或 host 实现。
- `packages/shared/src/schema/remote/modelSettings.ts`：模型设置摘要/变更 DTO；只含 base URL、模型 ID、source、configured，不含 API key 或 token。
- `packages/remote/src/protocol/`：版本协商、`RemoteFrame` 编解码与错误映射；只依赖 shared schema，不重复定义线格式。
- `packages/remote/src/host/`：`HostCommandPort` 契约、`RemoteHostSession`、controller lease、snapshot/event 流与背压；不 import Agent/CLI/Electron。
- `packages/remote/src/controller/`：`RemoteControllerSession`、重连、run 等待与命令 request 关联；不持有 TUI 或 transcript 状态。
- `packages/remote/src/access/`：访问密钥解析、证明、过期与撤销判断；不读写 OS 凭据、不发网络请求。
- `packages/remote/src/signaling/`：信令状态机与房间发现；只通过 `SignalingChannel` 端口收发，不实现 WebSocket。
- `packages/remote/src/ports/`：`RemoteLink`、`SignalingChannel`、`RemoteCredentialStore`；只定义能力，不提供平台实现。
- `packages/remote/src/testing/`：fake link/signaling/host port，供 CLI/desktop 按契约并行开发；不进入生产入口。
- `apps/cli/src/remote/host/`：只做 `CodingApplication` / `CodingHost` 到 `HostCommandPort` / `HostModelSettingsPort` 的适配与 host 组合，不复制 Agent 领域逻辑。
- `apps/cli/src/remote/controller/`：只做 `RemoteControllerSession` 到 `CodingSessionHost` 的适配，并实现 host-backed `RemoteModelSettings` 驱动现有 TUI；不改 TUI 语义。
- `apps/cli/src/remote/signaling/`、`transport/`、`credentials/`：分别只做 AnswraSite 信令、Node WebRTC、CLI 密钥存储的平台适配。
- `apps/cli/src/config/remoteOptions.ts`、`apps/cli/src/cli/remoteCommand.ts`：只做 argv 语法与命令分派，不实现远程状态机。
- `apps/desktop/src/main/remote/`：桌面 host 服务与 main 侧网络适配；复用 `AgentService`，不在 renderer 建 peer，不复制 Agent 命令分发。
- `apps/desktop/src/renderer/`、`packages/ui/`：只经 `DesktopBridge` 或 props 获取远程状态，不 import `@answra/remote`，不持有 peer/key。
- `apps/agent` 的既有领域与 `worker/` 不改；远程是另一条 host 入口，不是第四个领域。
- `AnswraSite` 只实现控制面；不得因为实现方便把 Agent 事件或消息落到服务端数据库。

## 并行开发切分

先合并“契约 + 空实现 + fake ports”，再按竖切并行；任何人不得先改别人的竖切来适配自己。

| 工作流 | 主要文件 | 可依赖 | 不碰 |
| --- | --- | --- | --- |
| R0 契约与端口 | `packages/shared/src/schema/remote/**`、`packages/remote/src/{protocol,ports,testing}/**` | 无 | Agent、TUI、WebRTC 库 |
| R1 远程 host 核心 | `packages/remote/src/host/**` | R0 | controller、CLI、desktop |
| R2 远程 controller 核心 | `packages/remote/src/controller/**` | R0 | host、CLI TUI、desktop |
| R3 CLI host 适配 | `apps/cli/src/remote/host/**`、`apps/cli/src/remote/credentials/**` | R0、R1 | TUI、controller |
| R4 CLI controller 适配 | `apps/cli/src/remote/controller/**`、`apps/cli/src/config/remoteOptions.ts`、`apps/cli/src/cli/remoteCommand.ts` | R0、R2 | TUI 组件、host |
| R5 信令与访问密钥 | `packages/remote/src/{access,signaling}/**`、`apps/cli/src/remote/signaling/**`、`apps/cli/src/remote/credentials/**` | R0 | WebRTC、Agent、TUI |
| R6 P2P 传输 | `apps/cli/src/remote/transport/**` | R0 | host/controller 状态机、Agent |
| R7 桌面 host + IPC | `apps/desktop/src/main/{remote,ipc}/**`、`packages/shared/src/channels/remote.ts`、preload | R0、R1、R3 的适配模式 | renderer 网络、CLI |
| R8 验收与安全 | 测试、网络矩阵、威胁模型、文档 | 各流接口 | 不改业务实现 |

- 接口冻结清单：`RemoteFrame`/`SignalingFrame`、`HostCommandPort`、`RemoteLink`、`SignalingChannel`、`RemoteCredentialStore`、访问密钥记录与 7 天过期语义、稳定错误码、snapshot/event revision 语义。
- R3/R4 可完全并行：host 端只实现 `HostCommandPort`，controller 端只实现 `CodingSessionHost`，中间用 `packages/remote/testing` 的 fake link 对接。
- R5/R6 可完全并行：信令与 P2P 通过 `RemoteLink` / `SignalingChannel` 端口解耦；WebRTC 库选型不影响 host/controller 测试。
- 每个 PR 只做一种事：目录移动/重命名独立于行为变化；契约变更独立于适配实现。远程不要和正在进行的 TUI 目录重构混在一个 PR。
- 每个竖切一个负责人；新增命令或事件先在 R0 立类型和 fake，再让 R1-R4 各自跟进，避免“接口在你脑子里”的串行等待。

分阶段落地：

1. **阶段 0：契约与骨架。** 已落地：`packages/shared/src/schema/remote/`、`packages/remote/src/{host,ports,protocol,testing}/`，覆盖帧/命令/模型设置/信令 schema、`HostCommandPort`、传输与凭据端口、fake link/signaling/host port、稳定错误码；不建 WebRTC、不接网络。
2. **阶段 1：远程会话核心。** 已落地：`RemoteHostSession` 与 `RemoteControllerSession` 通过 fake link 完成握手、命令 requestId 关联、host snapshot/event 推送、`/model` snapshot/add/switch/clear、send/cancel/clear 与 list/select bot；不接 CLI、TUI 或真实网络。
3. **阶段 2：CLI 两端适配。** R3 + R4 把 `CodingApplication` 映射成 `HostCommandPort`，把 `RemoteControllerSession` 映射成 `CodingSessionHost` 驱动现有 TUI；仍用 fake link，覆盖 `/model` 和命令归属，不改 TUI 语义。
4. **阶段 3：信令与访问密钥。** R5 接 AnswraSite（可用本地 fake signaling 先测），落地 key-only attach、7 天有效期、轮换与撤销；不设配对码。
5. **阶段 4：P2P 直连。** R6 接真实 WebRTC DataChannel，做 loopback 与家庭 NAT/IPv6 实机；不配置 TURN，记录 UDP 被封/对称 NAT 的失败矩阵。
6. **阶段 5：健壮性。** 重连、背压、慢 consumer、lease、密钥过期、host 退出；补架构守护和 TUI 端集成测试。
7. **阶段 6：桌面与多 Bot。** 复用 host/controller 契约；桌面 IPC/UI 与 CLI 多 Bot capability 分别落地，不复制远程状态机。

## 曾考虑的替代方案

- **Claude Code 式服务端中转：** 舍弃。v1/v2 都将 prompt、事件和工具内容送到后端，带宽和内容面都不符合目标；只借鉴会话生命周期、去重、恢复与权限控制。
- **家里 CLI 开公网 WebSocket/HTTP 端口：** 舍弃。需要 NAT/端口映射/TLS，暴露面大，且违反本地监听约束。
- **服务器 L7 转发但不存消息：** 舍弃作为默认方案。虽然不托管，但仍承载全部流量，并让服务端进入明文/可篡改边界。
- **服务器 TURN/relay 兜底：** 舍弃。能提高手机流量和企业网络的可达性，但会重新引入服务器带宽成本；首版接受这些网络不可直连，并以 `remote-unreachable` 显式失败。
- **一次性配对码：** 舍弃。用户要求拿密钥直接访问；配对码只增加一步，不构成额外安全边界。用高熵密钥、7 天有效期、host 可见和可撤销替代。
- **Tailscale/frp/SSH 隧道：** 不作为产品地基。它们能解决可达性，但把部署、账号和带宽成本转嫁给用户/运维；可作为高级用户兜底。
- **只做桌面远程，不做 CLI host：** 舍弃。用户明确要在公司用自己的 CLI 连接家里 CLI；桌面可以是第二 host，但不能替代 CLI。
- **复用 worker 线协议：** 舍弃。该协议含本地生命周期、`accessToken` 和 desktop 适配假设；公网需要独立的版本化远程协议。
- **把远程放进 `apps/agent/src/remote`：** 舍弃。远程是连接/会话支撑域，不是 Agent 领域；放进 Agent 会让 CLI controller 和未来浏览器为了连接而依赖整个 Agent 运行时，也会把远程状态机与领域执行绑在一起。
- **把远程状态机放进 `packages/shared`：** 舍弃。shared 只放跨端契约；重连、lease、背压、访问密钥校验是行为，放进去会让所有消费者被动携带，并模糊“schema”与“实现”的边界。
- **把远程塞进 `apps/cli/src/tui` 或 `apps/cli/src/adapters`：** 舍弃。TUI 只负责呈现与输入，`adapters` 是横向适配目录；远程有独立 host/controller/signaling/transport/credentials 子域，应形成自己的竖切。
- **把 `answra config` 透明重定向到远程 host：** 舍弃。用户会以为改的是公司本地配置，实际改家里；也可能把公司本地凭据语义带进远程。必须用显式 `answra remote config` / `/model`，并保持 `answra config` 的本地语义。
- **把 API key 纳入远程模型配置：** 舍弃。模型配置只传非 secret；API key 由 host 本地环境/凭据存储提供，远程只做选择与触发，不读取、不回显、不上传。
- **现在就建 `packages/remote-node`：** 舍弃。首版只有 CLI 一个 Node 消费者；等桌面也真实需要同一 WebRTC/信令适配时再上提，避免为不存在的第二消费者预建平台包。
- **先做服务端历史再谈 P2P：** 舍弃。会先制造带宽和内容托管问题，且掩盖 NAT 可达性；P2P 验证必须先做。
- **完全无鉴权、只靠 session ID：** 舍弃。远程可执行 shell/edit，链接泄露即远程 RCE；至少需要高熵访问密钥、host 显式开启和撤销。key-only 不等于无鉴权。

## 验收标准

- 可观察结果：
  - 公司 CLI 只凭有效密钥直接连接家里 CLI，不需要配对码；进入与本地一致的 TUI，可发送、排队、取消、切换 Bot（多 Bot 落地后）并看到同一 snapshot/事件。
  - 远程 `/model` 可查看、切换、新增、清空 host 的模型配置；操作写入 host，不写公司本地；`baseUrl` 由 host 网络解析，错误在 host 侧显式返回。
  - 远程 `/model` 不返回、不展示、不接受 API key；`answra config` 在公司机器上仍只改本地，显式 `answra remote config` 才改 host。
  - 工作区、时间、shell 和工具结果来自家里 host；公司端不把自身 cwd/时区注入 Agent。
  - 服务端只看到登录/房间/信令/presence 元数据，看不到访问密钥 secret、prompt、回复、工具输出或 transcript。
  - 密钥默认 7 天且最小 7 天；到期后新连接返回 `key-expired`，活动连接断开；host 可轮换和撤销。
  - host 可显示远程连接状态、密钥剩余时间并撤销密钥；撤销后新连接失败，已连接 controller 被断开。
  - P2P 失败时显式返回 `remote-unreachable`，不配置 TURN、不转发、不回退本机 Agent。
  - host 退出后远程会话结束；重连只在 host 存活期间通过 snapshot + event cursor 恢复。
- 自动化验证：
  - `packages/shared`：`RemoteFrame`/`SignalingFrame` 版本化、命令/事件/错误 schema 往返与拒绝未知版本；`remote-unreachable`、`key-expired` 等稳定错误码可序列化。
  - `packages/remote`：fake link + `HostCommandPort` 的 send/cancel/snapshot/readEvents、乱序 revision、重复 requestId、controller lease、重连与背压；密钥过期/撤销与 key-only 授权；不得出现平台依赖。
  - `packages/remote/test/session.test.ts`：host/controller 通过 fake link 完成握手、命令关联、`/model`、snapshot/event 推送与关闭语义；证明同一 `RemoteFrame` 契约可独立演进。
  - `apps/cli`：远程 `CodingSessionHost` 驱动现有 TUI 的测试，证明 TUI 未因远程分叉；密钥轮换/撤销、host 状态展示；host 适配只映射 `CodingApplication`。
  - `apps/cli`：`RemoteModelSettings` 的 snapshot/add/switch/clear 全部落到 host fake；断言公司本地 `ModelSettingsStore` 未被写；断言 API key 不出现在任何 frame。
  - `apps/cli`：命令归属表逐项测试：host 命令走远程，controller-local 命令不发送，`answra config` 不隐式改 host，`answra remote config` 才改 host。
  - `apps/desktop`：`AgentService` host 适配与 main 侧 peer 生命周期；renderer 不接触 peer。
  - 架构检查：远程代码无 `createServer(` / `.listen(`；`packages/remote` 只 import `@answra/shared`；`apps/cli/src/tui` 不 import `@answra/remote`；renderer 不 import `@answra/remote`。
  - `pnpm verify` 全绿。
- 需要的实机验证：
  - 家庭 NAT + 公司网络：UDP 可用时 P2P 直连；UDP 被封/对称 NAT 时记录为 `remote-unreachable`，确认没有任何 TURN 或 relay 流量。
  - Windows 家里 CLI 休眠/唤醒、断网重连、host 重启后会话丢失行为。
  - 公司代理/防火墙下的延迟、长输出、工具流、中文/宽字符 TUI。
  - 密钥泄露/撤销、错误密钥、7 天过期、重复 controller 和 host 本地状态可见性；手机流量/公共 Wi-Fi 仅记录 P2P 成功或失败，不启用中继。

## 风险

- **“密钥就行”不成立：** 还需要 host 在线、信令可达、NAT/防火墙允许 WebRTC。公司网络可能只允许 443/TCP，手机流量/公共 Wi-Fi 也常因 CGNAT/对称 NAT 失败；没有 TURN 时这些用户无法远程，密钥无法解决。
- **远程 shell 是高风险面：** key-only 下密钥泄露等于家里机器命令执行权限，且有效期内可直接连接。首版必须 host 显式开启、默认一周有效期、每设备独立密钥、可撤销，并限制 active controller；后续需要工具审批或命令白名单。
- **WebRTC 依赖与打包：** CLI 是 Node/Electron Node 模式，需要评估纯 TS 或原生 WebRTC 库的体积、ABI、Windows 打包和升级；不能把未经打包验证的库直接进发布链。
- **纯库被平台依赖污染：** `packages/remote` 一旦 import `node:`、Electron、Ink 或 WebRTC 实现，浏览器/未来 controller 就无法复用，CLI bundle 也会被动变大；必须用架构守护和单测扫描禁止。
- **host 适配漂移：** CLI `CodingApplication` 与 desktop `AgentService` 各自映射 `HostCommandPort`，可能在错误码、snapshot 顺序或 capability 上分叉；两个适配器必须跑同一套 contract test。
- **TUI 并行冲突：** CLI TUI 正在独立重构；远程 controller 只能实现 `CodingSessionHost`，不得为了远程改 `tui/**`，否则远程 PR 会与 TUI PR 互相冲突并模糊行为变化。
- **模型设置语义错位：** 公司 controller 不应读取本机模型配置或 API key；远程 `/model` 必须 host-backed，不能静默使用公司本地设置。`answra config` 与 `answra remote config` 的目标必须显式区分。
- **模型端点不可达：** 远程配置的是 host 的 base URL；公司 localhost/内网地址在 host 上不可达。host 应在应用配置或首次调用时返回可诊断错误，不能把网络错误伪装成模型错误。
- **API key 泄漏面：** 远程模型配置不能携带 API key；日志、错误、frame dump 和 host 状态展示都必须脱敏。若未来支持远程写入 secret，必须单独立项并使用 host 本地确认。
- **命令归属漂移：** “CLI 全部命令可远程”容易把所有顶层进程命令也透明转发；必须维护 host/controller/host-only 三类清单，新增命令先定归属再上协议。
- **静默本地回退：** 远程断开时不得自动切到本机 Agent 执行 prompt；必须显式失败为 `remote-disconnected`/`remote-unreachable`，避免用户以为在操作家里机器却在公司机器执行工具。
- **无中继的可达性缺口：** 不配置 TURN 意味着部分公司网络和手机流量用户无法使用；这是有意的成本取舍，必须通过诊断文案和 `remote-unreachable` 明确暴露，不能承诺“所有用户都能连”。
- **CLI 密钥存储：** CLI 不能使用桌面 `safeStorage`；首版需明确 OS keychain 或受保护文件的实现与权限，不能把 7 天有效期的 remote key 明文写进共享配置或日志。
- **当前无持久化：** host 退出即丢 transcript/run；远程体验在 host 生命周期内成立，不能宣称可恢复。跨重启恢复需要本地事件日志。
- **多 controller 并发：** 两个端同时 send/select/handoff 可能改变会话顺序；host 必须串行化并定义 lease，否则会出现第二个事实源。
- **信令服务可用性：** 即使不传消息，登录/房间/ICE 不可用也会阻断新连接；需要房间 TTL、重试和降级提示，但不能把失败误报成模型错误。信令成本瓶颈是并发连接与心跳，不是业务带宽。
- **服务端元数据仍可见：** 房间、设备、连接时间、IP/ICE candidate 等元数据仍经过网站；如果要求连元数据都不暴露，需要额外隐私设计。
- **本地监听约束：** WebRTC 的 UDP socket 虽不是 HTTP 服务，但会触发“第二个本地客户端/外部连接”的架构复核；本 Note 只允许出站 P2P 与信令，不允许新增监听。
- **CLI 多 Bot 尚未落地：** 远程协议只预留 capability 与通用命令，不能在 CLI 多 Bot 语义未定时提前固化 team/handoff 远程形状。
