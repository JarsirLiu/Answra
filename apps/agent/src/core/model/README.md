# Model Core

本目录是 Agent 调用 AI SDK 和模型供应商的边界层。

- `retryFetch.ts`：为可重放的模型 HTTP 请求提供限流、服务端错误和网络错误重试；通过回调报告每次等待，不保存会话或执行状态。
- `consumeStream.ts` / `streamEvents.ts`：消费 AI SDK `result.fullStream`，把生成、step warning、内容、工具输入/调用、工具结果、来源、文件和错误归一化为唯一 shared Agent event contract。`executeTurn.ts` 也把 AI SDK 工具执行开始/完成回调写入相同事件流；过滤 provider metadata 与 raw chunk。

Conversation 生成领域通过这里调用模型。这里不定义 profile、transcript、工具授权，也不根据 UI 图标推导业务状态。
