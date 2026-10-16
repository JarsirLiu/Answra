# Note：面试语音识别管线与客户端 VAD 选型

状态：提案

## 问题

[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)已定为"云端流式 STT"，但未选定供应商、协议形态和 VAD 责任边界。落地前出现三类困惑：一是语音模型计价单位混乱（ASR 按音频秒、TTS 按字符、Omni 按 token），不知道面试场景该用什么；二是实时 ASR 与批式 ASR 的取舍（谁负责断句）；三是原候选"腾讯云实时语音识别"未完成协议与成本评估。背景约束：AnswraSite 网关（sub2api）语音专用端点均未接入可用上游（`/v1/realtime` 仅 Grok 分组、`/v1/live` 受 macOS attestation 限制且 Windows 返回 503、`/v1/stt` 是 xAI 直通且仅限 Grok 平台），实时 STT 无法零改动经网关复用；通用 `/v1/chat/completions` raw 转发虽能承载 DashScope 的 OpenAI 兼容批式 ASR（曾按"批式先行"改写本 Note），但批式的延迟结构是"句尾静音 + 整段识别往返"，实测口径 2–4 秒，对实时面试/会议的核心体验不达标；用户裁决延迟优先于工程便利。因此主路径定为 realtime 流式，传输采用**直连**以与网关部署解耦；网关 realtime 透传仍是后续产品化切换路径，批式仅保留为网络受限降级。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`（既有 `InterviewChannels`/`InterviewState`/`InterviewChange`/`InterviewAudioFrame` 类型）、`apps/app` 转录 provider adapter、`apps/desktop/src/main/conversation/appService.ts`（STT 凭证存储，与 Chat LLM 凭证分离）、渲染进程采集与门控。
- 进程/隐私表面：音频帧仍按总提案经 typed IPC 上行；STT realtime WebSocket 与批式 HTTP 出站直连 DashScope（BYOK 出站到此为止）；转录文本不落盘。
- 相关 Note：[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)、[Answra 实时语音识别私有协议（AVP）v1](2026-10-16-answra-voice-protocol-avp-v1.md)、[功能边界与本地运行时分层](../../implemented/architecture/2026-10-11-feature-boundaries-and-local-runtime.md)。

## 提案

### 模型选型规则与结论

按"计价单位跟随被计量模态"判断：Audio→Text 是 ASR（按音频秒计费）；Text→Audio 是 TTS（按字符计费）；双向实时对话（Omni/Realtime conversation）按 token 计费且音频 token 单价远高于文本 token。面试场景只需「听 + 文字建议」，因此**只使用 ASR + 既有文本 LLM，明确排除 TTS 与 Omni 对话模型**。

- **主路径：`qwen3-asr-flash-realtime`（流式，直连）**。WebSocket 流式，服务端 `server_vad` 断句，按音频秒计费（官方文档价约 $0.000047–$0.00009/秒，量级约 ¥1/小时/路，以账单为准）。协议为 OpenAI Realtime 风格事件子集：连接 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`，头 `Authorization: Bearer <DASHSCOPE key>` 与 `OpenAI-Beta: realtime=v1`；先发 `session.update`（`modalities:["text"]`、`input_audio_format:"pcm"`、`sample_rate:16000`、`input_audio_transcription.language`/`corpus`、`turn_detection:{type:"server_vad", threshold, silence_duration_ms}`），随后循环发送 base64 PCM 块 `input_audio_buffer.append`。选中原因：首字延迟数百 ms 量级（待实测口径）与对话节奏匹配，断句在云端且尾窗参数可直接调，不被客户端工程能力限死。使用模型别名而非日期快照（快照会退役，`qwen3-asr-flash-2026-02-10` 已于 2026-10-10 退役）。
- **降级路径：`qwen3-asr-flash`（批式，OpenAI 兼容）**。`POST {base}/compatible-mode/v1/chat/completions`，content part 使用 `{type:"input_audio", input_audio:{data:"data:audio/...;base64,..."}}`，`asr_options` 作为非标准字段透传，单段上限 5 分钟/10MB（输入接受 URL/Base64；仅 *filetrans* 系列才限制公网 URL），响应为标准 `chat.completion` 且携带 `usage.seconds`。仅在企业网络禁 WS 等场景启用；网关通用 chat 中转同样可承载此降级路径。
- **两路音频复用同两套模型**：面试官（系统 loopback）与候选人（麦克风）各一条独立连接/请求，segment 带 source 标记，由总提案规定的「系统发言触发判断、麦克风仅作上下文」消费。

### 客户端 VAD 责任边界（Silero VAD，可选项）

主路径 realtime 的**断句由服务端 `server_vad` 完成，客户端 VAD 因此不再是正确性前提**，而是可开关的成本优化：Silero（MIT，约 2MB ONNX；JS 封装 `@ricky0123/vad-web` 跑在渲染进程 AudioWorklet）作为**发送门控**——仅当判定有人声时才把 PCM 块经主进程发送到云端，静默期不发送即可显著降低按秒计费的开销；服务端断句不受影响。门控必须**失败即放行**（fail-open）：模型加载失败、Worklet 异常或用户关闭门控时回退为全量流式发送，绝不能静音丢声。降级到批式时，同一 VAD 反过来承担切段职责（`speechStart`/`speechEnd` 切段拼 dataURI，段长按 5 分钟/10MB 约束收紧强切），成为批式路径的正确性前提。

