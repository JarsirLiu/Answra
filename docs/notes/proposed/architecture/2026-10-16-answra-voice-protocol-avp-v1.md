# Note：Answra 实时语音识别私有协议（AVP）v1

状态：提案

## 问题

面试语音管线（[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)）首轮复用当前可达的自部署 Qwen HTTP 批式服务；它不支持 OpenAI 兼容语音调用，当前运行实例也没有 WS 路由。本 Note 记录未来 AnswraSite 网关需要的网络协议草案，不是当前验证的前置工作。当前只需在 Agent 内部建立 provider-neutral 转录契约，并通过 Qwen `/transcribe` 验证；待确定网关接入时，再结合真实上游实现评审网络协议。OpenAI-compatible 不是 ASR provider 的必要条件。

## 涉及范围

- 代码/模块：AVP 是 Agent runtime↔upstream（未来 gateway）契约，不出现在 renderer/IPC 面；提案实现位置为 `apps/agent` 的转录模块与将来 AnswraSite 网关。跨进程契约仍由 `packages/shared/src/channels.ts` 承载，不导出 AVP 上游事件。
- 进程/隐私表面：音频按 typed IPC 抵达 Agent runtime；当前 Qwen HTTP adapter 从 Agent 出站连接内网 ASR endpoint，转录语义在进程内映射，不建立 Electron 本地 listener；未来网关 WSS 才使用 AVP wire framing。当前内网 Qwen endpoint 无鉴权且为 HTTP，仅供受控开发验证。
- 相关 Note：[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)。

## 提案

### 当前范围

本轮不实现 AVP WebSocket wire protocol、会话 token 或网关服务端。先实现 Agent 内部转录接口、当前 Qwen HTTP adapter 和 VAD 分段；该内部接口不是网络协议，不定义握手、帧编码或恢复机制。本 Note 后续网络事件字段仅作为讨论草案，不能据此要求当前功能先完成 AVP。等网关接入已排期且至少一个目标上游协议确定后，再评审是否按本草案落地并补齐跨 adapter 验证。

### 原则

1. 协议只定义「客户端会话 ↔ AnswraSite（未来）」之间的连接、凭证与语义，上游模型名、事件语法永不出现在协议里。
2. 事件语义借用 OpenAI Realtime 风格（业界最熟悉、样本最多），但删除所有厂商专属字段；扩展走自定义前缀 `answra.*`。这是 Answra 自有协议，不宣称与 OpenAI Realtime wire-compatible。
3. 批式上游在 adapter 内合成统一的识别终态；事件必须标明识别 chunk 是否结束了说话轮次，不能让上层把任意批式 chunk 当成完整问题。
4. v1 以 JSON 文本帧 + base64 内嵌音频为准，不引入二进制帧；帧格式与性能优化留给 v2。

### 传输与认证

- 传输全使用 WSS。产品化对端为 AnswraSite `wss://<gateway>/v1/voice`；v1 直连期对端为 runtime 内 adapter（进程内直调，不经网络），协议语义不变。
- 认证：未来网关握手头使用 `Authorization: Bearer <会话凭证>`，由网关签发短期 session token。当前直连内网 Qwen HTTP 的 adapter 不需要伪造 AVP 握手或发 API key；endpoint 通过开发配置注入，禁止打包硬编码。
- 版本：握手头 `X-Answra-Voice-Protocol: 1`；服务端在 `session.created` 回报 `protocolVersion`；客户端过低版本收到 `error{code:"PROTOCOL_TOO_OLD"}` 强制升级。

### 事件契约

客户端 → 服务端：

- `session.update`：`{format:"pcm_16k_mono", language?, corpus?, vad?:{type:"server_vad"|"client_vad", threshold, silenceMs, tailMs}, metering?:boolean}`；单连接一次，重复发送视为更新并入后续确认。当前批式 Qwen adapter 用 client VAD 聚段。
- `input_audio.append`：`{audio:<base64 PCM>, seq, tMs}`；`seq` 单调递增，服务端静默丢弃重复。
- `input_audio.commit`：`{}`；仅在 `turn_detection.type:"manual"` 模式下发。
- `session.stop`：`{reason:"user"|"shutdown"}`；客户端主动收尾。

