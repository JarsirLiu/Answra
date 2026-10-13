# Note：截图答题使用一次性会话

状态：已实施

## 问题

截图答题和 AI 对话面板共用 `active-exam-conversation`，导致截图每次发送都读取历史消息，回复条与多轮对话也显示同一份 transcript。

## 涉及范围

- 代码/模块：`packages/ui/src/app/useReplyWorkflow.ts`、`packages/ui/src/app/useConversationChat.ts`、`packages/ui/src/app/useReplyConversation.ts`、`packages/shared/src/channels.ts`、`apps/desktop/src/main/window.ts`、`apps/desktop/src/main/conversation/conversationIpc.ts`
- UI/进程/协议/持久化表面：截图发送、独立回复窗口只读会话、主对话会话、会话变更广播和 sender 授权。

## 决定

多轮对话继续使用固定 `active-exam-conversation`。每次截图点击发送时生成一个新的 `screenshot-<uuid>` 会话 ID，先创建会话，再将该 ID 传入模型请求、回复条状态和回复窗口读取路径。截图会话只服务当前一次发送，完成/取消/关闭后从 UI 状态解绑；内存 store 不提供历史恢复入口。

回复窗口 IPC 只允许读取当前回复条状态绑定的会话 ID，不按字符串前缀放开一组会话。主 renderer 仍可读取多轮会话和当前截图会话变更，但多轮 UI 的本地消息在工作流结束时清空。

## 模块边界

- `useReplyWorkflow` 拥有截图一次性会话 ID，并负责生命周期。
- `useConversationChat` 只负责发送和流式事件消费；默认 ID 仍用于多轮对话，可接收一次性 ID。
- `useReplyConversation` 只读取状态传入的会话 ID，不自行推断会话。
- main reply controller 持有当前回复条会话 ID，IPC sender 校验复用该事实。

## 曾考虑的替代方案

- **发送后清空同一个后端会话：** 会让多轮对话和截图互相删除数据，且需要新增破坏性 store API，边界不清晰，因此舍弃。
- **在回复窗口按 `screenshot-` 前缀放行所有会话：** 会扩大只读权限，旧窗口状态也可能读取到别的截图会话，因此改为精确匹配当前回复状态。
- **只在前端过滤历史消息：** 后端 revision 和 change 仍会串流，无法保证两个 renderer 的会话边界，因此不采用。

## 后果与防回退

截图会话 ID 必须随回复条状态跨 renderer 传递；回复窗口不得恢复固定 `active-exam-conversation` 或自行生成 ID。多轮对话 ID 不得用于截图发送。

## 验证

- UI 测试覆盖回复窗口按状态会话 ID读取，主对话仍使用固定 ID。
- 运行 UI、desktop 测试、类型检查、Biome、`pnpm notes:check` 和 `git diff --check`。
