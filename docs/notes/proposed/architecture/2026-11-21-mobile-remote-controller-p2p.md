# Note：移动端远程 controller——Android-first Expo/RN 落地提案

状态：提案
修订：2026-11-22
Phase 0：已落地（2026-11-22，骨架）

## 问题

桌面远程 host 已经落地，CLI controller 已移除；当前仓库没有手机 controller，用户无法在 Android 手机上查看桌面会话、发送消息或停止 run。现在只有 Android 真机，iOS 以后要复用同一套，鸿蒙暂不确定是否必须原生 App。

本提案要解决的是“从零到可用 Android APK”的可执行路径，而不是继续做平台选型讨论。目标边界：

- 手机只是桌面 host 的第二个 UI，不拥有 Agent、工具、模型凭据或 transcript。
- 内容只走 WebRTC DataChannel，信令服务器只转发房间、SDP/ICE 和心跳，不承载 prompt、回复、工具输出或图片。
- 不配置 TURN、不做服务器 relay、不做 L7 转发兜底；P2P 失败显式报 `remote-unreachable`。
- Android 首版只做前台文本会话；iOS 复用同一 Expo/RN 工程；鸿蒙不在本提案承诺原生实现。
- 不把 `cc-haha` 的 Cloudflare 兜底、桌面本地 H5 服务、localStorage 凭据和自定义 tunnel 协议带进来。

## 涉及范围

- 新增可启动单元：
  - `apps/mobile/package.json`
  - `apps/mobile/app.json`
  - `apps/mobile/eas.json`
  - `apps/mobile/metro.config.cjs`
  - `apps/mobile/babel.config.cjs`
  - `apps/mobile/tsconfig.json`
  - `apps/mobile/src/app/**`：Expo Router 路由
  - `apps/mobile/src/core/**`：平台无关连接、会话投影、错误映射
  - `apps/mobile/src/transport/**`：RN WebSocket、`react-native-webrtc`、计时器、NetInfo、AppState
  - `apps/mobile/src/auth/**`：OAuth PKCE、深链回调、token 刷新
  - `apps/mobile/src/credentials/**`：`expo-secure-store` 适配
  - `apps/mobile/src/state/**`：移动视图 store
  - `apps/mobile/src/ui/**`：RN 原语和页面
  - `apps/mobile/test/**`：core、auth、transport 测试
- 工程/门禁：
  - `scripts/architecture/architecture-check.mjs`：新增 mobile 依赖边界
  - `AGENTS.md`：实施后同步 `apps/mobile` 边界
  - `pnpm-lock.yaml`
- 可能的前置协议变更：
  - `packages/shared/src/schema/remote/frames.ts`：补 `ping` / `pong`（见“前置协议变更”）
  - `packages/remote/src/controller/remoteControllerSession.ts`、`packages/remote/src/host/remoteHostSession.ts`：链路心跳
  - `packages/shared/test/remoteSchema.test.ts`、`packages/remote/test/session.test.ts`
- 不在本提案修改：
  - `apps/desktop`：桌面 host 已由既有 Note 承接
  - `apps/cli`：CLI 只保留 host，不再加 controller
  - `apps/agent`：移动端不依赖 Agent
  - `packages/ui`：React DOM + CSS，不复用于 RN
  - `packages/remote-node`：Node-only，移动端不得 import
- 相关 Note：
  - [远程控制——信令与 P2P 直连数据面](./2026-11-13-remote-control-p2p-signaling.md)
  - [远程会话自动重连核心](../../implemented/architecture/2026-11-21-remote-session-reconnect-core.md)
  - [远程会话历史列表契约](./2026-11-21-remote-session-history-contract.md)
  - [桌面远程 host 运行时](../../implemented/architecture/2026-11-21-desktop-remote-host-runtime.md)
  - [桌面远程 host 命令适配](../../implemented/architecture/2026-11-21-desktop-remote-host-command-port.md)
  - [产品方向与 Agent 底座](./2026-10-20-product-direction-and-agent-foundation.md)
  - [禁止在 src 中自建本地监听](../../implemented/architecture/2026-10-17-local-listener-forbidden.md)
  - [UI 原语与比例契约](./2026-11-11-ui-primitive-and-proportion-contract.md)

