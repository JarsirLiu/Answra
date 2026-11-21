# Note：桌面远程 host 运行时——remote-node 抽取、host key 与最小控制面

状态：已实施

## 问题

桌面 `conversation` 命令适配已经落地，但还缺少可启动的 host 运行时：

- CLI 的 `startRemoteHost`、信令 WebSocket、计时器与 `node-datachannel` 适配都留在 `apps/cli`，桌面无法复用；直接复制会形成第二套协议与重连语义。
- 桌面没有 host key 存储。复用 CLI 的 `host-keys.json` 会绕过 Electron `safeStorage`，也违反“桌面与 CLI 凭据分离”的边界。
- 桌面 main 没有远程 host 生命周期：创建/轮换连接码、启动/停止、登录态失效停止、状态广播都没有唯一组合根。
- renderer 没有最小入口，用户无法一键开启或断开 host。
- 打包链路没有把 `node-datachannel` 作为 native runtime 依赖处理，Electron 打包后可能加载失败。

## 涉及范围

- 新增包：
  - `packages/remote-node/package.json`
  - `packages/remote-node/src/index.ts`
  - `packages/remote-node/src/connectRemoteSignaling.ts`
  - `packages/remote-node/src/nodeTimers.ts`
  - `packages/remote-node/src/nodeWebRtcLink.ts`
  - `packages/remote-node/src/remoteLinkFactory.ts`
  - `packages/remote-node/src/remoteSignalingService.ts`
  - `packages/remote-node/src/runtimeDependencies.ts`
  - `packages/remote-node/src/startRemoteHost.ts`
  - `packages/remote-node/src/webSocketSignalingChannel.ts`
- 共享/CLI：
  - `packages/remote/src/access/hostKeyFile.ts`、`packages/remote/src/index.ts`
  - `apps/cli/src/main.ts`、`apps/cli/src/cli/dependencies.ts`、`apps/cli/src/cli/remoteSessionCommands.ts`
  - `apps/cli/src/remote/credentials/fileRemoteHostKeyStore.ts`
- 桌面：
  - `apps/desktop/src/main/remote/credentials/encryptedRemoteHostKeyStore.ts`
  - `apps/desktop/src/main/remote/host/desktopRemoteHostService.ts`
  - `apps/desktop/src/main/remote/remoteIpc.ts`
  - `apps/desktop/src/main/window.ts`、`apps/desktop/src/main/index.ts`
  - `apps/desktop/src/preload/index.ts`、`apps/desktop/src/preload/answer.ts`
- 共享 IPC/UI：
  - `packages/shared/src/channels/remote.ts`、`packages/shared/src/channels.ts`、`packages/shared/src/bridge.ts`
  - `packages/ui/src/components/panels/RemoteHostSettings.tsx`、`SettingsPanel.tsx`、`SettingsPanel.css`
- 打包/架构：
  - `apps/desktop/package.json`、`apps/desktop/release-profiles.json`
  - `apps/desktop/scripts/build-electron.mjs`、`apps/desktop/scripts/audit-packaged-app.cjs`
  - `scripts/architecture/architecture-check.mjs`

## 决定

### 1. Node 远程适配独立为 `@answra/remote-node`

`@answra/remote` 保持平台无关；信令 HTTP/WebSocket、Node 计时器、`node-datachannel` 与 `startRemoteHost` 组合移入 `@answra/remote-node`。CLI host 与桌面 main 共用该包，PC/手机 controller 不依赖它。

### 2. host key 存储按宿主分离

`@answra/remote` 只提供通用 JSON store 与文件端口；CLI 继续使用本地受保护 JSON，桌面新增 `remote-host.bin`，通过 `safeStorage` 加密读写。桌面 key 不可用即失败，不回退明文，也不读写 CLI 文件。

### 3. 桌面 host 生命周期只有一个组合根

`DesktopRemoteHostService` 负责：

- `connect()`：生成新 key 后启动 host，返回一次性明文与状态；启动失败时停止并撤销新 key。
- `disconnect()`：停止 host 并撤销 active key，连接码不能继续复用。
- `createKey()`：停止当前 host、撤销所有 active key、生成永久 key，并只返回一次明文。
- `start()`：必须存在 active key；先确认登录令牌，再创建信令服务、计时器、WebRTC link 与命令端口。
- `stop()`：关闭 handle，状态回到 `stopped`，不撤销 key；登录态失效与进程退出走这条路径。
- `onAuthStatus(false)`：立即停止 host。
- 状态推送：`stopped`、`starting`、`waiting`、`ready`、`reconnecting`、`interrupted`。
- 启动代际：启动过程中登出/停止后，即使 `startHost` 晚到也会立刻关闭，不会把 host 重新挂回。

### 4. renderer 只拿到最小状态与一次性连接码

设置面板只保留一个“远程连接/断开连接”按钮：连接走单个 main 命令，生成新连接码并启动 host；断开时停止并撤销 key、清空连接码。连接码只显示一次并支持复制。不暴露 host key 文件、信令 token 或 Agent 事件流。当前为最小联调版本，连接码由 main 明文返回 renderer 显示，尚未实现 main 生成二维码。

