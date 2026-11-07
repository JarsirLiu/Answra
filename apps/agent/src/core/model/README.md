# Model Core

本目录是 Agent 调用 AI SDK 和模型供应商的边界层。

- `providerFetch.ts` / `errorSummary.ts`：校验模型端点、处理云端令牌刷新与本地 API Key，并把 provider 错误压缩成有界摘要。
- `imageInput.ts`：校验并解码模型请求使用的图片 data URL。
- `requestContent.ts`：校验 Conversation 与 Answer 共用的文本和图片请求边界。
- `retryFetch.ts`：为可重放的模型 HTTP 请求提供限流、服务端错误和网络错误重试；通过回调报告每次等待，不保存会话或执行状态。
- `consumeStream.ts` / `streamEvents.ts`：消费 AI SDK `result.fullStream`，把生成、step warning、内容、工具输入/调用、工具结果、来源、文件和错误归一化为唯一 shared Agent event contract；过滤 provider metadata 与 raw chunk。

`core/agent/executeRun.ts` 调用这里的模型边界。这里不定义 profile、transcript、工具授权，也不根据 UI 图标推导业务状态。