## 提案

### 1. 决策摘要

1. **Android-first，Expo/RN**：`apps/mobile` 使用 Expo + React Native + Expo Router，首版只交付 Android debug APK。
2. **iOS 复用同一工程**：不在首版构建，但目录、依赖和 transport 端口按 iOS 可复用设计。
3. **鸿蒙暂不承诺原生**：不引入 RNOH；未来优先用 H5/ArkWeb 壳，协议和 `@answra/remote` 不动。若鸿蒙原生 App 成为硬需求，另立 Note 重新选型。
4. **不抽 `@answra/auth`**：首版移动 auth 通过 `AuthPort` 隔离在 `apps/mobile/src/auth`；不复制 desktop 的 capabilities/quota/announcements。出现第二个移动宿主或 auth 协议变更时，再提取 `@answra/auth`。
5. **复用远程核心**：移动端只依赖 `@answra/shared` 和 `@answra/remote`；连接状态、重连、命令关联、snapshot/event 语义全部复用，不在 App 内复制。
6. **手动连接码**：首版只做手动输入 `answra1.<roomId>.<keyId>.<secret>`；二维码后续加，不改变协议。
7. **前台文本会话**：首版不做后台常驻、推送、图片、大历史、工具输出分片、TURN、模型设置、team/interview/answer。
8. **先同 LAN 验收**：蜂窝网络可能因 CGNAT/对称 NAT 失败，这是显式产品代价，不用 Cloudflare 兜底。

### 2. 目录与依赖

```text
apps/mobile/
  app.json
  eas.json
  metro.config.cjs
  babel.config.cjs
  package.json
  tsconfig.json
  src/
    app/                    # expo-router；只做路由和页面装配
      _layout.tsx
      index.tsx             # 电脑列表 / 连接入口
      connect.tsx           # 手动输入连接码
      hosts/[hostId].tsx    # 当前电脑、会话列表
      chat/[conversationId].tsx
      settings.tsx
    core/                   # 纯 TS；禁止 import React/RN/Expo
      controller/
        controllerRuntime.ts
        attempt.ts
        sessionProjection.ts
        hostCatalog.ts
        errors.ts
      ports/
        authPort.ts
        credentialPort.ts
        networkPort.ts
        lifecyclePort.ts
        clock.ts
    transport/              # 只实现端口，不解释业务命令
      signaling.ts
      webRtcLink.ts
      timers.ts
      netInfo.ts
      appState.ts
    auth/
      mobileAuthService.ts
      callback.ts
      device.ts
      endpoints.ts
    credentials/
      secureAuthStore.ts
      secureHostKeyStore.ts
    state/
      appStore.ts
      selectors.ts
    ui/
      tokens.ts
      primitives/
      screens/
    config/
      endpoints.ts
  test/
    core/
    auth/
    transport/
```

依赖方向：

```text
@answra/shared  ←  @answra/remote  ←  apps/mobile
@answra/shared  ←  apps/mobile
```

`apps/mobile` 禁止 import：

- `@answra/agent`
- `@answra/remote-node`
- `@answra/config`
- `@answra/credentials`
- `@answra/ui`
- `apps/desktop`、`apps/cli`
- `node:*`、`electron`

`apps/mobile/src/core` 额外禁止 import：

- `react`
- `react-native`
- `expo-*`
- `@react-native-community/netinfo`

`apps/mobile/src/transport` 可以使用 RN/Expo 模块，但只能实现 `SignalingChannel`、`RemoteLink`、计时器、网络和生命周期端口；不得复制 `RemoteControllerSession`、`RemoteHostSession`、重连策略或命令解析。

`scripts/architecture/architecture-check.mjs` 增加对应断言；`apps/mobile/src/core` 的纯 TS 测试必须能在 Node/Vitest 下运行，不加载 RN 原生模块。

### 3. 状态所有权

