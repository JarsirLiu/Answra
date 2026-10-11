# Note：功能边界与本地运行时分层

状态：已实施

## 问题

多人并行开发时，`FloatingBarApp` 容易同时承载表面生命周期、截图工作流、主题和平台桥接；未来还要在 `apps/app` 下运行本地服务和模型适配器。如果这些职责直接互相调用，UI、Electron 和服务运行时会形成难以测试的中心依赖。

## 涉及范围

- 代码/模块：`packages/ui/src/app/useSurfaceCoordinator.ts`、`packages/ui/src/app/FloatingBarApp.tsx`、`apps/app/src/conversationRuntime.ts`、`apps/desktop/src/main/conversation/`
- 相关 Note：桌面端架构边界、悬浮栏表面与任务工作流、[笔试截图一次性图片对话 V1](../feature/2026-10-11-ephemeral-exam-image-chat-v1.md)、[拒绝 V1 使用独立 Node 服务与 stdio 协议](../../rejected/architecture/2026-10-11-local-app-service-and-agent-boundary.md)

## 决定

表面生命周期由 `useSurfaceCoordinator` 统一管理。导航、二级面板、临时浮层和持续工作流由同一个 reducer 保证规则一致，但页面只使用命令方法，不直接拼装 reducer action。

本地截图对话遵守以下依赖方向：

```text
shared <- app runtime <- desktop main
shared <- ui <- desktop renderer
```

`apps/app` 当前负责单次 OpenAI-compatible 模型调用、图片校验和流式结果，不依赖 React 或 Electron。desktop main 以 Electron utility process 承载 worker，管理其生命周期、模型密钥安全存储、来源校验和事件转发；renderer 只通过 preload 访问类型化能力。UI 使用 AI SDK `useChat` 保留当前界面展示状态，但每次 transport 仅发送最新 user message。

## 模块边界

- `packages/ui`：表面状态、交互和展示；不负责服务进程、模型凭据或网络请求。
- `apps/desktop/src/main`：窗口、IPC、utility process worker 生命周期、安全配置存储及操作系统截图/录屏能力；不实现模型调用。
- `apps/app`：OpenAI-compatible 单次图文请求运行时；不持有窗口、UI 状态、密钥持久化或会话历史。
- `packages/shared`：跨边界的纯类型和协议；不放进程句柄、React 状态或供应商 SDK。

## 曾考虑的替代方案

- **独立 Node sidecar 和 stdio：** 首版没有第二客户端需求，单独打包 Node 会显著增加安装体积；复用 Electron 29 utility process。
- **localhost 服务：** 当前仅有桌面 renderer，增加端口、认证和来源控制没有首版收益；通过现有 preload IPC 接入。
- **把服务调用放进 `FloatingBarApp`：** 会让 UI 测试依赖网络和模型状态，也会绕过 Electron 的权限与生命周期管理，因此舍弃。
- **为每个面板各自维护开关状态：** 会重新引入面板、浮层和工作流互相覆盖的问题，因此继续由统一 coordinator 管理。

## 后果与防回退

- 新表面必须通过 `useSurfaceCoordinator` 或其后续等价 controller 改变生命周期，不能在页面内新增第二套 open/close 状态。
- 新模型能力必须在 `apps/app` runtime adapter 与 shared IPC 契约中明确声明；UI 不直接访问 provider。
- transport 只能发送最后一条 user message；禁止把 `useChat` 的展示消息列表整体转成模型上下文。
- 对话/图片内容不得写盘；新增多轮、压缩、工具/MCP、记忆或媒体持久化前，须各自新增 Note 定义数据所有权、保留期和权限。
- Electron 版本保持 `29.4.6`，不能因 Agent 依赖升级绕过隐身捕获验收。

## 验收标准

- `FloatingBarApp` 不再直接创建 surface reducer 实例。
- 现有面板互斥、浮层关闭和工作流恢复行为保持不变。
- 架构检查不允许 UI 或 renderer 引入 Electron/Node。

## 验证

- 已补充 `useSurfaceCoordinator` 封装，并复用现有 `surfaceState` 测试覆盖生命周期规则。
- 提交前运行 `pnpm notes:check`、`pnpm verify` 和 `pnpm architecture:check`。