### 凭证与传输形态（直连首发 / 网关透传后切）

- **首发路径（v1）：DashScope realtime WS 直连**。runtime worker 出站直连 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，DASHSCOPE key 走 main 进程 safeStorage 单独存储且与 Chat LLM 凭证隔离，renderer 不可见；未配置时面试启动显式失败，不回退本地模型或浏览器识别。**中转域（如 `maas.qianwenaiapi.com`）是否暴露 `/api-ws` 的 WSS 入口未验证**——实测通过才可使用中转域，否则首版必须用官方域，批式降级路径可另行使用中转域的 compatible-mode。
- **产品化路径：切换 AnswraSite 通用 realtime 透传**。客户端与网关之间以 [AVP v1 私有协议](2026-10-16-answra-voice-protocol-avp-v1.md)对话（网关按 AVP 做上游路由与短期 token，不借道 Grok 账号语义）；建成并验收后把 STT 连接指向网关，Answra 客户端仅改 provider（直连翻译器 → 纯转发器），批式降级与凭证形态不变。**透传端点未上线前不得**把主路径压到现行语音专用端点上；网关计费按音频秒/连接时长计量属网关侧后续课题。

主流以 [AVP v1](2026-10-16-answra-voice-protocol-avp-v1.md) 为会话语言：`TranscriptionProvider` adapter 是 AVP 与上游协议之间的唯一翻译点（会话开/停 → `TranscriptSegment`（text、startMs、endMs、isFinal、source）事件流，错误与重连显式），adapter 持有连接生命周期；上层与 shared 协议类型对上游零知识。稳定性工程按 Natively 参考实现具备：指数退避重连（约 1.5s 基数 × 2^min(attempts,6) + jitter）、断线自动恢复遥测、句尾静音尾窗与会话级 turn 合并（服务端断句时保留打点以观察延迟）。

## 模块边界

- `packages/shared`：只承载既有面试会话/转录/建议类型与 typed IPC contract，不知道任何 DashScope 事件细节；VAD 门控开关是其状态字段。
- `apps/app`：runtime utility worker 拥有 `TranscriptionProvider`（首版为 realtime 直连翻译器；批式为降级实现）与 [AVP](2026-10-16-answra-voice-protocol-avp-v1.md) 客户端会话、转录聚合与触发判断；不依赖 Electron API。
- `apps/desktop` main：音频采集（Electron loopback + getUserMedia）、音频帧转发、STT 凭证 safeStorage 读写、run/socket 生命周期回收；不解析转录语义。
- `packages/ui`：仅展示会话/断句/用量与错误状态，不持 key、不做采集。
- AnswraSite 网关：主路径产品化前不参与语音；批式降级可经通用 chat 中转（`/v1/chat/completions`）；AVP 服务端（realtime 透传 + 上游路由）为后续独立 Note。

## 曾考虑的替代方案

- **腾讯云实时语音识别（总提案原首选）**：一句一句断句能力强，但接入面更重——需额外 AppID/SecretKey 签名体系且以本地回调/密钥中心形态接入为常见路径；DashScope 提供官方 realtime WS 协议样例与 OpenAI 兼容批式两条路径，BYOK 接入成本更低。保留为后续 provider adapter 候选，不弃用其可用性。
- **AnswraSite 网关语音专用端点（/v1/realtime、/v1/live、/v1/stt）**：真实接入现状是全部分平台/未接入——`/v1/realtime` 仅 Grok 分组（`handler/grok_audio.go` 平台硬校验）、`/v1/live` 需 macOS attestation 且 Windows 503、`/v1/stt` 为 xAI 直通 `buildGrokVoiceURL`。接入须改网关代码，故 STT 不走这些端点；但网关**通用** `/v1/chat/completions` raw 转发不动 content 块与未知顶层字段，可承载批式 ASR（用户网关侧已验证，实施时需以真实请求复测）。
- **批式先行（曾为本 Note 一度方案，被延迟裁决否决）**：批式只需通用 chat 转发、接入最少；但"说完一句才出字"的延迟结构（VAD 尾窗 + 整段识别往返，估 2–4s）在实时面试/会议场景不达标。它同时需要客户端 VAD 切段作为正确性前提，工程重心反而压在客户端。保留为禁 WS 网络下的降级路径。
- **借道网关语音专用端点接入 realtime（`/v1/realtime` 仅 Grok 分组）**：唯一可行性是 platform=grok 账号 + base_url 指向 DashScope WS 的语义错位 hack（白名单/请求头都要绕，网关还按 token 给 ASR 计费），工程债大于收益；正确形态是网关建 AVP 透传（见 AVP Note）。
- **Qwen-Omni-Realtime 对话模型**：能听能说但按 token 计费且音频 token 单价高一个量级；面试不需要"AI 说话"，成本数倍、交互形态不符。明确排除。
- **非 VAD 模式（realtime turn_detection 为手动 commit）**：官方样例注明需客户端控制在 60 秒内发送并手动 `input_audio_buffer.commit`，额外状态机复杂；主路径默认 `server_vad`。
- **关闭客户端发送门控（realtime 门控）**：门控失效时仍须 fail-open 全量发送保底，绝不静音丢声；静默期全量发送只是多计费，不是丢内容风险，故门控是成本优化而非正确性前提，同样不做用户可见开关、只保留内部降级路径。批式降级中的 VAD 切段才是正确性前提（见上）。
- 本地 Whisper/Ollama、浏览器 SpeechRecognition、一次性音频上传已在总提案替代方案中否决，本 Note 不重复。