| 状态 | 唯一写者 | 说明 |
| --- | --- | --- |
| auth token / refresh token | `MobileAuthService` + `SecureAuthStore` | 只在 SecureStore；不进入 AsyncStorage、日志、URL |
| host key | `SecureHostKeyStore` | 完整连接码只进 SecureStore；AsyncStorage 只放 label、roomId、keyId、最近连接时间 |
| 连接状态 | `RemoteControllerConnection` | 不在 `AppStore` 复制 `connecting/reconnecting/closed` |
| attempt / generation | `RemoteControllerConnection` | 每次重连新建 attempt；旧回调按 generation 丢弃 |
| 会话 transcript / run 投影 | `SessionProjection` | 只消费 `ConversationSnapshot` 和 `AgentEventEnvelope`，丢弃旧 revision |
| 页面视图状态 | `AppStore` | `useSyncExternalStore` 订阅；只写 UI 状态、草稿、选中项、错误提示 |
| 网络/前后台 | `transport/netInfo.ts`、`transport/appState.ts` | 只把事件转成 `reconnectNow()` / `suspend()` / `resume()`，不判断业务 |

`AppStore` 不能成为第二个连接状态机。UI 只读 `AppStore` 和 `RemoteControllerConnection` 的投影；发送、取消、重连全部调用 `ControllerRuntime`。

### 4. 认证与凭据

#### 4.1 `AuthPort`

`apps/mobile/src/core/ports/authPort.ts` 只定义：

```ts
export interface AuthPort {
  status(): Promise<{ signedIn: boolean; account: string | null }>;
  login(): Promise<void>;
  logout(): Promise<void>;
  getAccessToken(): Promise<string>;
}
```

`MobileAuthService` 是唯一实现：

- OAuth 授权码 + PKCE S256。
- 使用 `expo-web-browser.openAuthSessionAsync()` 打开 AnswraSite 授权页并接收回调。
- 使用 `expo-crypto` 生成 verifier/state 和 SHA-256 challenge。
- 授权前把 `state`、`verifier`、`redirectUri`、创建时间写入 SecureStore；回调校验 `state` 后立即删除。
- token exchange / refresh / revoke 使用现有 AnswraSite 端点；refresh 单飞，提前 60 秒视为过期。
- 服务端明确 4xx 拒绝时清空 SecureStore；网络/超时/5xx 保留登录态并返回可重试错误。
- 不把 access token 放进日志、错误文案或 WebSocket URL。

#### 4.2 移动回调地址

- `app.json` 的 `scheme` 使用 `answra-mobile`。
- 回调地址固定为 `answra-mobile://auth/callback`。
- AnswraSite 必须把该 `redirect_uri` 加入允许列表；这是外部前置条件。若服务端未支持，停止在 Phase 1，不用临时轮询或假登录绕过。

#### 4.3 host key

- 连接码用 `@answra/remote` 的 `createRemoteCredentialRecord` 校验并解析。
- 完整 key 以 `host-key:<keyId>` 写入 SecureStore；不写 AsyncStorage。
- `HostCatalog` 只保存非 secret 元数据：`keyId`、`roomId`、label、`lastConnectedAt`、`lastErrorCode`。
- 收到 `unauthorized`、`key-revoked`、`key-expired` 时删除对应 SecureStore 记录，保留 host 元数据并提示重新导入。
- 桌面 `disconnect()` 会撤销 active key；手机不能假设连接码长期有效，重连失败必须回到“重新输入连接码”。

### 5. 传输与连接

#### 5.1 信令适配

`apps/mobile/src/transport/signaling.ts` 实现 `SignalingChannel`：

- 使用 RN 全局 `WebSocket`。
- 复用 `@answra/shared/schema` 的 `signalingFrameSchema` 和 `@answra/remote` 的 `encodeSignalingFrame` / `decodeSignalingFrame`。
- 不复制房间状态机；`RemoteSignalingSession` 继续负责 join、presence、offer/answer/ICE 方向。
- ticket 请求使用 `fetch` + `RemoteOperationError` 映射；不引入 `@answra/remote-node`。

