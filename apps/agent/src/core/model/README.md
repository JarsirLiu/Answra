# Model Core

本目录是 Agent 调用 AI SDK 和模型供应商的边界层。

- `retryFetch.ts`：为可重放的模型 HTTP 请求提供限流、服务端错误和网络错误重试；通过回调报告每次等待，不保存会话或执行状态。
- `streamEvents.ts`：把 AI SDK 的 `UIMessageChunk` 归一化为仓库的 `AgentStreamEvent`；过滤供应商元数据和不属于产品流的 framing。

Conversation 生成领域通过这里调用模型。这里不定义 profile、transcript、工具授权，也不根据 UI 图标推导业务状态。