服务端 → 客户端：

- `session.created`：`{sessionId, protocolVersion, metering}`；不回显上游模型名。
- `transcript.delta`：`{segmentId, source, text}`；流式部分结果，批式上游无此事件，上层不依赖。
- `transcript.segment`：`{segmentId, utteranceId, chunkIndex, source, text, startMs, endMs, isFinal:true, utteranceEnded:boolean}`；上层必消费的识别终态。`isFinal` 只表示该识别 chunk 的文本不会再被修订，`utteranceEnded` 才表示说话轮次完整结束并可触发回答；实时 provider 可按句/服务端端点映射，批式 VAD 自然闭合时为 true，最大时长强切的 continuation chunk 为 false。批式 provider 不伪造 `transcript.delta`。
- `vad.speech_started` / `vad.speech_ended`：`{tMs}`；client/server VAD 的归一化事件，来源不泄露 provider 名。
- `usage.update`：`{audioSeconds, connectionMs}`；只用于展示与调试对齐，不作为计费依据。
- `error`：`{code, message, retryable}`；code 枚举固定 `AUTH_EXPIRED / RATE_LIMITED / UPSTREAM_UNAVAILABLE / AUDIO_FORMAT_UNSUPPORTED / PROTOCOL_TOO_OLD`。
- `ping` / `pong`：保活与抖动观测。

约束：`segmentId` 在 session 内单调唯一，`chunkIndex` 在 utterance 内单调递增；断线重连后新会话重新分配，客户端清除旧流。旧 session 或旧 generation 的迟到结果不能触发回答。重连策略为指数退避 `1.5s × 2^min(attempts,6)` + jitter，v1 不做断线续传（resume）。

### Adapter 分工演进

- **首轮验证 adapter**：`QwenSelfHostedHttpProvider` 在 Agent 内维护 PCM ring buffer；VAD 自然闭合或最大长度强切时，将该段封装为 16 kHz mono PCM WAV，以 multipart `file` + `language` 请求现有 `/transcribe`。HTTP 返回后映射为 `transcript.segment`；只在 provider 真正提供修订事件时才发 `transcript.delta`，当前 Qwen HTTP 不生成 delta。`utteranceEnded` 根据本地 VAD 边界判定，不能根据 HTTP 响应到达或 chunk final 推断。错误映射 HTTP timeout/503 到统一可见错误并限制队列。adapter 不额外开本地代理服务。
- **后续 realtime adapter**：DashScope Recognition WS 或 `qwen3-asr-flash-realtime` 各自实现 provider adapter；只有采用实时上游时才把持续帧翻译为对应 WS 帧并映射原生 partial/VAD/终态。不同原生 WS 路径不是仅改 base URL。
- **产品化**：AnswraSite 网关按本协议实现服务端，负责向上游模型路由（DashScope Recognition/Realtime、Grok、未来腾讯云）与短期凭证、用量计量计费；客户端 adapter 从直连翻译器切换为纯转发器，**主程序与上层零改动**。
- 上游切换判据全部落在 provider/gateway 一处，renderer、转录聚合层和 UI 均无上游知识；批式 provider 只能提供 chunk-final，不能假装 realtime partial。

## 模块边界

- `packages/shared`：不承载 AVP 事件类型，避免把供应商级语言泄进 renderer 协议；涉及 IPC 的仍是 `InterviewChannels` 面向会话事件的组。
- `apps/agent`：当前 provider-neutral 转录会话与 Qwen HTTP adapter；未来增加 AVP wire client 连接 AnswraSite 网关。转录聚合层只消费统一事件语义。
- `apps/desktop` main：凭证与音频帧桥接，不解析 AVP 事件。
- AnswraSite 网关（未来）：AVP 服务端实现、上游路由与计量计费、短期 token 签发；当前 Qwen 自部署验证不依赖网关。
- Natively 参考件（重连退避、会话短期凭证、句尾静音、turn 合并）落位在本协议鲁棒性与 adapter 质量要求里，不构成协议字段。