`apps/mobile/src/transport/timers.ts` 提供 `RemoteSignalingTimers`，只封装 `setTimeout` / `clearTimeout`。

#### 5.2 WebRTC 适配

`apps/mobile/src/transport/webRtcLink.ts` 实现 `RemoteLink`：

- 使用 `react-native-webrtc` 的 `RTCPeerConnection`。
- controller 侧监听 `ondatachannel`，只接受 label `answra.remote.data`、protocol `answra.remote.v1` 的 DataChannel。
- 处理 `onopen`、`onclose`、`onerror`、`onmessage`、`onicecandidate`。
- 处理 `offer` / `answer` / `ice-candidate`，应用 `RemoteSignalingFacade`。
- 构造函数注入 `createPeerConnection` 工厂，测试用 fake 实现；不直接依赖原生模块做单元测试。
- 只做 DataChannel；不请求相机、麦克风、屏幕捕获权限。

#### 5.3 一次连接 attempt

`apps/mobile/src/core/controller/attempt.ts` 负责组装，不持有 UI：

```ts
createAttempt(credential) {
  const signaling = await connectMobileSignaling({ ... });
  const link = new MobileWebRtcLink({ role: "controller", signaling });
  const session = new RemoteControllerSession({
    link,
    sessionId,
    peerId,
    credential,
  });
  return { session, close() { session.close(); signaling.close(); } };
}
```

`ControllerRuntime` 持有 `RemoteControllerConnection`，对外提供：

- `connect(credential)`
- `disconnect()`
- `reconnectNow()`
- `suspend()` / `resume()`
- `send()`, `cancel()`, `clearConversation()`
- `onState`, `onSnapshot`, `onEvent`, `onError`

`RemoteControllerConnection` 已经实现退避、终态、`connectionId` 代际和 `reconnectNow()`；移动端不得另写重试循环。

#### 5.4 网络与前后台

- `NetInfo` 从 Wi-Fi/蜂窝/无网变化时调用 `reconnectNow()`；不等待普通退避。
- `AppState` 进入后台超过 60 秒时 `suspend()`：关闭当前 connection，保留 credential、host 元数据和草稿。
- 回前台时 `resume()`：创建新的 `RemoteControllerConnection`，重新连接，先 snapshot 再 `readEvents(afterRevision)`。
- 后台常驻、推送、锁屏保活不在首版；不能假装支持。

#### 5.5 前置协议变更：link heartbeat

现有 `RemoteFrame` 没有 `ping` / `pong`；`RemoteControllerConnection` 只能依赖 DataChannel close 和 ICE 状态，半开连接可能长时间不发现。移动端首版依赖网络切换触发重连，但不能宣称已覆盖半开。

本提案要求在同一阶段补最小链路心跳：

- `packages/shared/src/schema/remote/frames.ts` 增加 `ping` / `pong` 帧，带单调递增 `nonce`。
- `RemoteControllerSession` 每 5 秒发 `ping`；任何 `RemoteFrame` 都算活；连续 3 次没有 `pong` 且无其他帧，关闭 link。
- `RemoteHostSession` 收到 `ping` 立即回 `pong`，不进入命令队列、不写事件。
- 心跳失败进入 `interrupted`，交给 `RemoteControllerConnection` 的既有重连策略；不新增第二套重连。
- 测试覆盖：schema round-trip、host 回 pong、controller 超时关闭、任意帧重置存活、旧 `connectionId` 心跳不串代际。

如果评审要求把心跳独立留痕，拆成单独 Note；但移动端 Phase 2 必须依赖它，不能把半开检测留成“以后再说”。

### 6. 会话与 UI

`SessionProjection` 只做三件事：

1. 应用 `ConversationSnapshot`，替换当前会话的完整视图。
2. 按 `eventRevision` 追加/更新消息、run、队列和错误；旧 revision 丢弃。
3. 为 UI 提供不可变视图：`messages`、`activeRun`、`queuedMessages`、`connectionBanner`、`lastError`。

