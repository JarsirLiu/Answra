# Note：拒绝将 Pi 作为桌面 Agent Runtime

状态：已拒绝：Pi 与额外 Node runtime 的体积和 Electron 兼容性成本超过当前一次性图片问答所需。

## 问题

桌面 Agent 方案曾提出由 Pi SDK 统一提供会话、Agent 循环、工具和压缩能力，并在其上增加 MCP connector。此方案没有满足用户对安装体积、Electron 隐身兼容性和一次性截图请求的约束。

## 涉及范围

- 代码/模块：曾涉及 `apps/app` Agent runtime、模型配置、工具/MCP connector、desktop worker 生命周期。
- UI/进程/协议/持久化表面：Agent 事件、会话持久化、图片输入、工具授权及 Electron/Node 打包。
- 相关 Note：[拒绝以 Pi Runtime 实现截图多轮对话](../feature/2026-10-11-screenshot-conversation-with-pi-runtime.md)、[笔试截图一次性图片对话 V1](../../implemented/feature/2026-10-11-ephemeral-exam-image-chat-v1.md)

## 模块边界

已拒绝的拓扑是“独立 Node sidecar + Pi session/runtime + Pi 私有事件”。当前实现为 shared 数据契约、UI 自定义 transport、desktop main IPC/supervisor、Electron 29 utility process worker，以及 `apps/app` 中不依赖 Electron 的 AI SDK 模型调用。MCP、记忆、多轮持久化和通用工具注册尚未交付。

## 提案

曾建议以 Pi 作为唯一 Agent Runtime，并在其上增加会话、提示词、工具、MCP 和持久化管理。该方案未实施。

## 否决理由

Pi 高层 SDK 需要满足更高 Node engine；打包独立 Node 曾增加约 85 MB，升级 Electron 又曾导致悬浮导航的捕获保护回归。为仅有的单次图片问答引入这些运行时成本不合理。SDK 丰富的多轮、工具、压缩功能也不符合用户当前明确的临时无历史要求。

## 曾考虑的替代方案

- **Pi + 单独 Node sidecar：** 可隔离依赖，但显著增加应用体积和双运行时维护，拒绝。
- **Pi 装入 Electron utility process：** 可复用内嵌 Node，但 Pi engine 与 Electron 29 Node 版本不满足，不能假定可运行。
- **AI SDK 6 `streamText` + `useChat`：** 满足 OpenAI-compatible 文本/图片流式调用，使用 Electron 29 内嵌 Node，无需独立 Agent 进程，采用。

## 后果与防回退

- 不得将 Pi、其 session 格式或它的事件 schema 加入 shared 契约。
- 只有在新增需求确实需要 Agent loop、工具或压缩，且依赖可在 Electron 29.4.6 内运行、安装体积可接受、隐身捕获通过 Windows 实测时，才重新提案。
- 首版 UI 历史只是内存展示；每次 transport 必须只发送最后一条用户消息。

## 验证

- `apps/app` 当前依赖 AI SDK 6 和 OpenAI-compatible provider；无 Pi 依赖。
- Electron 版本保持 `29.4.6`；此 Note 不代替真实模型和系统捕获实测。
