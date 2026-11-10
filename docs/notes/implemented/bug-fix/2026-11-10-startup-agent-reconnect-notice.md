# Note：启动阶段不再展示 Agent 重连错误

状态：已实施

## 问题

应用启动后、用户尚未发送任何消息时，界面直接显示“网络连接中断，正在重连 5/5”。用户会误以为外网或云端模型不可用；实际是本地 agent worker 的启动预热与重试。

现场主进程约 16:20:21 启动，worker 进程约 16:21:23 才出现；单独用 Electron host 拉起 worker 并 `ping` 约 686ms 成功。因此 5/5 不是 AI 服务启动需要一分钟，而是启动重试循环在 UI 中持续可见。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/conversation/agentWorkerHost.ts`、`apps/agent/src/client/connection.ts`、`packages/ui/src/app/useConnectionState.ts`、`packages/ui/src/components/chat/ConnectionNotice.tsx`、`packages/ui/src/app/FloatingBarApp.tsx`、`packages/ui/src/app/ChatFeaturePanel.tsx`
- UI/进程/协议/持久化表面：启动预热、renderer 连接状态投影、对话/截图答题/面试/回复条发送失败提示；无协议或持久化变化
- 相关 Note：`docs/notes/implemented/architecture/2026-11-10-agent-connection-domain.md`

## 决定

- 启动预热继续保留，但首次成功连接前的连接状态不进入 UI。
- 首次成功连接前的 `reconnecting`/`unavailable` 不展示；首次连接成功后，运行期 `reconnecting` 仍展示重连计数，重试耗尽的 `unavailable` 展示本地 AI 服务提示。
- 用户发送失败时必须在对应表面显示同一句本地服务提示，不再静默吞掉断链错误。

## 根因

- `apps/desktop/src/main/index.ts` 在应用启动时调用 `startAgent()` 预热 worker；启动失败会按 `apps/agent/src/client/connection.ts` 的默认策略重试 5 次。
- `useConnectionState` 把 main 下发的所有状态原样投影到 UI；`ConnectionNotice` 把 `reconnecting` 渲染成“网络连接中断，正在重连 n/5”，且使用“网络”措辞。
- 发送链路对 `agent-service-disconnected` 做了静默处理：`FloatingBarApp.notifySendError` 与 `ChatFeaturePanel` 的 catch 直接返回，导致真正由用户发送触发的失败没有可见反馈。

## 修复

- `useConnectionState` 在首次 `connected` 前丢弃 `connecting`、`reconnecting`、`unavailable`；启动预热失败不进入 UI。
- `ConnectionNotice` 恢复展示 `reconnecting` 计数（“本地 AI 服务未连接，正在重连 n/5”）；启动期静默由 `useConnectionState` 过滤，重试耗尽的 `unavailable` 展示“本地 AI 服务暂不可用，请稍后重试”。
- 发送失败不再吞掉断链错误：对话与回复条的 `toFailure`、面试消息 catch、`ChatFeaturePanel` catch 统一映射到 `AGENT_SERVICE_UNAVAILABLE_NOTICE`。
- 启动预热保留，不改变 worker 生命周期；用户发送时仍由发送路径按需拉起或返回可展示失败。

## 曾考虑的替代方案

- **移除启动预热：** 舍弃。直接拉起 worker 并 `ping` 约 686ms，慢的是重试循环而非启动本身；移除预热不解决未发送时展示错误的问题，还会让首次发送承担冷启动等待。
- **只改文案为“本地服务重连”：** 舍弃。用户仍会在未操作时看到错误横幅，违背“启动不报错、发送失败才报错”的行为要求。
- **从启动就展示 `reconnecting`：** 舍弃。启动预热不是用户操作触发的运行期断链，会让首次打开就显示失败；首次连接成功后的重连仍保留展示。
- **运行期也永远隐藏所有连接状态：** 舍弃。首次连接成功后 worker 真正断开时，用户需要看到重连进度；`reconnecting` 和 `unavailable` 仍应作为运行期状态提示。
- **改为全局 toast：** 舍弃。现有产品约定失败留在发起它的对话/回复条表面；全局浮层会脱离上下文，并与模型错误提示形成两个入口。

## 后果与防回退

- 启动阶段不再出现连接横幅；首次连接成功后的运行期 `reconnecting` 仍显示重连计数，终态 `unavailable` 显示本地服务提示；发送失败在对应会话或回复条显示同一句提示。
- 不得把启动阶段的重连状态提前投影到 UI，也不得在连接成功后继续隐藏 `reconnecting`；发送链路不得重新吞掉 `agent-service-disconnected`。
- 提示文案必须继续使用单一常量 `AGENT_SERVICE_UNAVAILABLE_NOTICE`，避免不同表面出现“网络/本地服务”两套措辞。
- 启动静默只适用于首次 `connected` 之前；连接成功后的状态仍按 revision 投影，防止把真实断链也永久隐藏。

## 验证

- `packages/ui/test/useConnectionState.test.tsx`：启动期 `reconnecting`/`unavailable` 被丢弃，首次 `connected` 后恢复状态投影。
- `packages/ui/test/ConnectionNotice.test.tsx`、`ChatPanel.test.tsx`、`ReplyBarWindowApp.test.tsx`、`ReplyActivityTicker.test.tsx`：启动期 `reconnecting` 被过滤，首次连接成功后 `reconnecting` 显示计数，`unavailable` 显示本地服务提示并压过模型错误。
- `packages/ui/test/FloatingBarApp.test.tsx`：用户发送时 worker 已断链，会话显示“本地 AI 服务暂不可用，请稍后重试”，且草稿保留。
- 已执行：`pnpm notes:check` 通过；`pnpm lint`、`pnpm --filter @answra/ui typecheck`、`pnpm architecture:check` 通过；目标 UI 84 测试、全量 UI 298 测试通过。
- `pnpm verify` 当前在 `apps/desktop` typecheck 被未提交的 `pdfjs-dist/legacy/build/pdf.worker.mjs` 与 `word-extractor` 类型声明缺失阻断，与本次变更无关。
- 待实机验证：启动时无连接错误；运行期断链显示“本地 AI 服务未连接，正在重连 n/5”；重试耗尽和发送失败显示本地服务提示；模型自身失败仍显示模型错误。