不推导 Agent 状态，不根据消息文本猜 run 状态，不在手机上保存第二份 transcript。

首版页面：

- `/`：电脑列表；没有 host 时显示“输入连接码”。
- `/connect`：手动输入连接码；校验格式后写入 SecureStore。
- `/hosts/[hostId]`：当前电脑、连接状态、会话列表；只显示 `conversation` scope。
- `/chat/[conversationId]`：消息、发送、排队、停止、断线横幅、重连状态。
- `/settings`：账号、登出、清除本机 host、诊断信息；不提供模型 Key、shell、工作区权限。

能力门禁：

- 只按 host `welcome.capabilities` 显示入口。
- 首版只处理 `conversation` 和 `sessions`；不显示 `team`、`model-settings`、`multi-bot`。
- 发送只允许 `chat.send`；`team.send` 不显示、不发送。

UI 使用 RN 原语和自有 token；不复用 `packages/ui` 的 React DOM 组件和 CSS。状态色只表达等待/运行/完成/错误，品牌色只做标识。

### 7. 构建与发布

- Expo Continuous Native Generation：不提交 `android/`、`ios/`；原生配置只放 `app.json` 和 config plugins。
- 依赖版本用 `pnpm --filter @answra/mobile exec expo install <pkg>` 解析，不直接猜版本；不复制 `cc-haha` 的 Expo/RN 版本。
- `metro.config.cjs` 配置 pnpm monorepo 的 `watchFolders` 和 `nodeModulesPaths`；`expo-doctor` 通过后才继续。
- `app.json`：
  - `android.package = "dev.answra.mobile"`（实施前确认）
  - `scheme = "answra-mobile"`
  - 只申请首版需要的权限；WebRTC 只做 DataChannel，不申请相机/麦克风/屏幕捕获。
- `eas.json`：
  - `preview` profile 输出 APK，用于没有本地 Android SDK 时的临时构建。
  - `production` 后续再接签名和商店。
- 本地构建：
  - 需要 JDK 17 + Android SDK；`expo prebuild --platform android --no-install` 后执行 `apps/mobile/android/gradlew.bat :app:assembleDebug`。
  - debug APK 用 `adb install -r` 安装。
- 正式签名、商店提交、iOS TestFlight 不在首版范围。

### 8. 测试与门禁

- `apps/mobile/src/core`：Vitest，使用 fake `AuthPort`、fake `SignalingChannel`、fake `RemoteLink`、fake timers；覆盖连接状态、重连、snapshot/event 追平、错误映射、host key 失效。
- `apps/mobile/src/auth`：Vitest + fake fetch/crypto/secure store；覆盖 PKCE、state 不匹配、刷新单飞、4xx 清空、网络失败保留。
- `apps/mobile/src/transport`：Vitest + fake `RTCPeerConnection`；覆盖 DataChannel label/protocol、旧 `connectionId`、半开心跳、发送失败、关闭清理。
- `apps/mobile/src/ui`：Jest + `@testing-library/react-native`；只测关键页面状态和交互，不测样式像素。
- 架构：`pnpm architecture:check` 断言 mobile 不越界、`core` 不 import RN。
- 全量：`pnpm --filter @answra/mobile typecheck`、`test`、`lint`，以及根 `pnpm verify`。
- 真机：至少一台 Android 真机，记录 Android 版本、WebView/Chrome 版本、同 LAN 连接耗时和失败码。

### 9. 分阶段执行

#### Phase 0：工程骨架与可行性

- 创建 `apps/mobile` Expo 工程、`app.json`、`eas.json`、Metro monorepo 配置。
- 建 `core/ports`、`core/controller`、`transport`、`state`、`ui` 空壳；只写端口和 fake。
- 加架构检查；不接真实网络、不写业务 UI。
- 在 Android development build 上验证 `react-native-webrtc` 能加载、SecureStore 能读写、深链能回调。
- 退出：`expo-doctor`、typecheck、architecture check 通过；dev build 可安装。

#### Phase 1：认证与凭据

