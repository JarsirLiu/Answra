# Note：模型调用失败必须终结并显示

状态：已实施

## 问题

OpenAI-compatible 请求失败时，runtime 虽然发出 AI SDK `error` 和 `finish` chunk，但回复条只显示文本 delta。用户因此看到空条；此外发送函数只等待请求提交，回复工作流会过早清空待发送图片。

## 涉及范围

- 代码/模块：`apps/app/src/conversationRuntime.ts`、`packages/ui/src/app/useConversationChat.ts`、`packages/ui/src/app/useReplyWorkflow.ts`、`packages/ui/src/components/panels/ReplyBar.tsx`
- UI/进程/协议/持久化表面：模型 utility process 诊断日志、标准 UI message chunk、截图回复条终态呈现；不记录密钥、提示词、图片或模型正文。
- 相关 Note：[笔试截图一次性图片对话 V1](../feature/2026-10-11-ephemeral-exam-image-chat-v1.md)

## 根因

UI 对话把 AI SDK 错误 chunk 排除在展示内容外，截图回复条又只依赖文本内容，错误会显得像空回复。`useReplyWorkflow` 把提交 Promise 完成当作整轮结束，因此模型仍运行时就清除了附件。

## 修复

- runtime 对每个 run 记录开始、首个 chunk、chunk 类型计数、终态和耗时；失败记录截断后的错误说明、错误名和可用状态码。日志不带凭据、消息内容和图片；关闭 SDK 默认完整错误对象日志。
- UI 提取标准 `error` chunk 的 `errorText`，将其作为回复条可见状态；收到 `finish` / `abort` 后清理活动状态。
- 截图工作流等待实际终态后再清理附件；失败保留截图，错误文本在回复条中呈现并回到可重试状态。
- 成功但没有文本的终态展示明确提示，而非永久空白。

## 决定

保留 AI SDK `error` chunk 的标准语义，由 UI 单独呈现错误文本。截图发送 Promise 等待真实终态；失败切回编辑态并保留附件，成功完成后才清理附件。运行日志只保留诊断摘要。

## 曾考虑的替代方案

- **把错误伪装成 `text-delta`：** 会污染模型消息正文和后续 Markdown 内容，违反标准 chunk 语义，因此错误独立呈现。
- **仅增加日志：** 能排查但不能消除用户侧空等，因此同时修复回复状态生命周期。

## 后果与防回退

- `sendMessage` 的 Promise 仅代表提交，不得作为流完成信号；完成状态必须来自 AI SDK 终态 chunk。
- 诊断日志不得包含 prompt、图片 data URL、API Key 或模型生成正文。
- 没有正文的成功结束也必须有可见终态提示。

## 验收标准

- 模型错误时回复条显示原因、停止等待并保留待发截图。
- 成功响应仍显示文本，取消仍停止并返回编辑态。
- 自动化测试覆盖错误终态、流式成功与超时释放。

## 验证

- 已通过：app/UI typecheck，app runtime 测试（4 项），UI 测试（54 项）。

## 风险

- 错误消息由服务端提供，界面按纯文本显示，不解析为 Markdown。
- 真实模型 endpoint 的视觉能力和错误格式仍需目标服务实机验证。
