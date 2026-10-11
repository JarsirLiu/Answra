# Note：拒绝 V1 使用独立 Node 服务与 stdio 协议

状态：已拒绝：首版只需单客户端一次性请求；独立 Node、stdio 和持久 Agent 会增加安装体积及维护面。

## 问题

此前的本地服务提案计划让 `apps/app` 作为独立 Node 服务，由 Electron main 通过 stdio NDJSON 监管，并在服务中运行 Pi。该拓扑能服务多个客户端和较完整的持久 Agent，但首版截图问答尚无这些需求。

## 涉及范围

- 代码/模块：`apps/app`、`apps/desktop/src/main/conversation`、`packages/shared`。
- UI/进程/协议/持久化表面：Agent 子进程、main 到 worker 通信、会话文件及发布包运行时体积。
- 相关 Note：[功能边界与本地运行时分层](../../implemented/architecture/2026-10-11-feature-boundaries-and-local-runtime.md)、[笔试截图一次性图片对话 V1](../../implemented/feature/2026-10-11-ephemeral-exam-image-chat-v1.md)

## 模块边界

当前拓扑是 `packages/shared <- apps/app runtime <- apps/desktop main utility worker`，UI 通过 preload/DesktopBridge 向 main 发命令并收流事件。Agent 核心与 Electron 分离；仅 desktop worker adapter 调用 Electron utility process API。main 负责窗口、配置安全存储、请求校验和转发。V1 没有监听端口、stdio 协议、Pi session、会话索引或长期记忆。

## 提案

曾建议使用独立 Node 服务、stdio NDJSON 和 Pi session 管理本地 Agent。本方案未实施；该节仅记录曾评估的拓扑。

## 否决理由

用户要求快速验证图片对话，并明确拒绝随包增加 Node runtime 和 Pi。Electron 29 已提供满足 AI SDK 运行需要的 Node，utility process 可以将模型调用与 renderer/main 窗口管理隔开，不必再维护第二套 Node 可执行文件或一套 NDJSON 编解码协议。当前只有 Electron 客户端，localhost 服务也没有实际第二个消费者。

## 曾考虑的替代方案

- **Node sidecar + stdio NDJSON：** 可独立部署和跨客户端复用，但随包增加约 85 MB Node，当前没有多个客户端需求，拒绝。
- **localhost HTTP 服务：** 便于 Web 客户端访问，却引入端口冲突、认证和来源控制；当前 renderer 已有安全 IPC 边界，拒绝。
- **Electron utility process + DesktopBridge：** 复用 Electron Node，进程隔离模型请求，并沿用现有 IPC 安全边界，采用。

## 后果与防回退

- 不加入独立 `node.exe`、`ANSWRA_NODE_PATH` 或 localhost listener 来运行 V1 Agent。
- utility worker 不是面向外部客户端的服务 API；若未来加入 Web 客户端或长驻后端，先为该需求设计带鉴权的 transport，再复用 app 层模型/会话逻辑。
- 持久会话、提示词版本、用户记忆、工具/MCP、压缩、重试和语音都未由本 Note 承诺；每项上线前单独定义数据和权限契约。

## 验证

- 开发与发布 worker 均由 Electron utility process 运行；worker bundle 位于 desktop `out` 中，无独立 Node resource。
- Electron 固定为 `29.4.6`；实际 Windows 隐身回归须在 runtime 依赖或 Electron 更新时重测。
