# Note：拒绝以 Pi Runtime 实现截图多轮对话

状态：已拒绝：持久多轮 Pi session 与用户要求的独立、用后即清除请求冲突。

## 问题

首版截图对话需要尽快连接真实模型。曾提议通过 Pi SDK 提供持久会话、多轮消息和压缩，但与用户后来明确的“一次图片发送对应一次独立临时请求，不持久化”要求不同，也会影响安装体积和隐身 Electron 基线。

## 涉及范围

- 代码/模块：曾涉及 `apps/app`、`apps/desktop/src/main`、`packages/shared`、`packages/ui`
- UI/进程/协议/持久化表面：模型请求、图片输入、临时/持久会话、流式回复及取消。
- 相关 Note：[笔试截图一次性图片对话 V1](../../implemented/feature/2026-10-11-ephemeral-exam-image-chat-v1.md)、[Electron 捕获保护版本兼容](../../implemented/bug-fix/2026-10-11-electron-capture-protection-compatibility.md)

## 提案

曾计划由 Pi 管理会话和 Agent 消息，截图与文字进入可恢复的多轮 session。该提案未实施，以下记录用于防止后续误把原型或提案当成当前产品契约。

## 影响表面

- 若采用，会让截图会话跨轮累积并产生可恢复数据，与 V1 的独立请求语义相反。
- 要求 Pi 适配其 Node engine、session 持久化和内部事件协议。
- 曾考虑把 Pi 的 Agent 消息协议映射到 shared IPC，但这会让桌面产品契约依赖另一套运行时模型。

## 否决理由

用户明确拒绝 `pi-coding-agent`，原因是其需要 Node 运行时、显著增加安装包体积，并可能迫使升级已验证隐身能力的 Electron 版本。首版图片对话不需要可恢复多轮 session 或 Pi 的工具循环；以 AI SDK 6 `streamText`、`useChat` 和独立 IPC run 满足当前目标，变更范围更小。该判断不表示 Pi 技术上无法实现，而是它与当前产品约束及快速上线目标不匹配。

## 曾考虑的替代方案

- **Pi Coding Agent / Pi Agent Core：** 提供较完整的 Agent/session 能力，但引入额外 Node 或 Electron 升级风险，且持久化会话与需求冲突，拒绝。
- **AI SDK 6：** 提供 OpenAI-compatible 流式模型调用与 React `useChat`，可使用 Electron 29 内嵌 Node，无额外 runtime，采用。

## 后果与防回退

- 当前不能引入 Pi 包或额外 Node 可执行文件；若未来重新评估，必须先给出安装体积实测、Node engine 兼容证据和 Electron 29.4.6 隐身回归实测，并另建提案。
- 当前 V1 不创建 Pi session、JSONL transcript 或可恢复会话；未来改变保留策略必须先明确用户可见的清理和删除行为。
- 该否决仅适用于当前桌面临时图片对话路径，不约束未来独立产品若出现不同需求时做技术评估。

## 验证

- 代码中不依赖 Pi 包；模型执行使用 AI SDK `streamText`，renderer 使用 AI SDK React `useChat`。
- Electron 锁定 `29.4.6`；真实图片模型和目标 Windows 捕获仍需用户环境实测。
