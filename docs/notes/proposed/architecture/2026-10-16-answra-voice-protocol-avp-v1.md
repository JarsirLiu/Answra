# Note：Answra 实时语音识别私有协议（AVP）v1

状态：提案

## 问题

面试语音管线（[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)）确认实时流式为主路径，但主路径上游目前只有 DashScope 一个形态：客户端若直接说 DashScope 原生 WS 语法，产品化时把流量切到 AnswraSite 网关、或未来换 Grok/腾讯云等上游，客户端语法、状态机和测试都要重写；网关侧也因没有稳定的中转语义而无法先行开发。因此需要先冻结一个面向「客户端 ↔ AnswraSite（未来）」的私有语音识别协议，让上层与网关双向解耦上游。参照物是 Natively 的形态：客户端只说一种私有协议（`wss://api.natively.software/v1/transcribe`），供应商转换与模型路由全部在服务端；Answra 的差别仅是协议事件语法借用 OpenAI Realtime 风格而不是另起一套词汇，且直连期内"协议服务端"由 runtime 内 adapter 扮演。

## 涉及范围

- 代码/模块：`packages/shared/src/interview.ts` 不承载 AVP 事件——AVP 是 runtime↔upstream（未来 gateway）契约，不出现在 renderer/IPC 面；实现位置为 `apps/app/src/interview/transcription/`（v1）与将来 AnswraSite 网关。
- 进程/隐私表面：音频仍按总提案经 typed IPC 抵达 runtime，runtime 出站直连 DashScope WS 时即以本协议语言组织会话；key 只经 main safeStorage，不进 renderer。
- 相关 Note：[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)。

## 提案

### 原则

1. 协议只定义「客户端会话 ↔ AnswraSite（未来）」之间的连接、凭证与语义，上游模型名、事件语法永不出现在协议里。
2. 事件词汇借用 OpenAI Realtime 风格（业界最熟悉、样本最多），但删除所有厂商专属字段；扩展走自定义前缀 `answra.*`。
3. 批式上游在 adapter 内合成与实时流同样的终态事件，上层零感知。
4. v1 以 JSON 文本帧 + base64 内嵌音频为准，不引入二进制帧；帧格式与性能优化留给 v2。

### 传输与认证

- 传输全使用 WSS。产品化对端为 AnswraSite `wss://<gateway>/v1/voice`；v1 直连期对端为 runtime 内 adapter（进程内直调，不经网络），协议语义不变。
- 认证：握手头 `Authorization: Bearer <会话凭证>`。v1 直连期为本地内存标记（无泄密面，adapter 直接持有 DASHSCOPE key）；产品化时为网关签发的**短期 session token**（参考 Natively 先经 HTTP `/v1/stt/session` 换取短期凭证的形态，避免 key 下发与长期凭证驻留）。
- 版本：握手头 `X-Answra-Voice-Protocol: 1`；服务端在 `session.created` 回报 `protocolVersion`；客户端过低版本收到 `error{code:"PROTOCOL_TOO_OLD"}` 强制升级。

### 事件契约

客户端 → 服务端：

- `session.update`：`{format:"pcm_16k_mono", language?, corpus?, vad?:{type:"server_vad", threshold, silenceMs, tailMs}, metering?:boolean}`；单连接一次，重复发送视为更新并入后续确认。
- `input_audio.append`：`{audio:<base64 PCM>, seq, tMs}`；`seq` 单调递增，服务端静默丢弃重复。
- `input_audio.commit`：`{}`；仅在 `turn_detection.type:"manual"` 模式下发。
- `session.stop`：`{reason:"user"|"shutdown"}`；客户端主动收尾。

服务端 → 客户端：

- `session.created`：`{sessionId, protocolVersion, metering}`；不回显上游模型名。
- `transcript.delta`：`{segmentId, source, text}`；流式部分结果，批式上游无此事件，上层不依赖。
- `transcript.segment`：`{segmentId, source, text, startMs, endMs, isFinal:true}`；**上层唯一必消费的终态**，批式也合成它。
- `vad.speech_started` / `vad.speech_ended`：`{tMs}`；服务端 VAD 镜像，客户端仅用于 UI 或打点。
- `usage.update`：`{audioSeconds, connectionMs}`；只用于展示与调试对齐，不作为计费依据。
- `error`：`{code, message, retryable}`；code 枚举固定 `AUTH_EXPIRED / RATE_LIMITED / UPSTREAM_UNAVAILABLE / AUDIO_FORMAT_UNSUPPORTED / PROTOCOL_TOO_OLD`。
- `ping` / `pong`：保活与抖动观测。

约束：`segmentId` 服务端生命周期内单调唯一；断线重连后新会话重新分配，客户端清除旧流。重连策略为指数退避 `1.5s × 2^min(attempts,6)` + jitter，v1 不做断线续传（resume）。

### Adapter 分工演进

- **v1 直连**：`DashScopeRealtimeProvider` 在 runtime 内把 AVP 事件翻译为 DashScope 原生事件（`session.update`/`input_audio_buffer.append` 与上游对应字段一一映射），`transcript.delta`/`segment` 从上游事件映射回收；批式 `qwen3-asr-flash` 在 adapter 内把缓存段与分段批识别合成为同样的 `transcript.segment`。
- **产品化**：AnswraSite 网关按本协议实现服务端，负责向上游模型路由（DashScope/Grok/未来腾讯云）与短期凭证、用量计量计费；客户端 adapter 从直连翻译器切换为纯转发器，**主程序与上层零改动**。
- 上游切换判据全部落在 provider/gateway 一处，renderer、runtime 会话层、UI 均无上游知识。

## 模块边界

- `packages/shared`：不承载 AVP 事件类型，避免把供应商级语言泄进 renderer 协议；涉及 IPC 的仍是 `InterviewChannels` 面向会话事件的组。
- `apps/app`：AVP 客户端会话与 adapter（v1 直连 provider）；会话层只认 AVP 语法。
- `apps/desktop` main：凭证与音频帧桥接，不解析 AVP 事件。
- AnswraSite 网关（未来）：AVP 服务端实现、上游路由与计量计费、短期 token 签发；与 Answra 仓库通过本 Note 解耦。
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

- AVP 事件类型以唯一模块导出，并有类型隔离测试保证 renderer 与 `packages/shared` 不得引用 AVP。
- 时序测试：mock DashScope 事件 → AVP `transcript.segment` 时序正确、`segmentId` 单调、断线后新流拒绝旧 `segmentId`。
- 批式 adapter 在同一测试集下产出语义等价的 `transcript.segment`，证明上层与传输形态解耦。
- v1 直连与网关仿真（把 provider 换成 AVP echo 服务）跑同一套会话测试，同一份上层代码透测。
- 实机上 WSS 端到端验证按总提案执行并记录断线恢复时长/丢帧表现；未实测不迁入 `implemented/`。

## 验证证据

- Natively `NativelyProSTT`（`D:\learn\xx\natively-cluely-ai-assistant\electron\audio\NativelyProSTT.ts`）：私有 WS 单协议 + 多级 fallback 链 + 短期 session token 的客户端零协议转换先例。
- DashScope realtime 官方样例（user 提供并核查），事件词汇与 OpenAI Realtime 命名对齐。
- 提案阶段无实现；双 adapter 等价产出是设计目标，验收见验收标准。

