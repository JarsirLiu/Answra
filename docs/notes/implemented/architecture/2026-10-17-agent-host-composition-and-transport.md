# Note：Agent 组装点收归自身并抽象宿主传输

状态：已实施

## 问题

`@answra/agent` 是团队后续所有能力的落点（转写、工具、触发判断、`/go`、`/image`），但它的**组装与分发逻辑长在 Electron 胶水里**：`new ConversationRuntime(emit)` 和整个命令分发 `switch` 都写在 `apps/desktop/src/main/conversation/worker.ts`。

后果有三条：

1. 每加一类能力（工具、平台能力适配器），组装代码都会继续堆在这个只该绑定进程 API 的文件里，desktop 的 worker 变成事实上的 agent 装配车间。
2. 分发循环无法脱离 Electron 测试——全仓没有任何测试覆盖它（`apps/desktop/test` 里没有 worker/AgentService 相关用例）。
3. 换宿主（独立 sidecar、CLI、无窗口常驻进程）必须重写分发，而不是换一个 adapter。

同时发现一个与"能力"相关的死重量：`@answra/agent` 依赖里有 `ws`，但全仓零引用（`rg` 无命中），是为将来的 AVP 直连 WS adapter 预留的。

## 涉及范围

- 代码/模块：`apps/agent/src/worker/host.ts`（新增）、`apps/agent/src/index.ts`、`apps/agent/src/worker/protocol.ts`（不变）、`apps/desktop/src/main/conversation/worker.ts`（收缩为 adapter）、`apps/agent/package.json`、`pnpm-lock.yaml`、`apps/agent/test/worker/host.test.ts`（新增）。
- UI/进程/协议/持久化表面：线协议形状不变（仍是 `AgentCommand`/`AgentFrame`），IPC 频道不变，持久化不变；变化只是"谁持有分发循环"与依赖清单。
- 相关 Note：[Agent 运行时改名与领域分层](2026-10-17-agent-runtime-rename-and-layering.md)、[禁止自建本地监听](2026-10-17-local-listener-forbidden.md)、[拒绝：本地 app service 与 agent 边界](../../rejected/architecture/2026-10-11-local-app-service-and-agent-boundary.md)。

## 决定

- agent 导出 `startAgentHost({ transport, store })`：这是**唯一组装点**，负责创建会话运行时、把 change 转成上行帧、把下行命令分发到运行时方法。运行时与领域模块只暴露方法，不知道传输形态。
- host 认一个最小传输接口，宿主只做绑定：

  ```ts
  interface AgentTransport {
    send(frame: AgentFrame): void;
    onCommand(listener: (command: AgentCommand) => void): void;
    close?(): void; // 宿主收尾（Electron adapter 在此 process.exit(0)）
  }
  ```

- `apps/desktop/src/main/conversation/worker.ts` 收缩为 parentPort adapter：只判断"是否运行在 utility process 里"、把 `parentPort` 包成 `AgentTransport`、调用 `startAgentHost`。dispose 与进程退出不再由 agent 内部决定。
- 平台能力（采集、键鼠注入、窗口、密钥）继续留在 desktop，且**只能经帧交互**拿到：agent 是独立进程，无法被注入宿主对象；将来的能力调用是"agent 发帧 → main 执行 → 回命令"。`capabilities` 放在 `startAgentHost` 的组装参数里，一旦实现就走这条路径，不允许 `apps/agent` 直接 import desktop。
- 删除 `ws` 与 `@types/ws` 依赖（零引用）；AVP v1 直连 adapter 落地时再加回来。
- 升级条件（写死在协作约定里）：出现**第二个消费者**（CLI、sidecar、云端 worker、另一个 app，或 `packages/ui` 需要在进程内复用）时，`apps/agent` 升格为 `packages/agent`；在那之前搬进 `packages/` 只是换个住址，买不到任何东西。

## 模块边界

- `apps/agent/src/worker/host.ts`：组装点与命令分发，`AgentTransport` 接口的声明处；依赖 `conversation/*`，不依赖 Electron / React / 进程 API。
- `apps/agent/src/worker/protocol.ts`：只放 `AgentCommand` / `AgentFrame` 类型；命令或帧变化必须同时改 desktop 的 worker adapter 与 `AgentService`。
- `apps/agent/src/conversation`：领域模块，只暴露方法；不引入"当前宿主是什么"的判断。
- `apps/desktop/src/main/conversation/worker.ts`：Electron utility process adapter，只做绑定与进程退出，不含分发逻辑。
- `apps/desktop/src/main/conversation/agentService.ts`：main 侧的 worker 监管者与命令/帧转发，持有模型配置与密钥安全存储。

## 曾考虑的替代方案

- **把分发循环留在 desktop，agent 只导出方法：** 改动最小，但组装与分发继续依赖 Electron，测试与换宿主都要重做；本次正是要消除这个耦合点。
- **agent 内部直接 `process.exit`：** 少一层接口，但把"怎么收尾"写死成 Node 进程语义；若将来宿主是 sidecar 但共享进程（例如测试内的假宿主），会直接杀掉宿主。
- **传输接口设计成 EventEmitter / Node `MessagePort` 形状：** 会把 Node 具体类型带进公共面，测试只能造 Stream；最小接口更容易被 CLI、测试与将来的 sidecar 实现。
- **现在就加 `capabilities` 参数与工具注册表：** 没有第一个真实能力时，参数形状只能靠猜；等第一项能力落地时随之一并定形，避免二次返工。
- **保留 `ws` 依赖作为"预留"：** 零引用的依赖会被下一个人当死依赖清理或当成"已实现"信号；写进 Note 比挂在 `package.json` 更清楚。

## 后果与防回退

- `apps/desktop` 里不得再出现命令分发 `switch` 或 `new ConversationRuntime`；组装只能通过 `startAgentHost`。
- 新增能力时改 `host.ts` 的组装与协议类型，不要把平台实现拉进 `apps/agent`；`apps/agent` 仍不得依赖 Electron / React 与宿主进程 API 之外的东西。
- 依赖 AVP 直连时先加 `ws` 再提交 adapter，不允许留"预留但未用"的依赖。
- 换宿主必须只实现 `AgentTransport`，不得改动 `conversation/*` 与 `host.ts` 的领域逻辑。
- `apps/agent` 升格为 `packages/agent` 只在出现第二个消费者时进行，并需同步架构守护、AGENTS.md 与 README。

## 验证

- 新增 `apps/agent/test/worker/host.test.ts`（3 项）：命令与响应帧 id 对应、命令失败以 `ok:false` 帧返回而不抛出、shutdown 触发 `runtime.dispose` + `transport.close` 且不发响应帧。
- `apps/agent` 通过 3 文件 10 项测试（此前分发循环零覆盖）；`pnpm verify` 与 `pnpm build` 通过，`pnpm-lock.yaml` 中 `ws` 移除（`Packages: -2`）。
- 行为等价性：帧形状、`configure/send/snapshot/read-events/create-conversation/cancel` 语义与 shutdown 不发响应帧的行为与迁移前一致。
- 未做：真实 Electron 启动验证（`pnpm dev` 后确认截图问答链路与 `[agent-service] started`）。