## 曾考虑的替代方案

- **客户端直说 DashScope 原生 WS 语法（不经协议）**：接入最快、代码最少；但网关/上游切换需要重写客户端语法、状态机与测试，且网关因无稳定语义无法并行开发；舍弃。
- **直接采用 OpenAI Realtime 完整语法作为协议**：词汇最大兼容外部生态，但携带大量面试场景不需要的字段（output audio、tools、instructions），网关实现负担和混淆面更大；决定借词汇但不照搬全集，AVP 省略的即其所不承载的语义。
- **二进制音频帧 + 头字段**：带宽更省，但早期优先可调试性；留作 v2 性能升级，不在 v1 展开。
- **在 `packages/shared` 定义 AVP 类型**：让 AVP 可被任意层引用，但会进一步背离"shared 只承载跨层固定协议"的现状，且 renderer 一旦可见 AVP 就会有直接连上云的诱惑；AVP 类型固化在 runtime/gateway 两侧。
- **Qwen-Omni/腾讯云候选后再定协议**：协议晚于第二个上游出现，事件词汇会被第一个上游定型得更深；先冻结 AVP，让后续上游适配收敛为纯 adapter 工作。

## 风险

正面权衡：切换上游/网关零客户端改动；网关与客户端可并行开发；协议与第一个上游形态对齐，词汇借用业界最熟悉的 OpenAI Realtime 风格。

风险与约束：AVP 尚无第二个上游验证，DashScope 语义丢失或翻译失真可能需要提前修订 v1（修订即 bump protocolVersion 并回填本 Note）；`source` 粒度只有两路，多方会议/多声道汇入需 v2 扩展；短期 token 签发属网关职责，网关上线前网关路径不得运行；`usage.update` 明确不作为计费依据，防止双方在计费口径上耦合；批式上游的 `transcript.segment` 合成时间戳精度受批式往返限制；VAD 参数语义以 server_vad 官方样例为准，不同上游的阈值口径可能偏差。

## 验收标准

- 转录 provider 事件类型仅由 `apps/agent` 内部导出，`packages/shared` 只保留面向 UI 的面试 IPC 类型。
- 时序测试：mock Qwen HTTP 响应映射到 `transcript.segment`，保证序号、chunk 边界与 utterance 结束语义正确；HTTP timeout/503 和停止后迟到响应不能污染新 session。
- Qwen HTTP adapter 与未来 WS/AVP adapter 使用同一转录聚合测试集，验证上层与传输形态解耦。
- 当前实机验证先记录内网 Qwen HTTP 分段识别延迟；未来 AVP WSS 网关上线后再验证握手、鉴权、断线与丢帧表现。

## 验证证据

- Natively `NativelyProSTT`（`D:\learn\xx\natively-cluely-ai-assistant\electron\audio\NativelyProSTT.ts`）：私有 WS 单协议 + 多级 fallback 链 + 短期 session token 的客户端零协议转换先例。
- 内网 Qwen 服务（`10.76.13.161:10017`，2026-10-19 核对）：健康检查为 Qwen3-ASR-0.6B/CUDA ready，HTTP `/transcribe` 可用，当前运行实例 `/ws/asr` 404。此证据支持首轮 HTTP adapter 方案，不证明实时 WS 已部署或延迟达标。
- DashScope realtime 官方协议作为后续备选证据：Recognition WS 与 `qwen3-asr-flash-realtime` 使用不同原生协议；实施时依供应商当前文档重新核对。
- 提案阶段无 Answra 实现；provider adapter 与未来 AVP wire server 等价产出仍是设计目标，验收见验收标准。