### 5. `node-datachannel` 按 native runtime 处理

桌面主进程 bundle 将 `node-datachannel` 标记为 external；打包时 `asarUnpack` 覆盖 `node-datachannel` 与 `@node-datachannel/*`；发布审计把两者纳入 native runtime 检查。

## 模块边界

- `@answra/remote`：只保留平台无关协议、状态机与通用 JSON store；不 import Node、Electron、React、Ink、Agent、CLI。
- `@answra/remote-node`：只封装 Node 信令/WebRTC/计时器与 host 组合；不 import Electron、React、Ink、Agent、CLI、desktop。
- `apps/desktop/src/main/remote`：唯一持有桌面 host 生命周期、`safeStorage` key store 与 Agent 命令端口；不复制信令/WebRTC 协议。
- `apps/desktop/src/preload`：只转发 IPC；不持有 key、不启动 host。
- `packages/ui`：只消费 `DesktopBridge` 的状态与操作；不 import Electron/Node，不直接访问 key 文件。
- `apps/cli/src/remote`：只做 CLI host 适配与 host key 存储；信令/WebRTC 一律调用 `@answra/remote-node`，不保留 controller 入口。

状态单写者：

- `DesktopRemoteHostService`：唯一写桌面 host 生命周期与状态。
- `createEncryptedRemoteHostKeyStore`：唯一写桌面 host key 文件。
- `RemoteHostSession` / `startRemoteHost`：继续作为连接与 key 校验的唯一运行时来源。

## 曾考虑的替代方案

- **继续把 Node 实现留在 `apps/cli`，桌面复制一份**：舍弃。会产生两套信令重连、计时器和 WebRTC 适配。
- **把 Node 实现放进 `@answra/remote`**：舍弃。会破坏平台无关核心，并让 Web 端被迫接触 Node 模块。
- **桌面复用 CLI `host-keys.json`**：舍弃。绕过 `safeStorage`，且 CLI 与桌面凭据边界不清。
- **连接码只在 main 生成二维码，不进 renderer**：方向正确，但当前先做桌面 host 与 PC/手机 controller 联调；明文一次性返回 renderer 是已知收敛项。
- **桌面自动启动 host**：舍弃。首版要求用户显式生成 key 并开启，避免登录后后台监听。

## 后果与防回退

- 新增 `@answra/remote-node` 后，CLI 与桌面 main 的远程实现必须继续共用该包；不得再把 `node-datachannel` 或 WebSocket 状态机复制回宿主。
- 桌面 host key 只能通过 `createEncryptedRemoteHostKeyStore` 读写；不得改用 CLI 文件或明文。
- 任何启动流程变更都必须保留启动代际检查，防止登出后晚到的连接重新挂起。
- 打包必须保留 `node-datachannel` 的 external、`asarUnpack` 与审计条目；否则安装包可能能构建但运行期加载失败。
- 当前连接码是永久 key，断开时撤销；后续若改为过期 key，需要同时调整 UI、状态和 controller 录入体验。

## 验证

- `pnpm --filter @answra/remote-node test`：4 个测试通过。
- `pnpm --filter @answra/remote test`：48 个测试通过。
- `pnpm --filter @answra/desktop test -- test/desktopRemoteHostService.test.ts test/remoteCommandPort.test.ts test/agentService.test.ts`：18 个测试通过。
- `pnpm --filter @answra/ui test -- test/RemoteHostSettings.test.tsx`：3 个测试通过。
- `pnpm --filter @answra/cli test -- test/remote/remoteCommand.test.ts test/remote/remoteRuntimeCommand.test.ts test/remote/credentials/remoteKeyStores.test.ts`：8 个测试通过。
- `pnpm verify` 全绿；UI 套件曾出现一次既有 `FloatingBarApp.answer.test.tsx` 并行偶发失败，复跑通过，与远程改动无关。
- `pnpm --filter @answra/desktop build:electron -- --profile=full` 与 `pnpm --filter @answra/cli build` 通过。
- 未完成证据：真实桌面 host 与 PC/手机 controller 的 P2P 联调、真实信令服务 `connectionId` 支持、Windows 安装包原生加载验证、移动端 APK 构建。

## 风险

- 当前没有真实跨机联调；单元测试只能证明生命周期、key 存储和命令适配，不能证明网络可达。
- `RemoteHostSession` 认证后撤销 key 不会主动断开活动连接；当前通过停止 host/轮换 key 收敛。
- `cancel` 已要求 `conversationId` 并通过可见会话集合校验；仍未校验 runId 是否属于该会话，依赖桌面 `AgentService.cancel` 的 run 归属。
- 连接码明文进入 renderer，且为永久 key；二维码与更短有效期尚未实现。
- 桌面安装包的 `node-datachannel` 加载尚未在目标 Windows 环境实测。