- 实现 `AuthPort`、`MobileAuthService`、`SecureAuthStore`、`SecureHostKeyStore`。
- 确认 AnswraSite 允许 `answra-mobile://auth/callback`。
- 实现连接码解析、SecureStore 写入、host 元数据。
- 退出：真机完成登录、刷新、登出；连接码可保存/删除；没有 secret 进入 AsyncStorage 或日志。

#### Phase 2：传输与连接

- 实现 `signaling.ts`、`webRtcLink.ts`、`timers.ts`。
- 实现 `ControllerRuntime`、`attempt.ts`。
- 补 link heartbeat（见 5.5）。
- 用 fake 测重连、旧代际、心跳；真机连桌面 host，拿到 `welcome` 和 snapshot。
- 退出：Android 真机同 LAN 连上桌面 host，`list-sessions`、`snapshot`、`readEvents` 可用；Wi-Fi 切换能触发重连。

#### Phase 3：会话与最小 UI

- 实现 `SessionProjection`、`AppStore`、连接页、会话页、对话页。
- 接 `send`、`waitQueueStart`、`cancel`、`clearConversation`。
- 退出：手机可查看会话、发送消息、排队、停止 run；断线显示横幅，恢复后追平 revision。

#### Phase 4：APK 与真机验收

- 生成 debug APK，安装到 Android 真机。
- 同 LAN 验收：登录、连接、会话、发送、停止、断开、重新导入。
- 记录信令日志只含房间/角色/SDP/ICE 元数据，不含 prompt、回复、工具输出。
- 退出：APK 可重复安装；验收记录写入本 Note 或后续 implemented Note。

#### Phase 5：后续增强

- 二维码、图片/大历史分片、后台/推送、iOS 构建、H5/ArkWeb 兼容。
- 每一项单独评审；不把 TURN/relay 作为默认兜底。

### 10. 明确不做

- 不做手机 host、手机本地 Agent、手机工具执行。
- 不做 TURN、服务器 relay、Cloudflare 数据兜底、L7 转发。
- 不做服务器 transcript、消息历史、工具输出存储或 replay。
- 不做桌面本地 H5 服务；H5 若做，必须另行解决托管和凭据。
- 不做手机后台常驻 WebRTC、推送、Live Activity。
- 不做模型 API Key、shell、工作区权限、模型设置、team、interview、answer。
- 不做多 controller 同时写。
- 不复用 `packages/ui` 的 DOM 组件。
- 不在首版引入 RNOH 或鸿蒙原生工程。
- 不把 host key 放进 URL query、日志、AsyncStorage 或 localStorage。

## 模块边界

- `apps/mobile/src/app`：只做 Expo Router 路由和页面装配；不实现连接、认证或协议。
- `apps/mobile/src/core`：平台无关连接、attempt、投影、错误、host 元数据；不 import React/RN/Expo，不创建 WebSocket/PeerConnection。
- `apps/mobile/src/transport`：唯一创建 RN WebSocket、`react-native-webrtc`、NetInfo、AppState 的层；只实现端口，不解释命令。
- `apps/mobile/src/auth`：唯一处理 OAuth/PKCE/token 刷新的层；不读写 host key。
- `apps/mobile/src/credentials`：唯一读写 SecureStore 的层；不决定登录或连接策略。
- `apps/mobile/src/state`：唯一写移动视图状态的层；不复制连接状态或 transcript。
- `apps/mobile/src/ui`：只消费 `AppStore` 和 props；不 import `@answra/remote`、不创建 peer。
- `packages/remote`：继续平台无关；移动端只消费，不复制 host/controller 状态机。
- `packages/shared`：只放跨端 schema 和稳定错误码；心跳若实施，只加线协议，不放移动 UI 状态。
- `apps/desktop`：继续作为 host；不为移动端增加 renderer 网络能力。
- `apps/cli`：不再增加 controller；CLI 只保留 host。

状态单写者：

