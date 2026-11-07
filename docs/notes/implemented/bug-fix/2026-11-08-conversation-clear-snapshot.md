# Note：对话与面试清空后的 snapshot 同步

状态：已实施

## 问题

对话和面试面板的清空按钮会调用 Agent 的清理接口，但清理接口返回 `void`，也没有把清理后的 transcript snapshot 送回 UI。Agent 内存中的消息可能已经清空，renderer 仍保留旧 projection，因此用户看到按钮无效。

## 涉及范围

- 代码/模块：Agent transcript application、worker 命令响应、Desktop bridge、Chat/Interview UI projection
- UI/进程/协议/持久化表面：常驻对话和面试会话清空、snapshot-changed IPC、进程内 transcript store

## 根因

清空操作只完成了 Agent store 写入，没有返回新的 `ConversationSnapshot`。UI 的清空回调也没有拿到权威结果，只能继续显示旧的本地 projection。

## 决定

清空操作返回并广播清空后的 `ConversationSnapshot`。Agent application 负责读取权威 snapshot，worker 将它作为响应值并推送 snapshot change，Desktop bridge 透传，UI 以该 snapshot 协调自己的 projection。运行中的会话仍由 transcript store 拒绝清空。

## 修复

- `ConversationApplication.clearConversation()` 返回清空后的 snapshot。
- Agent worker 对 `clear-conversation` 同时返回并广播该 snapshot。
- `DesktopBridge.clearConversationMessages()` 和 shared channel map 改为返回 `ConversationSnapshot`。
- Chat 清空成功后用返回的 snapshot 重建唯一 conversation projection；Interview 由外层面试 projection 应用同一 snapshot。
- 清空失败继续由现有通知展示，按钮调用方消费错误，避免未处理 Promise。

## 曾考虑的替代方案

- **只在 renderer 本地调用 `clear()`：** 会让界面看似清空，却不能确认 Agent transcript 已清理成功，也无法同步其他订阅方，因此舍弃。
- **清空后由 renderer 再查询 snapshot：** 会增加一次时序窗口，且清空结果不是同一个请求的返回值，因此舍弃。
- **新增 Agent 事件表示清空：** 清空是 transcript 写入后的查询结果，不是模型执行事实；加入执行事件会污染既有 envelope 语义，因此舍弃。

## 后果与防回退

- 清空成功后消息和活动状态会立即归零，Agent transcript 与 UI projection 使用同一份 snapshot 结果。
- 运行中的会话仍不能清空；不能为了让按钮“看起来生效”而绕过 store 的活动 run 保护。
- 当前实现仍是进程内内存 store，未改变持久化边界。

## 验收标准

- 对话清空成功后，消息列表立即为空。
- 面试清空成功后，消息列表立即为空。
- 清空失败显示错误且不误删当前消息。

## 验证

- `pnpm notes:check`。
- `pnpm verify`。
- UI bridge fixture 返回清空后的 snapshot，覆盖清空返回值契约。
