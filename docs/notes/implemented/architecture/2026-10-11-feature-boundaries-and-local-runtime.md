# Note：功能边界与本地运行时分层

状态：已实施

## 问题

多人并行开发时，`FloatingBarApp` 容易同时承载表面生命周期、截图工作流、主题和平台桥接；未来还要在 `apps/app` 下运行本地服务和模型适配器。如果这些职责直接互相调用，UI、Electron 和服务运行时会形成难以测试的中心依赖。

## 涉及范围

- 代码/模块：`packages/ui/src/app/useSurfaceCoordinator.ts`、`packages/ui/src/app/FloatingBarApp.tsx`
- 未来边界：`apps/app` 本地运行时、模型供应商适配和服务生命周期
- 相关 Note：桌面端架构边界、悬浮栏表面与任务工作流

## 决定

当前先把表面生命周期封装为 `useSurfaceCoordinator`。导航、二级面板、临时浮层和持续工作流仍由同一个 reducer 保证规则一致，但页面只使用命令方法，不直接拼装 reducer action。

未来新增 `apps/app` 时，遵守以下依赖方向：

```text
shared <- app runtime <- desktop main
shared <- ui <- desktop renderer
```

`apps/app` 只负责本地 HTTP/API 生命周期、会话编排和模型适配器；不得导入 React、Electron 或桌面窗口实现。模型适配器统一返回应用自己的流式消息协议，本地模型和云端订阅模型都接入同一协议。Electron main 负责启动、停止、端口和崩溃处理，renderer 只通过 preload 访问能力。

## 模块边界

- `packages/ui`：表面状态、交互和展示；不负责服务进程、模型凭据或网络请求。
- `apps/desktop/src/main`：窗口、IPC 和本地运行时监管；不实现模型业务。
- `apps/app`（未来）：本地服务、模型路由、会话和供应商适配；不依赖 Electron。
- `packages/shared`：跨边界的纯类型和协议；不放进程句柄、React 状态或供应商 SDK。

## 曾考虑的替代方案

- **现在直接创建 `apps/app` 和完整 API：** 当前没有稳定的服务协议和模型调用需求，先建空服务会制造假接口和额外发布面，因此暂不创建。
- **把服务调用放进 `FloatingBarApp`：** 会让 UI 测试依赖网络和模型状态，也会绕过 Electron 的权限与生命周期管理，因此舍弃。
- **为每个面板各自维护开关状态：** 会重新引入面板、浮层和工作流互相覆盖的问题，因此继续由统一 coordinator 管理。

## 后果与防回退

- 新表面必须通过 `useSurfaceCoordinator` 或其后续等价 controller 改变生命周期，不能在页面内新增第二套 open/close 状态。
- 新增本地模型或云端模型时，先定义 shared 流式协议，再实现 app runtime adapter；UI 不直接依赖供应商 SDK。
- `apps/app` 只有在服务协议、启动方式和测试边界确定后创建；不能把它当成 desktop 的杂物目录。

## 验收标准

- `FloatingBarApp` 不再直接创建 surface reducer 实例。
- 现有面板互斥、浮层关闭和工作流恢复行为保持不变。
- 架构检查不允许 UI 或 renderer 引入 Electron/Node。

## 验证

- 已补充 `useSurfaceCoordinator` 封装，并复用现有 `surfaceState` 测试覆盖生命周期规则。
- 提交前运行 `pnpm notes:check`、`pnpm verify` 和 `pnpm architecture:check`。