- `MobileAuthService`：auth token 生命周期。
- `SecureHostKeyStore`：host key 持久化。
- `RemoteControllerConnection`：连接状态、attempt generation、重连预算。
- `RemoteControllerSession`：hello/auth、命令 requestId、snapshot/event。
- `SessionProjection`：会话视图投影。
- `AppStore`：页面视图状态。

## 曾考虑的替代方案

- **Capacitor / WebView 壳**：舍弃为首版方案。开发快，但 WebView 的后台、推送、SecureStore 桥接和鸿蒙兼容都要另做；Android 原生体验和 `react-native-webrtc` 更直接。未来 H5/ArkWeb 可复用协议，不排除作为鸿蒙兼容层。
- **Flutter**：舍弃。现有远程协议、状态机和测试都在 TypeScript；Flutter 要重写 controller 或做 FFI，WebRTC/安全存储/推送插件也要重新验证。
- **现在做 RNOH 原生鸿蒙**：舍弃/推迟。Expo 官方不支持鸿蒙，`react-native-webrtc` 和 Expo 模块在 RNOH 上未验证；先把 Android/iOS 主路径做稳。
- **先做 H5/PWA**：舍弃为首版。手机需要 SecureStore、深链登录、原生 WebRTC 和后续推送；H5 更适合作为鸿蒙/浏览器的兼容层，不是 Android APK 的主路径。
- **Cloudflare 隧道兜底**：舍弃。违反“内容不经过服务器”和“不配置 TURN/relay”的既有边界。
- **桌面本地 H5 服务**：舍弃。违反“禁止在 src 中自建本地监听”，也把 H5 凭据和桌面网络边界混在一起。
- **复用 `packages/ui`**：舍弃。现有 UI 是 React DOM + CSS，不能直接在 RN 运行；移动端需要自己的 token 和原语。
- **现在抽 `@answra/auth`**：暂缓。会同时改桌面和 CLI 的登录链路，风险和范围过大；首版用 `AuthPort` 隔离，出现第二个移动宿主或 auth 协议变更时再提取。
- **移动端自己写重连/状态机**：舍弃。会与 CLI/桌面产生三套退避、错误码和草稿语义；必须复用 `RemoteControllerConnection`。
- **只做 CLI controller 不做手机**：舍弃。用户明确需要手机，且 CLI controller 已移除。

## 验收标准

- 可观察结果：
  - Android debug APK 可安装、启动、登录。
  - 手动输入桌面连接码后，同 LAN 建立 P2P DataChannel，看到桌面 `conversation` 会话列表。
  - 打开会话能看到 snapshot 和后续事件；发送、排队、停止可用。
  - Wi-Fi 切换或短暂断网后，UI 进入 `interrupted/reconnecting`，恢复后按 revision 追平，不重复发送未确认消息。
  - 桌面断开/撤销 key 后，手机显示 `key-revoked`/`unauthorized` 并要求重新导入。
  - 信令日志只有房间、角色、presence、SDP/ICE 元数据和心跳；没有 prompt、回复、工具输出、图片或 transcript。
  - 手机不持有模型 API Key；SecureStore 之外没有 host key 或 auth token。
- 自动化验证：
  - `apps/mobile/src/core` 连接、重连、投影、错误映射测试通过。
  - `apps/mobile/src/auth` PKCE、state、刷新、存储失败测试通过。
  - `apps/mobile/src/transport` fake WebRTC/心跳/旧代际测试通过。
  - `pnpm architecture:check` 断言 mobile 不 import 禁止包，`core` 不 import RN。
  - `pnpm --filter @answra/mobile typecheck`、`test`、`lint` 通过；根 `pnpm verify` 通过。
- 需要的实机验证：
  - Android 真机同 LAN：连接、会话、发送、停止、断网重连。
  - Android 真机蜂窝网络：记录是否 `remote-unreachable`；不要求首版成功。
  - 不能只用模拟器或 fake link 证明 P2P 可用。
  - iOS/HarmonyOS 不在本阶段验收；后续分别补。

## Phase 0 落地记录（2026-11-22）

已落地：