## 风险

正面权衡：realtime 首字延迟数百 ms 量级、断句在云端可调尾窗，匹配实时面试节奏；直连与网关部署解耦，AVP 协议保证后续切换零客户端改动（《AVP v1》Note）；批式降级仍有网关 chat 中转这条现成道路。

风险与约束：主路径要求 DASHSCOPE(api) key（用户先前只有 OpenAI 兼容中转 key 的话，需要另行开通），并且中转域 WSS 支持未验证——v1 用官方域 `dashscope.aliyuncs.com`，中转域支持与否以实测为准；断句由服务端 VAD 决定，`silence_duration_ms`/`threshold` 是"说完 → 建议出现"延迟的主项，必须可调并实测口径；音频流式上行百炼（及网关产品化后），隐私文案须覆盖；误 VAD 可截短句首，参数可调且门控 fail-open；模型快照会退役必须用别名；批式降级经网关按 token 计费失真（少计），产品化/对外收费前网关须升级为按 `usage.seconds`/秒级计量；key 与中转凭证全程不进 renderer。实测前不宣称实时性与计费承诺；任何实机验证结果须记入本 Note 验证节。

## 验收标准

- `TranscriptionProvider` realtime 直连实现在 mock WS 下可自动测试：`session.update` 负载含 `server_vad`/格式与语言参数、`input_audio_buffer.append` 循环与分块、`server_vad` 断句 → `TranscriptSegment` 时序、重连指数退避、错误码与 stop 释放；批式降级实现补同类 mock HTTP 测试（`input_audio`/`asr_options`、dataURI 编码、段长上限强切、`usage.seconds` 解析），两实现须产出语义等价的 `TranscriptSegment`。
- VAD 门控测试：静默期不发送音频、检测异常或关闭门控时 fail-open 全量发送、批式降级时承担切段（纯静音不产生段、尾静音后闭合、超限强切有告警）。
- 配置测试：STT 凭证（官方域直连 or 切网关）与 Chat 凭证隔离，形态仅 base_url/凭证差异。
- 共享协议不含 DashScope/AVP 事件类型；key 永不出现在 renderer 可见表面；STT 凭证与 LLM 凭证分别为两个实体。AVP 协议相关验收见其 Note。
- 实机验证按总提案 Windows 实测执行（含首字延迟与断线恢复实测记录）；未实测不迁入 `implemented/`。

## 验证证据

- 官方样例（user 提交，Qwen 官方 realtime sample）：`websocket-client` 连接 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`，`session.update` 支持上述字段与 `server_vad`，音频 3200B/100ms base64 append；非 VAD 模式需 ≤60s 并 commit。
- 千问AI平台文档（user 提供链接，`platform.qianwenai.com/docs/developer-guides/speech/speech-to-text-models`，2026-10-16 核对）：`qwen3-asr-flash` 列为"非实时 / HTTP（OpenAI 兼容）"，单段 5 分钟/10MB；非实时音频规格中 Qwen3-ASR-Flash 的输入方式为"URL / Base64 / 本地文件绝对路径"（仅 *filetrans* 系列为"公网可访问的文件 URL"，从而排除"OpenAI 兼容仅收公网 URL"的疑虑）；`qwen3-asr-flash-realtime` 列为"实时 / WebSocket"二进制流。
- 阿里云文档：`qwen3-asr-flash` OpenAI 兼容响应含 `usage.seconds` 与 `prompt_tokens_details.audio_tokens`；快照退役公告 `2026-02-10`（退役日期 2026-10-10）；`-filetrans` 仅异步。
- AnswraSite 源码（`D:\learn\xx\AnswraSite\gateway`）：`server/routes/gateway.go:296` 只在 Grok 分组挂 `/stt`；`handler/grok_audio.go:30` 与 `service/grok_audio.go:38-40` 要求 `PlatformGrok`；`service/openai_gateway_grok_chat_bridge.go:451` 拒绝 `input_audio`（仅 Grok 桥；通用 chat raw 路径不触碰 content 块——user 网关侧验证，待实测复核）；`service/billing_service.go` 音频单价按小时/分钟/百万字符三种模式，未覆盖 token 型 ASR 请求。
- 提案阶段无代码实现，"未做实时性/断句稳定性实测"视为默认，验收不由本 Note 解锁。