- `apps/mobile` Expo 58 / RN 0.88 工程：`app.json`、`eas.json`、`metro.config.cjs`、`babel.config.cjs`、`tsconfig.json`、`vitest.config.ts`。
- Expo Router 占位路由：`/`、`/connect`、`/hosts/[hostId]`、`/chat/[conversationId]`、`/settings`。
- `src/core/ports`：`AuthPort`、`HostCredentialStore`、`HostSummaryStore`、`NetworkPort`、`LifecyclePort`、`Clock`。
- `src/core/controller`：`ControllerRuntime`/`ControllerAttemptFactory` 契约、`HostSummary` 投影。
- `src/transport/timers.ts`：`RemoteSignalingTimers` 适配。
- `src/state/viewState.ts`、`src/ui/tokens.ts`、`src/ui/primitives/Screen.tsx`。
- 架构守护新增 mobile 依赖边界：只允许 `@answra/shared`/`@answra/remote`，`core` 禁止 React/RN/Expo。
- `AGENTS.md` 与 `README.md` 已同步 mobile 入口、依赖方向和 Phase 0 状态。

验证证据：

- `pnpm --filter @answra/mobile typecheck` 通过。
- `pnpm --filter @answra/mobile test` 通过：2 个测试文件、6 个用例。
- `pnpm --filter @answra/mobile exec expo-doctor` 通过：20/20。
- `pnpm --filter @answra/mobile exec expo export --platform android` 通过：Android bundle 成功。
- `pnpm architecture:check` 通过：11 个 workspace 包。
- `pnpm lint` 通过。
- `pnpm verify` 通过（exit 0），覆盖 lint、全包 typecheck、db:check、vitest、profiles:check、架构守护与 tokens:check。

未完成/未验证：

- 未生成 APK：本机没有 JDK/Android SDK，未做 `expo prebuild` 与 Gradle 构建。
- 未在 Android 真机验证 `react-native-webrtc` 加载、SecureStore 读写和深链回调；这些属于 Phase 0 的实机退出条件，当前只完成工程与自动化骨架。
- 本机 npmmirror 缺少 `metro-symbolicate@0.87.3`，首次 `pnpm install` 需 `--registry=https://registry.npmjs.org`；CI/其他开发机应使用官方 registry 或补齐镜像，否则安装会失败。

## 风险

- **可达性风险**：没有 TURN，手机蜂窝、CGNAT、对称 NAT、公司 UDP 封锁可能无法建立 P2P；必须显式失败，不得静默切 relay 或手机本地 Agent。
- **认证外部依赖**：AnswraSite 必须允许 `answra-mobile://auth/callback`；未支持时 Phase 1 阻塞，不能用假登录绕过。
- **host key 生命周期**：桌面 `disconnect()` 会撤销 key，手机保存的连接码会失效；UX 必须支持重新导入，不能把“保存过”当成永久授权。
- **半开连接**：不补 heartbeat 时只能依赖 DataChannel close/ICE 和网络切换；本提案要求 Phase 2 补最小心跳，否则不能宣称可靠断线检测。
- **原生构建风险**：`react-native-webrtc` 不在 Expo Go；必须 development build/prebuild。Android SDK/JDK 缺失时先用 EAS preview，但不能把云构建当成长期唯一路径。
- **pnpm/Metro 风险**：Expo monorepo 对 pnpm 的解析需要 Metro 配置；`expo-doctor` 不通过就停下修配置，不靠 `node_modules` 手工拷贝。
- **后台限制**：Android/iOS 会挂起后台网络；首版只保证前台连接，后台/推送另立提案。
- **凭据风险**：连接码泄露等同远程控制权限；必须 SecureStore、可撤销、不得进入日志/URL/AsyncStorage。
- **协议漂移风险**：移动端不得复制 `RemoteControllerSession`/`RemoteHostSession`/重连策略；共享核心变更必须同步移动端测试。
- **鸿蒙不确定性**：本提案不承诺鸿蒙原生 App；如果后续要求原生上架，必须重新评估 RNOH/Flutter/Web-first，不在现有骨架上硬塞。
